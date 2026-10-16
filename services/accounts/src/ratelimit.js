// Sliding-window rate limiter + exponential lockout, in-process. Keyed by ip and by account.
// Pure + injectable clock so tests are deterministic.
export class RateLimiter {
  constructor({ windowMs, max, lockoutBaseMs, lockThreshold = 0 }, now = () => Date.now()) {
    this.windowMs = windowMs; this.max = max; this.lockoutBaseMs = lockoutBaseMs;
    this.lockThreshold = lockThreshold; // failures tolerated before lockout engages
    this.now = now;
    this.hits = new Map();      // key -> number[] (timestamps)
    this.fails = new Map();     // key -> { count, until }
  }

  _prune(key) {
    const t = this.now(); const arr = (this.hits.get(key) || []).filter((ts) => t - ts < this.windowMs);
    this.hits.set(key, arr); return arr;
  }

  // Returns true if allowed (and records the hit), false if over the window cap.
  allow(key) {
    const arr = this._prune(key);
    if (arr.length >= this.max) return false;
    arr.push(this.now()); this.hits.set(key, arr); return true;
  }

  // Lockout: returns ms remaining if locked, else 0. Only locks past lockThreshold failures.
  lockedFor(key) {
    const f = this.fails.get(key);
    if (!f || f.count <= this.lockThreshold) return 0;
    const rem = f.until - this.now();
    return rem > 0 ? rem : 0;
  }

  recordFailure(key) {
    const f = this.fails.get(key) || { count: 0, until: 0 };
    f.count += 1;
    // backoff grows once past the threshold: base, 2×, 4×, … capped at 1h
    const over = Math.max(1, f.count - this.lockThreshold);
    f.until = this.now() + Math.min(this.lockoutBaseMs * 2 ** (over - 1), 60 * 60 * 1000);
    this.fails.set(key, f);
  }

  reset(key) { this.fails.delete(key); }
}
