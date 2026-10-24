import { CONFIG as C } from './config.js';
import { TerrainManager } from './terrain.js';
import { Player, PlayerState } from './player.js';
import { Atmosphere } from './atmosphere.js';
import { ObstacleManager } from './obstacles.js';
import { AudioEngine } from './audioEngine.js';

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const el = {
  distance: document.getElementById('distance'),
  speed: document.getElementById('speed'),
  tricks: document.getElementById('tricks'),
  trick: document.getElementById('trick'),
  crash: document.getElementById('crash'),
  crashDistance: document.getElementById('crashDistance'),
  combo: document.getElementById('combo'),
  comboMult: document.getElementById('comboMult'),
  comboPts: document.getElementById('comboPts'),
  audio: document.getElementById('audioToggle'),
  audioLabel: document.getElementById('audioLabel'),
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const game = { timeScale: 1.0 }; // future slow-mo QTEs will drive this; audio tempo + filter follow it
const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

class Camera {
  constructor() { this.x = 0; this.y = 0; this.zoom = C.BASE_ZOOM; this.width = 1; this.height = 1; this.unit = 1; }
  resize(w, h) { this.width = w; this.height = h; this.unit = Math.min(w / 1200, h / 700); }
  get scale() { return this.zoom * this.unit; }
  view() {
    const s = this.scale, ax = this.width * C.CAMERA_LEAD_X, ay = this.height * C.CAMERA_ANCHOR_Y;
    return { left: this.x - ax / s, right: this.x + (this.width - ax) / s, top: this.y - ay / s, bottom: this.y + (this.height - ay) / s };
  }
  snapTo(p) { this.x = p.x; this.y = p.y; this.zoom = C.BASE_ZOOM; }
  update(dt, p, terrain) {
    const speedT = clamp((p.speed - C.BASE_SPEED) / (C.MAX_SPEED - C.BASE_SPEED), 0, 1);
    const altT = clamp(Math.max(0, terrain.getHeightAt(p.x) - p.y) / 450, 0, 1);
    const targetZoom = C.BASE_ZOOM - (C.BASE_ZOOM - C.MIN_ZOOM) * clamp(speedT * 0.65 + altT * 0.6, 0, 1);
    const tx = p.x + p.vx * 0.18;
    const ty = p.y - 40 + clamp(p.vy * 0.12, -80, 120);
    const k = (rate) => 1 - Math.exp(-rate * dt);
    this.x += (tx - this.x) * k(6);
    this.y += (ty - this.y) * k(4);
    this.zoom += (targetZoom - this.zoom) * k(1.6);
  }
}

let W = 1, H = 1, dpr = 1;
const camera = new Camera();
const atmosphere = new Atmosphere(); // keeps running across restarts so the day keeps turning
const audio = new AudioEngine();
let terrain, player, obstacles;
const input = { held: false, pressed: false };

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth; H = window.innerHeight;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  camera.resize(W, H);
}

// ---- Audio: unlock on first gesture, mute toggle ----
try { audio.muted = localStorage.getItem('hd-muted') === '1'; } catch (e) { /* storage blocked */ }

function syncAudioUi() {
  el.audio.setAttribute('aria-pressed', String(audio.muted));
  el.audio.setAttribute('aria-label', audio.muted ? 'Unmute sound (M)' : 'Mute sound (M)');
  el.audio.classList.toggle('muted', audio.muted);
  el.audioLabel.textContent = audio.muted ? 'Muted' : 'Sound';
}
function toggleMute() {
  audio.unlock();
  audio.setMuted(!audio.muted);
  try { localStorage.setItem('hd-muted', audio.muted ? '1' : '0'); } catch (e) { /* storage blocked */ }
  syncAudioUi();
}
if (!audio.supported) el.audio.hidden = true;
syncAudioUi();

// Browsers only allow audio after a user gesture; resume on the first pointer / key / touch.
const unlockAudio = () => audio.unlock();
['pointerdown', 'keydown', 'touchend'].forEach((t) => window.addEventListener(t, unlockAudio, { capture: true, passive: true }));
el.audio.addEventListener('click', () => { toggleMute(); el.audio.blur(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) audio.suspend(); else audio.resume(); });

// ---- HUD ----
let trickTimer = 0, bankUntil = 0;
let lastDist = '', lastSpeed = '', lastTricks = '', lastMult = '', lastPts = '', lastLv = -1, lastPulse = -1;
const fmt = (n) => Math.round(n).toLocaleString('en-US');

function showTrick(name) {
  el.trick.textContent = name;
  el.trick.classList.add('show');
  clearTimeout(trickTimer);
  trickTimer = setTimeout(() => el.trick.classList.remove('show'), 1600);
}
function bumpCombo() {
  el.combo.classList.remove('bump', 'banked');
  void el.combo.offsetWidth; // restart the CSS animation
  el.combo.classList.add('bump');
  bankUntil = 0;
}
function updateHud() {
  const d = `${Math.max(0, Math.floor(player.x / C.PX_PER_METER))} m`;
  const s = `${Math.round((player.speed / C.PX_PER_METER) * 3.6)} km/h`;
  const t = fmt(player.trickScore);
  if (d !== lastDist) { el.distance.textContent = d; lastDist = d; }
  if (s !== lastSpeed) { el.speed.textContent = s; lastSpeed = s; }
  if (t !== lastTricks) { el.tricks.textContent = t; lastTricks = t; }

  if (player.comboCount > 0) {
    const m = `${player.comboCount}x`, p = `+${fmt(player.comboPoints * player.comboCount)}`;
    if (m !== lastMult) { el.comboMult.textContent = m; lastMult = m; }
    if (p !== lastPts) { el.comboPts.textContent = p; lastPts = p; }
    el.combo.classList.add('show');
  } else if (performance.now() < bankUntil) {
    el.combo.classList.add('show');
  } else {
    el.combo.classList.remove('show', 'banked');
  }

  // audio indicator: equalizer bars follow the output level, glow follows the beat
  if (!reducedMotion && !audio.muted) {
    const lv = Math.round(audio.level * 50) / 50, pu = Math.round(audio.pulse * 20) / 20;
    if (lv !== lastLv) { el.audio.style.setProperty('--lv', String(lv)); lastLv = lv; }
    if (pu !== lastPulse) { el.audio.style.setProperty('--pulse', String(pu)); lastPulse = pu; }
  }
}

// ---- Game lifecycle ----
function bindAudio() {
  player.on('jump', () => audio.onJump());
  player.on('takeoff', () => audio.onTakeoff());
  player.on('flip', (e) => audio.onFlip(e));
  player.on('grindStart', () => audio.onGrindStart());
  player.on('grindEnd', () => audio.onGrindEnd());
  player.on('land', (e) => audio.onLand(e));
  player.on('bank', (e) => audio.onBank(e));
  player.on('crash', () => audio.onCrash());
  obstacles.on('rockSmash', (e) => audio.onRockSmash(e));
}

function reset() {
  terrain = new TerrainManager();
  obstacles = new ObstacleManager(terrain);
  player = new Player(terrain, 0);
  player.on('trick', ({ name }) => showTrick(name));
  player.on('combo', bumpCombo);
  player.on('bank', ({ points, count }) => {
    el.comboMult.textContent = `${count}x`;
    el.comboPts.textContent = `Banked +${fmt(points)}`;
    lastMult = lastPts = '';
    el.combo.classList.remove('bump');
    el.combo.classList.add('show', 'banked');
    bankUntil = performance.now() + 1400;
  });
  player.on('crash', () => {
    el.crashDistance.textContent = `${Math.max(0, Math.floor(player.x / C.PX_PER_METER))} m`;
    el.crash.classList.remove('hidden');
  });
  bindAudio();
  audio.onReset();
  camera.snapTo(player);
  obstacles.update(camera, W / camera.unit); // must precede terrain.update (registers chasms first)
  terrain.update(camera, W / camera.unit);
  input.held = input.pressed = false;
  bankUntil = 0;
  el.crash.classList.add('hidden');
  el.trick.classList.remove('show');
  el.combo.classList.remove('show', 'banked', 'bump');
  lastDist = lastSpeed = lastTricks = lastMult = lastPts = '';
}

// ---- Input (mouse / touch / keyboard) ----
function press() {
  if (player.state === PlayerState.CRASHED) {
    if (performance.now() - player.crashedAt > C.RESTART_DELAY_MS) reset();
    return;
  }
  input.held = true;
  input.pressed = true;
}
function release() { input.held = false; }

window.addEventListener('pointerdown', (e) => {
  if (e.target.closest && e.target.closest('#audioToggle')) return; // HUD button is not a jump
  e.preventDefault();
  press();
}, { passive: false });
window.addEventListener('pointerup', release);
window.addEventListener('pointercancel', release);
window.addEventListener('blur', release);
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) press(); }
  else if (e.code === 'KeyR') reset();
  else if (e.code === 'KeyM' && !e.repeat) toggleMute();
  else if (e.code === 'KeyN') atmosphere.skipPhase(); // debug: jump to the next time-of-day phase
});
window.addEventListener('keyup', (e) => { if (e.code === 'Space') release(); });
document.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
['gesturestart', 'gesturechange', 'gestureend'].forEach((t) => document.addEventListener(t, (e) => e.preventDefault()));
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', resize);

// ---- Audio telemetry (sent every frame) ----
function audioTelemetry() {
  return {
    speed: player.speed,
    boost: player.boost,
    heightAboveGround: Math.max(0, terrain.getHeightAt(player.x) - player.y),
    nightFactor: atmosphere.nightFactor,
    timeScale: game.timeScale,
    state: player.state,
    airRotation: player.state === PlayerState.AIRBORNE ? Math.max(0, -player.totalAirRotation) : 0,
    combo: player.comboCount,
  };
}

// ---- Rendering (back to front) ----
// Soft glow around the rider that breathes with the beat, plus a gold edge flash on stingers.
function renderPulse() {
  if (reducedMotion || audio.muted) return;
  const e = audio.energy, p = audio.pulse, f = audio.flash;
  if (e < 0.04 && f < 0.02) return;
  const s = camera.scale;
  const sx = W * C.CAMERA_LEAD_X + (player.x - camera.x) * s;
  const sy = H * C.CAMERA_ANCHOR_Y + (player.y - 24 - camera.y) * s;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  if (e >= 0.04) {
    const r = (120 + 90 * p * (0.4 + e)) * camera.unit;
    const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, r);
    g.addColorStop(0, `rgba(255, 214, 140, ${0.05 + 0.12 * p * e})`);
    g.addColorStop(1, 'rgba(255, 214, 140, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(sx - r, sy - r, r * 2, r * 2);
  }
  if (f >= 0.02) {
    const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.hypot(W, H) * 0.55);
    g.addColorStop(0, 'rgba(255, 210, 122, 0)');
    g.addColorStop(1, `rgba(255, 210, 122, ${0.22 * f})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
  ctx.restore();
}

function render() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  atmosphere.renderBackground(ctx, W, H, camera);
  ctx.save();
  ctx.translate(W * C.CAMERA_LEAD_X, H * C.CAMERA_ANCHOR_Y);
  ctx.scale(camera.scale, camera.scale);
  ctx.translate(-camera.x, -camera.y);
  const view = camera.view();
  terrain.render(ctx, view, atmosphere.palette, atmosphere.glow);
  obstacles.render(ctx, view, atmosphere.palette, atmosphere.glow);
  player.render(ctx, atmosphere.glow);
  player.renderParticles(ctx);
  ctx.restore();
  renderPulse();
  atmosphere.renderForeground(ctx, W, H);
}

// ---- Main loop ----
let last = performance.now();
function frame(now) {
  const raw = Math.min((now - last) / 1000, C.MAX_FRAME_DT);
  last = now;
  const dt = raw * game.timeScale;

  obstacles.update(camera, W / camera.unit);
  terrain.update(camera, W / camera.unit);
  const steps = Math.max(1, Math.ceil(dt / C.PHYSICS_STEP)), h = dt / steps;
  if (dt > 0) {
    for (let i = 0; i < steps; i++) {
      player.update(h, input, terrain);
      obstacles.resolve(player);
    }
  }
  camera.update(dt, player, terrain);
  atmosphere.update(dt, camera, W, H);
  audio.update(raw, audioTelemetry()); // real-time dt: audio smoothing shouldn't stretch with slow-mo

  updateHud();
  render();
  requestAnimationFrame(frame);
}

// Handles for debugging.
window.harmonicDescent = {
  game, atmosphere, camera, audio,
  get player() { return player; },
  get terrain() { return terrain; },
  get obstacles() { return obstacles; },
};

resize();
reset();
requestAnimationFrame(frame);