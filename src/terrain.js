import { CONFIG as C } from './config.js';

function hash(i, seed) {
  let h = Math.imul(i ^ seed, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 2147483647.5 - 1;
}
const cosLerp = (a, b, t) => a + (b - a) * (1 - Math.cos(t * Math.PI)) * 0.5;
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

export class TerrainManager {
  constructor(seed = (Math.random() * 0x7fffffff) | 0) {
    this.seed = seed;
    this.vertices = []; // rolling buffer of {x, y, d}; d = true for vertices at the bottom of a chasm
    this.chasms = [];   // {x0, x1, kickLen, kickH, depth}; x0/x1 are the lip x positions (multiples of SEGMENT_WIDTH)
  }

  noise(x) {
    let sum = 0, amp = 1, norm = 0, freq = C.NOISE_FREQUENCY;
    for (let o = 0; o < C.NOISE_OCTAVES; o++) {
      const p = x * freq, i = Math.floor(p), s = this.seed + o * 977;
      sum += amp * cosLerp(hash(i, s), hash(i + 1, s), p - i);
      norm += amp;
      amp *= C.NOISE_PERSISTENCE;
      freq *= 2;
    }
    return sum / norm;
  }

  // Natural terrain with no chasms: continuous downhill + eased-in noise.
  baseHeight(x) {
    const r = Math.min(1, Math.max(0, (x + 200) / 1400));
    const ramp = r * r * (3 - 2 * r);
    return x * C.BASE_SLOPE_DROP + this.noise(x) * C.NOISE_AMPLITUDE * ramp;
  }

  // Chasms must be registered BEFORE the vertex buffer reaches their x range
  // (ObstacleManager.update runs ahead of TerrainManager.update every frame).
  addChasm(c) { this.chasms.push(c); }

  chasmAt(x) {
    for (const c of this.chasms) if (x > c.x0 && x < c.x1) return c;
    return null;
  }

  // Terrain including chasm geometry: a kicker ramp rising into the lip, then a deep gap.
  heightFn(x) {
    let h = this.baseHeight(x);
    for (const c of this.chasms) {
      if (x > c.x0 && x < c.x1) h += c.depth;
      else if (x <= c.x0 && x >= c.x0 - c.kickLen) {
        const t = (x - (c.x0 - c.kickLen)) / c.kickLen;
        h -= c.kickH * t * t;
      }
    }
    return h;
  }

  update(camera, windowWidth) {
    const SW = C.SEGMENT_WIDTH, v = this.vertices;
    const back = Math.max(400, (windowWidth * C.CAMERA_LEAD_X) / C.MIN_ZOOM + 60);
    const minX = camera.x - back;
    const maxX = camera.x + windowWidth * 2.5;

    if (!v.length || v[v.length - 1].x < minX || v[0].x > maxX) {
      v.length = 0;
      const x0 = Math.floor(minX / SW) * SW;
      v.push({ x: x0, y: this.heightFn(x0), d: !!this.chasmAt(x0) });
    }
    while (v.length > 2 && v[1].x < minX) v.shift();
    while (v[v.length - 1].x < maxX) {
      const x = v[v.length - 1].x + SW;
      v.push({ x, y: this.heightFn(x), d: !!this.chasmAt(x) });
    }
    while (this.chasms.length && this.chasms[0].x1 < minX - 800) this.chasms.shift();
  }

  getHeightAt(x) {
    const v = this.vertices;
    if (v.length > 1 && x >= v[0].x && x <= v[v.length - 1].x) {
      const f = (x - v[0].x) / C.SEGMENT_WIDTH;
      const i = Math.min(Math.floor(f), v.length - 2);
      return v[i].y + (v[i + 1].y - v[i].y) * (f - i);
    }
    return this.heightFn(x);
  }

  // Tangent angle (radians, positive = descending). Samples are kept on the same side of a
  // chasm as x so a lip reports the real takeoff angle instead of the near-vertical wall.
  getSlopeAngleAt(x) {
    const dx = C.SEGMENT_WIDTH;
    let a = x - dx, b = x + dx;
    for (const c of this.chasms) {
      if (b > c.x0 && a < c.x1) {
        if (x < (c.x0 + c.x1) / 2) { b = Math.min(b, c.x0); a = Math.min(a, b - 2 * dx); }
        else { a = Math.max(a, c.x1); b = Math.max(b, a + 2 * dx); }
      }
    }
    return Math.atan2(this.getHeightAt(b) - this.getHeightAt(a), b - a);
  }

  // view = {left,right,top,bottom}; palette = Atmosphere.palette; glow = Atmosphere.glow (0..1)
  render(ctx, view, palette, glow = 0) {
    const v = this.vertices, SW = C.SEGMENT_WIDTH;
    if (v.length < 2) return;
    const i0 = Math.max(0, Math.floor((view.left - v[0].x) / SW) - 1);
    const i1 = Math.min(v.length - 1, Math.ceil((view.right - v[0].x) / SW) + 1);
    if (i1 <= i0) return;

    const bottom = view.bottom + 60;
    ctx.beginPath();
    ctx.moveTo(v[i0].x, bottom);
    for (let i = i0; i <= i1; i++) ctx.lineTo(v[i].x, v[i].y);
    ctx.lineTo(v[i1].x, bottom);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, view.top, 0, view.bottom);
    g.addColorStop(0, palette.groundTop);
    g.addColorStop(1, palette.groundBottom);
    ctx.fillStyle = g;
    ctx.fill();

    // Snow crust: skip chasm interiors so the gap reads as a drop, not a valley floor.
    const crust = () => {
      ctx.beginPath();
      let pen = false;
      for (let i = i0; i <= i1; i++) {
        const p = v[i];
        if (p.d) { pen = false; continue; }
        if (pen) ctx.lineTo(p.x, p.y); else { ctx.moveTo(p.x, p.y); pen = true; }
      }
    };
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    crust();
    ctx.strokeStyle = 'rgba(160, 185, 240, 0.35)';
    ctx.lineWidth = 10;
    ctx.stroke();
    crust();
    ctx.strokeStyle = palette.crust;
    ctx.lineWidth = 3;
    ctx.stroke();

    if (glow > 0.02) this._renderChasmGlow(ctx, view, glow);
  }

  // Gold rim-glow on the kicker ramp and the lip walls so chasms stay readable at night.
  _renderChasmGlow(ctx, view, glow) {
    const SW = C.SEGMENT_WIDTH, gold = C.GLOW_GOLD;
    ctx.save();
    ctx.shadowColor = rgba(gold, 0.9 * glow);
    ctx.shadowBlur = 14;
    ctx.strokeStyle = rgba(gold, 0.85 * glow);
    ctx.lineCap = 'round';
    ctx.lineWidth = 3;
    for (const c of this.chasms) {
      if (c.x1 < view.left - 100 || c.x0 - c.kickLen > view.right + 100) continue;
      ctx.beginPath(); // kicker ramp
      for (let x = c.x0 - c.kickLen; x <= c.x0; x += SW) {
        const y = this.getHeightAt(x) - 3;
        if (x === c.x0 - c.kickLen) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      const y0 = this.getHeightAt(c.x0), yd = this.getHeightAt(c.x0 + SW);
      const t0 = Math.min(1, 150 / Math.max(1, yd - y0));
      ctx.beginPath(); // left lip wall
      ctx.moveTo(c.x0, y0);
      ctx.lineTo(c.x0 + SW * t0, y0 + (yd - y0) * t0);
      ctx.stroke();
      const y1 = this.getHeightAt(c.x1), yr = this.getHeightAt(c.x1 - SW);
      const t1 = Math.min(1, 150 / Math.max(1, yr - y1));
      ctx.beginPath(); // right lip wall
      ctx.moveTo(c.x1, y1);
      ctx.lineTo(c.x1 - SW * t1, y1 + (yr - y1) * t1);
      ctx.stroke();
    }
    ctx.restore();
  }
}