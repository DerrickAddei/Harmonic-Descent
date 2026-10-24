import { CONFIG as C } from './config.js';

export const PlayerState = Object.freeze({
  GROUNDED: 'GROUNDED', AIRBORNE: 'AIRBORNE', GRINDING: 'GRINDING', CRASHED: 'CRASHED',
});

const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const rand = (a, b) => a + Math.random() * (b - a);
const wrapPi = (a) => { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; };
const trickName = (n) => ['Backflip', 'Double Backflip', 'Triple Backflip'][n - 1] || `${n}x Backflip`;
const BOOST_CAP = C.BOOST_SPEED_BONUS * C.MAX_BOOST_STACK;

// Tiny event hub. Milestone 3 audio listens here: player.on('grindStart', fn), etc.
export class Emitter {
  constructor() { this._listeners = {}; }
  on(name, fn) { (this._listeners[name] = this._listeners[name] || []).push(fn); return this; }
  emit(name, data) { const l = this._listeners[name]; if (l) for (const fn of l) fn(data); }
}

/*
 Events emitted: jump, takeoff, land, trick, flip, grindStart, grindEnd, combo, bank,
 comboLost, rockSmash (via onRockSmash), crash.
*/
export class Player extends Emitter {
  constructor(terrain, startX = 0) {
    super();
    this.x = startX;
    this.y = terrain.getHeightAt(startX);
    this.prevX = this.x;
    this.prevY = this.y;
    this.vx = C.BASE_SPEED;
    this.vy = 0;
    this.rotation = terrain.getSlopeAngleAt(startX);
    this.angVel = 0;
    this.state = PlayerState.GROUNDED;
    this.coyoteMs = 0;
    this.jumpBufferMs = 0;
    this.totalAirRotation = 0; // radians; negative = backward rotation
    this.flipsCompleted = 0;
    this.boost = 0;
    this.auraTimer = 0;
    this.grind = null;          // { surface } while GRINDING
    this.ignoreSurface = null;  // surface just left; can't be re-grabbed until ignoreTimer expires
    this.ignoreTimer = 0;
    this.comboCount = 0;        // live multiplier (1x, 2x, ...); 0 = no combo running
    this.comboPoints = 0;       // un-banked points; banks as comboPoints * comboCount
    this.trickScore = 0;        // banked total
    this.scoreMult = 1;         // Overdrive Harp multiplier applied when a combo banks (set by main.js)
    this.speedMult = 1;         // Resonance Board: scales base speed
    this.flipMult = 1;          // Resonance Board: scales flip torque and max flip rate
    this.crashedAt = 0;
    this.time = 0;
    this.particles = [];
    this.sprayAcc = 0;
    this.sparkAcc = 0;
    this.scarf = Array.from({ length: C.SCARF_NODES }, () => ({ x: this.x, y: this.y - 33 }));
  }

  get invulnerable() { return this.auraTimer > 0; }
  get speed() { return Math.hypot(this.vx, this.vy); }

  // input = { held, pressed }; `pressed` is consumed here.
  update(dt, input, terrain) {
    this.time += dt;
    this.prevX = this.x;
    this.prevY = this.y;
    if (input.pressed) { this.jumpBufferMs = C.JUMP_BUFFER_MS; input.pressed = false; }
    this.jumpBufferMs = Math.max(0, this.jumpBufferMs - dt * 1000);
    this.ignoreTimer = Math.max(0, this.ignoreTimer - dt);

    if (this.state !== PlayerState.CRASHED) {
      this.auraTimer = Math.max(0, this.auraTimer - dt);
      this.boost *= Math.exp(-C.BOOST_DECAY * dt);
    }
    switch (this.state) {
      case PlayerState.GROUNDED: this._updateGrounded(dt, terrain); break;
      case PlayerState.AIRBORNE: this._updateAirborne(dt, input, terrain); break;
      case PlayerState.GRINDING: this._updateGrinding(dt); break;
      default: this._updateCrashed(dt, terrain);
    }
    this._updateParticles(dt);
    this._updateScarf(dt);
  }

  // ---------- GROUNDED ----------
  _updateGrounded(dt, terrain) {
    if (this.jumpBufferMs > 0) { this._jump(terrain, 'ground'); return; }

    const ang = terrain.getSlopeAngleAt(this.x), sinA = Math.sin(ang);
    const target = C.BASE_SPEED * this.speedMult + this.boost;
    this.vx += Math.max(0, sinA - C.SLOPE_NEUTRAL_SIN) * C.SLOPE_ACCEL_FACTOR * dt;
    if (sinA < 0) this.vx += sinA * C.SLOPE_ACCEL_FACTOR * 0.25 * dt; // uphill kickers cost a little speed
    this.vx += (target - this.vx) * C.SPEED_RELAX * dt;
    this.vx = Math.min(C.MAX_SPEED * this.speedMult, Math.max(C.BASE_SPEED * 0.5, this.vx));

    const vyT = this.vx * Math.tan(ang);
    const nx = this.x + this.vx * dt, ny = terrain.getHeightAt(nx);
    const ballistic = this.y + vyT * dt + 0.5 * C.GRAVITY * dt * dt;
    if (ny - ballistic > C.TAKEOFF_EPS * (dt * 60) ** 2) { // ground fell away: leave it
      this.x = nx; this.y = ballistic; this.vy = vyT + C.GRAVITY * dt;
      this._leaveGround(true);
      return;
    }
    this.x = nx; this.y = ny; this.vy = 0;
    this.rotation += wrapPi(terrain.getSlopeAngleAt(nx) - this.rotation) * (1 - Math.exp(-14 * dt));
    this._spray(dt, sinA);
  }

  _leaveGround(coyote) {
    this.state = PlayerState.AIRBORNE;
    this.totalAirRotation = 0;
    this.angVel = 0;
    this.coyoteMs = coyote ? C.COYOTE_TIME_MS : 0;
    this.emit('takeoff', { x: this.x, y: this.y, speed: this.speed });
  }

  _jump(terrain, from) {
    const a = terrain.getSlopeAngleAt(this.x);
    const wasGrounded = this.state === PlayerState.GROUNDED;
    this.vy = this.vx * Math.tan(a) - C.JUMP_VELOCITY * Math.cos(a);
    this.vx += C.JUMP_VELOCITY * Math.max(0, Math.sin(a)) * 0.3;
    if (wasGrounded) this._leaveGround(false);
    this.jumpBufferMs = 0;
    this.coyoteMs = 0;
    this.burst(this.x, this.y, 8, { colors: ['#ffffff', '#dfe9ff'], speed: [60, 200], arc: [-Math.PI, 0], size: [2, 3.5] });
    this.emit('jump', { x: this.x, y: this.y, from });
  }

  // ---------- AIRBORNE ----------
  _updateAirborne(dt, input, terrain) {
    this.coyoteMs = Math.max(0, this.coyoteMs - dt * 1000);
    if (this.jumpBufferMs > 0 && this.coyoteMs > 0) this._jump(terrain, 'coyote');

    if (input.held) {
      this.angVel = Math.max(-C.MAX_FLIP_SPEED * this.flipMult, this.angVel - C.FLIP_ANGULAR_ACCEL * this.flipMult * dt);
    } else {
      const aim = terrain.getSlopeAngleAt(this.x + this.vx * 0.35);
      this.angVel += wrapPi(aim - this.rotation) * C.AUTO_TUCK_TORQUE * dt;
      this.angVel *= Math.exp(-3.5 * dt);
    }
    const dRot = this.angVel * dt;
    this.rotation += dRot;
    this.totalAirRotation += dRot;

    this.vy += C.GRAVITY * dt;
    this.vx *= Math.exp(-C.AIR_DRAG * dt);
    this.x += this.vx * dt;
    this.y += this.vy * dt;

    if (this.y >= terrain.getHeightAt(this.x)) this._land(terrain);
  }

  _land(terrain) {
    if (terrain.chasmAt(this.x)) { this.crash(terrain, 1, 'chasm'); return; } // fell in or hit the far wall

    const slope = terrain.getSlopeAngleAt(this.x);
    const diff = wrapPi(this.rotation - slope);
    const ok = Math.abs(diff) <= C.LANDING_ANGLE_TOLERANCE;
    if (!ok && !this.invulnerable) { this.crash(terrain, diff >= 0 ? 1 : -1, 'landing'); return; }

    const impact = this.vy;
    const backflips = Math.max(0, -this.totalAirRotation / TAU);
    const flips = ok ? Math.floor(backflips + (1 - C.FLIP_COUNT_THRESHOLD)) : 0;
    this.flipsCompleted = flips;
    this.totalAirRotation = 0;

    const s = Math.tan(slope);
    let vx = (this.vx + this.vy * s) / (1 + s * s); // keep momentum along the slope
    vx *= 1 - 0.15 * Math.min(1, Math.abs(diff) / C.LANDING_ANGLE_TOLERANCE) ** 2;
    this.vx = Math.max(C.BASE_SPEED * 0.6, vx);
    this.vy = 0;
    this.angVel = 0;
    this.y = terrain.getHeightAt(this.x);
    this.rotation = slope + diff;
    this.state = PlayerState.GROUNDED;

    this.burst(this.x, this.y, clamp(Math.abs(impact) / 30, 6, 24), {
      colors: ['#ffffff', '#dfe9ff'], speed: [80, 260], arc: [-Math.PI, 0], size: [2, 4],
    });
    if (flips >= 1) this._awardFlips(flips);
    if (ok) this._bank(); else this._dropCombo();
    this.emit('land', { x: this.x, y: this.y, impact, clean: ok, flips });
  }

  // ---------- GRINDING ----------
  // Called by ObstacleManager when the player descends onto a rail or roof.
  startGrind(surface) {
    this._settleFlips();
    this.state = PlayerState.GRINDING;
    this.grind = { surface };
    this.vy = 0;
    this.angVel = 0;
    this.jumpBufferMs = 0; // a late jump tap shouldn't instantly kick you off
    this.y = surface.yAt(this.x);
    this.comboCount++;
    this.comboPoints += C.GRIND_LAND_POINTS;
    this.burst(this.x, this.y, 10, { colors: ['#ffd27a', '#ffffff'], speed: [80, 260], add: true, size: [1.5, 3], life: [0.2, 0.45] });
    this.emit('grindStart', { kind: surface.kind, x: this.x, y: this.y, speed: this.speed });
    this.emit('trick', { name: surface.kind === 'roof' ? 'Roof Grind' : 'Rail Grind' });
    this._comboChanged();
  }

  _updateGrinding(dt) {
    const s = this.grind.surface;
    if (this.jumpBufferMs > 0) { this._jumpOffGrind(); return; }

    const slope = s.slopeAt(this.x);
    this.vx += Math.sin(Math.atan(slope)) * C.GRIND_SLOPE_ACCEL * dt;
    this.vx = clamp(this.vx, C.BASE_SPEED * 0.8, C.MAX_SPEED);
    this.x += this.vx * dt;
    this.boost = Math.min(BOOST_CAP, this.boost + C.GRIND_BOOST_RATE * dt);
    this.comboPoints += C.GRIND_POINTS_PER_SEC * dt;

    if (this.x >= s.x1) { // ran off the end: continue along the tangent
      this.x = s.x1;
      this.y = s.yAt(s.x1);
      this.vy = this.vx * s.slopeAt(s.x1);
      this.ignoreSurface = s;
      this.ignoreTimer = C.GRIND_REARM_SEC;
      this.grind = null;
      this._leaveGround(false);
      this.emit('grindEnd', { x: this.x, y: this.y, jumped: false });
      return;
    }
    this.y = s.yAt(this.x);
    this.rotation += wrapPi(Math.atan(s.slopeAt(this.x)) - this.rotation) * (1 - Math.exp(-16 * dt));

    this.sparkAcc += C.GRIND_SPARK_RATE * dt;
    while (this.sparkAcc >= 1) {
      this.sparkAcc -= 1;
      this._spawn({
        x: this.x + rand(-10, 10), y: this.y + rand(-1, 3),
        vx: -this.vx * 0.25 + rand(-60, 60), vy: -rand(40, 200),
        life: 0, max: rand(0.25, 0.5), size: rand(1.5, 2.8),
        color: Math.random() < 0.5 ? '#ffd27a' : '#ff9a4a', g: 900, add: true,
      });
    }
  }

  _jumpOffGrind() {
    const s = this.grind.surface, sl = s.slopeAt(this.x), a = Math.atan(sl);
    this.vy = this.vx * sl - C.JUMP_VELOCITY * C.GRIND_JUMP_FACTOR * Math.cos(a);
    this.y = s.yAt(this.x) - 1;
    this.ignoreSurface = s;
    this.ignoreTimer = C.GRIND_REARM_SEC;
    this.grind = null;
    this.state = PlayerState.AIRBORNE;
    this.totalAirRotation = 0;
    this.angVel = 0;
    this.coyoteMs = 0;
    this.jumpBufferMs = 0;
    this.burst(this.x, this.y, 6, { colors: ['#ffd27a', '#ffffff'], speed: [60, 200], add: true, size: [1.5, 2.5] });
    this.emit('grindEnd', { x: this.x, y: this.y, jumped: true });
    this.emit('jump', { x: this.x, y: this.y, from: 'grind' });
  }

  // ---------- ROCKS ----------
  // Called by ObstacleManager. bounce = true when landed on top of the rock from a jump.
  onRockSmash(rock, bounce) {
    this._settleFlips();
    this.comboCount++;
    this.comboPoints += bounce ? C.ROCK_BOUNCE_POINTS : C.ROCK_SMASH_POINTS;
    this.auraTimer = C.AURA_DURATION;                                   // refresh boost aura
    this.boost = Math.min(BOOST_CAP, this.boost + C.BOOST_SPEED_BONUS * 0.5);
    if (bounce) this.vy = -C.ROCK_BOUNCE_VELOCITY;
    this.emit('trick', { name: bounce ? 'Rock Bounce' : 'Rock Smash' });
    this._comboChanged();
    if (this.state === PlayerState.GROUNDED) this._bank(); // no airtime left to chain: cash in now
  }

  // ---------- COMBO ----------
  _settleFlips() { // count backflips completed since the last event, then restart the tally
    const n = Math.floor(Math.max(0, -this.totalAirRotation / TAU) + (1 - C.FLIP_COUNT_THRESHOLD));
    this.totalAirRotation = 0;
    if (n >= 1) this._awardFlips(n);
  }

  _awardFlips(n) {
    this.comboCount += n;
    this.comboPoints += C.FLIP_POINTS * n;
    this.boost = Math.min(BOOST_CAP, this.boost + C.BOOST_SPEED_BONUS * n);
    this.auraTimer = C.AURA_DURATION;
    this.emit('trick', { name: trickName(n), flips: n });
    this.emit('flip', { flips: n });
    this._comboChanged();
  }

  _comboChanged() { this.emit('combo', { count: this.comboCount, points: Math.round(this.comboPoints) }); }

  _bank() {
    if (this.comboCount <= 0) return;
    const pts = Math.round(this.comboPoints * this.comboCount * this.scoreMult), count = this.comboCount;
    this.trickScore += pts;
    this.comboCount = 0;
    this.comboPoints = 0;
    this.burst(this.x, this.y - 18, 30, {
      colors: ['#ffd27a', '#ffffff', '#ffe9b0'], speed: [200, 460], add: true, size: [2, 4], life: [0.4, 0.8], gravity: 380,
    });
    this.emit('bank', { points: pts, count, total: this.trickScore, mult: this.scoreMult });
  }

  _dropCombo() {
    if (this.comboCount <= 0) return;
    const lost = this.comboCount;
    this.comboCount = 0;
    this.comboPoints = 0;
    this.emit('comboLost', { count: lost });
  }

  // ---------- CRASH ----------
  crash(terrain, dir = 1, cause = 'terrain') {
    if (this.state === PlayerState.CRASHED) return;
    const lost = this.comboCount;
    this.grind = null;
    this._dropCombo();
    this.state = PlayerState.CRASHED;
    this.crashedAt = performance.now();
    this.vx *= 0.55;
    this.angVel = dir * 5;
    this.burst(this.x, this.y - 10, 18, { colors: ['#ffffff', '#cfe0ff'], speed: [120, 360], arc: [-Math.PI, 0], size: [2, 5] });
    this.emit('crash', { cause, x: this.x, y: this.y, lostCombo: lost });
  }

  _updateCrashed(dt, terrain) {
    this.vx *= Math.exp(-2.5 * dt);
    this.x += this.vx * dt;
    this.vy += C.GRAVITY * dt; // keeps falling if it crashed over a chasm
    this.y += this.vy * dt;
    const gy = terrain.getHeightAt(this.x);
    if (this.y >= gy) { this.y = gy; this.vy = 0; }
    this.angVel *= Math.exp(-3 * dt);
    this.rotation += this.angVel * dt;
  }

  // ---------- PARTICLES ----------
  _spawn(p) {
    p.life = p.max;
    if (this.particles.length >= C.PARTICLE_MAX) this.particles.shift();
    this.particles.push(p);
  }

  burst(x, y, n, o = {}) {
    const colors = o.colors || ['#ffffff'];
    const [s0, s1] = o.speed || [120, 360], [l0, l1] = o.life || [0.4, 0.8];
    const [z0, z1] = o.size || [2, 4], [a0, a1] = o.arc || [0, TAU];
    for (let i = 0; i < n; i++) {
      const a = rand(a0, a1), s = rand(s0, s1);
      this._spawn({
        x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, max: rand(l0, l1), size: rand(z0, z1),
        color: colors[(Math.random() * colors.length) | 0], g: o.gravity !== undefined ? o.gravity : 500, add: !!o.add,
      });
    }
  }

  _spray(dt, sinA) { // snow thrown off the tail when carving a steep slope
    const steep = sinA - C.SPRAY_MIN_SIN;
    if (steep <= 0) { this.sprayAcc = 0; return; }
    this.sprayAcc += steep * C.SPRAY_RATE * (this.vx / C.BASE_SPEED) * dt;
    const c = Math.cos(this.rotation), s = Math.sin(this.rotation);
    while (this.sprayAcc >= 1) {
      this.sprayAcc -= 1;
      this._spawn({
        x: this.x - 20 * c + 2 * s, y: this.y - 20 * s - 2 * c,
        vx: -this.vx * 0.35 + rand(-40, 40), vy: -rand(60, 200),
        max: rand(0.35, 0.7), size: rand(2, 4), color: Math.random() < 0.7 ? '#ffffff' : '#cfe0ff', g: 700, add: false,
      });
    }
  }

  _updateParticles(dt) {
    const a = this.particles;
    for (let i = a.length - 1; i >= 0; i--) {
      const p = a[i];
      p.life -= dt;
      if (p.life <= 0) { a[i] = a[a.length - 1]; a.pop(); continue; }
      p.vy += p.g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
  }

  _updateScarf(dt) {
    const c = Math.cos(this.rotation), s = Math.sin(this.rotation), n = this.scarf;
    n[0].x = this.x + c + 33 * s;
    n[0].y = this.y + s - 33 * c;
    for (let i = 1; i < n.length; i++) {
      const p = n[i - 1], q = n[i];
      q.y += (80 + Math.sin(this.time * 9 + i * 0.7) * 60) * dt;
      const dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy) || 1;
      q.x = p.x + (dx / d) * C.SCARF_SEGMENT;
      q.y = p.y + (dy / d) * C.SCARF_SEGMENT;
    }
  }

  // ---------- RENDER ----------
  renderParticles(ctx) {
    const a = this.particles;
    for (let pass = 0; pass < 2; pass++) {
      const add = pass === 1;
      ctx.globalCompositeOperation = add ? 'lighter' : 'source-over';
      for (let i = 0; i < a.length; i++) {
        const p = a[i];
        if (p.add !== add) continue;
        ctx.globalAlpha = clamp(p.life / p.max, 0, 1);
        ctx.fillStyle = p.color;
        ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  render(ctx, glow = 0) {
    const c = Math.cos(this.rotation), s = Math.sin(this.rotation);
    const aura = this.auraTimer > 0;

    if (aura) {
      const fade = Math.min(1, this.auraTimer / 0.6);
      const r = 78 * (0.9 + 0.1 * Math.sin(this.time * 8));
      const cx = this.x + 22 * s, cy = this.y - 22 * c;
      const g = ctx.createRadialGradient(cx, cy, 4, cx, cy, r);
      g.addColorStop(0, `rgba(255, 214, 120, ${0.7 * fade})`);
      g.addColorStop(1, 'rgba(255, 214, 120, 0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, TAU);
      ctx.fill();
    }

    const n = this.scarf;
    ctx.lineCap = 'round';
    ctx.strokeStyle = aura ? '#ffd27a' : '#ff5a5f';
    for (let i = 1; i < n.length; i++) {
      ctx.lineWidth = 5 * (1 - i / n.length) + 1;
      ctx.beginPath();
      ctx.moveTo(n[i - 1].x, n[i - 1].y);
      ctx.lineTo(n[i].x, n[i].y);
      ctx.stroke();
    }

    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(this.rotation);
    if (glow > 0.05) { // faint cyan rim so the rider stays readable against dark night terrain
      ctx.shadowColor = `rgba(95, 243, 255, ${0.7 * glow})`;
      ctx.shadowBlur = 9;
    }
    ctx.strokeStyle = ctx.fillStyle = '#0e1022';
    ctx.lineCap = ctx.lineJoin = 'round';

    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(-25, -7); ctx.quadraticCurveTo(-21, -2, -14, -2);
    ctx.lineTo(14, -2); ctx.quadraticCurveTo(21, -2, 25, -7);
    ctx.stroke();

    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(-6, -3); ctx.lineTo(-3, -13); ctx.lineTo(2, -20);
    ctx.moveTo(7, -3); ctx.lineTo(6, -13); ctx.lineTo(2, -20);
    ctx.stroke();

    ctx.lineWidth = 9;
    ctx.beginPath(); ctx.moveTo(2, -20); ctx.lineTo(5, -33); ctx.stroke();

    ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(4, -31); ctx.lineTo(14, -24); ctx.stroke();

    ctx.beginPath(); ctx.arc(6, -41, 6, 0, TAU); ctx.fill();
    ctx.restore();
  }
}