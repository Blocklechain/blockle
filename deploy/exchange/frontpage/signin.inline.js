(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };

  // ---------------------------------------------------------------- the mark
  //
  // Particle targets are SAMPLED FROM THE DRAWN MARK, so the particles form the
  // real thing and follow any change to the drawing. The alternative — a
  // hand-typed list of coordinates — drifts away from the logo the moment the
  // logo changes, and nobody notices until it is subtly wrong.

  function sampleMark(size) {
    var c = document.createElement("canvas");
    c.width = c.height = size;
    var g = c.getContext("2d");
    var s = size / 24; // the mark is authored on a 24-unit grid

    g.strokeStyle = "#fff";
    g.lineWidth = 1.7 * s;
    g.lineJoin = "round";
    g.lineCap = "round";

    // The cube: a hexagon with the three visible inner edges.
    g.beginPath();
    g.moveTo(12 * s, 2.2 * s);
    g.lineTo(20.4 * s, 7 * s);
    g.lineTo(20.4 * s, 17 * s);
    g.lineTo(12 * s, 21.8 * s);
    g.lineTo(3.6 * s, 17 * s);
    g.lineTo(3.6 * s, 7 * s);
    g.closePath();
    g.stroke();

    g.beginPath();
    g.moveTo(3.6 * s, 7 * s);
    g.lineTo(12 * s, 11.8 * s);
    g.lineTo(20.4 * s, 7 * s);
    g.moveTo(12 * s, 11.8 * s);
    g.lineTo(12 * s, 21.8 * s);
    g.stroke();

    // The B, sitting on the cube's top face so the mark reads as a lettered
    // block rather than a letter beside a block.
    g.fillStyle = "#fff";
    g.font = "700 " + (7.4 * s) + "px ui-monospace, SFMono-Regular, Menlo, monospace";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText("B", 12 * s, 7.2 * s);

    // Sample on a grid. Step controls particle count; a finer step is a denser
    // mark and more work per frame.
    var data = g.getImageData(0, 0, size, size).data;
    var pts = [];
    var step = 3;
    for (var y = 0; y < size; y += step) {
      for (var x = 0; x < size; x += step) {
        if (data[(y * size + x) * 4 + 3] > 110) pts.push([x, y]);
      }
    }
    return pts;
  }

  // ------------------------------------------------------------- the particles

  var canvas = $("fx");
  var ctx = canvas.getContext("2d");
  var P = [];
  var pointer = { x: -1e9, y: -1e9, down: false };
  var mode = "idle"; // idle -> assembling -> burst
  var modeAt = 0;
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var dpr = 1, W = 0, H = 0, scale = 1, offX = 0, offY = 0;

  function layout() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth;
    H = canvas.clientHeight;
    canvas.width = Math.max(1, Math.floor(W * dpr));
    canvas.height = Math.max(1, Math.floor(H * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    var side = Math.min(W, H) * 0.56;
    scale = side / 240;
    offX = (W - 240 * scale) / 2;
    offY = (H - 240 * scale) / 2 - H * 0.04;
    for (var i = 0; i < P.length; i++) {
      P[i].tx = offX + P[i].sx * scale;
      P[i].ty = offY + P[i].sy * scale;
    }
  }

  function build() {
    var pts = sampleMark(240);
    P = pts.map(function (p) {
      return {
        sx: p[0], sy: p[1],
        tx: 0, ty: 0,
        // Scattered start, so the first thing the page does is pull itself
        // together.
        x: Math.random() * Math.max(W, 400),
        y: Math.random() * Math.max(H, 400),
        vx: 0, vy: 0,
        // Per-particle jitter so the swarm does not move as one rigid body.
        k: 0.014 + Math.random() * 0.018,
        drag: 0.86 + Math.random() * 0.06,
        hue: Math.random() < 0.18 ? 1 : 0,
      };
    });
    layout();
  }

  function frame(t) {
    ctx.clearRect(0, 0, W, H);

    var burst = mode === "burst";
    var elapsed = t - modeAt;

    for (var i = 0; i < P.length; i++) {
      var p = P[i];

      if (burst) {
        // Outward, from the centre of the mark, decelerating. Not gravity —
        // this is a hand-off, and something falling would read as a failure.
        p.vx *= 0.985;
        p.vy *= 0.985;
      } else {
        // Spring to the target.
        var k = mode === "assembling" ? p.k * 3.2 : p.k;
        p.vx += (p.tx - p.x) * k;
        p.vy += (p.ty - p.y) * k;

        // Pointer interaction: push away, or pull in while held. Cheap
        // inverse-square-ish falloff, clamped so a particle under the cursor
        // does not acquire absurd velocity.
        var dx = p.x - pointer.x, dy = p.y - pointer.y;
        var d2 = dx * dx + dy * dy;
        if (d2 < 150 * 150) {
          var d = Math.sqrt(d2) || 1;
          var f = (1 - d / 150) * (pointer.down ? -2.6 : 3.1);
          p.vx += (dx / d) * f;
          p.vy += (dy / d) * f;
        }
        p.vx *= p.drag;
        p.vy *= p.drag;
      }

      p.x += p.vx;
      p.y += p.vy;

      var settled = Math.abs(p.x - p.tx) + Math.abs(p.y - p.ty);
      // Cyan for the minority accent particles and for anything still moving;
      // the settled mark is near-white, so "assembled" is legible at a glance.
      var lively = burst || settled > 2.5;
      ctx.fillStyle = p.hue
        ? "rgba(53,214,232," + (burst ? 0.9 : 0.95) + ")"
        : lively
          ? "rgba(147,160,182,.85)"
          : "rgba(233,238,246,.95)";
      var r = burst ? 1.9 : lively ? 1.5 : 1.7;
      ctx.fillRect(p.x - r, p.y - r, r * 2, r * 2);
    }

    if (mode === "assembling" && elapsed > 700) {
      mode = "burst";
      modeAt = t;
      var cx = offX + 120 * scale, cy = offY + 120 * scale;
      for (var j = 0; j < P.length; j++) {
        var q = P[j];
        var ax = q.x - cx, ay = q.y - cy;
        var al = Math.sqrt(ax * ax + ay * ay) || 1;
        var speed = 7 + Math.random() * 9;
        q.vx = (ax / al) * speed;
        q.vy = (ay / al) * speed;
      }
    }

    requestAnimationFrame(frame);
  }

  canvas.addEventListener("pointermove", function (e) {
    var r = canvas.getBoundingClientRect();
    pointer.x = e.clientX - r.left;
    pointer.y = e.clientY - r.top;
  });
  canvas.addEventListener("pointerleave", function () {
    pointer.x = pointer.y = -1e9;
    pointer.down = false;
  });
  canvas.addEventListener("pointerdown", function () { pointer.down = true; });
  window.addEventListener("pointerup", function () { pointer.down = false; });
  window.addEventListener("resize", layout);

  build();
  if (reduced) {
    // Place them on target and draw once: the mark, no motion.
    for (var i = 0; i < P.length; i++) { P[i].x = P[i].tx; P[i].y = P[i].ty; }
    ctx.clearRect(0, 0, W, H);
    for (var j = 0; j < P.length; j++) {
      ctx.fillStyle = P[j].hue ? "rgba(53,214,232,.95)" : "rgba(233,238,246,.95)";
      ctx.fillRect(P[j].x - 1.7, P[j].y - 1.7, 3.4, 3.4);
    }
    $("fx-hint").textContent = "";
  } else {
    requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------------ sign in

  /**
   * Where to go after signing in.
   *
   * VALIDATED AS A SAME-ORIGIN PATH. A `return` parameter handed straight to
   * location.assign is an open redirect: a crafted link would sign someone in
   * and then hand the freshly-authenticated session to another site. Only a
   * path on this host is accepted, and anything else falls back to the app.
   */
  /*
   * ONE ALLOWLISTED DESTINATION BESIDES OUR OWN ORIGIN.
   *
   * The guard here is against an open redirect: anything can put a `return`
   * in a URL, so an unchecked one turns this page into a credential-phishing
   * springboard that borrows our domain's credibility. Same-origin only was
   * the right default and stays the default.
   *
   * But the operator console lives on admin.blockle.org and sends people here
   * to sign in, and rejecting its return dumped every operator on the TRADING
   * APP instead of back at the console — which is exactly what it looked like
   * from outside: "admin.blockle.org just takes you to the exchange".
   *
   * So: the console's own path on its own host, and nothing else. An
   * allowlist of one is still an allowlist.
   */
  var OPERATOR_CONSOLE = "https://admin.blockle.org";

  function destination() {
    var raw = new URLSearchParams(location.search).get("return") || "";
    if (raw === "") return "app.html";
    try {
      var u = new URL(raw, location.origin);
      if (u.origin === location.origin) return u.pathname + u.search + u.hash;
      if (u.origin === OPERATOR_CONSOLE && u.pathname.indexOf("/admin/") === 0) {
        return u.href;
      }
      return "app.html";
    } catch (e) {
      return "app.html";
    }
  }

  // Tailor the copy to why they were sent here, without inventing anything.
  (function context() {
    var p = new URLSearchParams(location.search);
    if (p.get("as") === "operator") {
      $("title").textContent = "Operator sign in";
      $("why").textContent =
        "The console needs an account on the operator allowlist. It is the " +
        "same Blockle account — admin rights are granted to the account, not " +
        "to a separate login.";
      $("create").parentNode.style.display = "none";
    }
    var reason = p.get("reason");
    if (reason === "expired") {
      show("Your session has expired. Sign in again to continue.", "");
    }
  })();

  /*
   * REMEMBER WHICH ACCOUNTS USE 2FA, so the code field is there BEFORE the
   * first submit.
   *
   * Without this the page had to post the password alone to discover that 2FA
   * was on — a throwaway request that the server counted as a failed attempt.
   * Every sign-in therefore burned one against a lockout threshold of four, so
   * two typos and the exponential backoff engaged. The server no longer counts
   * an absent code, and this removes the wasted round trip as well: after the
   * first time, a 2FA sign-in is one request.
   *
   * Local to the browser and nothing more than "this address uses 2FA" — the
   * same thing the next sign-in reveals anyway. Cleared if a later sign-in
   * succeeds without a code, so disabling 2FA does not leave a stale prompt.
   */
  var TFA_KEY = "blockle.ex.2fa";
  function knownTfa() {
    try {
      return JSON.parse(localStorage.getItem(TFA_KEY) || "[]");
    } catch (e) { return []; }
  }
  function rememberTfa(email, on) {
    try {
      var list = knownTfa().filter(function (e) { return e !== email; });
      if (on) list.push(email);
      localStorage.setItem(TFA_KEY, JSON.stringify(list.slice(-8)));
    } catch (e) { /* storage denied: the probe path still works */ }
  }
  function maybeRevealTfa() {
    var email = $("email").value.trim().toLowerCase();
    if (email !== "" && knownTfa().indexOf(email) >= 0) {
      $("otp-wrap").classList.remove("hidden");
    }
  }
  $("email").addEventListener("change", maybeRevealTfa);
  $("email").addEventListener("blur", maybeRevealTfa);
  // Covers the browser autofilling a remembered address before any event.
  setTimeout(maybeRevealTfa, 150);

  /*
   * A LOCKOUT COUNTS DOWN INSTEAD OF INVITING ANOTHER ATTEMPT.
   *
   * The server now reports `retryAfter`. Leaving the button live during a
   * lockout is actively harmful: each attempt doubles the next delay, so a
   * person hammering it digs themselves in.
   */
  var cooldown = null;
  function holdFor(seconds) {
    var btn = $("go");
    var left = seconds;
    clearInterval(cooldown);
    btn.disabled = true;
    var tick = function () {
      if (left <= 0) {
        clearInterval(cooldown);
        btn.disabled = false;
        btn.textContent = "Sign in";
        return;
      }
      btn.textContent =
        "Wait " + (left < 60 ? left + "s" : Math.ceil(left / 60) + " min");
      left--;
    };
    tick();
    cooldown = setInterval(tick, 1000);
  }

  function show(text, kind) {
    var m = $("msg");
    m.className = "msg " + (kind || "");
    m.textContent = text;
  }
  function hide() { $("msg").className = "msg hidden"; }

  $("form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var btn = $("go");
    hide();
    btn.disabled = true;
    btn.textContent = "Signing in…";

    var body = {
      email: $("email").value.trim(),
      password: $("password").value,
    };
    var otp = $("otp").value.trim();
    if (otp !== "") {
      /*
       * THE FIELD IS `totp`. Read from the accounts service, not guessed.
       *
       * The first version sent `otp`, `token` and `code` on the theory that one
       * of them would land — and none of them is what the server reads, so
       * every code was rejected and the prompt simply reappeared. That is the
       * "says 2fa and never logs in" symptom exactly: the page looked like it
       * was asking again, because it was.
       *
       * Sending speculative aliases was the mistake, not just the wrong name.
       * One field, confirmed against src/server.js.
       *
       * A RECOVERY CODE GOES IN THE SAME FIELD — the server tries the
       * authenticator first and then the recovery list, consuming the code.
       */
      body.totp = otp;
    }

    // SAME-ORIGIN. /account/api/ is proxied on this host, so the session cookie
    // (domain .blockle.org) is set for the exchange and the main site at once
    // and there is no CORS to configure or get wrong.
    fetch("/account/api/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        return { ok: r.ok, status: r.status, d: d };
      });
    }).then(function (res) {
      // THE PASSWORD IS CLEARED EITHER WAY, so a failed attempt does not leave
      // it sitting in the DOM for the next person at the machine.
      $("password").value = "";

      if (res.ok) {
        // Remember whether this account needed a code, so the next sign-in
        // asks up front rather than probing.
        rememberTfa(body.email.toLowerCase(), otp !== "");
        show("Signed in. Taking you through…", "ok");
        // THE ONE NON-AMBIENT ANIMATION: converge, then burst, then hand over.
        if (!reduced) { mode = "assembling"; modeAt = performance.now(); }
        setTimeout(function () { location.assign(destination()); }, reduced ? 150 : 1150);
        return;
      }

      /*
       * `message` FIRST, then `error`.
       *
       * The accounts service answers a failed second factor with
       * `{error: "2fa", message: "Enter your 6-digit code."}` — `error` is a
       * MACHINE CODE and `message` is the sentence meant for a person. Showing
       * `error` put the literal text "2fa" on screen as the explanation, which
       * is how the page ended up saying nothing useful at the exact moment it
       * most needed to.
       */
      var err = res.d.message || res.d.error || "";
      var code = String(res.d.error || "");
      // A 2FA CHALLENGE IS A PROMPT, NOT A FAILURE. Matched on the error CODE
      // the service returns rather than by pattern-matching prose, which
      // changes.
      if (code === "2fa" || code === "2fa_setup_required" || res.d.twoFactorRequired) {
        rememberTfa(body.email.toLowerCase(), true);
        $("otp-wrap").classList.remove("hidden");
        $("otp").focus();
        $("otp").select();
        show(
          otp === ""
            ? "This account has two-factor enabled. Enter the current 6-digit " +
              "code — or one of your recovery codes."
            : "That code was not accepted. Codes last 30 seconds, so wait for " +
              "the next one rather than retyping this one. A recovery code " +
              "works here too.",
          otp === "" ? "" : "bad"
        );
      } else if (res.status === 429) {
        // The server tells us how long. Hold the button for exactly that, so
        // the next press cannot make the backoff worse.
        var wait = Number(res.d.retryAfter) || 30;
        show(err || "Too many attempts.", "bad");
        holdFor(wait);
        return;
      } else {
        // THE SERVICE'S OWN WORDING. Guessing between "wrong password" and "no
        // such account" would make this form an account-enumeration oracle,
        // and the accounts service already answers both the same way.
        show(err || ("Sign in failed (HTTP " + res.status + ")."), "bad");
      }
    }).catch(function (e) {
      show(
        "Could not reach the account service — " + e.message +
        ". Nothing was sent; try again in a moment.",
        "bad"
      );
    }).then(function () {
      // A cooldown owns the button while it runs; re-enabling here would undo
      // the hold the moment it was set.
      if ($("go").textContent.indexOf("Wait") !== 0) {
        btn.disabled = false;
        btn.textContent = "Sign in";
      }
    });
  });

  // If they are already signed in, do not make them do it again.
  fetch("/v1/me", { credentials: "same-origin", cache: "no-store" })
    .then(function (r) { if (r.ok) location.replace(destination()); })
    .catch(function () { /* offline or signed out: show the form */ });

  // The testnet badge, failing closed the same way every other surface does.
  fetch("public/status", { cache: "no-store" })
    .then(function (r) { return r.json(); })
    .then(function (st) {
      if (st.live === true) {
        var e = $("env");
        e.textContent = "LIVE";
        e.style.borderColor = "var(--up)";
        e.style.color = "var(--up)";
      }
    })
    .catch(function () { /* badge stays TESTNET */ });
})();
