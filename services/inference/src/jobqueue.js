// Pull-based job queue so BROWSER miners (web wallet, WebGPU) can serve inference without
// being an inbound HTTP server. A paid /infer enqueues a job and awaits a result; browser
// miners long-poll claimNext(), compute in-browser, and submitResult(). If no browser answers
// in time, the caller falls back to push-miners / bootstrap. Pure + injectable → unit-testable.
"use strict";

function createQueue(opts = {}) {
  const jobTimeoutMs = opts.jobTimeoutMs || 30000;
  const pending = [];              // jobs waiting to be claimed
  const inflight = new Map();      // jobId -> { job, resolve, reject, timer }
  const waiters = [];              // { resolve } browser long-polls waiting for a job
  let seq = 0;

  // A paid request enters here; resolves with { answer, address } or rejects on timeout.
  function enqueue(request) {
    return new Promise((resolve, reject) => {
      const jobId = "j" + (++seq);
      const job = { jobId, request, ts: Date.now() };
      const timer = setTimeout(() => {
        inflight.delete(jobId);
        const i = pending.findIndex((p) => p.jobId === jobId);
        if (i >= 0) pending.splice(i, 1);
        reject(new Error("job timeout"));
      }, jobTimeoutMs);
      inflight.set(jobId, { job, resolve, reject, timer });
      const w = waiters.shift();
      if (w) w.resolve(job);         // hand straight to a waiting browser miner
      else pending.push(job);
    });
  }

  // Browser miner claims the next job. Returns a job now, or a promise + a canceller for
  // the caller's long-poll timeout. Shape: { job } | { wait: Promise, cancel: fn }.
  function claimNext() {
    if (pending.length) return { job: pending.shift() };
    let resolve; const wait = new Promise((r) => (resolve = r));
    const w = { resolve };
    waiters.push(w);
    const cancel = () => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); resolve(null); };
    return { wait, cancel };
  }

  // Browser miner returns a result; resolves the waiting enqueue().
  function submitResult(jobId, address, answer) {
    const f = inflight.get(jobId);
    if (!f) return false;
    clearTimeout(f.timer); inflight.delete(jobId);
    f.resolve({ answer, address });
    return true;
  }

  function stats() { return { pending: pending.length, inflight: inflight.size, waiters: waiters.length }; }
  return { enqueue, claimNext, submitResult, stats };
}

module.exports = { createQueue };
