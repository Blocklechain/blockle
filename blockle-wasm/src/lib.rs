//! WASM bindings for Blockle's post-quantum wallet crypto.
//!
//! Exposes the real consensus primitives from `blockle-core` to JavaScript:
//! ML-DSA-44 key generation, `block1…` address derivation, message signing /
//! verification, and construction of a signed, broadcast-ready transfer. Used
//! by the browser-extension wallet so it holds genuine chain keys and can sign
//! real transactions (not just dApp-auth signatures).

use blockle_core::hash::blake2b_256_personal;
use blockle_core::keys::{
    decode_address, encode_address, pubkey_to_address, verify_signature, Keypair,
};
use blockle_core::transaction::OutPoint;
use blockle_core::{ContractAction, Transaction, TxInput, TxOutput};
use blockle_vm::{self as vm, asm, script};
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use wasm_bindgen::prelude::*;

fn hexs(b: &[u8]) -> String {
    hex::encode(b)
}

fn load_kp(secret_hex: &str, public_hex: &str) -> Result<Keypair, JsError> {
    let sk = hex::decode(secret_hex).map_err(|_| JsError::new("bad secret hex"))?;
    let pk = hex::decode(public_hex).map_err(|_| JsError::new("bad public hex"))?;
    Keypair::from_bytes(&sk, &pk).map_err(|_| JsError::new("invalid keypair"))
}

/// Generate a fresh ML-DSA-44 wallet. Returns JSON:
/// `{ address, publicKey, secretKey }` (keys hex-encoded).
#[wasm_bindgen]
pub fn keygen() -> String {
    let kp = Keypair::generate();
    serde_json::json!({
        "address": encode_address(&kp.address()),
        "publicKey": hexs(&kp.public_bytes()),
        "secretKey": hexs(&kp.secret_bytes()),
    })
    .to_string()
}

/// Derive the `block1…` address committed to by a public key.
#[wasm_bindgen]
pub fn address_from_pubkey(public_hex: &str) -> Result<String, JsError> {
    let pk = hex::decode(public_hex).map_err(|_| JsError::new("bad pubkey hex"))?;
    Ok(encode_address(&pubkey_to_address(&pk)))
}

/// Sign a UTF-8 message with the wallet key. Returns JSON:
/// `{ scheme, address, publicKey, signature }`.
#[wasm_bindgen]
pub fn sign_message(secret_hex: &str, public_hex: &str, msg: &str) -> Result<String, JsError> {
    let kp = load_kp(secret_hex, public_hex)?;
    let sig = kp.sign(msg.as_bytes());
    Ok(serde_json::json!({
        "scheme": "ML-DSA-44",
        "address": encode_address(&kp.address()),
        "publicKey": public_hex,
        "signature": hexs(&sig),
    })
    .to_string())
}

/// Verify an ML-DSA-44 signature over a UTF-8 message.
#[wasm_bindgen]
pub fn verify(public_hex: &str, msg: &str, sig_hex: &str) -> bool {
    match (hex::decode(public_hex), hex::decode(sig_hex)) {
        (Ok(pk), Ok(sig)) => verify_signature(&pk, msg.as_bytes(), &sig).is_ok(),
        _ => false,
    }
}

#[derive(Deserialize)]
struct Utxo {
    txid: String,
    vout: u32,
    amount: u64,
}

/// Build and sign a transfer. `utxos_json` is `[{txid, vout, amount}]` (base
/// units). Selects inputs greedily, adds change back to the sender, signs every
/// input with ML-DSA over the tx sighash, and returns JSON:
/// `{ txid, raw, change, inputs }` where `raw` is the bincode-serialized
/// transaction (hex) ready to POST to the node's submit endpoint.
#[wasm_bindgen]
pub fn build_transfer(
    secret_hex: &str,
    public_hex: &str,
    utxos_json: &str,
    to: &str,
    amount: u64,
    fee: u64,
) -> Result<String, JsError> {
    let kp = load_kp(secret_hex, public_hex)?;
    let utxos: Vec<Utxo> =
        serde_json::from_str(utxos_json).map_err(|_| JsError::new("bad utxos json"))?;
    let recipient = decode_address(to).map_err(|_| JsError::new("bad recipient address"))?;
    let needed = amount
        .checked_add(fee)
        .ok_or_else(|| JsError::new("amount + fee overflow"))?;

    let mut selected: Vec<OutPoint> = Vec::new();
    let mut total: u64 = 0;
    for u in &utxos {
        let bytes = hex::decode(&u.txid).map_err(|_| JsError::new("bad utxo txid hex"))?;
        let txid: [u8; 32] = bytes
            .as_slice()
            .try_into()
            .map_err(|_| JsError::new("utxo txid must be 32 bytes"))?;
        selected.push(OutPoint { txid, vout: u.vout });
        total = total.saturating_add(u.amount);
        if total >= needed {
            break;
        }
    }
    if total < needed {
        return Err(JsError::new("insufficient spendable funds"));
    }

    let mut outputs = vec![TxOutput { recipient, amount }];
    let change = total - needed;
    if change > 0 {
        outputs.push(TxOutput {
            recipient: kp.address(),
            amount: change,
        });
    }

    let mut tx = Transaction {
        version: 1,
        inputs: selected
            .iter()
            .map(|op| TxInput {
                prev: *op,
                pubkey: kp.public_bytes(),
                signature: vec![],
            })
            .collect(),
        outputs,
        coinbase_data: vec![],
        shielded: None,
        contract: None,
    };

    let sighash = tx.sighash();
    let signature = kp.sign(&sighash);
    for input in &mut tx.inputs {
        input.signature = signature.clone();
    }

    let raw = bincode::serialize(&tx).map_err(|_| JsError::new("serialize failed"))?;
    Ok(serde_json::json!({
        "txid": hexs(&tx.txid()),
        "raw": hexs(&raw),
        "change": change,
        "inputs": tx.inputs.len(),
    })
    .to_string())
}

// ====================================================================
// Programming studio: compile, assemble, simulate (local testnet), deploy
// ====================================================================

/// Compile Blockle Script source to bytecode. Returns JSON
/// `{ ok, bytecode, asm, size }` or `{ ok:false, error }`.
#[wasm_bindgen]
pub fn compile_script(src: &str) -> String {
    match script::compile(src) {
        Ok(code) => {
            let asm = script::compile_to_asm(src).unwrap_or_default();
            serde_json::json!({ "ok": true, "bytecode": hexs(&code), "asm": asm, "size": code.len() }).to_string()
        }
        Err(e) => serde_json::json!({ "ok": false, "error": format!("{e}") }).to_string(),
    }
}

/// Assemble raw Blockle VM assembly to bytecode.
#[wasm_bindgen]
pub fn assemble_asm(src: &str) -> String {
    match asm::assemble(src) {
        Ok(code) => serde_json::json!({ "ok": true, "bytecode": hexs(&code), "size": code.len() }).to_string(),
        Err(e) => serde_json::json!({ "ok": false, "error": format!("{e}") }).to_string(),
    }
}

/// In-memory Host for the local testnet sandbox.
struct SimHost {
    storage: HashMap<[u8; 32], Vec<u8>>,
    balance: u64,
    logs: Vec<Vec<u8>>,
    sends: Vec<(String, u64)>,
}
impl vm::Host for SimHost {
    fn storage_get(&self, key: &[u8; 32]) -> Option<Vec<u8>> {
        self.storage.get(key).cloned()
    }
    fn storage_set(&mut self, key: [u8; 32], value: Vec<u8>) {
        self.storage.insert(key, value);
    }
    fn send(&mut self, recipient: [u8; 32], amount: u64) -> Result<(), vm::VmError> {
        if amount > self.balance {
            return Err(vm::VmError::SendFailed);
        }
        self.balance -= amount;
        self.sends.push((encode_address(&recipient), amount));
        Ok(())
    }
    fn balance(&self) -> u64 {
        self.balance
    }
    fn log(&mut self, data: &[u8]) {
        self.logs.push(data.to_vec());
    }
}

#[derive(Deserialize)]
struct SimCall {
    #[serde(default)]
    calldata: String,
    #[serde(default)]
    value: u64,
    #[serde(default)]
    height: u64,
}

fn as_u64(data: &[u8]) -> Option<u64> {
    if data.len() >= 8 {
        Some(u64::from_le_bytes(data[..8].try_into().unwrap()))
    } else {
        None
    }
}

/// Run a sequence of calls against a fresh in-memory contract (the local
/// testnet). `calls_json` is `[{calldata, value, height}]`, run in order
/// against one persistent state. Returns per-call receipts plus final storage.
#[wasm_bindgen]
pub fn simulate(bytecode_hex: &str, calls_json: &str, start_balance: u64) -> String {
    let code = match hex::decode(bytecode_hex) {
        Ok(c) => c,
        Err(_) => return serde_json::json!({ "error": "bad bytecode hex" }).to_string(),
    };
    let calls: Vec<SimCall> = serde_json::from_str(calls_json).unwrap_or_default();
    let mut host = SimHost { storage: HashMap::new(), balance: start_balance, logs: vec![], sends: vec![] };
    let contract = [0x11u8; 32];
    let caller = [0x22u8; 32];
    let mut results = Vec::new();
    for c in &calls {
        host.logs.clear();
        host.sends.clear();
        let input = hex::decode(&c.calldata).unwrap_or_default();
        host.balance = host.balance.saturating_add(c.value);
        let ctx = vm::Context { caller, contract, value: c.value, height: c.height };
        match vm::execute(&code, &input, &ctx, &mut host, 10_000_000) {
            Ok(r) => {
                let (kind, data) = match r.outcome {
                    vm::Outcome::Return(d) => ("return", d),
                    vm::Outcome::Revert(d) => ("revert", d),
                };
                results.push(serde_json::json!({
                    "ok": kind == "return",
                    "outcome": kind,
                    "data": hexs(&data),
                    "u64": as_u64(&data),
                    "gas": r.gas_used,
                    "logs": host.logs.iter().map(|l| hexs(l)).collect::<Vec<_>>(),
                    "logsU64": host.logs.iter().map(|l| as_u64(l)).collect::<Vec<_>>(),
                    "sends": host.sends.iter().map(|(a, v)| serde_json::json!({"to": a, "amount": v})).collect::<Vec<_>>(),
                }));
            }
            Err(e) => results.push(serde_json::json!({
                "ok": false, "outcome": "trap", "error": format!("{e}"),
                "logs": [], "gas": null
            })),
        }
    }
    let storage: Vec<Value> = {
        let mut kv: Vec<_> = host.storage.iter().collect();
        kv.sort_by(|a, b| a.0.cmp(b.0));
        kv.into_iter()
            .map(|(k, v)| serde_json::json!({ "key": hexs(k), "value": hexs(v), "u64": as_u64(v) }))
            .collect()
    };
    serde_json::json!({ "results": results, "storage": storage, "balance": host.balance }).to_string()
}

/// Build + sign a mainnet contract-deploy transaction. `fee = gas_limit *
/// gas_price`; inputs fund the fee, change returns to the sender. Returns
/// `{ txid, raw, contractId, fee }`.
#[wasm_bindgen]
pub fn build_deploy(
    secret_hex: &str,
    public_hex: &str,
    utxos_json: &str,
    code_hex: &str,
    gas_limit: u64,
    gas_price: u64,
) -> Result<String, JsError> {
    let kp = load_kp(secret_hex, public_hex)?;
    let code = hex::decode(code_hex).map_err(|_| JsError::new("bad code hex"))?;
    let utxos: Vec<Utxo> =
        serde_json::from_str(utxos_json).map_err(|_| JsError::new("bad utxos json"))?;
    let fee = gas_limit
        .checked_mul(gas_price)
        .ok_or_else(|| JsError::new("gas overflow"))?;

    let mut selected: Vec<OutPoint> = Vec::new();
    let mut total: u64 = 0;
    for u in &utxos {
        let bytes = hex::decode(&u.txid).map_err(|_| JsError::new("bad utxo txid hex"))?;
        let txid: [u8; 32] = bytes.as_slice().try_into().map_err(|_| JsError::new("utxo txid len"))?;
        selected.push(OutPoint { txid, vout: u.vout });
        total = total.saturating_add(u.amount);
        if total >= fee {
            break;
        }
    }
    if total < fee {
        return Err(JsError::new("insufficient funds for gas fee"));
    }

    let mut outputs = Vec::new();
    let change = total - fee;
    if change > 0 {
        outputs.push(TxOutput { recipient: kp.address(), amount: change });
    }

    let mut tx = Transaction {
        version: 1,
        inputs: selected
            .iter()
            .map(|op| TxInput { prev: *op, pubkey: kp.public_bytes(), signature: vec![] })
            .collect(),
        outputs,
        coinbase_data: vec![],
        shielded: None,
        contract: Some(ContractAction::Deploy { code, gas_limit }),
    };
    let sighash = tx.sighash();
    let signature = kp.sign(&sighash);
    for input in &mut tx.inputs {
        input.signature = signature.clone();
    }

    let txid = tx.txid();
    let contract_id = blake2b_256_personal(b"BlklCntr", &txid);
    let raw = bincode::serialize(&tx).map_err(|_| JsError::new("serialize failed"))?;
    Ok(serde_json::json!({
        "txid": hexs(&txid),
        "contractId": hexs(&contract_id),
        "raw": hexs(&raw),
        "fee": fee,
    })
    .to_string())
}

/// Emit the BLOCK-20 assembly for a token with metadata + supply baked in.
/// (Mirrors the conformance-tested builder in the chain crate.)
fn block20_asm(name: &str, symbol: &str, decimals: u64, supply: u64) -> String {
    fn return_bytes(label: &str, s: &str, strbuf: u64) -> String {
        let mut out = format!("{label}:\n");
        for (i, b) in s.bytes().enumerate() {
            out += &format!("  PUSH {}\n  PUSH8 {}\n  MSTORE8\n", strbuf + i as u64, b);
        }
        out += &format!("  PUSH {strbuf}\n  PUSH8 {}\n  RETURN\n", s.len());
        out
    }
    fn return_u64(label: &str, v: u64, scratch: u64) -> String {
        format!("{label}:\n  PUSH {scratch}\n  PUSH {v}\n  MSTORE64\n  PUSH {scratch}\n  PUSH8 8\n  RETURN\n")
    }
    let (sel, keya, val, hbuf, amt, nf, nt, one, flag, fixed, strbuf) =
        (0x00u64, 0x40u64, 0x80u64, 0xC0u64, 0x100u64, 0xA0u64, 0xB0u64, 0xA8u64, 0x90u64, 0x240u64, 0x300u64);
    let mut a = String::new();
    a += &format!("  PUSH {sel}\n  PUSH8 0\n  PUSH8 1\n  CALLDATACOPY\n  PUSH {sel}\n  MLOAD8\n");
    for (s, label) in [
        (0u64, "fn_init"), (1, "fn_balanceOf"), (2, "fn_transfer"),
        (3, "fn_totalSupply"), (4, "fn_decimals"), (5, "fn_name"), (6, "fn_symbol"),
    ] {
        a += &format!("  DUP 0\n  PUSH8 {s}\n  EQ\n  PUSH @{label}\n  JUMPI\n");
    }
    a += "  PUSH @revert\n  JUMP\n";
    let build_bal_key = format!(
        "  PUSH {hbuf}\n  PUSH8 1\n  MSTORE8\n  PUSH {hbuf}\n  PUSH8 33\n  PUSH {keya}\n  BLAKE2B\n");
    a += "fn_init:\n";
    a += &format!("  PUSH {fixed}\n  PUSH8 7\n  MSTORE8\n");
    a += &format!("  PUSH {flag}\n  PUSH8 0\n  MSTORE64\n");
    a += &format!("  PUSH {fixed}\n  PUSH {flag}\n  SLOAD\n  POP\n");
    a += &format!("  PUSH {flag}\n  MLOAD64\n  PUSH @revert\n  JUMPI\n");
    a += &format!("  PUSH {}\n  CALLER\n", hbuf + 1);
    a += &build_bal_key;
    a += &format!("  PUSH {val}\n  PUSH {supply}\n  MSTORE64\n");
    a += &format!("  PUSH {keya}\n  PUSH {val}\n  PUSH8 8\n  SSTORE\n");
    a += &format!("  PUSH {fixed}\n  PUSH8 7\n  MSTORE8\n");
    a += &format!("  PUSH {flag}\n  PUSH8 1\n  MSTORE64\n");
    a += &format!("  PUSH {fixed}\n  PUSH {flag}\n  PUSH8 8\n  SSTORE\n");
    a += &format!("  PUSH {one}\n  PUSH8 1\n  MSTORE64\n  PUSH {one}\n  PUSH8 8\n  RETURN\n");
    a += "fn_balanceOf:\n";
    a += &format!("  PUSH {}\n  PUSH8 1\n  PUSH8 32\n  CALLDATACOPY\n", hbuf + 1);
    a += &build_bal_key;
    a += &format!("  PUSH {val}\n  PUSH8 0\n  MSTORE64\n");
    a += &format!("  PUSH {keya}\n  PUSH {val}\n  SLOAD\n  POP\n");
    a += &format!("  PUSH {val}\n  PUSH8 8\n  RETURN\n");
    a += "fn_transfer:\n";
    a += &format!("  PUSH {amt}\n  PUSH8 33\n  PUSH8 8\n  CALLDATACOPY\n");
    a += &format!("  PUSH {}\n  CALLER\n", hbuf + 1);
    a += &build_bal_key;
    a += &format!("  PUSH {val}\n  PUSH8 0\n  MSTORE64\n");
    a += &format!("  PUSH {keya}\n  PUSH {val}\n  SLOAD\n  POP\n");
    a += &format!("  PUSH {val}\n  MLOAD64\n  PUSH {amt}\n  MLOAD64\n  LT\n  PUSH @revert\n  JUMPI\n");
    a += &format!("  PUSH {val}\n  MLOAD64\n  PUSH {amt}\n  MLOAD64\n  SUB\n");
    a += &format!("  PUSH {nf}\n  SWAP 1\n  MSTORE64\n");
    a += &format!("  PUSH {keya}\n  PUSH {nf}\n  PUSH8 8\n  SSTORE\n");
    a += &format!("  PUSH {}\n  PUSH8 1\n  PUSH8 32\n  CALLDATACOPY\n", hbuf + 1);
    a += &build_bal_key;
    a += &format!("  PUSH {nt}\n  PUSH8 0\n  MSTORE64\n");
    a += &format!("  PUSH {keya}\n  PUSH {nt}\n  SLOAD\n  POP\n");
    a += &format!("  PUSH {nt}\n  MLOAD64\n  PUSH {amt}\n  MLOAD64\n  ADD\n");
    a += &format!("  PUSH {nt}\n  SWAP 1\n  MSTORE64\n");
    a += &format!("  PUSH {keya}\n  PUSH {nt}\n  PUSH8 8\n  SSTORE\n");
    a += &format!("  PUSH {one}\n  PUSH8 1\n  MSTORE64\n  PUSH {one}\n  PUSH8 8\n  RETURN\n");
    a += &return_u64("fn_totalSupply", supply, val);
    a += &return_u64("fn_decimals", decimals, val);
    a += &return_bytes("fn_name", name, strbuf);
    a += &return_bytes("fn_symbol", symbol, strbuf);
    a += "revert:\n  PUSH8 0\n  PUSH8 0\n  REVERT\n";
    a
}

/// Build BLOCK-20 token bytecode (hex) for the given metadata + supply.
#[wasm_bindgen]
pub fn build_block20_token(name: &str, symbol: &str, decimals: u64, supply: u64) -> Result<String, JsError> {
    let code = blockle_vm::asm::assemble(&block20_asm(name, symbol, decimals, supply))
        .map_err(|e| JsError::new(&format!("asm error: {e:?}")))?;
    Ok(hexs(&code))
}

/// Build a signed contract-call transaction (ContractAction::Call). Used for
/// init(), transfer(), and any BLOCK-20/contract method. `value` moves into
/// the contract; fee = gas_limit * gas_price. Inputs must cover value + fee.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn build_call(
    secret_hex: &str,
    public_hex: &str,
    utxos_json: &str,
    contract_hex: &str,
    input_hex: &str,
    value: u64,
    gas_limit: u64,
    gas_price: u64,
) -> Result<String, JsError> {
    let kp = load_kp(secret_hex, public_hex)?;
    let contract_bytes = hex::decode(contract_hex).map_err(|_| JsError::new("bad contract hex"))?;
    let contract: [u8; 32] = contract_bytes.as_slice().try_into().map_err(|_| JsError::new("contract id len"))?;
    let input = hex::decode(input_hex).map_err(|_| JsError::new("bad input hex"))?;
    let utxos: Vec<Utxo> = serde_json::from_str(utxos_json).map_err(|_| JsError::new("bad utxos json"))?;
    let fee = gas_limit.checked_mul(gas_price).ok_or_else(|| JsError::new("gas overflow"))?;
    let need = fee.checked_add(value).ok_or_else(|| JsError::new("amount overflow"))?;

    let mut selected: Vec<OutPoint> = Vec::new();
    let mut total: u64 = 0;
    for u in &utxos {
        let bytes = hex::decode(&u.txid).map_err(|_| JsError::new("bad utxo txid hex"))?;
        let txid: [u8; 32] = bytes.as_slice().try_into().map_err(|_| JsError::new("utxo txid len"))?;
        selected.push(OutPoint { txid, vout: u.vout });
        total = total.saturating_add(u.amount);
        if total >= need {
            break;
        }
    }
    if total < need {
        return Err(JsError::new("insufficient funds for value + gas fee"));
    }
    let mut outputs = Vec::new();
    let change = total - need;
    if change > 0 {
        outputs.push(TxOutput { recipient: kp.address(), amount: change });
    }
    let mut tx = Transaction {
        version: 1,
        inputs: selected.iter()
            .map(|op| TxInput { prev: *op, pubkey: kp.public_bytes(), signature: vec![] })
            .collect(),
        outputs,
        coinbase_data: vec![],
        shielded: None,
        contract: Some(ContractAction::Call { contract, input, value, gas_limit }),
    };
    let sighash = tx.sighash();
    let signature = kp.sign(&sighash);
    for inp in &mut tx.inputs {
        inp.signature = signature.clone();
    }
    let txid = tx.txid();
    let raw = bincode::serialize(&tx).map_err(|_| JsError::new("serialize failed"))?;
    Ok(serde_json::json!({ "txid": hexs(&txid), "raw": hexs(&raw), "fee": fee }).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn block20_builder_assembles() {
        let hex = build_block20_token("Blockle Meme", "MEME", 8, 1_000_000).unwrap();
        assert!(!hex.is_empty() && hex.len() % 2 == 0);
    }
    #[test]
    fn keygen_address_sign_verify_roundtrip() {
        let kp = serde_json::from_str::<serde_json::Value>(&keygen()).unwrap();
        let (sk, pk, addr) = (
            kp["secretKey"].as_str().unwrap().to_string(),
            kp["publicKey"].as_str().unwrap().to_string(),
            kp["address"].as_str().unwrap().to_string(),
        );
        assert!(addr.starts_with("block1"));
        assert_eq!(address_from_pubkey(&pk).unwrap(), addr);
        let sig = serde_json::from_str::<serde_json::Value>(&sign_message(&sk, &pk, "hello").unwrap()).unwrap();
        assert!(verify(&pk, "hello", sig["signature"].as_str().unwrap()));
        assert!(!verify(&pk, "tampered", sig["signature"].as_str().unwrap()));
    }
}

#[cfg(test)]
mod studio_tests {
    use super::*;
#[test]
fn examples_compile() {
    let examples = [
        ("Adder", "contract Adder {\n  fn add(a: u64, b: u64) -> u64 {\n    return a + b\n  }\n}"),
        ("Counter", "contract Counter {\n  state count: u64\n  fn add(amount: u64) -> u64 {\n    count = count + amount\n    return count\n  }\n  fn get() -> u64 {\n    return count\n  }\n}"),
        ("PiggyBank", "contract PiggyBank {\n  state total: u64\n  fn deposit() -> u64 {\n    total = total + value()\n    return total\n  }\n  fn withdraw(amount: u64) -> u64 {\n    require(amount <= total)\n    total = total - amount\n    send_caller(amount)\n    return total\n  }\n}"),
        ("Faucet", "contract Faucet {\n  state drip: u64\n  fn configure(amount: u64) -> u64 {\n    drip = amount\n    return drip\n  }\n  fn claim() -> u64 {\n    require(balance() >= drip)\n    send_caller(drip)\n    log(drip)\n    return balance()\n  }\n}"),
    ];
    for (name, src) in examples {
        let r: serde_json::Value = serde_json::from_str(&compile_script(src)).unwrap();
        assert!(r["ok"].as_bool().unwrap(), "{name} failed: {}", r["error"]);
        eprintln!("{name}: ok, {} bytes", r["size"]);
    }
}

    #[test]
    fn compile_and_simulate_counter() {
        let src = "contract Counter {\n  state count: u64\n  fn add(amount: u64) -> u64 {\n    count = count + amount\n    return count\n  }\n}";
        let c: serde_json::Value = serde_json::from_str(&compile_script(src)).unwrap();
        assert!(c["ok"].as_bool().unwrap(), "compile failed: {c}");
        let bc = c["bytecode"].as_str().unwrap();
        // call add(5) then add(3): calldata = [fnIdx] ++ LE(arg)
        let call = |idx: u8, arg: u64| {
            let mut d = vec![idx];
            d.extend_from_slice(&arg.to_le_bytes());
            hex::encode(d)
        };
        let calls = serde_json::json!([
            {"calldata": call(0,5), "value":0, "height":0},
            {"calldata": call(0,3), "value":0, "height":0}
        ]).to_string();
        let r: serde_json::Value = serde_json::from_str(&simulate(bc, &calls, 0)).unwrap();
        let last = &r["results"][1];
        assert_eq!(last["u64"].as_u64().unwrap(), 8, "counter should be 8: {r}");
    }
}
