import { CONFIG as C } from './config.js';
import { PlayerState, Emitter } from './player.js';

const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const range = (r, rnd) => lerp(r[0], r[1], rnd());
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const INK = '#14162b';
const FLAGS = ['#e8574a', '#f2b84b', '#4aa3c7', '#7bc67e', '#d46ab2'];

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/*
 Procedural obstacle chunks. Each CHUNK_WIDTH chunk past the grace zone holds at most one feature
 (rocks / rail / roof / chasm / nothing), chosen deterministically from the terrain seed.
 update() must run BEFORE TerrainManager.update() each frame: chasms are registered with the
 terrain before its vertex buffer reaches them.
 Events: grind, rockSmash, rockHit.
*/
export class ObstacleManager extends Emitter {
  constructor(terrain) {
    super();
    this.terrain = terrain;
    this.seed = terrain.seed;
    this.rocks = [];
    this.surfaces = []; // grindable rails + roofs
    this.nextChunk = Math.ceil(C.SAFE_ZONE_PX / C.CHUNK_WIDTH);
    this._id = 1;
    this._frame = 0;
  }

  update(camera, windowWidth) {
    const horizon = camera.x + windowWidth * 2.5 + C.CHUNK_WIDTH;
    while (this.nextChunk * C.CHUNK_WIDTH < horizon) this._spawnChunk(this.nextChunk++);
    if (++this._frame % 30 === 0) {
      const minX = camera.x - (windowWidth * C.CAMERA_LEAD_X / C.MIN_ZOOM + 500);
      this.rocks = this.rocks.filter((r) => r.alive && r.x > minX);
      this.surfaces = this.surfaces.filter((s) => s.x1 > minX);
    }
  }

  // ---------- spawning ----------
  _spawnChunk(k) {
    const start = k * C.CHUNK_WIDTH;
    if (start < C.SAFE_ZONE_PX) return; // grace period: nothing in the first 250 m
    const rnd = mulberry32((this.seed ^ Math.imul(k + 1, 0x9e3779b1)) >>> 0);
    const diff = clamp((start - C.SAFE_ZONE_PX) / C.DIFFICULTY_RAMP_PX, 0, 1);
    const table = [['empty', 0.1], ['rocks', 0.32], ['rail', 0.2], ['roof', 0.16], ['chasm', 0.12 + 0.1 * diff]];
    let r = rnd() * table.reduce((s, e) => s + e[1], 0), kind = 'empty';
    for (const [name, w] of table) if ((r -= w) < 0) { kind = name; break; }

    if (kind === 'rocks') this._spawnRocks(start, rnd, diff);
    else if (kind === 'rail') this._spawnRail(start, rnd);
    else if (kind === 'roof') this._spawnRoof(start, rnd);
    else if (kind === 'chasm' && !this._spawnChasm(start, rnd, diff)) this._spawnRocks(start, rnd, diff);
  }

  _spawnRocks(start, rnd, diff) {
    const n = 1 + Math.floor(rnd() * (2 + diff * 2));
    let x = start + 150 + rnd() * 100;
    for (let i = 0; i < n && x < start + C.CHUNK_WIDTH - 120; i++) {
      const w = range(C.ROCK_WIDTH, rnd), h = w * range(C.ROCK_ASPECT, rnd);
      const pts = [];
      for (let j = 0; j <= 7; j++) { // jagged half-ellipse, left to right
        const a = Math.PI * (1 - j / 7);
        pts.push([Math.cos(a) * (w / 2) * (0.9 + rnd() * 0.2), -Math.sin(a) * h * (0.85 + rnd() * 0.3)]);
      }
      this.rocks.push({ id: this._id++, x, w, h, pts, alive: true });
      x += 140 + rnd() * 120;
    }
  }

  _spawnRail(start, rnd) {
    const t = this.terrain, k = C.RAIL_CATENARY_K, ck = Math.cosh(k);
    const xa = start + 200 + rnd() * 150, xb = xa + range(C.RAIL_LENGTH, rnd);
    const ph = range(C.RAIL_POLE_HEIGHT, rnd), sag = range(C.RAIL_SAG, rnd);
    const ya = t.heightFn(xa) - ph, yb = t.heightFn(xb) - ph;
    const yAt = (x) => { // catenary: straight line between poles plus a cosh sag
      const u = clamp((x - xa) / (xb - xa), 0, 1);
      return ya + (yb - ya) * u + (sag * (ck - Math.cosh(k * (2 * u - 1)))) / (ck - 1);
    };
    this.surfaces.push({
      id: this._id++, kind: 'rail', x0: xa, x1: xb, yAt, slopeAt: (x) => (yAt(x + 1) - yAt(x - 1)) / 2,
    });
  }

  _spawnRoof(start, rnd) {
    const t = this.terrain, over = C.ROOF_OVERHANG;
    const xa = start + 230 + rnd() * 120, xb = xa + range(C.ROOF_WIDTH, rnd), xm = (xa + xb) / 2;
    const wallH = range(C.ROOF_WALL_HEIGHT, rnd), rise = range(C.ROOF_RISE, rnd);
    const eaveA = t.heightFn(xa) - wallH, eaveB = t.heightFn(xb) - wallH;
    const apex = (eaveA + eaveB) / 2 - rise;
    const sL = (apex - eaveA) / (xm - xa), sR = (eaveB - apex) / (xb - xm);
    const yAt = (x) => (x <= xm ? eaveA + sL * (x - xa) : apex + sR * (x - xm));
    this.surfaces.push({
      id: this._id++, kind: 'roof', x0: xa - over, x1: xb + over, xa, xb, xm, eaveA, eaveB, apex,
      yAt, slopeAt: (x) => (x <= xm ? sL : sR),
    });
  }

  // Returns false if the terrain here can't host a jumpable chasm (far lip too high).
  _spawnChasm(start, rnd, diff) {
    const SW = C.SEGMENT_WIDTH, t = this.terrain;
    const gap = Math.round(lerp(C.CHASM_GAP[0], C.CHASM_GAP[1], clamp(0.2 + 0.5 * rnd() + 0.3 * diff, 0, 1)) / SW) * SW;
    for (let attempt = 0; attempt < 6; attempt++) {
      const x0 = Math.round((start + 260 + rnd() * 160) / SW) * SW, x1 = x0 + gap;
      if (t.baseHeight(x1) - t.baseHeight(x0) < 0.18 * gap) continue;               // far lip must sit below the launch lip
      if (t.baseHeight(x0) - t.baseHeight(x0 - 50) > 0.5 * 50) continue;             // too steep: the kicker wouldn't point upward
      t.addChasm({ x0, x1, kickLen: C.CHASM_KICK_LEN, kickH: C.CHASM_KICK_HEIGHT, depth: C.CHASM_DEPTH });
      return true;
    }
    return false;
  }

  // ---------- collisions (call after every Player.update substep) ----------
  resolve(player) {
    if (player.state === PlayerState.CRASHED) return;
    const px = player.x, py = player.y;

    if (player.state === PlayerState.AIRBORNE && player.vy > 0) {
      for (const s of this.surfaces) {
        if (px < s.x0 || px > s.x1) continue;
        if (s === player.ignoreSurface && player.ignoreTimer > 0) continue;
        const yNow = s.yAt(px), yPrev = s.yAt(clamp(player.prevX, s.x0, s.x1));
        if (player.prevY <= yPrev + C.GRIND_SNAP_TOLERANCE && py >= yNow - 2) { // crossed the rail from above
          player.startGrind(s);
          this.emit('grind', { surface: s });
          return;
        }
      }
    }

    const pl = px - C.PLAYER_HALF_WIDTH, pr = px + C.PLAYER_HALF_WIDTH, pt = py - C.PLAYER_HEIGHT;
    for (const rock of this.rocks) {
      if (!rock.alive || Math.abs(rock.x - px) > rock.w) continue;
      const gy = this.terrain.getHeightAt(rock.x);
      const hw = rock.w * 0.5 * C.ROCK_HITBOX_SCALE, hh = rock.h * C.ROCK_HITBOX_SCALE, top = gy - hh;
      if (pr < rock.x - hw || pl > rock.x + hw || py < top || pt > gy) continue;

      const fromTop = player.state === PlayerState.AIRBORNE && player.vy > 0 && player.prevY <= top + 12;
      if (fromTop || player.invulnerable) { this._smash(rock, player, fromTop, gy - hh * 0.5); return; }
      player.crash(this.terrain, 1, 'rock');
      this.emit('rockHit', { rock });
      return;
    }
  }

  _smash(rock, player, bounce, cy) {
    rock.alive = false;
    player.burst(rock.x, cy, 18, { colors: ['#2a2d4f', '#0e1022', '#3b3f6b'], speed: [120, 420], size: [3, 6], life: [0.5, 0.9], gravity: 900 });
    player.burst(rock.x, cy, 8, { colors: ['#5ff3ff', '#ffffff'], speed: [100, 340], size: [1.5, 3], life: [0.3, 0.6], add: true });
    player.onRockSmash(rock, bounce);
    this.emit('rockSmash', { rock, x: rock.x, y: cy, bounce });
  }

  // ---------- rendering ----------
  render(ctx, view, palette, glow = 0) {
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const s of this.surfaces) {
      if (s.x1 < view.left - 200 || s.x0 > view.right + 200) continue;
      if (s.kind === 'rail') this._drawRail(ctx, s, glow); else this._drawRoof(ctx, s, glow, palette);
    }
    for (const r of this.rocks) {
      if (!r.alive || r.x < view.left - 150 || r.x > view.right + 150) continue;
      this._drawRock(ctx, r, glow, palette);
    }
  }

  _glowStroke(ctx, rgb, glow, width) {
    ctx.save();
    ctx.shadowColor = rgba(rgb, 0.9 * glow);
    ctx.shadowBlur = 12;
    ctx.strokeStyle = rgba(rgb, 0.85 * glow);
    ctx.lineWidth = width;
    ctx.stroke();
    ctx.restore();
  }

  _drawRock(ctx, r, glow, palette) {
    const gy = this.terrain.getHeightAt(r.x), tilt = this.terrain.getSlopeAngleAt(r.x) * 0.7;
    ctx.save();
    ctx.translate(r.x, gy);
    ctx.rotate(tilt);
    ctx.beginPath();
    ctx.moveTo(-r.w / 2, 7);
    for (const p of r.pts) ctx.lineTo(p[0], p[1]);
    ctx.lineTo(r.w / 2, 7);
    ctx.closePath();
    ctx.fillStyle = '#10122a';
    ctx.fill();
    if (glow > 0.02) this._glowStroke(ctx, C.GLOW_CYAN, glow, 2);
    ctx.beginPath(); // snow dusting along the top
    for (let i = 1; i < r.pts.length - 1; i++) {
      if (i === 1) ctx.moveTo(r.pts[i][0], r.pts[i][1] + 1); else ctx.lineTo(r.pts[i][0], r.pts[i][1] + 1);
    }
    ctx.strokeStyle = palette.crust;
    ctx.globalAlpha = 0.75;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  _drawRail(ctx, s, glow) {
    const t = this.terrain;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 4;
    for (const x of [s.x0, s.x1]) { // posts
      ctx.beginPath(); ctx.moveTo(x, t.getHeightAt(x) + 6); ctx.lineTo(x, s.yAt(x) - 6); ctx.stroke();
    }
    const path = () => {
      ctx.beginPath();
      for (let x = s.x0; x < s.x1 + 10; x += 10) {
        const xx = Math.min(x, s.x1), y = s.yAt(xx);
        if (x === s.x0) ctx.moveTo(xx, y); else ctx.lineTo(xx, y);
      }
    };
    path();
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = INK;
    ctx.stroke();

    ctx.globalAlpha = 1 - 0.35 * glow;
    let i = 0;
    for (let x = s.x0 + 22; x < s.x1 - 10; x += 36, i++) { // bunting flags
      const y = s.yAt(x);
      ctx.fillStyle = FLAGS[i % FLAGS.length];
      ctx.beginPath(); ctx.moveTo(x - 8, y); ctx.lineTo(x + 8, y); ctx.lineTo(x, y + 17); ctx.closePath(); ctx.fill();
    }
    ctx.globalAlpha = 1;
    if (glow > 0.02) { path(); this._glowStroke(ctx, C.GLOW_GOLD, glow, 2); }
  }

  _drawRoof(ctx, s, glow, palette) {
    const t = this.terrain, { xa, xb, xm, eaveA, eaveB, apex } = s;
    const gA = t.getHeightAt(xa), gB = t.getHeightAt(xb);

    ctx.fillStyle = '#171a33'; // house body with gabled front
    ctx.beginPath();
    ctx.moveTo(xa, gA + 30); ctx.lineTo(xa, eaveA); ctx.lineTo(xm, apex); ctx.lineTo(xb, eaveB); ctx.lineTo(xb, gB + 30);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = rgba(C.GLOW_GOLD, 0.25 + 0.65 * glow); // lit windows
    for (const f of [0.28, 0.72]) {
      const x = lerp(xa, xb, f), eave = lerp(eaveA, eaveB, f), wy = eave + (t.getHeightAt(x) - eave) * 0.4;
      ctx.fillRect(x - 9, wy - 11, 18, 22);
    }

    const roof = () => {
      ctx.beginPath();
      ctx.moveTo(s.x0, s.yAt(s.x0)); ctx.lineTo(xm, apex); ctx.lineTo(s.x1, s.yAt(s.x1));
    };
    roof();
    ctx.strokeStyle = '#4a3328'; // wooden shingles
    ctx.lineWidth = 7;
    ctx.stroke();
    ctx.save();
    ctx.translate(0, -4);
    roof();
    ctx.strokeStyle = palette.crust; // snow on the ridge
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.restore();
    if (glow > 0.02) { roof(); this._glowStroke(ctx, C.GLOW_GOLD, glow, 2); }
  }
}