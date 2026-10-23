import { CONFIG as C } from './config.js';
import { TerrainManager } from './terrain.js';
import { Player, PlayerState } from './player.js';

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const el = {
  distance: document.getElementById('distance'),
  speed: document.getElementById('speed'),
  trick: document.getElementById('trick'),
  crash: document.getElementById('crash'),
  crashDistance: document.getElementById('crashDistance'),
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const game = { timeScale: 1.0 }; // future slow-mo QTEs will drive this

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
let terrain, player;
const input = { held: false, pressed: false };

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth; H = window.innerHeight;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  camera.resize(W, H);
}

// ---- HUD ----
let trickTimer = 0, lastDist = '', lastSpeed = '';
function showTrick(name) {
  el.trick.textContent = name;
  el.trick.classList.add('show');
  clearTimeout(trickTimer);
  trickTimer = setTimeout(() => el.trick.classList.remove('show'), 1600);
}
function updateHud() {
  const d = `${Math.max(0, Math.floor(player.x / C.PX_PER_METER))} m`;
  const s = `${Math.round((player.speed / C.PX_PER_METER) * 3.6)} km/h`;
  if (d !== lastDist) { el.distance.textContent = d; lastDist = d; }
  if (s !== lastSpeed) { el.speed.textContent = s; lastSpeed = s; }
}

// ---- Game lifecycle ----
function reset() {
  terrain = new TerrainManager();
  player = new Player(terrain, 0);
  player.onTrick = (name) => showTrick(name);
  player.onCrash = () => {
    el.crashDistance.textContent = `${Math.max(0, Math.floor(player.x / C.PX_PER_METER))} m`;
    el.crash.classList.remove('hidden');
  };
  camera.snapTo(player);
  terrain.update(camera, W / camera.unit);
  input.held = input.pressed = false;
  el.crash.classList.add('hidden');
  el.trick.classList.remove('show');
  lastDist = lastSpeed = '';
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

window.addEventListener('pointerdown', (e) => { e.preventDefault(); press(); }, { passive: false });
window.addEventListener('pointerup', release);
window.addEventListener('pointercancel', release);
window.addEventListener('blur', release);
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) press(); }
  else if (e.code === 'KeyR') reset();
});
window.addEventListener('keyup', (e) => { if (e.code === 'Space') release(); });
// iOS Safari ignores user-scalable=no, so block scroll/pinch explicitly.
document.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
['gesturestart', 'gesturechange', 'gestureend'].forEach((t) => document.addEventListener(t, (e) => e.preventDefault()));
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', resize);

// ---- Rendering ----
function drawSky() {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#1c2150');
  g.addColorStop(0.55, '#a05f8e');
  g.addColorStop(1, '#f6b894');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  const sx = W * 0.72, sy = H * 0.34, r = 36 * camera.unit + 10;
  const glow = ctx.createRadialGradient(sx, sy, r * 0.5, sx, sy, r * 5);
  glow.addColorStop(0, 'rgba(255, 232, 196, 0.85)');
  glow.addColorStop(1, 'rgba(255, 232, 196, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#fff1d6';
  ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.fill();
}

function render() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawSky();
  ctx.save();
  ctx.translate(W * C.CAMERA_LEAD_X, H * C.CAMERA_ANCHOR_Y);
  ctx.scale(camera.scale, camera.scale);
  ctx.translate(-camera.x, -camera.y);
  terrain.render(ctx, camera.view());
  player.render(ctx);
  ctx.restore();
}

// ---- Main loop ----
let last = performance.now();
function frame(now) {
  const raw = Math.min((now - last) / 1000, C.MAX_FRAME_DT);
  last = now;
  const dt = raw * game.timeScale;

  terrain.update(camera, W / camera.unit);
  const steps = Math.max(1, Math.ceil(dt / C.PHYSICS_STEP)), h = dt / steps;
  if (dt > 0) for (let i = 0; i < steps; i++) player.update(h, input, terrain);
  camera.update(dt, player, terrain);

  updateHud();
  render();
  requestAnimationFrame(frame);
}

resize();
reset();
requestAnimationFrame(frame);