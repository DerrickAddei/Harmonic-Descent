import { CONFIG as C } from './config.js';

export const PlayerState = Object.freeze({ GROUNDED: 'GROUNDED', AIRBORNE: 'AIRBORNE', CRASHED: 'CRASHED' });

const TAU = Math.PI * 2;
const wrapPi = (a) => { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; };
const trickName = (n) => ['Backflip', 'Double Backflip', 'Triple Backflip'][n - 1] || `${n}x Backflip`;

export class Player {
  constructor(terrain, startX = 0) {
    this.x = startX;
    this.y = terrain.getHeightAt(startX);
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
    this.crashedAt = 0;
    this.time = 0;
    this.onTrick = null; // (name, flips) => void
    this.onCrash = null; // () => void
    this.scarf = Array.from({ length: C.SCARF_NODES }, () => ({ x: this.x, y: this.y - 33 }));
  }

  get invulnerable() { return this.auraTimer > 0; }
  get speed() { return Math.hypot(this.vx, this.vy); }

  // input = { held: bool, pressed: bool } ; `pressed` is consumed here.
  update(dt, input, terrain) {
    this.time += dt;
    if (input.pressed) { this.jumpBufferMs = C.JUMP_BUFFER_MS; input.pressed = false; }
    this.jumpBufferMs = Math.max(0, this.jumpBufferMs - dt * 1000);

    if (this.state !== PlayerState.CRASHED) {
      this.auraTimer = Math.max(0, this.auraTimer - dt);
      this.boost *= Math.exp(-C.BOOST_DECAY * dt);
    }
    if (this.state === PlayerState.GROUNDED) this._updateGrounded(dt, terrain);
    else if (this.state === PlayerState.AIRBORNE) this._updateAirborne(dt, input, terrain);
    else this._updateCrashed(dt, terrain);
    this._updateScarf(dt);
  }

  _updateGrounded(dt, terrain) {
    if (this.jumpBufferMs > 0) { this._jump(terrain); return; }

    const ang = terrain.getSlopeAngleAt(this.x), sinA = Math.sin(ang);
    const target = C.BASE_SPEED + this.boost;
    this.vx += Math.max(0, sinA - C.SLOPE_NEUTRAL_SIN) * C.SLOPE_ACCEL_FACTOR * dt; // steep = faster
    if (sinA < 0) this.vx += sinA * C.SLOPE_ACCEL_FACTOR * 0.5 * dt;                  // uphill = slower
    this.vx += (target - this.vx) * C.SPEED_RELAX * dt;                               // relax to target
    this.vx = Math.min(C.MAX_SPEED, Math.max(C.BASE_SPEED * 0.5, this.vx));

    // Compare the terrain with the ballistic path: if the ground falls away faster, take off.
    const vyT = this.vx * Math.tan(ang);
    const nx = this.x + this.vx * dt, ny = terrain.getHeightAt(nx);
    const ballistic = this.y + vyT * dt + 0.5 * C.GRAVITY * dt * dt;
    if (ny - ballistic > C.TAKEOFF_EPS * (dt * 60) ** 2) {
      this.x = nx; this.y = ballistic; this.vy = vyT + C.GRAVITY * dt;
      this._leaveGround(true);
      return;
    }
    this.x = nx; this.y = ny; this.vy = 0;
    this.rotation += wrapPi(terrain.getSlopeAngleAt(nx) - this.rotation) * (1 - Math.exp(-14 * dt));
  }

  _leaveGround(coyote) {
    this.state = PlayerState.AIRBORNE;
    this.totalAirRotation = 0;
    this.angVel = 0;
    this.coyoteMs = coyote ? C.COYOTE_TIME_MS : 0;
  }

  _jump(terrain) {
    const a = terrain.getSlopeAngleAt(this.x);
    const wasGrounded = this.state === PlayerState.GROUNDED;
    this.vy = this.vx * Math.tan(a) - C.JUMP_VELOCITY * Math.cos(a);
    this.vx += C.JUMP_VELOCITY * Math.sin(a) * 0.3;
    if (wasGrounded) this._leaveGround(false);
    this.jumpBufferMs = 0;
    this.coyoteMs = 0;
  }

  _updateAirborne(dt, input, terrain) {
    this.coyoteMs = Math.max(0, this.coyoteMs - dt * 1000);
    if (this.jumpBufferMs > 0 && this.coyoteMs > 0) this._jump(terrain);

    if (input.held) {
      this.angVel = Math.max(-C.MAX_FLIP_SPEED, this.angVel - C.FLIP_ANGULAR_ACCEL * dt);
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
    const slope = terrain.getSlopeAngleAt(this.x);
    const diff = wrapPi(this.rotation - slope);
    const ok = Math.abs(diff) <= C.LANDING_ANGLE_TOLERANCE;

    if (!ok && !this.invulnerable) { this._crash(terrain, diff); return; }

    const backflips = Math.max(0, -this.totalAirRotation / TAU);
    this.flipsCompleted = ok ? Math.floor(backflips + (1 - C.FLIP_COUNT_THRESHOLD)) : 0;

    // Keep momentum along the slope (convert to horizontal speed), small penalty for sloppy angles.
    const s = Math.tan(slope);
    let vx = (this.vx + this.vy * s) / (1 + s * s);
    vx *= 1 - 0.15 * Math.min(1, Math.abs(diff) / C.LANDING_ANGLE_TOLERANCE) ** 2;
    this.vx = Math.max(C.BASE_SPEED * 0.6, vx);
    this.vy = 0;
    this.angVel = 0;
    this.y = terrain.getHeightAt(this.x);
    this.rotation = slope + diff; // eased onto the slope by the grounded update
    this.state = PlayerState.GROUNDED;

    if (this.flipsCompleted >= 1) {
      this.boost = Math.min(C.BOOST_SPEED_BONUS * C.MAX_BOOST_STACK, this.boost + C.BOOST_SPEED_BONUS * this.flipsCompleted);
      this.auraTimer = C.AURA_DURATION;
      if (this.onTrick) this.onTrick(trickName(this.flipsCompleted), this.flipsCompleted);
    }
  }

  _crash(terrain, diff) {
    this.state = PlayerState.CRASHED;
    this.crashedAt = performance.now();
    this.vx *= 0.55;
    this.vy = 0;
    this.y = terrain.getHeightAt(this.x);
    this.angVel = (diff >= 0 ? 1 : -1) * 5;
    if (this.onCrash) this.onCrash();
  }

  _updateCrashed(dt, terrain) {
    this.vx *= Math.exp(-2.5 * dt);
    this.x += this.vx * dt;
    this.y = terrain.getHeightAt(this.x);
    this.angVel *= Math.exp(-3 * dt);
    this.rotation += this.angVel * dt;
  }

  _updateScarf(dt) {
    const c = Math.cos(this.rotation), s = Math.sin(this.rotation), n = this.scarf;
    n[0].x = this.x + c + 33 * s; // neck at local (1, -33)
    n[0].y = this.y + s - 33 * c;
    for (let i = 1; i < n.length; i++) {
      const p = n[i - 1], q = n[i];
      q.y += (80 + Math.sin(this.time * 9 + i * 0.7) * 60) * dt; // sag + flutter
      const dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy) || 1;
      q.x = p.x + (dx / d) * C.SCARF_SEGMENT;
      q.y = p.y + (dy / d) * C.SCARF_SEGMENT;
    }
  }

  render(ctx) {
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

    // Scarf (tapered, drawn segment by segment)
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

    // Rider silhouette
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(this.rotation);
    ctx.strokeStyle = ctx.fillStyle = '#0e1022';
    ctx.lineCap = ctx.lineJoin = 'round';

    ctx.lineWidth = 4; // board
    ctx.beginPath();
    ctx.moveTo(-25, -7); ctx.quadraticCurveTo(-21, -2, -14, -2);
    ctx.lineTo(14, -2); ctx.quadraticCurveTo(21, -2, 25, -7);
    ctx.stroke();

    ctx.lineWidth = 6; // legs
    ctx.beginPath();
    ctx.moveTo(-6, -3); ctx.lineTo(-3, -13); ctx.lineTo(2, -20);
    ctx.moveTo(7, -3); ctx.lineTo(6, -13); ctx.lineTo(2, -20);
    ctx.stroke();

    ctx.lineWidth = 9; // torso
    ctx.beginPath(); ctx.moveTo(2, -20); ctx.lineTo(5, -33); ctx.stroke();

    ctx.lineWidth = 4; // arm
    ctx.beginPath(); ctx.moveTo(4, -31); ctx.lineTo(14, -24); ctx.stroke();

    ctx.beginPath(); ctx.arc(6, -41, 6, 0, TAU); ctx.fill(); // head
    ctx.restore();
  }
}