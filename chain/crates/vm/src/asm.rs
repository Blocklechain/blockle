//! A small assembler for Blockle VM bytecode.
//!
//! Syntax (one instruction per line, `;` starts a comment):
//!
//! ```text
//! start:              ; a label — emits a JUMPDEST here
//!     PUSH 42         ; 64-bit push (decimal or 0x hex)
//!     PUSH @start     ; push a label's offset (for JUMP/JUMPI)
//!     PUSH8 7         ; 1-byte push
//!     DUP 0           ; DUP/SWAP take a depth immediate
//!     JUMPI
//! ```
//!
//! `PUSH` always emits the 9-byte `PUSH64` form so label offsets are stable
//! across passes; use `PUSH8` explicitly when size matters.

use std::collections::HashMap;

use thiserror::Error;

use crate::op;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum AsmError {
    #[error("line {0}: unknown mnemonic {1:?}")]
    UnknownMnemonic(usize, String),
    #[error("line {0}: bad operand {1:?}")]
    BadOperand(usize, String),
    #[error("line {0}: missing operand")]
    MissingOperand(usize),
    #[error("line {0}: unexpected operand")]
    UnexpectedOperand(usize),
    #[error("unknown label {0:?}")]
    UnknownLabel(String),
    #[error("line {0}: duplicate label {1:?}")]
    DuplicateLabel(usize, String),
}

enum Operand {
    None,
    Imm8,
    Imm64,
}

fn mnemonic(name: &str) -> Option<(u8, Operand)> {
    use Operand::*;
    Some(match name {
        "STOP" => (op::STOP, None),
        "PUSH8" => (op::PUSH8, Imm8),
        "PUSH" | "PUSH64" => (op::PUSH64, Imm64),
        "POP" => (op::POP, None),
        "DUP" => (op::DUP, Imm8),
        "SWAP" => (op::SWAP, Imm8),
        "ADD" => (op::ADD, None),
        "SUB" => (op::SUB, None),
        "MUL" => (op::MUL, None),
        "DIV" => (op::DIV, None),
        "MOD" => (op::MOD, None),
        "AND" => (op::AND, None),
        "OR" => (op::OR, None),
        "XOR" => (op::XOR, None),
        "NOT" => (op::NOT, None),
        "SHL" => (op::SHL, None),
        "SHR" => (op::SHR, None),
        "EQ" => (op::EQ, None),
        "LT" => (op::LT, None),
        "GT" => (op::GT, None),
        "ISZERO" => (op::ISZERO, None),
        "JUMP" => (op::JUMP, None),
        "JUMPI" => (op::JUMPI, None),
        "JUMPDEST" => (op::JUMPDEST, None),
        "MLOAD64" => (op::MLOAD64, None),
        "MSTORE64" => (op::MSTORE64, None),
        "MLOAD8" => (op::MLOAD8, None),
        "MSTORE8" => (op::MSTORE8, None),
        "CALLDATASIZE" => (op::CALLDATASIZE, None),
        "CALLDATACOPY" => (op::CALLDATACOPY, None),
        "SLOAD" => (op::SLOAD, None),
        "SSTORE" => (op::SSTORE, None),
        "CALLER" => (op::CALLER, None),
        "CALLVALUE" => (op::CALLVALUE, None),
        "HEIGHT" => (op::HEIGHT, None),
        "BALANCE" => (op::BALANCE, None),
        "SELF" => (op::SELF, None),
        "SEND" => (op::SEND, None),
        "BLAKE2B" => (op::BLAKE2B, None),
        "ZKVERIFY" => (op::ZKVERIFY, None),
        "LOG" => (op::LOG, None),
        "REVERT" => (op::REVERT, None),
        "RETURN" => (op::RETURN, None),
        _ => return Option::None,
    })
}

fn parse_number(s: &str) -> Option<u64> {
    if let Some(hex) = s.strip_prefix("0x") {
        u64::from_str_radix(hex, 16).ok()
    } else {
        s.parse().ok()
    }
}

enum Item {
    Op(u8),
    Imm8(u8),
    Imm64(u64),
    LabelRef(String, usize), // emits 8 bytes once resolved
}

pub fn assemble(source: &str) -> Result<Vec<u8>, AsmError> {
    let mut items: Vec<Item> = Vec::new();
    let mut labels: HashMap<String, u64> = HashMap::new();
    let mut offset: u64 = 0;

    for (lineno, raw) in source.lines().enumerate() {
        let lineno = lineno + 1;
        let line = raw.split(';').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        if let Some(label) = line.strip_suffix(':') {
            let label = label.trim();
            if labels.insert(label.to_string(), offset).is_some() {
                return Err(AsmError::DuplicateLabel(lineno, label.to_string()));
            }
            items.push(Item::Op(op::JUMPDEST));
            offset += 1;
            continue;
        }
        let mut parts = line.split_whitespace();
        let name = parts.next().unwrap().to_uppercase();
        let operand = parts.next();
        if parts.next().is_some() {
            return Err(AsmError::UnexpectedOperand(lineno));
        }
        let (opcode, kind) = mnemonic(&name)
            .ok_or_else(|| AsmError::UnknownMnemonic(lineno, name.clone()))?;
        items.push(Item::Op(opcode));
        offset += 1;
        match kind {
            Operand::None => {
                if operand.is_some() {
                    return Err(AsmError::UnexpectedOperand(lineno));
                }
            }
            Operand::Imm8 => {
                let text = operand.ok_or(AsmError::MissingOperand(lineno))?;
                let v = parse_number(text)
                    .filter(|&v| v <= 255)
                    .ok_or_else(|| AsmError::BadOperand(lineno, text.to_string()))?;
                items.push(Item::Imm8(v as u8));
                offset += 1;
            }
            Operand::Imm64 => {
                let text = operand.ok_or(AsmError::MissingOperand(lineno))?;
                if let Some(label) = text.strip_prefix('@') {
                    items.push(Item::LabelRef(label.to_string(), lineno));
                } else {
                    let v = parse_number(text)
                        .ok_or_else(|| AsmError::BadOperand(lineno, text.to_string()))?;
                    items.push(Item::Imm64(v));
                }
                offset += 8;
            }
        }
    }

    let mut out = Vec::with_capacity(offset as usize);
    for item in items {
        match item {
            Item::Op(b) => out.push(b),
            Item::Imm8(b) => out.push(b),
            Item::Imm64(v) => out.extend_from_slice(&v.to_le_bytes()),
            Item::LabelRef(name, _line) => {
                let target = labels
                    .get(&name)
                    .ok_or(AsmError::UnknownLabel(name))?;
                out.extend_from_slice(&target.to_le_bytes());
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assembles_labels_and_immediates() {
        let code = assemble(
            "start:\n  PUSH 1\n  PUSH @start\n  JUMPI\n  PUSH8 0xff\n  STOP ; done\n",
        )
        .unwrap();
        assert_eq!(code[0], op::JUMPDEST);
        assert_eq!(code[1], op::PUSH64);
        assert_eq!(&code[2..10], &1u64.to_le_bytes());
        assert_eq!(code[10], op::PUSH64);
        assert_eq!(&code[11..19], &0u64.to_le_bytes()); // @start = 0
        assert_eq!(code[19], op::JUMPI);
        assert_eq!(code[20], op::PUSH8);
        assert_eq!(code[21], 0xff);
        assert_eq!(code[22], op::STOP);
    }

    #[test]
    fn errors() {
        assert!(matches!(assemble("FROB\n"), Err(AsmError::UnknownMnemonic(1, _))));
        assert!(matches!(assemble("PUSH\n"), Err(AsmError::MissingOperand(1))));
        assert!(matches!(assemble("PUSH @nope\n"), Err(AsmError::UnknownLabel(_))));
        assert!(matches!(assemble("x:\nx:\n"), Err(AsmError::DuplicateLabel(2, _))));
        assert!(matches!(assemble("DUP 300\n"), Err(AsmError::BadOperand(1, _))));
    }
}
