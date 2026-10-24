import { CONFIG as C } from './config.js';

const TAU = Math.PI * 2;
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const css = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (t) => t * t * (3 - 2 * t);

function hash(i, seed) {
  let h = Math.imul(i ^ seed, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 2147483647.5 - 1;
}
const cosLerp = (a, b, t) => a + (b - a) * (1 - Math.cos(t * Math.PI)) * 0.5;
function fbm(x, seed) { // 3 octaves, deterministic, ~[-1, 1]
  let sum = 0, amp = 1, norm = 0, f = 1;
  for (let o = 0; o < 3; o++) {
    const p = x * f, i = Math.floor(p), s = seed + o * 131;
    sum += amp * cosLerp(hash(i, s), hash(i + 1, s), p - i);
    norm += amp; amp *= 0.5; f *= 2.1;
  }
  return sum / norm;
}

const KEYS = ['zenith', 'horizon', 'fog', 'sun', 'groundTop', 'groundBottom', 'crust'];

export class Atmosphere {
  constructor() {
    this.keys = C.PALETTES.map((p) => {
      const k = { name: p.name, night: p.night, layers: p.layers.map(hex) };
      for (const n of KEYS) k[n] = hex(p[n]);
      return k;
    });
    this.time = C.START_TIME_OF_DAY * C.CYCLE_SECONDS;
    this.timeOfDay = 0;   // 0..1 through the cycle
    this.phase = 'DAWN';  // DAWN | DAY | DUSK | NIGHT
    this.phaseIndex = 0;
    this.nightFactor = 0; // 0 (day) .. 1 (deep night)
    this.glow = 0;        // 0..1 obstacle rim-glow strength, derived from nightFactor
    this.starAlpha = 0;
    this.wind = 40;       // px/s, drives snow drift
    this.raw = null;
    this.palette = null;
    this.stars = Array.from({ length: C.STAR_COUNT }, (_, i) => ({
      x: (hash(i, 1) + 1) / 2, y: ((hash(i, 2) + 1) / 2) * 0.62,
      s: 0.8 + ((hash(i, 3) + 1) / 2) * 1.6, tw: 1 + (hash(i, 4) + 1) * 1.5,
    }));
    this.snow = Array.from({ length: C.SNOW_COUNT }, () => ({
      x: Math.random(), y: Math.random(), d: 0.3 + Math.random() * 0.7, ph: Math.random() * TAU,
    }));
    this._lastCamX = null;
    this._lastCamY = null;
    this._advance();
  }

  skipPhase() { this.time = ((this.phaseIndex + 1) / this.keys.length) * C.CYCLE_SECONDS; this._advance(); }

  _advance() {
    const n = this.keys.length;
    const u = ((this.time / C.CYCLE_SECONDS) % 1 + 1) % 1;
    const f = u * n, i = Math.floor(f) % n, t = smooth(f - Math.floor(f));
    const a = this.keys[i], b = this.keys[(i + 1) % n], r = {};
    for (const k of KEYS) r[k] = mix(a[k], b[k], t);
    r.layers = a.layers.map((c, j) => mix(c, b.layers[j], t));
    this.raw = r;
    const p = {};
    for (const k of KEYS) p[k] = css(r[k]);
    p.layers = r.layers.map((c) => css(c));
    this.palette = p;
    this.timeOfDay = u;
    this.phaseIndex = i;
    this.phase = a.name;
    this.nightFactor = a.night + (b.night - a.night) * t;
    this.glow = clamp((this.nightFactor - 0.25) / 0.55, 0, 1);
    this.starAlpha = clamp((this.nightFactor - 0.5) / 0.45, 0, 1);
  }

  update(dt, camera, W, H) {
    this.time += dt;
    this._advance();
    this.wind = 45 + 30 * Math.sin(this.time * 0.23) + 18 * Math.sin(this.time * 0.71);

    const dx = this._lastCamX === null ? 0 : (camera.x - this._lastCamX) * camera.scale;
    const dy = this._lastCamY === null ? 0 : (camera.y - this._lastCamY) * camera.scale;
    this._lastCamX = camera.x;
    this._lastCamY = camera.y;
    for (const p of this.snow) {
      p.ph += dt * (0.8 + p.d);
      const vx = this.wind * p.d + Math.sin(p.ph) * 18 * p.d;
      const vy = 36 + 70 * p.d;
      p.x += (vx * dt - dx * p.d * 0.9) / W;
      p.y += (vy * dt - dy * p.d * 0.9) / H;
      p.x -= Math.floor(p.x);
      p.y -= Math.floor(p.y);
    }
  }

  renderBackground(ctx, W, H, camera) {
    const r = this.raw, hy = H * 0.62;
    const g = ctx.createLinearGradient(0, 0, 0, hy);
    g.addColorStop(0, css(r.zenith));
    g.addColorStop(1, css(r.horizon));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, hy);
    ctx.fillStyle = css(mix(r.horizon, r.fog, 0.6));
    ctx.fillRect(0, hy - 1, W, H - hy + 1);

    this._stars(ctx, W, H, camera);
    const t = this.timeOfDay, uu = t > 0.94 ? t - 1 : t;
    this._body(ctx, W, H, camera.unit, (uu + 0.06) / 0.62, false);
    this._body(ctx, W, H, camera.unit, ((((t - 0.48) % 1) + 1) % 1) / 0.62, true);
    for (let i = 0; i < C.PARALLAX_SCROLL.length; i++) this._layer(ctx, i, W, H, camera);
  }

  _stars(ctx, W, H, camera) {
    if (this.starAlpha < 0.02) return;
    const shift = camera.x * 0.01 * camera.unit;
    ctx.fillStyle = '#ffffff';
    for (const s of this.stars) {
      const x = (((s.x * W - shift) % W) + W) % W;
      ctx.globalAlpha = this.starAlpha * (0.55 + 0.45 * Math.sin(this.time * s.tw + s.tw * 7));
      ctx.fillRect(x, s.y * H, s.s, s.s);
    }
    ctx.globalAlpha = 1;
  }

  // Sun or moon on an arc from the right horizon to the left horizon; T in [0,1] while visible.
  _body(ctx, W, H, unit, T, moon) {
    if (T < 0 || T > 1) return;
    const e = Math.sin(Math.PI * T), a = clamp(e * 3, 0, 1);
    const x = W * (0.84 - 0.68 * T), y = H * 0.62 - e * H * (moon ? 0.5 : 0.44);
    const r = (moon ? 20 : 30) * unit * (1 + 0.35 * (1 - e)) + 4;
    const col = moon ? [232, 240, 255] : this.raw.sun;
    const glow = ctx.createRadialGradient(x, y, r * 0.4, x, y, r * (moon ? 5 : 7));
    glow.addColorStop(0, css(col, (moon ? 0.3 : 0.55) * a));
    glow.addColorStop(1, css(col, 0));
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(x, y, r * (moon ? 5 : 7), 0, TAU); ctx.fill();
    ctx.fillStyle = css(col, a);
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
    if (moon) {
      ctx.fillStyle = `rgba(150,170,210,${0.35 * a})`;
      for (const [cx, cy, cr] of [[-0.3, -0.2, 0.22], [0.25, 0.1, 0.3], [-0.05, 0.4, 0.16]]) {
        ctx.beginPath(); ctx.arc(x + cx * r, y + cy * r, cr * r, 0, TAU); ctx.fill();
      }
    }
  }

  _layer(ctx, i, W, H, camera) {
    const f = C.PARALLAX_SCROLL[i], u = camera.unit, r = this.raw;
    const L0 = camera.x * f * u; // layer-space x of the screen's left edge (zoom-independent)
    const devY = camera.y - camera.x * C.BASE_SLOPE_DROP; // only react to deviation from the average descent
    const baseY = H * C.PARALLAX_BASE_Y[i] - devY * f * u * 0.5;
    const amp = C.PARALLAX_AMP[i] * u, wl = C.PARALLAX_WAVELENGTH[i] * u;
    const ridged = C.PARALLAX_RIDGED[i], seed = 4001 + i * 211;
    const ridgeY = (L) => { const n = fbm(L / wl, seed); return baseY - amp * (ridged ? 1 - Math.abs(n) : n * 0.5 + 0.5); };
    const col = r.layers[i];

    const grad = ctx.createLinearGradient(0, baseY - amp, 0, H);
    grad.addColorStop(0, css(col));
    grad.addColorStop(1, css(mix(col, r.fog, C.PARALLAX_FOG[i]))); // haze pools toward the valley
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(-10, H + 2);
    for (let sx = -10; sx <= W + 10; sx += 10) ctx.lineTo(sx, ridgeY(sx + L0));
    ctx.lineTo(W + 10, H + 2);
    ctx.closePath();
    ctx.fill();

    if (i === C.PARALLAX_SCROLL.length - 1) this._trees(ctx, W, L0, u, ridgeY, mix(col, [0, 0, 0], 0.18));
  }

  _trees(ctx, W, L0, u, ridgeY, color) {
    const sp = C.TREE_SPACING * u;
    const i0 = Math.floor((L0 - 40) / sp), i1 = Math.ceil((L0 + W + 40) / sp);
    const [h0, h1] = C.TREE_HEIGHT;
    ctx.fillStyle = css(color);
    ctx.beginPath();
    for (let k = i0; k <= i1; k++) {
      if (hash(k, 9) < -0.3) continue;
      const L = k * sp + hash(k, 7) * sp * 0.45, sx = L - L0, y = ridgeY(L) + 3;
      const h = (h0 + ((hash(k, 11) + 1) / 2) * (h1 - h0)) * u, w = h * 0.5;
      for (let j = 0; j < 3; j++) { // three stacked tiers per pine
        const top = y - h + j * h * 0.26, bot = top + h * 0.42, half = w * 0.5 * (0.55 + j * 0.25);
        ctx.moveTo(sx, top); ctx.lineTo(sx + half, bot); ctx.lineTo(sx - half, bot); ctx.closePath();
      }
      ctx.rect(sx - 1.2 * u, y - h * 0.1, 2.4 * u, h * 0.1 + 3);
    }
    ctx.fill();
  }

  // Drawn on top of the world, in screen space.
  renderForeground(ctx, W, H) {
    const c = mix([255, 255, 255], [188, 214, 255], this.nightFactor);
    for (const p of this.snow) {
      const s = 1 + p.d * 2.2;
      ctx.fillStyle = css(c, 0.45 + 0.45 * p.d);
      if (s > 2.4) { ctx.beginPath(); ctx.arc(p.x * W, p.y * H, s * 0.5, 0, TAU); ctx.fill(); }
      else ctx.fillRect(p.x * W, p.y * H, s, s);
    }
  }
}