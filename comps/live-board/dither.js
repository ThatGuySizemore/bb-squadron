// The comp's dither renderer: ordered (Bayer 8x8) dither drawn per device
// pixel on canvas. One requestAnimationFrame loop paints every animated
// surface that is on screen; it stops while the document is hidden, and under
// reduced motion each surface is painted once, as a still frame.
window.Dither = (() => {
  // ---------- Bayer 8x8 thresholds in (0, 1) ----------
  const BAYER = new Float32Array(64);
  {
    const b2 = [[0, 2], [3, 1]];
    let m = b2;
    for (let n = 2; n < 8; n *= 2) {
      const next = [];
      for (let y = 0; y < n * 2; y++) {
        next.push([]);
        for (let x = 0; x < n * 2; x++) {
          next[y].push(4 * m[y % n][x % n] + b2[Math.floor(y / n)][Math.floor(x / n)]);
        }
      }
      m = next;
    }
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) BAYER[y * 8 + x] = (m[y][x] + 0.5) / 64;
  }

  // ---------- smooth value noise ----------
  const PERM = new Uint8Array(512);
  {
    const p = Array.from({ length: 256 }, (_, i) => i);
    let seed = 948;
    for (let i = 255; i > 0; i--) {
      seed = (seed * 16807) % 2147483647;
      const j = seed % (i + 1);
      [p[i], p[j]] = [p[j], p[i]];
    }
    for (let i = 0; i < 512; i++) PERM[i] = p[i & 255];
  }
  const fade = (t) => t * t * (3 - 2 * t);
  function noise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const X = xi & 255, Y = yi & 255;
    const a = PERM[PERM[X] + Y] / 255, b = PERM[PERM[X + 1] + Y] / 255;
    const c = PERM[PERM[X] + Y + 1] / 255, d = PERM[PERM[X + 1] + Y + 1] / 255;
    const u = fade(xf), v = fade(yf);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  const fbm = (x, y) => noise(x, y) * 0.65 + noise(x * 2.1 + 17.3, y * 2.1 + 5.1) * 0.35;

  // ---------- colours ----------
  const colourCache = new Map();
  const probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  /** Any CSS colour (hex or a custom property's value) as a packed RGBA pixel. */
  function pixel(css, alpha = 1) {
    const key = `${css}|${alpha}`;
    if (colourCache.has(key)) return colourCache.get(key);
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = "#000";
    probe.fillStyle = css;
    probe.fillRect(0, 0, 1, 1);
    const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
    const a = Math.round(alpha * 255);
    const packed = ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
    colourCache.set(key, packed);
    return packed;
  }
  function token(el, name) {
    return getComputedStyle(el).getPropertyValue(name).trim() || "#888";
  }
  const INK = { amber: "#f2a900", sky: "#3fa7d6", red: "#d7263d", green: "#2fa36b" };

  // ---------- surfaces ----------
  const surfaces = new Set();
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  let reducedOverride = null;
  let raf = 0;
  let frames = 0;
  let lastFrameAt = 0;
  const reduced = () => (reducedOverride ?? media.matches);

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const s = e.target.__surface;
      if (s) s.visible = e.isIntersecting;
    }
    schedule();
  }, { rootMargin: "64px" });

  const ro = new ResizeObserver((entries) => {
    for (const e of entries) {
      const s = e.target.__surface;
      if (s) { size(s); paintOnce(s); }
    }
  });

  function size(s) {
    const dpr = window.devicePixelRatio || 1;
    const rect = s.canvas.getBoundingClientRect();
    const cssW = Math.max(1, Math.round(rect.width));
    const cssH = Math.max(1, Math.round(rect.height));
    const w = Math.round(cssW * dpr), h = Math.round(cssH * dpr);
    if (s.canvas.width !== w || s.canvas.height !== h) {
      s.canvas.width = w;
      s.canvas.height = h;
      s.image = s.ctx.createImageData(w, h);
      s.buf = new Uint32Array(s.image.data.buffer);
    }
    Object.assign(s, { dpr, cssW, cssH, w, h });
  }

  function paintOnce(s, t) {
    if (!s.buf) return;
    const time = t ?? (s.animated && !reduced() ? (performance.now() - s.born) / 1000 : s.stillAt);
    s.buf.fill(0);
    s.paint(s, time);
    s.ctx.putImageData(s.image, 0, 0);
  }

  /**
   * Registers a canvas. `paint(surface, seconds)` writes packed pixels into
   * surface.buf. Animated surfaces join the loop; still ones paint on resize
   * and on refresh only.
   */
  function surface(canvas, paint, { animated = false, stillAt = 1.6, until = Infinity } = {}) {
    const s = { canvas, ctx: canvas.getContext("2d"), paint, animated, stillAt, until, visible: true, born: performance.now() };
    canvas.__surface = s;
    surfaces.add(s);
    size(s);
    paintOnce(s);
    io.observe(canvas);
    ro.observe(canvas);
    schedule();
    return s;
  }

  function release(root) {
    for (const s of [...surfaces]) {
      if (!root || root.contains(s.canvas) || !s.canvas.isConnected) {
        io.unobserve(s.canvas);
        ro.unobserve(s.canvas);
        surfaces.delete(s);
      }
    }
  }

  function loop(now) {
    raf = 0;
    if (document.hidden || reduced()) return;
    let any = false;
    for (const s of surfaces) {
      if (!s.animated || !s.canvas.isConnected) continue;
      const age = (now - s.born) / 1000;
      if (age > s.until) { s.animated = false; s.done?.(); paintOnce(s, s.until); continue; }
      any = true;
      if (s.visible) paintOnce(s, age);
    }
    if (any) {
      frames++;
      lastFrameAt = now;
      raf = requestAnimationFrame(loop);
    }
  }
  function schedule() {
    if (!raf && !document.hidden && !reduced()) raf = requestAnimationFrame(loop);
  }
  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : schedule()));
  media.addEventListener("change", () => refresh());

  function refresh() {
    colourCache.clear();
    stop();
    for (const s of surfaces) { size(s); paintOnce(s); }
    schedule();
  }

  function setReduced(value) {
    reducedOverride = value;
    refresh();
  }

  // ---------- painting helpers ----------
  /**
   * Dithers a scalar field into the surface: the field is sampled once per
   * CSS pixel and thresholded per device pixel, so the grain is device-fine.
   */
  function field(s, ink, fn) {
    const { w, h, dpr, cssW, buf } = s;
    const row = new Float32Array(cssW);
    let lastCy = -1;
    for (let y = 0; y < h; y++) {
      const cy = Math.min(s.cssH - 1, Math.floor(y / dpr));
      if (cy !== lastCy) {
        for (let cx = 0; cx < cssW; cx++) row[cx] = fn(cx, cy);
        lastCy = cy;
      }
      const by = (y & 7) * 8;
      const o = y * w;
      for (let x = 0; x < w; x++) {
        const v = row[Math.min(cssW - 1, Math.floor(x / dpr))];
        if (v > BAYER[by + (x & 7)]) buf[o + x] = ink;
      }
    }
  }

  /** A solid rectangle in CSS pixels, snapped to device pixels. */
  function rect(s, ink, x, y, w, h) {
    const d = s.dpr;
    const x0 = Math.max(0, Math.round(x * d)), y0 = Math.max(0, Math.round(y * d));
    const x1 = Math.min(s.w, Math.round((x + w) * d)), y1 = Math.min(s.h, Math.round((y + h) * d));
    for (let yy = y0; yy < y1; yy++) s.buf.fill(ink, yy * s.w + x0, yy * s.w + x1);
  }

  /** A border march: dashes running round the edge, offset continuously. */
  function march(s, ink, t, { thickness = 2, dash = 6, gap = 4, speed = 14 } = {}) {
    const d = s.dpr;
    const th = Math.max(1, Math.round(thickness * d));
    const { w, h, buf } = s;
    const period = (dash + gap) * d;
    const on = dash * d;
    const shift = (t * speed * d) % period;
    const per = 2 * (w + h);
    const ink2 = (p) => ((((p - shift) % period) + period) % period) < on;
    for (let x = 0; x < w; x++) {
      if (ink2(x)) for (let k = 0; k < th; k++) buf[k * w + x] = ink;
      if (ink2(per / 2 + (w - 1 - x))) for (let k = 0; k < th; k++) buf[(h - 1 - k) * w + x] = ink;
    }
    for (let y = 0; y < h; y++) {
      if (ink2(w + y)) for (let k = 0; k < th; k++) buf[y * w + (w - 1 - k)] = ink;
      if (ink2(per - 1 - y)) for (let k = 0; k < th; k++) buf[y * w + k] = ink;
    }
  }

  // ---------- painters ----------
  const painters = {
    /** The sortie line's airstream: streaks flowing left to right, paced by working threads. */
    airstream({ pace }) {
      const speed = 12 + 12 * Math.min(pace, 4);
      const strength = 0.16 + 0.06 * Math.min(pace, 4);
      return (s, t) => {
        const ink = pixel(INK.sky);
        const mid = s.cssH / 2, spread = Math.min(20, s.cssH * 0.36);
        field(s, ink, (x, y) => {
          const dy = (y - mid) / spread;
          const env = Math.exp(-dy * dy * 1.6);
          if (env < 0.02) return 0;
          const n = fbm((x - t * speed) / 52, y / 3.2 + Math.sin(x / 160 + t * 0.25) * 0.5);
          const gust = 0.5 + 0.5 * Math.sin((x - t * speed * 1.7) / 140);
          return env * strength * (0.25 + 2.2 * Math.max(0, n - 0.42) * (0.5 + gust));
        });
      };
    },
    /** Inside a peg: a fine fill that drifts while an agent works on it. */
    pegFill({ colour, base, amp = 0, speed = 0, edge = null }) {
      return (s, t) => {
        const ink = pixel(INK[colour]);
        field(s, ink, (x, y) => {
          if (!amp) return base;
          const n = fbm((x + y * 0.6 - t * speed) / 26, (y - t * speed * 0.15) / 18);
          return base + amp * (n - 0.45);
        });
        if (edge) march(s, pixel(INK[edge]), t, { speed: 12 });
      };
    },
    /** Needs you: amber that breathes while the row has an item. */
    needsYou() {
      return (s, t) => {
        const ink = pixel(INK.amber);
        const breath = 0.5 + 0.5 * Math.sin((t * Math.PI * 2) / 3.6);
        const depth = 7 + 3 * breath;
        field(s, ink, (x, y) => {
          const edge = Math.min(y, s.cssH - 1 - y, x * 0.6, (s.cssW - 1 - x) * 0.6);
          if (edge > depth + 2) return 0;
          const n = fbm((x - t * 14) / 40, y / 9 + t * 0.08);
          const falloff = Math.max(0, 1 - edge / depth);
          return falloff * falloff * (0.22 + 0.3 * breath + 0.35 * (n - 0.4));
        });
      };
    },
    /** A still plate: a flat dither level, e.g. green behind a landed number. */
    plate({ colour, level }) {
      return (s) => field(s, pixel(INK[colour]), () => level);
    },
    /** The formation mark: one chevron per lane flying across every project. */
    formation({ flying, el }) {
      const CHEV = ["  #  ", " # # ", "#   #"];
      const slots = [[8, 0], [2, 5], [14, 5], [-4, 10], [20, 10]];
      return (s, t) => {
        const cell = 3;
        const on = pixel(INK.sky);
        const off = pixel(token(el, "--border"));
        const trail = pixel(INK.sky);
        const n = Math.max(3, flying);
        // contrails behind the flying chevrons
        if (flying > 0) {
          field(s, trail, (x, y) => {
            let v = 0;
            for (let i = 0; i < Math.min(flying, slots.length); i++) {
              const [ox, oy] = slots[i];
              const bob = Math.sin(t * 1.3 + i * 1.9) * 0.9;
              const cy = (oy + 1) * cell + bob + 4;
              const cx = (ox + 2.5) * cell + 14;
              const dx = cx - x;
              if (dx < 0 || dx > 44) continue;
              const dyv = (y - cy) / (1.2 + dx * 0.05);
              const flow = fbm((x + t * 22) / 9, i * 7.1 + y / 4);
              v = Math.max(v, Math.exp(-dyv * dyv) * (1 - dx / 44) * (0.25 + 0.55 * flow));
            }
            return v * 0.85;
          });
        }
        for (let i = 0; i < Math.min(n, slots.length); i++) {
          const [ox, oy] = slots[i];
          const flyingHere = i < flying;
          const bob = flyingHere ? Math.sin(t * 1.3 + i * 1.9) * 0.9 : 0;
          const drift = flyingHere ? Math.sin(t * 0.7 + i) * 0.6 : 0;
          CHEV.forEach((row, ry) => [...row].forEach((c, rx) => {
            if (c === "#") rect(s, flyingHere ? on : off, (ox + rx) * cell + 14 + drift, (oy + ry) * cell + 4 + bob, cell, cell);
          }));
        }
      };
    },
    /** The landing burst: green pixels sweep the sortie line once, leaving a fading wake. */
    burst({ seed = 939 }) {
      const bits = Array.from({ length: 110 }, (_, i) => {
        const r = (k) => ((Math.sin((i + 1) * 12.9898 * k + seed) * 43758.5453) % 1 + 1) % 1;
        return { lane: r(1) * 2 - 1, reach: 0.35 + r(2) * 0.65, size: r(3) < 0.25 ? 3 : r(3) < 0.6 ? 2 : 1, delay: r(4) * 0.28, wobble: r(5) * 6.28 };
      });
      const ease = (p) => 1 - Math.pow(1 - p, 4);
      return (s, t) => {
        const green = pixel(INK.green);
        const mid = s.cssH / 2;
        const head = ease(Math.min(1, t / 0.95));
        // wake: a green band behind the head that thins out over 1.4 s
        const fadeOut = Math.max(0, 1 - Math.max(0, t - 0.6) / 0.8);
        field(s, green, (x, y) => {
          const p = x / s.cssW;
          if (p > head) return 0;
          const dy = (y - mid) / Math.min(18, s.cssH * 0.3);
          const behind = 1 - (head - p);
          return Math.exp(-dy * dy) * behind * 0.38 * fadeOut * (0.6 + 0.4 * noise(x / 7 - t * 30, y / 3));
        });
        for (const b of bits) {
          const p = ease(Math.max(0, Math.min(1, (t - b.delay) / 0.9)));
          if (p <= 0 || t - b.delay > 1.3) continue;
          const x = p * b.reach * s.cssW;
          const y = mid + b.lane * Math.min(s.cssH * 0.45, 40) * (0.4 + 0.6 * p) + Math.sin(b.wobble + t * 9) * 1.5;
          rect(s, green, x, y, b.size, b.size);
        }
      };
    },
  };

  return {
    surface, release, refresh, setReduced, painters, token, INK,
    get reduced() { return reduced(); },
    /** For the comp's own checks: frames drawn, and whether the loop runs. */
    stats: () => ({ frames, running: raf !== 0, lastFrameAt, surfaces: surfaces.size, animated: [...surfaces].filter((s) => s.animated).length }),
  };
})();
