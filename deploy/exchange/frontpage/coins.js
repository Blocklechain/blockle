// -----------------------------------------------------------------------------
// COIN MARKS — one per listed asset, drawn as geometry, served from our host.
//
// WHY THESE ARE DRAWN RATHER THAN FETCHED. Every exchange that pulls coin
// artwork from a CDN has a page that half-renders when the CDN is slow and
// shows broken images when it is down. This set is ~6 KB of inline SVG, has no
// network dependency, survives the strict CSP on the admin host, and renders
// identically at 16px and 40px because it is all primitives.
//
// THE GLYPHS ARE THE CURRENCY SYMBOLS, NOT THE PROJECTS' LOGO FILES — the
// bitcoin B-with-strokes, the ether double tetrahedron, tether's barred T, and
// so on. Those are the marks people recognise, and drawing them as paths keeps
// this file self-contained.
//
// EVERY ASSET MUST HAVE ONE. `coinIcon` on an unknown symbol does not return
// nothing and does not return a generic coin: it returns a disc carrying the
// first two letters of the ticker, in a hue derived from the ticker itself. A
// new listing therefore gets a stable, distinct mark the moment it is listed,
// rather than a hole in the table until someone draws an icon. Hue from a hash
// so the same ticker is always the same colour across reloads and screens.
//
// Colours are the assets' own, so BTC is orange and SOL is purple wherever
// they appear. They are DECORATION, never the only carrier of meaning — the
// ticker is always beside the mark, and nothing here is used for up/down or
// pass/fail, which have their own semantic colours in the stylesheet.
// -----------------------------------------------------------------------------

(function (root) {
  "use strict";

  // [background, glyph fill, glyph paths]
  var COINS = {
    BTC: ["#f7931a", "#fff",
      // The barred B.
      '<path d="M15.1 10.9c.2-1.5-.9-2.3-2.5-2.8l.5-2.1-1.3-.3-.5 2c-.3-.1-.7-.2-1.1-.2l.5-2L9.4 5l-.5 2.1-2.6-.7-.4 1.4s1 .2 1 .3c.5.1.6.5.6.7l-1.4 5.7c-.1.2-.2.4-.6.3 0 0-1-.2-1-.2L3.7 16l2.6.6-.5 2.1 1.3.3.5-2.1 1.1.3-.5 2 1.3.4.5-2.1c2.2.4 3.8.2 4.5-1.8.5-1.6 0-2.5-1.2-3.1.9-.2 1.5-.8 1.7-1.9z" />' +
      '<path d="M13 15.4c-.4 1.6-3 .7-3.9.5l.7-2.9c.9.2 3.6.6 3.2 2.4zm.4-4.5c-.4 1.5-2.6.7-3.4.5l.7-2.6c.8.2 3.1.5 2.7 2.1z" fill="#f7931a"/>'],

    ETH: ["#627eea", "#fff",
      // Double tetrahedron: upper solid, lower outline, as the mark is drawn.
      '<path d="M12 3.2l5.6 9L12 15.4 6.4 12.2z" opacity=".75"/>' +
      '<path d="M12 3.2v12.2L6.4 12.2z"/>' +
      '<path d="M12 16.6l5.6-3.3L12 21.2 6.4 13.3z" opacity=".75"/>' +
      '<path d="M12 21.2v-4.6l-5.6-3.3z"/>'],

    USDT: ["#26a17b", "#fff",
      // Barred T on a rounded tablet.
      '<path d="M10.8 8.2V6.4H5.9V4.1h12.2v2.3h-4.9v1.8c3.6.2 6.3 1 6.3 2 0 1-2.7 1.8-6.3 2v4.3c0 .6-.5 1.1-1.2 1.1s-1.2-.5-1.2-1.1v-4.3c-3.6-.2-6.3-1-6.3-2 0-1 2.7-1.8 6.3-2zm0 3.2v1.4c.4 0 .8 0 1.2 0s.8 0 1.2 0v-1.4c-.4 0-.8 0-1.2 0s-.8 0-1.2 0z"/>'],

    USDC: ["#2775ca", "#fff",
      // Dollar through a ring.
      '<circle cx="12" cy="12" r="8.6" fill="none" stroke="#fff" stroke-width="1.5" opacity=".55"/>' +
      '<path d="M12.9 11.3c-1.9-.5-2.5-.8-2.5-1.6 0-.7.6-1.2 1.7-1.2 1 0 1.6.4 1.8 1.2h1.7c-.2-1.4-1.1-2.3-2.6-2.5V5.9h-1.6v1.3c-1.7.2-2.7 1.2-2.7 2.6 0 1.6 1.1 2.3 3 2.8 1.8.5 2.3.8 2.3 1.6s-.7 1.3-1.8 1.3c-1.2 0-1.9-.5-2-1.4H8.4c.1 1.5 1.2 2.5 3 2.7v1.3h1.6v-1.3c1.8-.2 2.9-1.2 2.9-2.7 0-1.7-1.1-2.4-3-2.8z"/>'],

    SOL: ["#14f195", "#0b1220",
      // Three parallelograms, the stacked-slash mark.
      '<path d="M6.3 15.6a.6.6 0 01.4-.2h11a.3.3 0 01.2.5l-2.2 2.2a.6.6 0 01-.4.2h-11a.3.3 0 01-.2-.5z"/>' +
      '<path d="M6.3 5.7a.6.6 0 01.4-.2h11a.3.3 0 01.2.5l-2.2 2.2a.6.6 0 01-.4.2h-11a.3.3 0 01-.2-.5z"/>' +
      '<path d="M15.7 10.6a.6.6 0 00-.4-.2h-11a.3.3 0 00-.2.5l2.2 2.2a.6.6 0 00.4.2h11a.3.3 0 00.2-.5z"/>'],

    DOGE: ["#c3a634", "#fff",
      // Barred D.
      '<path d="M8.3 4.8h4.2c3.6 0 5.9 2.7 5.9 7.2s-2.3 7.2-5.9 7.2H8.3v-5.6H6.1v-2.3h2.2zm2.8 2.4v3.9h2.4v2.3h-2.4v4h1.3c2.1 0 3.3-1.7 3.3-5.1s-1.2-5.1-3.3-5.1z"/>'],

    TRX: ["#eb0029", "#fff",
      // The angular tri-fold.
      '<path d="M4.2 6.1l6.6 13.4L19.8 7.9 4.2 6.1zm2.6 1.6l3.5.4-1.3 3.4zm4.9.9l4.7.5-5.6 6.9-1.3-3.6zm-3.2 4.6l1.4 3.8-3.6-7.3z"/>'],

    BNB: ["#f3ba2f", "#fff",
      // Four diamonds around a centre.
      '<path d="M12 4.3l2.4 2.4L12 9.1 9.6 6.7z"/>' +
      '<path d="M16.1 8.4l2.4 2.4-2.4 2.4-2.4-2.4z"/>' +
      '<path d="M7.9 8.4l2.4 2.4-2.4 2.4-2.4-2.4z"/>' +
      '<path d="M12 12.5l2.4 2.4L12 17.3l-2.4-2.4z"/>'],

    XRP: ["#23292f", "#fff",
      // The two crossing chevrons.
      '<path d="M17.3 5.3h2.5l-4.4 4.4a4.8 4.8 0 01-6.8 0L4.2 5.3h2.5l3.2 3.2a3 3 0 004.2 0z"/>' +
      '<path d="M6.7 18.7H4.2l4.4-4.4a4.8 4.8 0 016.8 0l4.4 4.4h-2.5l-3.2-3.2a3 3 0 00-4.2 0z"/>'],

    BLOCK: ["#35d6e8", "#061418",
      // The Blockle cube — the same geometry as the brand mark elsewhere.
      '<path d="M12 4l7 4v8l-7 4-7-4V8z" fill="none" stroke="#061418" stroke-width="1.6" stroke-linejoin="round"/>' +
      '<path d="M5 8l7 4 7-4M12 12v8" fill="none" stroke="#061418" stroke-width="1.6" stroke-linejoin="round"/>'],

    PERBUG: ["#7b61ff", "#fff",
      // A beetle: body, wing-split, legs, antennae.
      '<ellipse cx="12" cy="13" rx="4.2" ry="5.2" fill="none" stroke="#fff" stroke-width="1.5"/>' +
      '<path d="M12 8v10" stroke="#fff" stroke-width="1.5"/>' +
      '<circle cx="12" cy="7" r="1.9" fill="#fff"/>' +
      '<path d="M10.4 5.4L9 4M13.6 5.4L15 4" stroke="#fff" stroke-width="1.4" stroke-linecap="round"/>' +
      '<path d="M7.8 10.4L5.2 9.2M7.6 13.4H4.8M7.9 16.3l-2.4 1.4M16.2 10.4l2.6-1.2M16.4 13.4h2.8M16.1 16.3l2.4 1.4" stroke="#fff" stroke-width="1.4" stroke-linecap="round"/>'],
  };

  /** Stable hue for an unlisted ticker, so it never changes between screens. */
  function hueOf(symbol) {
    var h = 0;
    for (var i = 0; i < symbol.length; i++) {
      h = (h * 31 + symbol.charCodeAt(i)) % 360;
    }
    return h;
  }

  /**
   * Inline SVG mark for an asset.
   *
   * `size` is a CSS length. Network-qualified ids resolve to their settlement
   * asset, so "USDT.TRC20" gets the USDT mark — it is the same token to a
   * person looking at a balance.
   */
  function coinIcon(symbol, size) {
    var sym = String(symbol || "").toUpperCase();
    var dot = sym.indexOf(".");
    if (dot > 0) sym = sym.slice(0, dot);
    var px = size || 24;
    var head =
      '<svg class="coin" viewBox="0 0 24 24" width="' + px + '" height="' + px +
      '" aria-hidden="true" focusable="false">';
    var c = COINS[sym];
    if (c) {
      return head +
        '<circle cx="12" cy="12" r="12" fill="' + c[0] + '"/>' +
        '<g fill="' + c[1] + '">' + c[2] + "</g></svg>";
    }
    // UNKNOWN TICKER: a lettered disc, not a blank and not a generic coin.
    var hue = hueOf(sym);
    var label = sym.slice(0, 2) || "??";
    return head +
      '<circle cx="12" cy="12" r="12" fill="hsl(' + hue + ' 48% 38%)"/>' +
      '<text x="12" y="12" fill="#fff" font-size="10" font-weight="700" ' +
      'font-family="ui-monospace, monospace" text-anchor="middle" ' +
      'dominant-baseline="central" letter-spacing="-0.5">' + label + "</text></svg>";
  }

  /** Does this asset have a drawn mark, or is it falling back to letters? */
  coinIcon.drawn = function (symbol) {
    var sym = String(symbol || "").toUpperCase();
    var dot = sym.indexOf(".");
    if (dot > 0) sym = sym.slice(0, dot);
    return Object.prototype.hasOwnProperty.call(COINS, sym);
  };

  /** The asset's own colour, for a sparkline or a legend swatch. */
  coinIcon.color = function (symbol) {
    var sym = String(symbol || "").toUpperCase();
    var dot = sym.indexOf(".");
    if (dot > 0) sym = sym.slice(0, dot);
    var c = COINS[sym];
    return c ? c[0] : "hsl(" + hueOf(sym) + " 48% 38%)";
  };

  /**
   * Full names, for the markets list and the asset picker.
   *
   * A ticker alone is not enough for someone who has not met the asset before,
   * and an exchange that assumes everyone knows what PERBUG is has forgotten
   * who it is selling to.
   */
  var NAMES = {
    BTC: "Bitcoin",
    ETH: "Ethereum",
    USDT: "Tether",
    USDC: "USD Coin",
    SOL: "Solana",
    DOGE: "Dogecoin",
    TRX: "Tron",
    BNB: "BNB",
    XRP: "XRP",
    BLOCK: "Blockle",
    PERBUG: "Perbug",
  };
  coinIcon.name = function (symbol) {
    var sym = String(symbol || "").toUpperCase();
    return NAMES[sym] || sym;
  };

  /** Chain labels for the network pills. */
  var NETWORKS = {
    TRC20: "Tron",
    ERC20: "Ethereum",
    SOL: "Solana",
    BEP20: "BNB Chain",
  };
  coinIcon.network = function (id) {
    return NETWORKS[String(id || "").toUpperCase()] || id || "";
  };

  root.coinIcon = coinIcon;
})(typeof window !== "undefined" ? window : this);
