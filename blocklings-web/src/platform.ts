/**
 * Platform gate for App Store compliance.
 *
 * Inside the iOS App Store build we make all crypto COMMERCE (buying/selling/
 * sending crypto, NFT minting, buying in-game goods for crypto) unavailable,
 * while still letting players VIEW balances, addresses, collectibles and
 * listings. Crypto actions point players to the web (same account).
 *
 * CRITICAL: this MUST be evaluated LAZILY (a function, not a load-time const).
 * The iOS shell injects its signals AFTER the bundle has loaded, so a constant
 * captured at module-eval time reads `false` and the gate silently does nothing
 * — which is exactly why crypto "still worked" in the app. By checking at call
 * time (every crypto action happens on user interaction, long after the shell
 * has injected), the gate is reliable.
 *
 * Signals (any one ⇒ iOS app):
 *   - window.__blkNativeIos === true  — flag injected by the shell at document
 *     start (onPageStarted), the earliest and most reliable signal.
 *   - window.blocklingsIAP            — the StoreKit shim (injected on page load,
 *     iOS only; present well before any crypto tap).
 *   - window.webkit.messageHandlers.BlocklingsIAPNative — the native channel the
 *     iOS WKWebView shell always exposes (last-resort detection).
 *
 * iOS Safari, Android and desktop expose none of these, so they keep everything.
 */
export function isIosApp(): boolean {
  const w = window as unknown as {
    __blkNativeIos?: boolean
    blocklingsIAP?: unknown
    webkit?: { messageHandlers?: Record<string, unknown> }
  }
  if (w.__blkNativeIos === true) return true
  if (typeof w.blocklingsIAP !== 'undefined') return true
  if (w.webkit?.messageHandlers?.['BlocklingsIAPNative'] != null) return true
  return false
}

export const CRYPTO_WEB = 'https://blocklings.blockle.org'

/** Open the full-featured web build (same account) — native browser in the app. */
export function openCryptoWeb(): void {
  const bridge = (window as unknown as { blocklingsOpenURL?: (u: string) => void }).blocklingsOpenURL
  if (bridge) bridge(CRYPTO_WEB)
  else window.open(CRYPTO_WEB, '_blank', 'noopener')
}
