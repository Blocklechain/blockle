//! The Blockle VM — a deterministic, gas-metered stack machine purpose-built
//! for Blockle contracts. No EVM compatibility.
//!
//! - 64-bit words on an operand stack (max 1024), byte-addressed zeroed
//!   memory (max 64 KiB, growth metered).
//! - 32-byte storage keys with variable-length values, read/written through
//!   the [`Host`] interface backed by consensus state.
//! - Privacy and asset primitives arrive as host calls, keeping the
//!   instruction set stable.
//! - Gas is charged per instruction plus per byte for memory/storage/hash
//!   work; execution halts with `OutOfGas` when the limit is exhausted.
//!   Blockle's consensus prepays gas from the transaction fee.
//!
//! Execution ends in one of three ways: `RETURN` (success — state effects
//! apply), `REVERT` (failure with data), or a trap ([`VmError`], failure).
//! Consensus treats revert and trap identically: all effects are discarded.

pub mod asm;
pub mod script;

use thiserror::Error;

pub const MAX_STACK: usize = 1024;
pub const MAX_MEMORY: usize = 64 * 1024;
pub const MAX_RETURN: usize = 8 * 1024;
pub const MAX_STORAGE_VALUE: usize = 1024;

#[derive(Debug, Error, PartialEq, Eq, Clone)]
pub enum VmError {
    #[error("out of gas")]
    OutOfGas,
    #[error("stack overflow")]
    StackOverflow,
    #[error("stack underflow")]
    StackUnderflow,
    #[error("invalid jump destination {0}")]
    BadJump(u64),
    #[error("invalid opcode {0:#04x}")]
    BadOpcode(u8),
    #[error("truncated instruction at {0}")]
    TruncatedCode(usize),
    #[error("memory limit exceeded")]
    MemoryLimit,
    #[error("storage value too large")]
    StorageValueTooLarge,
    #[error("return data too large")]
    ReturnTooLarge,
    #[error("send failed: insufficient contract balance")]
    SendFailed,
}

/// Opcode constants.
pub mod op {
    pub const STOP: u8 = 0x00;
    pub const PUSH8: u8 = 0x01; // 1-byte immediate, zero-extended
    pub const PUSH64: u8 = 0x02; // 8-byte LE immediate
    pub const POP: u8 = 0x03;
    pub const DUP: u8 = 0x04; // imm: depth from top, 0-based
    pub const SWAP: u8 = 0x05; // imm: depth from top, >= 1

    pub const ADD: u8 = 0x10; // wrapping
    pub const SUB: u8 = 0x11; // wrapping
    pub const MUL: u8 = 0x12; // wrapping
    pub const DIV: u8 = 0x13; // x/0 = 0
    pub const MOD: u8 = 0x14; // x%0 = 0
    pub const AND: u8 = 0x15;
    pub const OR: u8 = 0x16;
    pub const XOR: u8 = 0x17;
    pub const NOT: u8 = 0x18;
    pub const SHL: u8 = 0x19; // shift & 63
    pub const SHR: u8 = 0x1a;

    pub const EQ: u8 = 0x20;
    pub const LT: u8 = 0x21;
    pub const GT: u8 = 0x22;
    pub const ISZERO: u8 = 0x23;

    pub const JUMP: u8 = 0x30; // pops dest; must be JUMPDEST
    pub const JUMPI: u8 = 0x31; // pops dest, cond
    pub const JUMPDEST: u8 = 0x32;

    pub const MLOAD64: u8 = 0x40; // pops off; pushes LE u64
    pub const MSTORE64: u8 = 0x41; // pops val, off
    pub const MLOAD8: u8 = 0x42; // pops off
    pub const MSTORE8: u8 = 0x43; // pops val, off

    pub const CALLDATASIZE: u8 = 0x48;
    pub const CALLDATACOPY: u8 = 0x49; // pops len, src, dst

    pub const SLOAD: u8 = 0x50; // pops dst, key_off; copies value to dst, pushes len
    pub const SSTORE: u8 = 0x51; // pops vlen, voff, key_off

    pub const CALLER: u8 = 0x58; // pops dst; writes 32-byte caller address
    pub const CALLVALUE: u8 = 0x59;
    pub const HEIGHT: u8 = 0x5a;
    pub const BALANCE: u8 = 0x5b; // contract's own balance
    pub const SELF: u8 = 0x5c; // pops dst; writes 32-byte contract id

    pub const SEND: u8 = 0x60; // pops amount, addr_off; pays out of contract balance

    pub const BLAKE2B: u8 = 0x68; // pops dst, len, src; writes 32-byte hash
    pub const ZKVERIFY: u8 = 0x69; // pops pub_len, pub_off, proof_len, proof_off; pushes 0/1
    pub const LOG: u8 = 0x70; // pops len, off

    pub const REVERT: u8 = 0x7e; // pops len, off
    pub const RETURN: u8 = 0x7f; // pops len, off
}

/// Interface the VM uses to touch consensus state. The chain provides an
/// implementation that stages effects and applies them only on success.
pub trait Host {
    fn storage_get(&self, key: &[u8; 32]) -> Option<Vec<u8>>;
    fn storage_set(&mut self, key: [u8; 32], value: Vec<u8>);
    /// Pay `amount` from the contract's balance to a transparent address.
    fn send(&mut self, recipient: [u8; 32], amount: u64) -> Result<(), VmError>;
    /// The contract's current spendable balance.
    fn balance(&self) -> u64;
    fn log(&mut self, data: &[u8]);
    /// Verify a shielded-pool spend proof against encoded public inputs
    /// (`root ‖ nullifier ‖ value_le ‖ binding`, 104 bytes). Lets contracts
    /// build private applications on the protocol's proof system. Default:
    /// reject everything.
    fn zk_verify(&self, _proof: &[u8], _public_inputs: &[u8]) -> bool {
        false
    }
}

/// Execution environment.
#[derive(Clone, Debug)]
pub struct Context {
    pub caller: [u8; 32],
    pub contract: [u8; 32],
    pub value: u64,
    pub height: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    Return(Vec<u8>),
    Revert(Vec<u8>),
}

#[derive(Clone, Debug)]
pub struct Receipt {
    pub gas_used: u64,
    pub outcome: Outcome,
}

/// Positions that are valid jump targets (JUMPDEST opcodes, skipping
/// immediate bytes).
fn jump_table(code: &[u8]) -> Vec<bool> {
    let mut dests = vec![false; code.len()];
    let mut pc = 0;
    while pc < code.len() {
        match code[pc] {
            op::JUMPDEST => {
                dests[pc] = true;
                pc += 1;
            }
            op::PUSH8 | op::DUP | op::SWAP => pc += 2,
            op::PUSH64 => pc += 9,
            _ => pc += 1,
        }
    }
    dests
}

struct Machine<'a> {
    code: &'a [u8],
    input: &'a [u8],
    ctx: &'a Context,
    stack: Vec<u64>,
    mem: Vec<u8>,
    gas_limit: u64,
    gas_used: u64,
    dests: Vec<bool>,
}

impl<'a> Machine<'a> {
    fn charge(&mut self, gas: u64) -> Result<(), VmError> {
        self.gas_used = self.gas_used.saturating_add(gas);
        if self.gas_used > self.gas_limit {
            Err(VmError::OutOfGas)
        } else {
            Ok(())
        }
    }

    fn push(&mut self, v: u64) -> Result<(), VmError> {
        if self.stack.len() >= MAX_STACK {
            return Err(VmError::StackOverflow);
        }
        self.stack.push(v);
        Ok(())
    }

    fn pop(&mut self) -> Result<u64, VmError> {
        self.stack.pop().ok_or(VmError::StackUnderflow)
    }

    /// Grow memory to cover `[off, off+len)`, charging for new bytes.
    fn mem_ensure(&mut self, off: u64, len: u64) -> Result<(usize, usize), VmError> {
        let end = off.checked_add(len).ok_or(VmError::MemoryLimit)?;
        if end > MAX_MEMORY as u64 {
            return Err(VmError::MemoryLimit);
        }
        let (off, end) = (off as usize, end as usize);
        if end > self.mem.len() {
            let grown = end - self.mem.len();
            self.charge(grown.div_ceil(8) as u64)?;
            self.mem.resize(end, 0);
        }
        Ok((off, end))
    }

    fn mem_read32(&mut self, off: u64) -> Result<[u8; 32], VmError> {
        let (off, end) = self.mem_ensure(off, 32)?;
        let mut out = [0u8; 32];
        out.copy_from_slice(&self.mem[off..end]);
        Ok(out)
    }

    fn mem_write(&mut self, off: u64, data: &[u8]) -> Result<(), VmError> {
        let (off, end) = self.mem_ensure(off, data.len() as u64)?;
        self.mem[off..end].copy_from_slice(data);
        Ok(())
    }
}

/// Execute `code` with `input` under `gas_limit`. Traps are returned as
/// `Err`; `RETURN`/`REVERT`/`STOP` produce a [`Receipt`].
pub fn execute(
    code: &[u8],
    input: &[u8],
    ctx: &Context,
    host: &mut dyn Host,
    gas_limit: u64,
) -> Result<Receipt, VmError> {
    let dests = jump_table(code);
    let mut m = Machine {
        code,
        input,
        ctx,
        stack: Vec::with_capacity(64),
        mem: Vec::new(),
        gas_limit,
        gas_used: 0,
        dests,
    };

    let mut pc: usize = 0;
    loop {
        let Some(&opcode) = m.code.get(pc) else {
            // Running off the end is an implicit STOP.
            return Ok(Receipt { gas_used: m.gas_used, outcome: Outcome::Return(vec![]) });
        };
        m.charge(2)?;
        pc += 1;
        match opcode {
            op::STOP => {
                return Ok(Receipt { gas_used: m.gas_used, outcome: Outcome::Return(vec![]) })
            }
            op::PUSH8 => {
                let &b = m.code.get(pc).ok_or(VmError::TruncatedCode(pc))?;
                pc += 1;
                m.push(b as u64)?;
            }
            op::PUSH64 => {
                let bytes = m
                    .code
                    .get(pc..pc + 8)
                    .ok_or(VmError::TruncatedCode(pc))?;
                pc += 8;
                m.push(u64::from_le_bytes(bytes.try_into().unwrap()))?;
            }
            op::POP => {
                m.pop()?;
            }
            op::DUP => {
                let &depth = m.code.get(pc).ok_or(VmError::TruncatedCode(pc))?;
                pc += 1;
                let idx = m
                    .stack
                    .len()
                    .checked_sub(1 + depth as usize)
                    .ok_or(VmError::StackUnderflow)?;
                let v = m.stack[idx];
                m.push(v)?;
            }
            op::SWAP => {
                let &depth = m.code.get(pc).ok_or(VmError::TruncatedCode(pc))?;
                pc += 1;
                if depth == 0 {
                    return Err(VmError::BadOpcode(op::SWAP));
                }
                let top = m.stack.len().checked_sub(1).ok_or(VmError::StackUnderflow)?;
                let idx = top.checked_sub(depth as usize).ok_or(VmError::StackUnderflow)?;
                m.stack.swap(top, idx);
            }
            op::ADD | op::SUB | op::MUL | op::DIV | op::MOD | op::AND | op::OR | op::XOR
            | op::SHL | op::SHR | op::EQ | op::LT | op::GT => {
                if matches!(opcode, op::MUL | op::DIV | op::MOD) {
                    m.charge(3)?;
                }
                let b = m.pop()?;
                let a = m.pop()?;
                let r = match opcode {
                    op::ADD => a.wrapping_add(b),
                    op::SUB => a.wrapping_sub(b),
                    op::MUL => a.wrapping_mul(b),
                    op::DIV => a.checked_div(b).unwrap_or(0),
                    op::MOD => a.checked_rem(b).unwrap_or(0),
                    op::AND => a & b,
                    op::OR => a | b,
                    op::XOR => a ^ b,
                    op::SHL => a << (b & 63),
                    op::SHR => a >> (b & 63),
                    op::EQ => (a == b) as u64,
                    op::LT => (a < b) as u64,
                    op::GT => (a > b) as u64,
                    _ => unreachable!(),
                };
                m.push(r)?;
            }
            op::NOT => {
                let a = m.pop()?;
                m.push(!a)?;
            }
            op::ISZERO => {
                let a = m.pop()?;
                m.push((a == 0) as u64)?;
            }
            op::JUMP | op::JUMPI => {
                m.charge(3)?;
                let dest = m.pop()?;
                let take = if opcode == op::JUMPI { m.pop()? != 0 } else { true };
                if take {
                    let d = dest as usize;
                    if dest >= m.code.len() as u64 || !m.dests[d] {
                        return Err(VmError::BadJump(dest));
                    }
                    pc = d;
                }
            }
            op::JUMPDEST => {}
            op::MLOAD64 => {
                let off = m.pop()?;
                let (o, e) = m.mem_ensure(off, 8)?;
                let v = u64::from_le_bytes(m.mem[o..e].try_into().unwrap());
                m.push(v)?;
            }
            op::MSTORE64 => {
                let val = m.pop()?;
                let off = m.pop()?;
                m.mem_write(off, &val.to_le_bytes())?;
            }
            op::MLOAD8 => {
                let off = m.pop()?;
                let (o, _) = m.mem_ensure(off, 1)?;
                let v = m.mem[o] as u64;
                m.push(v)?;
            }
            op::MSTORE8 => {
                let val = m.pop()?;
                let off = m.pop()?;
                m.mem_write(off, &[val as u8])?;
            }
            op::CALLDATASIZE => m.push(m.input.len() as u64)?,
            op::CALLDATACOPY => {
                let len = m.pop()?;
                let src = m.pop()?;
                let dst = m.pop()?;
                m.charge(len.div_ceil(8))?;
                let (d, _) = m.mem_ensure(dst, len)?;
                // Out-of-range calldata reads as zeros.
                for i in 0..len as usize {
                    m.mem[d + i] = *m.input.get(src as usize + i).unwrap_or(&0);
                }
            }
            op::SLOAD => {
                let dst = m.pop()?;
                let key_off = m.pop()?;
                let key = m.mem_read32(key_off)?;
                let value = host.storage_get(&key).unwrap_or_default();
                m.charge(50 + value.len() as u64)?;
                m.mem_write(dst, &value)?;
                m.push(value.len() as u64)?;
            }
            op::SSTORE => {
                let vlen = m.pop()?;
                let voff = m.pop()?;
                let key_off = m.pop()?;
                if vlen > MAX_STORAGE_VALUE as u64 {
                    return Err(VmError::StorageValueTooLarge);
                }
                m.charge(200 + 5 * vlen)?;
                let key = m.mem_read32(key_off)?;
                let (o, e) = m.mem_ensure(voff, vlen)?;
                let value = m.mem[o..e].to_vec();
                host.storage_set(key, value);
            }
            op::CALLER => {
                let dst = m.pop()?;
                let caller = m.ctx.caller;
                m.mem_write(dst, &caller)?;
            }
            op::CALLVALUE => m.push(m.ctx.value)?,
            op::HEIGHT => m.push(m.ctx.height)?,
            op::BALANCE => {
                let b = host.balance();
                m.push(b)?;
            }
            op::SELF => {
                let dst = m.pop()?;
                let id = m.ctx.contract;
                m.mem_write(dst, &id)?;
            }
            op::SEND => {
                m.charge(100)?;
                let amount = m.pop()?;
                let addr_off = m.pop()?;
                let addr = m.mem_read32(addr_off)?;
                host.send(addr, amount)?;
            }
            op::BLAKE2B => {
                let dst = m.pop()?;
                let len = m.pop()?;
                let src = m.pop()?;
                m.charge(30 + len.div_ceil(8))?;
                let (o, e) = m.mem_ensure(src, len)?;
                let hash = blake2b_simd::Params::new()
                    .hash_length(32)
                    .to_state()
                    .update(&m.mem[o..e])
                    .finalize();
                let mut out = [0u8; 32];
                out.copy_from_slice(hash.as_bytes());
                m.mem_write(dst, &out)?;
            }
            op::ZKVERIFY => {
                let pub_len = m.pop()?;
                let pub_off = m.pop()?;
                let proof_len = m.pop()?;
                let proof_off = m.pop()?;
                m.charge(5000 + proof_len.div_ceil(8))?;
                let (po, pe) = m.mem_ensure(proof_off, proof_len)?;
                let proof = m.mem[po..pe].to_vec();
                let (io, ie) = m.mem_ensure(pub_off, pub_len)?;
                let public = m.mem[io..ie].to_vec();
                let ok = host.zk_verify(&proof, &public);
                m.push(ok as u64)?;
            }
            op::LOG => {
                let len = m.pop()?;
                let off = m.pop()?;
                m.charge(10 + len)?;
                let (o, e) = m.mem_ensure(off, len)?;
                let data = m.mem[o..e].to_vec();
                host.log(&data);
            }
            op::RETURN | op::REVERT => {
                let len = m.pop()?;
                let off = m.pop()?;
                if len > MAX_RETURN as u64 {
                    return Err(VmError::ReturnTooLarge);
                }
                let (o, e) = m.mem_ensure(off, len)?;
                let data = m.mem[o..e].to_vec();
                let outcome = if opcode == op::RETURN {
                    Outcome::Return(data)
                } else {
                    Outcome::Revert(data)
                };
                return Ok(Receipt { gas_used: m.gas_used, outcome });
            }
            other => return Err(VmError::BadOpcode(other)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[derive(Default)]
    pub struct MockHost {
        pub storage: HashMap<[u8; 32], Vec<u8>>,
        pub balance: u64,
        pub sends: Vec<([u8; 32], u64)>,
        pub logs: Vec<Vec<u8>>,
    }

    impl Host for MockHost {
        fn storage_get(&self, key: &[u8; 32]) -> Option<Vec<u8>> {
            self.storage.get(key).cloned()
        }
        fn storage_set(&mut self, key: [u8; 32], value: Vec<u8>) {
            self.storage.insert(key, value);
        }
        fn send(&mut self, recipient: [u8; 32], amount: u64) -> Result<(), VmError> {
            if amount > self.balance {
                return Err(VmError::SendFailed);
            }
            self.balance -= amount;
            self.sends.push((recipient, amount));
            Ok(())
        }
        fn balance(&self) -> u64 {
            self.balance
        }
        fn log(&mut self, data: &[u8]) {
            self.logs.push(data.to_vec());
        }
    }

    fn ctx() -> Context {
        Context { caller: [7; 32], contract: [9; 32], value: 5, height: 42 }
    }

    fn run(src: &str, input: &[u8], host: &mut MockHost) -> Result<Receipt, VmError> {
        let code = asm::assemble(src).expect("assembles");
        execute(&code, input, &ctx(), host, 1_000_000)
    }

    #[test]
    fn arithmetic_and_return() {
        let mut host = MockHost::default();
        let r = run(
            "PUSH 20\nPUSH 22\nADD\nPUSH 0\nSWAP 1\nMSTORE64\nPUSH 0\nPUSH 8\nRETURN\n",
            &[],
            &mut host,
        )
        .unwrap();
        match r.outcome {
            Outcome::Return(data) => assert_eq!(u64::from_le_bytes(data.try_into().unwrap()), 42),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn out_of_gas() {
        let mut host = MockHost::default();
        let code = asm::assemble("loop:\nPUSH 1\nPOP\nPUSH @loop\nJUMP\n").unwrap();
        let err = execute(&code, &[], &ctx(), &mut host, 1000).unwrap_err();
        assert_eq!(err, VmError::OutOfGas);
    }

    #[test]
    fn storage_roundtrip_and_env() {
        let mut host = MockHost::default();
        host.balance = 100;
        // store CALLVALUE under key at mem[64] (zero key), then read it back.
        let src = "
            PUSH 0
            CALLVALUE
            MSTORE64
            PUSH 64
            PUSH 0
            PUSH 8
            SSTORE
            PUSH 64
            PUSH 8
            SLOAD          ; value -> mem[8..16], pushes len
            POP
            PUSH 8
            PUSH 8
            RETURN
        ";
        let r = run(src, &[], &mut host).unwrap();
        match r.outcome {
            Outcome::Return(data) => assert_eq!(u64::from_le_bytes(data.try_into().unwrap()), 5),
            other => panic!("unexpected {other:?}"),
        }
        assert_eq!(host.storage.get(&[0u8; 32]).unwrap(), &5u64.to_le_bytes().to_vec());
    }

    #[test]
    fn revert_and_send() {
        let mut host = MockHost::default();
        host.balance = 10;
        // send 7 to caller, then revert with 1 byte
        let src = "
            PUSH 0
            CALLER
            PUSH 0
            PUSH 7
            SEND
            PUSH 100
            PUSH 1
            MSTORE8
            PUSH 100
            PUSH 1
            REVERT
        ";
        let r = run(src, &[], &mut host).unwrap();
        assert!(matches!(r.outcome, Outcome::Revert(ref d) if d == &[1u8]));
        assert_eq!(host.sends, vec![([7u8; 32], 7)]);
        // over-balance send traps
        let src2 = "PUSH 0\nCALLER\nPUSH 0\nPUSH 99\nSEND\nSTOP\n";
        assert_eq!(run(src2, &[], &mut host).unwrap_err(), VmError::SendFailed);
    }

    #[test]
    fn bad_jump_rejected() {
        let mut host = MockHost::default();
        let code = asm::assemble("PUSH 3\nJUMP\n").unwrap(); // 3 is not a JUMPDEST
        assert!(matches!(
            execute(&code, &[], &ctx(), &mut host, 10_000),
            Err(VmError::BadJump(3))
        ));
    }

    #[test]
    fn calldata_copy_zero_fills() {
        let mut host = MockHost::default();
        let src = "PUSH 0\nPUSH 0\nPUSH 8\nCALLDATACOPY\nPUSH 0\nPUSH 8\nRETURN\n";
        let r = run(src, &[0xaa, 0xbb], &mut host).unwrap();
        match r.outcome {
            Outcome::Return(data) => assert_eq!(data, vec![0xaa, 0xbb, 0, 0, 0, 0, 0, 0]),
            other => panic!("unexpected {other:?}"),
        }
    }
}
