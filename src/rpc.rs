//! JSON-RPC 1.0/2.0 client (bitcoind dialect) over plain HTTP.

use std::time::Duration;

use anyhow::{anyhow, Result};
use serde_json::{json, Value};

use crate::http;

#[derive(Clone)]
pub struct RpcClient {
    pub url: String,
    pub timeout: Duration,
}

/// Outcome of a single RPC call, distinguishing "method missing" from other
/// failures — the prober cares about the difference.
#[derive(Debug)]
pub enum RpcOutcome {
    Ok(Value),
    MethodNotFound,
    Error(String),
}

impl RpcClient {
    pub fn new(url: &str) -> Self {
        RpcClient { url: url.to_string(), timeout: Duration::from_secs(5) }
    }

    pub fn call(&self, method: &str, params: Value) -> RpcOutcome {
        let body = json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params});
        let raw = match http::post(
            &self.url,
            "application/json",
            body.to_string().as_bytes(),
            self.timeout,
        ) {
            Ok(r) => r,
            Err(e) => return RpcOutcome::Error(e.to_string()),
        };
        let parsed: Value = match serde_json::from_slice(&raw) {
            Ok(v) => v,
            Err(e) => return RpcOutcome::Error(format!("bad JSON response: {e}")),
        };
        if let Some(err) = parsed.get("error").filter(|e| !e.is_null()) {
            let code = err.get("code").and_then(|c| c.as_i64()).unwrap_or(0);
            let msg = err
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("unknown error")
                .to_string();
            // -32601 is the JSON-RPC standard "method not found".
            if code == -32601 || msg.to_lowercase().contains("method not found") {
                return RpcOutcome::MethodNotFound;
            }
            return RpcOutcome::Error(msg);
        }
        RpcOutcome::Ok(parsed.get("result").cloned().unwrap_or(Value::Null))
    }

    /// Call a method that must succeed.
    pub fn require(&self, method: &str, params: Value) -> Result<Value> {
        match self.call(method, params) {
            RpcOutcome::Ok(v) => Ok(v),
            RpcOutcome::MethodNotFound => Err(anyhow!("{method}: method not found")),
            RpcOutcome::Error(e) => Err(anyhow!("{method}: {e}")),
        }
    }
}
