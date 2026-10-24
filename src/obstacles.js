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
 Collectibles (Milestone 4): Gold Coin rows/arcs, Gilded Chime and Overdrive Harp pickups are placed
 from a SEPARATE seeded RNG stream per chunk, so hazard layout is identical with or without them.
 Events: grind, rockSmash, rockHit, coinPickup {coin,x,y}, multiplierPickup {kind,x,y}.
*/
export class ObstacleManager extends Emitter {
  constructor(terrain, economy = null) {
    super();
    this.terrain = terrain;
    this.economy = economy; // optional: supplies Chime spawn chance and Magnet radius
    this.seed = terrain.seed;
    this.rocks = [];
    this.surfaces = []; // grindable rails + roofs
    this.coins = [];    // {x, y, ph, alive, pulled}
    this.pickups = [];  // {id, kind: 'chime'|'harp', x, y, ph, alive}
    this.nextChunk = Math.ceil(C.COIN_START_PX / C.CHUNK_WIDTH); // coins start before the hazard-free zone ends
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
      this.coins = this.coins.filter((c) => c.alive && c.x > minX);
      this.pickups = this.pickups.filter((p) => p.alive && p.x > minX);
    }
  }

  // ---------- spawning ----------
  _spawnChunk(k) {
    const start = k * C.CHUNK_WIDTH;
    const cr = mulberry32(((this.seed ^ 0x51ed270b) ^ Math.imul(k + 1, 0x85ebca6b)) >>> 0); // collectibles stream
    if (start < C.SAFE_ZONE_PX) { // grace period: no hazards in the first 250 m, but coins may appear
      this._spawnCollectibles(start, cr, 'empty', [], [], null);
      return;
    }
    const rnd = mulberry32((this.seed ^ Math.imul(k + 1, 0x9e3779b1)) >>> 0);
    const diff = clamp((start - C.SAFE_ZONE_PX) / C.DIFFICULTY_RAMP_PX, 0, 1);
    const table = [['empty', 0.1], ['rocks', 0.32], ['rail', 0.2], ['roof', 0.16], ['chasm', 0.12 + 0.1 * diff]];
    let r = rnd() * table.reduce((s, e) => s + e[1], 0), kind = 'empty';
    for (const [name, w] of table) if ((r -= w) < 0) { kind = name; break; }

    const r0 = this.rocks.length, s0 = this.surfaces.length, cs = this.terrain.chasms, lastChasm = cs[cs.length - 1];
    if (kind === 'rocks') this._spawnRocks(start, rnd, diff);
    else if (kind === 'rail') this._spawnRail(start, rnd);
    else if (kind === 'roof') this._spawnRoof(start, rnd);
    else if (kind === 'chasm' && !this._spawnChasm(start, rnd, diff)) this._spawnRocks(start, rnd, diff);

    const rocks = this.rocks.slice(r0), surfaces = this.surfaces.slice(s0);
    const chasm = cs[cs.length - 1] !== lastChasm ? cs[cs.length - 1] : null;
    const actual = chasm ? 'chasm' : surfaces.length ? 'surface' : rocks.length ? 'rocks' : 'empty';
    this._spawnCollectibles(start, cr, actual, rocks, surfaces, chasm);
  }

  // ---------- collectibles ----------
  _spawnCollectibles(start, cr, kind, rocks, surfaces, chasm) {
    // Fixed number of rolls per chunk so upgrades (Chime chance) never shift other decisions.
    const chimeRoll = cr(), rowRoll = cr(), arcRoll = cr(), harpRoll = cr(), jitter = cr(), pick = cr();
    if (kind === 'empty') {
      const chance = start < C.SAFE_ZONE_PX ? Math.min(0.6, C.COIN_ROW_CHANCE + 0.2) : C.COIN_ROW_CHANCE;
      if (rowRoll < chance) this._coinRow(start + 220 + jitter * 320, cr);
    } else if (arcRoll < C.COIN_ARC_CHANCE) {
      if (kind === 'rocks') this._coinsOverRock(rocks[Math.floor(pick * rocks.length)], cr);
      else if (kind === 'surface') this._coinsAlongSurface(surfaces[0], cr);
      else this._coinsOverChasm(chasm, cr);
    }
    if (kind === 'chasm' && harpRoll < C.HARP_CHANCE) this._addHarp(chasm, cr);
    if (start >= C.CHIME_START_PX) {
      const chance = this.economy ? this.economy.chimeChance() : C.UPGRADES.chime.spawn[0];
      if (chimeRoll < chance) this._addChime(start + 960, cr);
    }
  }

  _coin(x, y, cr) { this.coins.push({ x, y, ph: cr() * TAU, alive: true, pulled: false }); }

  // Gentle arc hugging the slope.
  _coinRow(x0, cr) {
    const n = C.COIN_ROW_COUNT[0] + Math.floor(cr() * (C.COIN_ROW_COUNT[1] - C.COIN_ROW_COUNT[0] + 1)), t = this.terrain;
    for (let i = 0; i < n; i++) {
      const x = x0 + i * C.COIN_SPACING, u = n > 1 ? i / (n - 1) : 0.5;
      this._coin(x, t.heightFn(x) - 38 - 26 * Math.sin(Math.PI * u), cr);
    }
  }

  // Five coins forming a hop-over arc above a rock.
  _coinsOverRock(rock, cr) {
    if (!rock) return;
    const t = this.terrain, bump = clamp(rock.h + 50, 70, 120);
    for (let i = 0; i < 5; i++) {
      const u = i / 4, x = rock.x - 120 + 240 * u;
      this._coin(x, t.heightFn(x) - 36 - bump * Math.sin(Math.PI * u), cr);
    }
  }

  // Coins riding the rail / roof ridge, at grind height.
  _coinsAlongSurface(s, cr) {
    if (!s) return;
    const a = s.kind === 'roof' ? s.xa + 30 : s.x0 + 50, b = s.kind === 'roof' ? s.xb - 30 : s.x1 - 50;
    let n = 0;
    for (let x = a; x <= b && n < 9; x += C.COIN_SPACING, n++) this._coin(x, s.yAt(x) - 34, cr);
  }

  // Body-centre jump trajectory off the chasm kicker (fit to the measured jump arc).
  _jumpArcY(c, s) {
    const yl = this.terrain.heightFn(c.x0);
    return yl - 1.945 * s + 0.00519 * s * s - C.PLAYER_HEIGHT * 0.5;
  }

  _coinsOverChasm(c, cr) {
    if (!c) return;
    const gap = c.x1 - c.x0;
    for (const f of [0.18, 0.32, 0.68, 0.82]) this._coin(c.x0 + gap * f, this._jumpArcY(c, gap * f) - 8, cr);
  }

  _addHarp(c, cr) {
    const s = (c.x1 - c.x0) * 0.5;
    this.pickups.push({ id: this._id++, kind: 'harp', x: c.x0 + s, y: this._jumpArcY(c, s), ph: cr() * TAU, alive: true });
  }

  _addChime(x, cr) {
    const t = this.terrain;
    for (const c of t.chasms) if (x > c.x0 - c.kickLen - 80 && x < c.x1 + 80) return;
    for (const s of this.surfaces) if (x > s.x0 - 80 && x < s.x1 + 80) return;
    for (const r of this.rocks) if (Math.abs(r.x - x) < 100) return;
    this.pickups.push({ id: this._id++, kind: 'chime', x, y: t.heightFn(x) - 46, ph: cr() * TAU, alive: true });
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
  resolve(player, dt = 1 / 120) {
    this._resolveHazards(player);
    this._collect(player, dt);
  }

  _collect(player, dt) {
    if (player.state === PlayerState.CRASHED) return;
    const cx = player.x, cy = player.y - C.PLAYER_HEIGHT * 0.5;
    const mag = this.economy ? this.economy.magnetRadius() : 0;
    for (const c of this.coins) {
      if (!c.alive) continue;
      let dx = cx - c.x, dy = cy - c.y;
      if (Math.abs(dx) > mag + 400 && !c.pulled) continue;
      let d = Math.hypot(dx, dy);
      if (mag > 0 && d > C.COIN_PICK_RADIUS && (c.pulled || d < mag)) {
        c.pulled = true; // once captured by the Harmonic Magnet a coin keeps homing
        const step = Math.min(d, (C.MAGNET_SPEED + Math.max(0, player.vx)) * dt);
        c.x += (dx / d) * step; c.y += (dy / d) * step;
        dx = cx - c.x; dy = cy - c.y; d = Math.hypot(dx, dy);
      }
      if (d <= C.COIN_PICK_RADIUS) {
        c.alive = false;
        player.burst(c.x, c.y, 6, { colors: ['#ffd24a', '#fff2b0'], speed: [60, 220], size: [1.5, 3], life: [0.3, 0.55], add: true });
        this.emit('coinPickup', { coin: c, x: c.x, y: c.y });
      }
    }
    for (const p of this.pickups) {
      if (!p.alive || Math.abs(p.x - cx) > 120) continue;
      const r = p.kind === 'harp' ? C.HARP_RADIUS : C.CHIME_RADIUS;
      if (Math.hypot(cx - p.x, cy - p.y) > r) continue;
      p.alive = false;
      const col = p.kind === 'harp' ? ['#5ff3ff', '#ffffff', '#b58cff'] : ['#ffd24a', '#fff2b0', '#ffffff'];
      player.burst(p.x, p.y, 26, { colors: col, speed: [120, 460], size: [2, 4.5], life: [0.5, 1], add: true });
      this.emit('multiplierPickup', { kind: p.kind, x: p.x, y: p.y });
    }
  }

  _resolveHazards(player) {
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
  render(ctx, view, palette, glow = 0, time = 0) {
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
    this._drawCollectibles(ctx, view, glow, time);
  }

  _drawCollectibles(ctx, view, glow, time) {
    ctx.save();
    for (const c of this.coins) {
      if (!c.alive || c.x < view.left - 40 || c.x > view.right + 40) continue;
      const w = Math.abs(Math.cos(time * 3.2 + c.ph)), bob = Math.sin(time * 2 + c.ph) * 2.5;
      ctx.save();
      ctx.translate(c.x, c.y + bob);
      ctx.shadowColor = 'rgba(255,210,90,0.9)';
      ctx.shadowBlur = 8 + 8 * glow;
      ctx.fillStyle = '#ffd24a';
      ctx.beginPath(); ctx.ellipse(0, 0, Math.max(1.8, 11 * w), 11, 0, 0, TAU); ctx.fill();
      if (w > 0.3) {
        ctx.shadowBlur = 0;
        ctx.strokeStyle = '#fff2b0'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.ellipse(0, 0, Math.max(1, 6.5 * w), 6.5, 0, 0, TAU); ctx.stroke();
      }
      ctx.restore();
    }
    for (const p of this.pickups) {
      if (!p.alive || p.x < view.left - 80 || p.x > view.right + 80) continue;
      const bob = Math.sin(time * 2.2 + p.ph) * 4, pulse = 0.5 + 0.5 * Math.sin(time * 4 + p.ph);
      ctx.save();
      ctx.translate(p.x, p.y + bob);
      if (p.kind === 'chime') {
        ctx.strokeStyle = `rgba(255,210,90,${0.25 + 0.25 * pulse})`; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(0, 0, 26 + 4 * pulse, 0, TAU); ctx.stroke();
        ctx.rotate(Math.sin(time * 2.4 + p.ph) * 0.18);
        ctx.shadowColor = 'rgba(255,210,90,0.95)'; ctx.shadowBlur = 14 + 6 * glow;
        ctx.fillStyle = '#f6c453'; ctx.strokeStyle = '#fff0b8'; ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-15, 10); ctx.bezierCurveTo(-15, 2, -10, -2, -9, -12);
        ctx.bezierCurveTo(-8, -20, 8, -20, 9, -12); ctx.bezierCurveTo(10, -2, 15, 2, 15, 10);
        ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.beginPath(); ctx.arc(0, 13, 3.5, 0, TAU); ctx.fill();
        ctx.beginPath(); ctx.arc(0, -21, 2.5, 0, TAU); ctx.stroke();
      } else {
        const rgb = C.GLOW_CYAN;
        ctx.strokeStyle = rgba(rgb, 0.25 + 0.3 * pulse); ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(0, 0, 32 + 6 * pulse, 0, TAU); ctx.stroke();
        ctx.beginPath(); ctx.arc(0, 0, 44 + 8 * pulse, 0, TAU); ctx.globalAlpha = 0.4; ctx.stroke(); ctx.globalAlpha = 1;
        ctx.shadowColor = rgba(rgb, 0.95); ctx.shadowBlur = 16 + 6 * glow;
        ctx.strokeStyle = '#7df9ff'; ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(-14, 16); ctx.quadraticCurveTo(-19, -18, 4, -20); ctx.quadraticCurveTo(17, -16, 14, 16); ctx.closePath();
        ctx.stroke();
        ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 1.5;
        for (let i = 0; i < 5; i++) {
          const x = -9 + i * 5, top = -15 + i * 3.2, wob = Math.sin(time * 16 + i * 1.7 + p.ph) * 1.4;
          ctx.beginPath(); ctx.moveTo(x, top); ctx.quadraticCurveTo(x + wob, (top + 15) / 2, x, 15); ctx.stroke();
        }
      }
      ctx.restore();
    }
    ctx.restore();
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