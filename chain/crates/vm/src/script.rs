//! Blockle Script — a small, safe contract language compiling to Blockle VM
//! assembly.
//!
//! ```text
//! contract Counter {
//!     state count: u64
//!
//!     fn add(amount: u64) -> u64 {
//!         require(amount > 0)
//!         count = count + amount
//!         return count
//!     }
//! }
//! ```
//!
//! Semantics:
//! - All values are `u64` (wrapping arithmetic, like the VM).
//! - `state` variables live in contract storage (slot i → key `[i,0,…]`).
//! - Functions dispatch on calldata byte 0 (declaration order); arguments
//!   are LE u64s at offsets `1 + 8·i`. Empty calldata calls function 0 with
//!   zeroed arguments.
//! - Builtins: `value()`, `height()`, `balance()` (expressions);
//!   `send_caller(amount)`, `log(x)` (statements); `require(cond)` reverts
//!   on failure.
//! - `&&`/`||` are non-short-circuiting boolean ops; `!` is boolean not.

use std::collections::HashMap;
use std::fmt::Write as _;

use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ScriptError {
    #[error("line {0}: {1}")]
    Parse(usize, String),
    #[error("line {0}: unknown identifier {1:?}")]
    UnknownIdent(usize, String),
    #[error("line {0}: duplicate definition of {1:?}")]
    Duplicate(usize, String),
    #[error("too many {0}")]
    TooMany(&'static str),
}

// LEXER
// ================================================================================================

#[derive(Clone, Debug, PartialEq, Eq)]
enum Tok {
    Ident(String),
    Num(u64),
    Sym(&'static str),
}

struct Lexer {
    toks: Vec<(Tok, usize)>, // token + line number
    pos: usize,
}

const SYMBOLS: &[&str] = &[
    "->", "==", "!=", "<=", ">=", "&&", "||", "<<", ">>", "{", "}", "(", ")", ":", ",", "=",
    "+", "-", "*", "/", "%", "<", ">", "!", "&", "|", "^",
];

fn lex(src: &str) -> Result<Vec<(Tok, usize)>, ScriptError> {
    let mut toks = Vec::new();
    for (lineno, raw) in src.lines().enumerate() {
        let lineno = lineno + 1;
        let line = raw.split("//").next().unwrap_or("");
        let bytes = line.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            let c = bytes[i] as char;
            if c.is_whitespace() {
                i += 1;
                continue;
            }
            if c.is_ascii_alphabetic() || c == '_' {
                let start = i;
                while i < bytes.len()
                    && ((bytes[i] as char).is_ascii_alphanumeric() || bytes[i] == b'_')
                {
                    i += 1;
                }
                toks.push((Tok::Ident(line[start..i].to_string()), lineno));
                continue;
            }
            if c.is_ascii_digit() {
                let start = i;
                while i < bytes.len()
                    && ((bytes[i] as char).is_ascii_alphanumeric() || bytes[i] == b'_')
                {
                    i += 1;
                }
                let text = line[start..i].replace('_', "");
                let v = if let Some(hex) = text.strip_prefix("0x") {
                    u64::from_str_radix(hex, 16)
                } else {
                    text.parse()
                }
                .map_err(|_| ScriptError::Parse(lineno, format!("bad number {text:?}")))?;
                toks.push((Tok::Num(v), lineno));
                continue;
            }
            let rest = &line[i..];
            let sym = SYMBOLS.iter().find(|s| rest.starts_with(**s));
            match sym {
                Some(s) => {
                    toks.push((Tok::Sym(s), lineno));
                    i += s.len();
                }
                None => {
                    return Err(ScriptError::Parse(lineno, format!("unexpected character {c:?}")))
                }
            }
        }
    }
    Ok(toks)
}

// AST
// ================================================================================================

enum Expr {
    Num(u64),
    Var(String, usize),
    Call(String, Vec<Expr>, usize),
    Unary(&'static str, Box<Expr>),
    Binary(&'static str, Box<Expr>, Box<Expr>),
}

enum Stmt {
    Let(String, Expr, usize),
    Assign(String, Expr, usize),
    Return(Option<Expr>),
    Require(Expr),
    If(Expr, Vec<Stmt>, Vec<Stmt>),
    While(Expr, Vec<Stmt>),
    CallStmt(String, Vec<Expr>, usize),
}

struct Function {
    name: String,
    params: Vec<String>,
    body: Vec<Stmt>,
}

struct Contract {
    states: Vec<String>,
    functions: Vec<Function>,
}

// PARSER
// ================================================================================================

impl Lexer {
    fn peek(&self) -> Option<&Tok> {
        self.toks.get(self.pos).map(|(t, _)| t)
    }

    fn line(&self) -> usize {
        self.toks
            .get(self.pos.min(self.toks.len().saturating_sub(1)))
            .map(|(_, l)| *l)
            .unwrap_or(0)
    }

    fn next(&mut self) -> Option<Tok> {
        let t = self.toks.get(self.pos).map(|(t, _)| t.clone());
        self.pos += 1;
        t
    }

    fn expect_sym(&mut self, s: &str) -> Result<(), ScriptError> {
        let line = self.line();
        match self.next() {
            Some(Tok::Sym(t)) if t == s => Ok(()),
            other => Err(ScriptError::Parse(line, format!("expected {s:?}, got {other:?}"))),
        }
    }

    fn expect_ident(&mut self) -> Result<String, ScriptError> {
        let line = self.line();
        match self.next() {
            Some(Tok::Ident(s)) => Ok(s),
            other => Err(ScriptError::Parse(line, format!("expected identifier, got {other:?}"))),
        }
    }

    fn expect_kw(&mut self, kw: &str) -> Result<(), ScriptError> {
        let line = self.line();
        match self.next() {
            Some(Tok::Ident(s)) if s == kw => Ok(()),
            other => Err(ScriptError::Parse(line, format!("expected {kw:?}, got {other:?}"))),
        }
    }

    fn eat_sym(&mut self, s: &str) -> bool {
        match self.peek() {
            Some(Tok::Sym(t)) if *t == s => {
                self.pos += 1;
                true
            }
            _ => false,
        }
    }
}

fn parse(src: &str) -> Result<Contract, ScriptError> {
    let mut lx = Lexer { toks: lex(src)?, pos: 0 };
    lx.expect_kw("contract")?;
    let _name = lx.expect_ident()?;
    lx.expect_sym("{")?;

    let mut states = Vec::new();
    let mut functions = Vec::new();
    loop {
        let line = lx.line();
        match lx.next() {
            Some(Tok::Sym("}")) => break,
            Some(Tok::Ident(kw)) if kw == "state" => {
                let name = lx.expect_ident()?;
                lx.expect_sym(":")?;
                lx.expect_kw("u64")?;
                if states.contains(&name) {
                    return Err(ScriptError::Duplicate(line, name));
                }
                states.push(name);
            }
            Some(Tok::Ident(kw)) if kw == "fn" => {
                let name = lx.expect_ident()?;
                lx.expect_sym("(")?;
                let mut params = Vec::new();
                if !lx.eat_sym(")") {
                    loop {
                        let p = lx.expect_ident()?;
                        lx.expect_sym(":")?;
                        lx.expect_kw("u64")?;
                        params.push(p);
                        if lx.eat_sym(")") {
                            break;
                        }
                        lx.expect_sym(",")?;
                    }
                }
                if lx.eat_sym("->") {
                    lx.expect_kw("u64")?;
                }
                let body = parse_block(&mut lx)?;
                if functions.iter().any(|f: &Function| f.name == name) {
                    return Err(ScriptError::Duplicate(line, name));
                }
                functions.push(Function { name, params, body });
            }
            other => {
                return Err(ScriptError::Parse(
                    line,
                    format!("expected `state`, `fn`, or `}}`, got {other:?}"),
                ))
            }
        }
    }
    if functions.is_empty() {
        return Err(ScriptError::Parse(0, "contract has no functions".into()));
    }
    if functions.len() > 255 {
        return Err(ScriptError::TooMany("functions"));
    }
    Ok(Contract { states, functions })
}

fn parse_block(lx: &mut Lexer) -> Result<Vec<Stmt>, ScriptError> {
    lx.expect_sym("{")?;
    let mut stmts = Vec::new();
    loop {
        if lx.eat_sym("}") {
            return Ok(stmts);
        }
        stmts.push(parse_stmt(lx)?);
    }
}

fn parse_stmt(lx: &mut Lexer) -> Result<Stmt, ScriptError> {
    let line = lx.line();
    match lx.peek() {
        Some(Tok::Ident(kw)) if kw == "let" => {
            lx.next();
            let name = lx.expect_ident()?;
            lx.expect_sym("=")?;
            Ok(Stmt::Let(name, parse_expr(lx)?, line))
        }
        Some(Tok::Ident(kw)) if kw == "return" => {
            lx.next();
            // `return` with no value: next token starts a new statement/block end
            match lx.peek() {
                Some(Tok::Sym("}")) => Ok(Stmt::Return(None)),
                _ => Ok(Stmt::Return(Some(parse_expr(lx)?))),
            }
        }
        Some(Tok::Ident(kw)) if kw == "require" => {
            lx.next();
            lx.expect_sym("(")?;
            let e = parse_expr(lx)?;
            lx.expect_sym(")")?;
            Ok(Stmt::Require(e))
        }
        Some(Tok::Ident(kw)) if kw == "if" => {
            lx.next();
            let cond = parse_expr(lx)?;
            let then = parse_block(lx)?;
            let els = if matches!(lx.peek(), Some(Tok::Ident(k)) if k == "else") {
                lx.next();
                parse_block(lx)?
            } else {
                Vec::new()
            };
            Ok(Stmt::If(cond, then, els))
        }
        Some(Tok::Ident(kw)) if kw == "while" => {
            lx.next();
            let cond = parse_expr(lx)?;
            let body = parse_block(lx)?;
            Ok(Stmt::While(cond, body))
        }
        Some(Tok::Ident(_)) => {
            let name = lx.expect_ident()?;
            if lx.eat_sym("=") {
                Ok(Stmt::Assign(name, parse_expr(lx)?, line))
            } else if lx.eat_sym("(") {
                let mut args = Vec::new();
                if !lx.eat_sym(")") {
                    loop {
                        args.push(parse_expr(lx)?);
                        if lx.eat_sym(")") {
                            break;
                        }
                        lx.expect_sym(",")?;
                    }
                }
                Ok(Stmt::CallStmt(name, args, line))
            } else {
                Err(ScriptError::Parse(line, format!("expected `=` or `(` after {name:?}")))
            }
        }
        other => Err(ScriptError::Parse(line, format!("unexpected {other:?}"))),
    }
}

/// Precedence-climbing expression parser.
fn parse_expr(lx: &mut Lexer) -> Result<Expr, ScriptError> {
    parse_bin(lx, 0)
}

const PRECEDENCE: &[&[&str]] = &[
    &["||"],
    &["&&"],
    &["|"],
    &["^"],
    &["&"],
    &["==", "!=", "<", ">", "<=", ">="],
    &["<<", ">>"],
    &["+", "-"],
    &["*", "/", "%"],
];

fn parse_bin(lx: &mut Lexer, level: usize) -> Result<Expr, ScriptError> {
    if level >= PRECEDENCE.len() {
        return parse_unary(lx);
    }
    let mut left = parse_bin(lx, level + 1)?;
    loop {
        let op = match lx.peek() {
            Some(Tok::Sym(s)) if PRECEDENCE[level].contains(s) => *s,
            _ => return Ok(left),
        };
        lx.next();
        let right = parse_bin(lx, level + 1)?;
        left = Expr::Binary(op, Box::new(left), Box::new(right));
    }
}

fn parse_unary(lx: &mut Lexer) -> Result<Expr, ScriptError> {
    if lx.eat_sym("!") {
        return Ok(Expr::Unary("!", Box::new(parse_unary(lx)?)));
    }
    let line = lx.line();
    match lx.next() {
        Some(Tok::Num(v)) => Ok(Expr::Num(v)),
        Some(Tok::Sym("(")) => {
            let e = parse_expr(lx)?;
            lx.expect_sym(")")?;
            Ok(e)
        }
        Some(Tok::Ident(name)) => {
            if lx.eat_sym("(") {
                let mut args = Vec::new();
                if !lx.eat_sym(")") {
                    loop {
                        args.push(parse_expr(lx)?);
                        if lx.eat_sym(")") {
                            break;
                        }
                        lx.expect_sym(",")?;
                    }
                }
                Ok(Expr::Call(name, args, line))
            } else {
                Ok(Expr::Var(name, line))
            }
        }
        other => Err(ScriptError::Parse(line, format!("unexpected {other:?}"))),
    }
}

// CODEGEN
// ================================================================================================

const KEY_SCRATCH: u64 = 0x100; // 32-byte storage key
const CALLER_SCRATCH: u64 = 0x140;
const VALUE_SCRATCH: u64 = 0x180; // storage/return value
const LOG_SCRATCH: u64 = 0x188;
const SELECTOR_SCRATCH: u64 = 0x1f0;
const LOCALS_BASE: u64 = 0x200;

struct Codegen {
    out: String,
    states: HashMap<String, usize>,
    locals: HashMap<String, usize>,
    next_label: usize,
}

impl Codegen {
    fn emit(&mut self, line: &str) {
        let _ = writeln!(self.out, "    {line}");
    }

    fn label(&mut self, prefix: &str) -> String {
        self.next_label += 1;
        format!("{}_{}", prefix, self.next_label)
    }

    fn place_label(&mut self, name: &str) {
        let _ = writeln!(self.out, "{name}:");
    }

    fn local_addr(&self, slot: usize) -> u64 {
        LOCALS_BASE + 8 * slot as u64
    }

    /// Leave the state variable's current value on the stack.
    fn gen_state_read(&mut self, slot: usize) {
        self.emit(&format!("PUSH {VALUE_SCRATCH}"));
        self.emit("PUSH 0");
        self.emit("MSTORE64");
        self.emit(&format!("PUSH {KEY_SCRATCH}"));
        self.emit(&format!("PUSH {slot}"));
        self.emit("MSTORE8");
        self.emit(&format!("PUSH {KEY_SCRATCH}"));
        self.emit(&format!("PUSH {VALUE_SCRATCH}"));
        self.emit("SLOAD");
        self.emit("POP");
        self.emit(&format!("PUSH {VALUE_SCRATCH}"));
        self.emit("MLOAD64");
    }

    /// Store the stack top into the state variable.
    fn gen_state_write(&mut self, slot: usize) {
        self.emit(&format!("PUSH {VALUE_SCRATCH}"));
        self.emit("SWAP 1");
        self.emit("MSTORE64");
        self.emit(&format!("PUSH {KEY_SCRATCH}"));
        self.emit(&format!("PUSH {slot}"));
        self.emit("MSTORE8");
        self.emit(&format!("PUSH {KEY_SCRATCH}"));
        self.emit(&format!("PUSH {VALUE_SCRATCH}"));
        self.emit("PUSH 8");
        self.emit("SSTORE");
    }

    fn gen_expr(&mut self, e: &Expr) -> Result<(), ScriptError> {
        match e {
            Expr::Num(v) => self.emit(&format!("PUSH {v}")),
            Expr::Var(name, line) => {
                if let Some(&slot) = self.locals.get(name) {
                    self.emit(&format!("PUSH {}", self.local_addr(slot)));
                    self.emit("MLOAD64");
                } else if let Some(&slot) = self.states.get(name).as_deref() {
                    self.gen_state_read(slot);
                } else {
                    return Err(ScriptError::UnknownIdent(*line, name.clone()));
                }
            }
            Expr::Call(name, args, line) => match (name.as_str(), args.len()) {
                ("value", 0) => self.emit("CALLVALUE"),
                ("height", 0) => self.emit("HEIGHT"),
                ("balance", 0) => self.emit("BALANCE"),
                _ => {
                    return Err(ScriptError::UnknownIdent(
                        *line,
                        format!("{name}({} args)", args.len()),
                    ))
                }
            },
            Expr::Unary("!", inner) => {
                self.gen_expr(inner)?;
                self.emit("ISZERO");
            }
            Expr::Unary(op, _) => unreachable!("unary {op}"),
            Expr::Binary(op, a, b) => {
                self.gen_expr(a)?;
                if matches!(*op, "&&" | "||") {
                    self.emit("ISZERO");
                    self.emit("ISZERO");
                }
                self.gen_expr(b)?;
                if matches!(*op, "&&" | "||") {
                    self.emit("ISZERO");
                    self.emit("ISZERO");
                }
                match *op {
                    "+" => self.emit("ADD"),
                    "-" => self.emit("SUB"),
                    "*" => self.emit("MUL"),
                    "/" => self.emit("DIV"),
                    "%" => self.emit("MOD"),
                    "&" => self.emit("AND"),
                    "|" | "||" => self.emit("OR"),
                    "^" => self.emit("XOR"),
                    "&&" => self.emit("AND"),
                    "<<" => self.emit("SHL"),
                    ">>" => self.emit("SHR"),
                    "==" => self.emit("EQ"),
                    "<" => self.emit("LT"),
                    ">" => self.emit("GT"),
                    "!=" => {
                        self.emit("EQ");
                        self.emit("ISZERO");
                    }
                    "<=" => {
                        self.emit("GT");
                        self.emit("ISZERO");
                    }
                    ">=" => {
                        self.emit("LT");
                        self.emit("ISZERO");
                    }
                    other => unreachable!("binary {other}"),
                }
            }
        }
        Ok(())
    }

    fn gen_stmts(&mut self, stmts: &[Stmt]) -> Result<(), ScriptError> {
        for stmt in stmts {
            self.gen_stmt(stmt)?;
        }
        Ok(())
    }

    fn gen_stmt(&mut self, stmt: &Stmt) -> Result<(), ScriptError> {
        match stmt {
            Stmt::Let(name, e, line) => {
                if self.locals.contains_key(name) || self.states.contains_key(name) {
                    return Err(ScriptError::Duplicate(*line, name.clone()));
                }
                let slot = self.locals.len();
                if slot >= 256 {
                    return Err(ScriptError::TooMany("locals"));
                }
                self.gen_expr(e)?;
                self.locals.insert(name.clone(), slot);
                self.emit(&format!("PUSH {}", self.local_addr(slot)));
                self.emit("SWAP 1");
                self.emit("MSTORE64");
            }
            Stmt::Assign(name, e, line) => {
                self.gen_expr(e)?;
                if let Some(&slot) = self.locals.get(name) {
                    self.emit(&format!("PUSH {}", self.local_addr(slot)));
                    self.emit("SWAP 1");
                    self.emit("MSTORE64");
                } else if let Some(&slot) = self.states.get(name).as_deref() {
                    self.gen_state_write(slot);
                } else {
                    return Err(ScriptError::UnknownIdent(*line, name.clone()));
                }
            }
            Stmt::Return(Some(e)) => {
                self.gen_expr(e)?;
                self.emit(&format!("PUSH {VALUE_SCRATCH}"));
                self.emit("SWAP 1");
                self.emit("MSTORE64");
                self.emit(&format!("PUSH {VALUE_SCRATCH}"));
                self.emit("PUSH 8");
                self.emit("RETURN");
            }
            Stmt::Return(None) => self.emit("STOP"),
            Stmt::Require(e) => {
                self.gen_expr(e)?;
                self.emit("ISZERO");
                self.emit("PUSH @__revert");
                self.emit("JUMPI");
            }
            Stmt::If(cond, then, els) => {
                let else_label = self.label("else");
                let end_label = self.label("endif");
                self.gen_expr(cond)?;
                self.emit("ISZERO");
                self.emit(&format!("PUSH @{else_label}"));
                self.emit("JUMPI");
                self.gen_stmts(then)?;
                self.emit(&format!("PUSH @{end_label}"));
                self.emit("JUMP");
                self.place_label(&else_label);
                self.gen_stmts(els)?;
                self.place_label(&end_label);
            }
            Stmt::While(cond, body) => {
                let start = self.label("loop");
                let end = self.label("endloop");
                self.place_label(&start);
                self.gen_expr(cond)?;
                self.emit("ISZERO");
                self.emit(&format!("PUSH @{end}"));
                self.emit("JUMPI");
                self.gen_stmts(body)?;
                self.emit(&format!("PUSH @{start}"));
                self.emit("JUMP");
                self.place_label(&end);
            }
            Stmt::CallStmt(name, args, line) => match (name.as_str(), args.len()) {
                ("send_caller", 1) => {
                    self.gen_expr(&args[0])?;
                    self.emit(&format!("PUSH {CALLER_SCRATCH}"));
                    self.emit("CALLER");
                    self.emit(&format!("PUSH {CALLER_SCRATCH}"));
                    self.emit("SWAP 1");
                    self.emit("SEND");
                }
                ("log", 1) => {
                    self.gen_expr(&args[0])?;
                    self.emit(&format!("PUSH {LOG_SCRATCH}"));
                    self.emit("SWAP 1");
                    self.emit("MSTORE64");
                    self.emit(&format!("PUSH {LOG_SCRATCH}"));
                    self.emit("PUSH 8");
                    self.emit("LOG");
                }
                _ => {
                    return Err(ScriptError::UnknownIdent(
                        *line,
                        format!("{name}({} args)", args.len()),
                    ))
                }
            },
        }
        Ok(())
    }
}

/// Compile Blockle Script source into Blockle VM assembly text.
pub fn compile_to_asm(src: &str) -> Result<String, ScriptError> {
    let contract = parse(src)?;
    let mut cg = Codegen {
        out: String::new(),
        states: contract
            .states
            .iter()
            .enumerate()
            .map(|(i, s)| (s.clone(), i))
            .collect(),
        locals: HashMap::new(),
        next_label: 0,
    };
    if cg.states.len() > 255 {
        return Err(ScriptError::TooMany("state variables"));
    }

    // Dispatcher: selector = calldata[0] (0 when calldata is empty).
    cg.emit(&format!("PUSH {SELECTOR_SCRATCH}"));
    cg.emit("PUSH 0");
    cg.emit("PUSH 1");
    cg.emit("CALLDATACOPY");
    cg.emit(&format!("PUSH {SELECTOR_SCRATCH}"));
    cg.emit("MLOAD8");
    for (i, f) in contract.functions.iter().enumerate() {
        cg.emit("DUP 0");
        cg.emit(&format!("PUSH {i}"));
        cg.emit("EQ");
        cg.emit(&format!("PUSH @fn_{}", f.name));
        cg.emit("JUMPI");
    }
    cg.emit("PUSH @__revert");
    cg.emit("JUMP");

    for f in &contract.functions {
        cg.place_label(&format!("fn_{}", f.name));
        cg.emit("POP"); // drop the selector
        cg.locals = f
            .params
            .iter()
            .enumerate()
            .map(|(i, p)| (p.clone(), i))
            .collect();
        for i in 0..f.params.len() {
            let addr = cg.local_addr(i);
            cg.emit(&format!("PUSH {addr}"));
            cg.emit(&format!("PUSH {}", 1 + 8 * i));
            cg.emit("PUSH 8");
            cg.emit("CALLDATACOPY");
        }
        cg.gen_stmts(&f.body)?;
        cg.emit("STOP");
    }

    cg.place_label("__revert");
    cg.emit("PUSH 0");
    cg.emit("PUSH 0");
    cg.emit("REVERT");

    Ok(cg.out)
}

/// Compile Blockle Script straight to bytecode.
pub fn compile(src: &str) -> Result<Vec<u8>, ScriptError> {
    let asm = compile_to_asm(src)?;
    crate::asm::assemble(&asm)
        .map_err(|e| ScriptError::Parse(0, format!("internal codegen error: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::MockHost;
    use crate::{execute, Context, Outcome};

    const COUNTER: &str = "
        contract Counter {
            state count: u64

            fn add(amount: u64) -> u64 {
                require(amount > 0)
                count = count + amount
                return count
            }

            fn get() -> u64 {
                return count
            }
        }
    ";

    fn ctx() -> Context {
        Context { caller: [7; 32], contract: [9; 32], value: 0, height: 1 }
    }

    fn call(code: &[u8], selector: u8, args: &[u64], host: &mut MockHost) -> Option<u64> {
        let mut input = vec![selector];
        for a in args {
            input.extend_from_slice(&a.to_le_bytes());
        }
        let r = execute(code, &input, &ctx(), host, 1_000_000).unwrap();
        match r.outcome {
            Outcome::Return(data) if data.len() == 8 => {
                Some(u64::from_le_bytes(data.try_into().unwrap()))
            }
            Outcome::Return(_) => None,
            Outcome::Revert(_) => panic!("unexpected revert"),
        }
    }

    #[test]
    fn counter_compiles_and_runs() {
        let code = compile(COUNTER).unwrap();
        let mut host = MockHost::default();
        assert_eq!(call(&code, 0, &[5], &mut host), Some(5));
        assert_eq!(call(&code, 0, &[37], &mut host), Some(42));
        assert_eq!(call(&code, 1, &[], &mut host), Some(42));
    }

    #[test]
    fn require_reverts() {
        let code = compile(COUNTER).unwrap();
        let mut host = MockHost::default();
        let input = [0u8, 0, 0, 0, 0, 0, 0, 0, 0]; // add(0)
        let r = execute(&code, &input, &ctx(), &mut host, 1_000_000).unwrap();
        assert!(matches!(r.outcome, Outcome::Revert(_)));
    }

    #[test]
    fn control_flow_and_builtins() {
        let src = "
            contract Math {
                fn sum_to(n: u64) -> u64 {
                    let total = 0
                    let i = 1
                    while i <= n {
                        total = total + i
                        i = i + 1
                    }
                    return total
                }

                fn pick(a: u64, b: u64) -> u64 {
                    if a > b && a != 0 {
                        return a
                    } else {
                        return b
                    }
                }

                fn env() -> u64 {
                    log(height())
                    return height() + balance()
                }
            }
        ";
        let code = compile(src).unwrap();
        let mut host = MockHost::default();
        host.balance = 41;
        assert_eq!(call(&code, 0, &[10], &mut host), Some(55));
        assert_eq!(call(&code, 1, &[9, 4], &mut host), Some(9));
        assert_eq!(call(&code, 1, &[3, 8], &mut host), Some(8));
        assert_eq!(call(&code, 2, &[], &mut host), Some(42));
        assert_eq!(host.logs, vec![1u64.to_le_bytes().to_vec()]);
    }

    #[test]
    fn unknown_selector_reverts() {
        let code = compile(COUNTER).unwrap();
        let mut host = MockHost::default();
        let r = execute(&code, &[9u8], &ctx(), &mut host, 1_000_000).unwrap();
        assert!(matches!(r.outcome, Outcome::Revert(_)));
    }

    #[test]
    fn parse_errors_are_reported() {
        assert!(matches!(
            compile("contract X { fn f() { nope = 1 } }"),
            Err(ScriptError::UnknownIdent(1, _))
        ));
        assert!(matches!(compile("contract X {"), Err(ScriptError::Parse(_, _))));
    }
}
