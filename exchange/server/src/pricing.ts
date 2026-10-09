// Price / amount math in BASE UNITS using BigInt fixed-point — no floats touch
// value. Price is a decimal STRING meaning "quote whole-units per base
// whole-unit". quoteBaseUnits converts a base-asset base-unit amount into the
// corresponding quote-asset base-unit amount, accounting for each asset's
// decimals. Numeric ordering (for the book) is fine to do in Number space; the
// exact settled amounts are computed here with BigInt.

export function parseDecimalRatio(dec: string): { num: bigint; den: bigint } {
  if (!/^\d+(\.\d+)?$/.test(dec)) throw new Error(`invalid price "${dec}"`);
  const [intPart, fracPart = ""] = dec.split(".");
  const num = BigInt(intPart + fracPart);
  const den = 10n ** BigInt(fracPart.length);
  return { num, den };
}

function pow10(n: number): bigint {
  return 10n ** BigInt(n);
}

/**
 * quoteBaseUnits = baseBaseUnits * price * 10^quoteDec / 10^baseDec
 * with price = num/den. Floor division (never over-credits).
 */
export function quoteBaseUnits(
  baseBaseUnits: bigint,
  price: string,
  baseDec: number,
  quoteDec: number,
): bigint {
  const { num, den } = parseDecimalRatio(price);
  const numerator = baseBaseUnits * num * pow10(quoteDec);
  const denominator = den * pow10(baseDec);
  return numerator / denominator;
}

/** Numeric price for book ordering only (never for settled amounts). */
export function priceNum(price: string | null | undefined): number {
  if (price == null) return NaN;
  const n = Number(price);
  return Number.isFinite(n) ? n : NaN;
}

export function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
