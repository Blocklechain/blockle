//! BLOCK amounts. The base unit is 1e-8 BLOCK (like a satoshi).

use thiserror::Error;

/// Base units per BLOCK.
pub const COIN: u64 = 100_000_000;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum AmountError {
    #[error("invalid amount: {0}")]
    Invalid(String),
}

/// Parse a decimal BLOCK amount ("1", "0.5", "12.34567890") into base units.
pub fn parse_amount(s: &str) -> Result<u64, AmountError> {
    let err = || AmountError::Invalid(s.to_string());
    let s = s.trim();
    if s.is_empty() || s.starts_with('-') || s.starts_with('+') {
        return Err(err());
    }
    let (whole, frac) = match s.split_once('.') {
        Some((w, f)) => (w, f),
        None => (s, ""),
    };
    if whole.is_empty() && frac.is_empty() {
        return Err(err());
    }
    if frac.len() > 8 || !whole.chars().all(|c| c.is_ascii_digit()) || !frac.chars().all(|c| c.is_ascii_digit()) {
        return Err(err());
    }
    let whole: u64 = if whole.is_empty() { 0 } else { whole.parse().map_err(|_| err())? };
    let frac_units: u64 = if frac.is_empty() {
        0
    } else {
        let padded = format!("{frac:0<8}");
        padded.parse().map_err(|_| err())?
    };
    whole
        .checked_mul(COIN)
        .and_then(|v| v.checked_add(frac_units))
        .ok_or_else(err)
}

/// Format base units as a decimal BLOCK string.
pub fn format_amount(units: u64) -> String {
    let whole = units / COIN;
    let frac = units % COIN;
    if frac == 0 {
        format!("{whole}")
    } else {
        let s = format!("{frac:08}");
        format!("{whole}.{}", s.trim_end_matches('0'))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_and_format() {
        assert_eq!(parse_amount("1").unwrap(), COIN);
        assert_eq!(parse_amount("0.5").unwrap(), COIN / 2);
        assert_eq!(parse_amount("50").unwrap(), 50 * COIN);
        assert_eq!(parse_amount("0.00000001").unwrap(), 1);
        assert_eq!(parse_amount("210000").unwrap(), 210_000 * COIN);
        assert!(parse_amount("-1").is_err());
        assert!(parse_amount("1.123456789").is_err());
        assert!(parse_amount("abc").is_err());
        assert!(parse_amount("").is_err());

        assert_eq!(format_amount(COIN), "1");
        assert_eq!(format_amount(COIN / 2), "0.5");
        assert_eq!(format_amount(1), "0.00000001");
        assert_eq!(parse_amount(&format_amount(123_456_789)).unwrap(), 123_456_789);
    }
}
