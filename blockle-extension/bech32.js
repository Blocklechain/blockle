// bech32.js — minimal bech32 encoder (BIP-173) for rendering BLOCK addresses
// as `block1…`. Exposed as global `Bech32`.
(function (global) {
  const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

  function polymod(values) {
    const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    let chk = 1;
    for (const v of values) {
      const b = chk >> 25;
      chk = ((chk & 0x1ffffff) << 5) ^ v;
      for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= GEN[i];
    }
    return chk;
  }

  function hrpExpand(hrp) {
    const ret = [];
    for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) >> 5);
    ret.push(0);
    for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) & 31);
    return ret;
  }

  function createChecksum(hrp, data) {
    const values = hrpExpand(hrp).concat(data).concat([0, 0, 0, 0, 0, 0]);
    const mod = polymod(values) ^ 1;
    const ret = [];
    for (let i = 0; i < 6; i++) ret.push((mod >> (5 * (5 - i))) & 31);
    return ret;
  }

  function convertBits(data, from, to, pad) {
    let acc = 0,
      bits = 0;
    const ret = [];
    const maxv = (1 << to) - 1;
    for (const value of data) {
      acc = (acc << from) | value;
      bits += from;
      while (bits >= to) {
        bits -= to;
        ret.push((acc >> bits) & maxv);
      }
    }
    if (pad && bits > 0) ret.push((acc << (to - bits)) & maxv);
    return ret;
  }

  function encode(hrp, bytes) {
    const data = convertBits(Array.from(bytes), 8, 5, true);
    const combined = data.concat(createChecksum(hrp, data));
    let ret = hrp + '1';
    for (const d of combined) ret += CHARSET[d];
    return ret;
  }

  global.Bech32 = { encode };
})(typeof self !== 'undefined' ? self : window);
