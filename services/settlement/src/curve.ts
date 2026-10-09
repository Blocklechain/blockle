// curve.ts — a byte-for-byte mirror of the sell side of web/buy.js.
//
// BLOCK is priced by a rising sqrt primary-sale curve whose price is a pure
// function of the USDC actually raised into the reserve on Base (R, in whole
// USDC):
//
//     price(R) = max(p0, sqrt(p0^2 + 2*k*R))          // p0 = $0.10 floor
//     soldAt(R) = (price(R) - p0) / k                  // BLOCK sold at reserve R
//     reserveForN(n) = p0*n + k*n^2/2                  // USDC to have sold n BLOCK
//     k = 2*(targetUsdc - p0*allocation) / allocation^2
//
// Selling `blockIn` BLOCK walks the curve back down from the current reserve:
//
//     n   = soldAt(R)
//     n2  = max(0, n - blockIn)
//     gross = R - reserveForN(n2)                      // USDC the curve releases
//     fee   = gross * FEE
//     out   = gross * (1 - FEE)                         // USDC proceeds
//
// $0.10 is the TREASURY FLOOR only — it is baked into price(R) via max(p0, …),
// so the effective price can never fall below it on the curve itself. The
// reserve-availability clamp (see settle.ts) is a separate, stricter guard.
//
// These are the SAME float equations the public /buy page quotes, so an agent
// or user gets the identical number here. We keep the curve in whole units
// (USDC, BLOCK) exactly like buy.js; conversion to/from base units happens only
// at the edges in settle.ts.

export interface CurveParams {
  /** $0.10 floor price, USD per BLOCK */
  startPrice: number;
  /** target USDC raised when the whole allocation is sold */
  targetUsdc: number;
  /** BLOCK allocation sold across the curve */
  allocation: number;
  /** fee in basis points (buy.js default 500 = 5%) */
  feeBps: number;
}

export const DEFAULT_CURVE: CurveParams = {
  startPrice: 0.1,
  targetUsdc: 2_000_000,
  allocation: 210_000,
  feeBps: 500,
};

export class Curve {
  readonly p0: number;
  readonly target: number;
  readonly alloc: number;
  readonly fee: number;
  readonly k: number;

  constructor(params: CurveParams = DEFAULT_CURVE) {
    this.p0 = params.startPrice;
    this.target = params.targetUsdc;
    this.alloc = params.allocation;
    this.fee = params.feeBps / 10_000;
    // identical to buy.js: K = 2*(TARGET - P0*ALLOC)/(ALLOC*ALLOC)
    this.k = (2 * (this.target - this.p0 * this.alloc)) / (this.alloc * this.alloc);
  }

  /** Spot price at reserve `r` (whole USDC). Floored at p0. */
  priceAt(r: number): number {
    return Math.max(this.p0, Math.sqrt(this.p0 * this.p0 + 2 * this.k * r));
  }

  /** BLOCK sold by the time the reserve has raised `r` USDC. */
  soldAt(r: number): number {
    return (this.priceAt(r) - this.p0) / this.k;
  }

  /** USDC the reserve must hold to have sold `n` BLOCK. */
  reserveForN(n: number): number {
    const nn = Math.max(0, n);
    return this.p0 * nn + (this.k * nn * nn) / 2;
  }

  /**
   * Quote a sell of `blockIn` whole BLOCK against a reserve currently holding
   * `reserveUsdc` whole USDC. Returns the gross USDC the curve releases, the
   * 5% fee, the net USDC proceeds, and the average price — matching buy.js.
   */
  sellQuote(blockIn: number, reserveUsdc: number): {
    gross: number;
    fee: number;
    out: number;
    avgPrice: number;
  } {
    const n = this.soldAt(reserveUsdc);
    const n2 = Math.max(0, n - blockIn);
    const gross = Math.max(0, reserveUsdc - this.reserveForN(n2));
    const fee = gross * this.fee;
    const out = gross * (1 - this.fee);
    const avgPrice = blockIn > 0 ? gross / blockIn : this.priceAt(reserveUsdc);
    return { gross, fee, out, avgPrice };
  }
}
