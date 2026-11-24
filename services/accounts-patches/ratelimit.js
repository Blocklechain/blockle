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
    const f = this.fails.get(key) || { count: 0, until: 0, last: 0 };
    /*
     * THE FAILURE COUNT DECAYS. Without this it only ever reset on a
     * successful login, so in a process that stays up for weeks the count
     * accumulated for the lifetime of the process — someone who had mistyped
     * ten times over a month sat permanently one failure away from a
     * sixteen-minute lockout, and the backoff fired almost immediately. That
     * is the "too quick to say too many attempts" report.
     *
     * A genuine attacker is unaffected: within a window the exponential
     * backoff is unchanged, and all this does is stop punishing a person for
     * typos they made weeks ago.
     */
    const t = this.now();
    if (f.last && t - f.last > this.windowMs) { f.count = 0; f.until = 0; }
    f.last = t;
    f.count += 1;
    // backoff grows once past the threshold: base, 2×, 4×, … capped at 1h
    const over = Math.max(1, f.count - this.lockThreshold);
    f.until = this.now() + Math.min(this.lockoutBaseMs * 2 ** (over - 1), 60 * 60 * 1000);
    this.fails.set(key, f);
  }

  reset(key) { this.fails.delete(key); }
}
