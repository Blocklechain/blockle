// particles.js — an interactive particle logo. Particles (tiny blocks) settle
// into the shape of a glyph, drift gently, scatter away from the pointer, and
// burst outward on click/tap before reassembling. Exposed as global `ParticleLogo`.
(function (global) {
  class ParticleLogo {
    constructor(canvas, opts = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.glyph = opts.glyph || 'B';
      this.density = opts.density || 4; // sample step in px (smaller = more particles)
      this.pointer = { x: -9999, y: -9999, active: false };
      this.particles = [];
      this.dpr = Math.max(1, Math.min(2, global.devicePixelRatio || 1));
      this.t = 0;
      this._raf = null;
      this._resize = this._resize.bind(this);
      this._onMove = this._onMove.bind(this);
      this._onLeave = this._onLeave.bind(this);
      this._onDown = this._onDown.bind(this);
      this._tick = this._tick.bind(this);
      this._resize();
      global.addEventListener('resize', this._resize);
      canvas.addEventListener('pointermove', this._onMove);
      canvas.addEventListener('pointerleave', this._onLeave);
      canvas.addEventListener('pointerdown', this._onDown);
      this._raf = requestAnimationFrame(this._tick);
    }

    _resize() {
      const rect = this.canvas.getBoundingClientRect();
      this.w = Math.max(1, rect.width);
      this.h = Math.max(1, rect.height);
      this.canvas.width = this.w * this.dpr;
      this.canvas.height = this.h * this.dpr;
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this._sample();
    }

    // Rasterize the glyph to an offscreen canvas and pick target points.
    _sample() {
      const off = document.createElement('canvas');
      off.width = this.w;
      off.height = this.h;
      const o = off.getContext('2d');
      o.clearRect(0, 0, this.w, this.h);
      o.fillStyle = '#fff';
      o.textAlign = 'center';
      o.textBaseline = 'middle';
      const size = Math.min(this.w, this.h) * 0.82;
      o.font = `900 ${size}px -apple-system, "Segoe UI", system-ui, sans-serif`;
      o.fillText(this.glyph, this.w / 2, this.h / 2 + size * 0.02);
      const img = o.getImageData(0, 0, this.w, this.h).data;

      const targets = [];
      const step = this.density;
      for (let y = 0; y < this.h; y += step) {
        for (let x = 0; x < this.w; x += step) {
          const a = img[(y * this.w + x) * 4 + 3];
          if (a > 128) targets.push({ x, y });
        }
      }

      // Reconcile with existing particles so a resize doesn't reset the motion.
      const prev = this.particles;
      this.particles = targets.map((tg, i) => {
        const p = prev[i] || {
          x: this.w / 2 + (Math.random() - 0.5) * this.w,
          y: this.h / 2 + (Math.random() - 0.5) * this.h,
          vx: 0,
          vy: 0,
        };
        p.hx = tg.x;
        p.hy = tg.y;
        // hue from left (cyan ~188) to right (violet ~276)
        p.hue = 188 + (tg.x / this.w) * 88;
        p.size = 1.6 + Math.random() * 1.3;
        p.phase = Math.random() * Math.PI * 2;
        return p;
      });
    }

    _onMove(e) {
      const r = this.canvas.getBoundingClientRect();
      this.pointer.x = e.clientX - r.left;
      this.pointer.y = e.clientY - r.top;
      this.pointer.active = true;
    }
    _onLeave() {
      this.pointer.active = false;
      this.pointer.x = this.pointer.y = -9999;
    }
    _onDown(e) {
      const r = this.canvas.getBoundingClientRect();
      const cx = e.clientX - r.left;
      const cy = e.clientY - r.top;
      for (const p of this.particles) {
        const dx = p.x - cx;
        const dy = p.y - cy;
        const d = Math.hypot(dx, dy) || 1;
        const force = Math.min(26, 2600 / (d * d + 60));
        p.vx += (dx / d) * force;
        p.vy += (dy / d) * force;
      }
    }

    _tick() {
      this.t += 1;
      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.w, this.h);
      ctx.globalCompositeOperation = 'lighter';
      const px = this.pointer.x;
      const py = this.pointer.y;
      const repelR = Math.min(this.w, this.h) * 0.26;
      const repelR2 = repelR * repelR;

      for (const p of this.particles) {
        // spring home
        p.vx += (p.hx - p.x) * 0.035;
        p.vy += (p.hy - p.y) * 0.035;
        // pointer repulsion
        if (this.pointer.active) {
          const dx = p.x - px;
          const dy = p.y - py;
          const d2 = dx * dx + dy * dy;
          if (d2 < repelR2) {
            const d = Math.sqrt(d2) || 1;
            const f = (1 - d / repelR) * 5.5;
            p.vx += (dx / d) * f;
            p.vy += (dy / d) * f;
          }
        }
        // idle shimmer
        p.vx += Math.cos(this.t * 0.02 + p.phase) * 0.03;
        p.vy += Math.sin(this.t * 0.02 + p.phase) * 0.03;
        // integrate + damping
        p.vx *= 0.86;
        p.vy *= 0.86;
        p.x += p.vx;
        p.y += p.vy;

        const speed = Math.min(1, Math.hypot(p.vx, p.vy) / 6);
        const light = 60 + speed * 30;
        ctx.fillStyle = `hsla(${p.hue}, 90%, ${light}%, 0.9)`;
        const s = p.size + speed * 1.2;
        ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
      }
      ctx.globalCompositeOperation = 'source-over';
      this._raf = requestAnimationFrame(this._tick);
    }

    burst() {
      const cx = this.w / 2;
      const cy = this.h / 2;
      for (const p of this.particles) {
        p.vx += (Math.random() - 0.5) * 30 + (p.x - cx) * 0.15;
        p.vy += (Math.random() - 0.5) * 30 + (p.y - cy) * 0.15;
      }
    }

    destroy() {
      cancelAnimationFrame(this._raf);
      global.removeEventListener('resize', this._resize);
      this.canvas.removeEventListener('pointermove', this._onMove);
      this.canvas.removeEventListener('pointerleave', this._onLeave);
      this.canvas.removeEventListener('pointerdown', this._onDown);
    }
  }

  global.ParticleLogo = ParticleLogo;
})(typeof self !== 'undefined' ? self : window);
