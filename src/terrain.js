import { CONFIG as C } from './config.js';

// Integer hash -> pseudo-random value in [-1, 1].
function hash(i, seed) {
  let h = Math.imul(i ^ seed, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 2147483647.5 - 1;
}
const cosLerp = (a, b, t) => a + (b - a) * (1 - Math.cos(t * Math.PI)) * 0.5;

export class TerrainManager {
  constructor(seed = (Math.random() * 0x7fffffff) | 0) {
    this.seed = seed;
    this.vertices = []; // rolling buffer of {x, y}, evenly spaced by SEGMENT_WIDTH
  }

  // Multi-octave cosine-interpolated value noise, normalized to [-1, 1].
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

  // Analytic height: continuous downhill + noise (eased in so the start is gentle).
  heightFn(x) {
    const r = Math.min(1, Math.max(0, (x + 200) / 1400));
    const ramp = r * r * (3 - 2 * r);
    return x * C.BASE_SLOPE_DROP + this.noise(x) * C.NOISE_AMPLITUDE * ramp;
  }

  // Extend the buffer ahead of the camera and prune vertices left behind it.
  update(camera, windowWidth) {
    const SW = C.SEGMENT_WIDTH, v = this.vertices;
    const back = Math.max(400, (windowWidth * C.CAMERA_LEAD_X) / C.MIN_ZOOM + 60);
    const minX = camera.x - back;
    const maxX = camera.x + windowWidth * 2.5;

    if (!v.length || v[v.length - 1].x < minX || v[0].x > maxX) {
      v.length = 0;
      const x0 = Math.floor(minX / SW) * SW;
      v.push({ x: x0, y: this.heightFn(x0) });
    }
    while (v.length > 2 && v[1].x < minX) v.shift();
    while (v[v.length - 1].x < maxX) {
      const x = v[v.length - 1].x + SW;
      v.push({ x, y: this.heightFn(x) });
    }
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

  // Tangent angle in radians. Positive = descending (y grows downward).
  getSlopeAngleAt(x) {
    const dx = C.SEGMENT_WIDTH;
    return Math.atan2(this.getHeightAt(x + dx) - this.getHeightAt(x - dx), dx * 2);
  }

  // view = { left, right, top, bottom } in world coordinates.
  render(ctx, view) {
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
    g.addColorStop(0, '#222850');
    g.addColorStop(1, '#090a1a');
    ctx.fillStyle = g;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(v[i0].x, v[i0].y);
    for (let i = i0 + 1; i <= i1; i++) ctx.lineTo(v[i].x, v[i].y);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(160, 185, 240, 0.35)'; // soft cool halo under the crust
    ctx.lineWidth = 10;
    ctx.stroke();
    ctx.strokeStyle = '#fbf6ee';                    // crisp snow crust
    ctx.lineWidth = 3;
    ctx.stroke();
  }
}