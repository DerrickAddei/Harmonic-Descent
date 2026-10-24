import { CONFIG as C } from './config.js';
import { TerrainManager } from './terrain.js';
import { Player, PlayerState } from './player.js';
import { Atmosphere } from './atmosphere.js';
import { ObstacleManager } from './obstacles.js';
import { AudioEngine } from './audioEngine.js';
import { EconomyManager } from './economy.js';

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const $ = (id) => document.getElementById(id);
const el = {
  distance: $('distance'),
  speed: $('speed'),
  coins: $('coins'),
  echoes: $('echoes'),
  coinsStat: $('coinsStat'),
  echoesStat: $('echoesStat'),
  trick: $('trick'),
  crash: $('crash'),
  crashDistance: $('crashDistance'),
  crashRun: $('crashRun'),
  openWorkshop: $('openWorkshop'),
  combo: $('combo'),
  comboMult: $('comboMult'),
  comboPts: $('comboPts'),
  audio: $('audioToggle'),
  audioLabel: $('audioLabel'),
  buffs: $('buffs'),
  workshop: $('workshop'),
  wsCoins: $('wsCoins'),
  wsEchoes: $('wsEchoes'),
  wsMsg: $('wsMsg'),
  wsUpgrades: $('wsUpgrades'),
  wsGear: $('wsGear'),
  wsStats: $('wsStats'),
  wsClose: $('wsClose'),
};
const buffEls = {};
for (const row of el.buffs.querySelectorAll('.buff')) {
  buffEls[row.dataset.kind] = {
    row, label: row.querySelector('.name'), time: row.querySelector('.time'), bar: row.querySelector('.bar i'),
    shown: false, lastP: -1, lastText: '', lastLabel: '',
  };
}

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
const economy = new EconomyManager(); // persistent wallet, buffs and upgrades (localStorage)
let terrain, player, obstacles;
let workshopOpen = false;
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
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { audio.suspend(); economy.flush(); } else audio.resume();
});
window.addEventListener('pagehide', () => economy.flush());

// ---- HUD ----
let trickTimer = 0, bankUntil = 0;
let lastDist = '', lastSpeed = '', lastCoins = '', lastEchoes = '', lastMult = '', lastPts = '', lastLv = -1, lastPulse = -1;
const fmt = (n) => Math.round(n).toLocaleString('en-US');

function bumpEl(node) {
  if (reducedMotion) return;
  node.classList.remove('bump');
  void node.offsetWidth; // restart the CSS animation
  node.classList.add('bump');
}
function showTrick(name) {
  el.trick.textContent = name;
  el.trick.classList.add('show');
  clearTimeout(trickTimer);
  trickTimer = setTimeout(() => el.trick.classList.remove('show'), 1600);
}
function bumpCombo() {
  el.combo.classList.remove('bump', 'banked');
  void el.combo.offsetWidth;
  el.combo.classList.add('bump');
  bankUntil = 0;
}

const BUFF_NAMES = { chime: 'Gilded Chime', harp: 'Overdrive Harp' };
const BUFF_WHAT = { chime: 'Coins', harp: 'Tricks' };

function updateBuffs() {
  for (const kind of ['chime', 'harp']) {
    const b = economy.buffs[kind], ui = buffEls[kind], active = b.t > 0;
    if (active !== ui.shown) {
      ui.shown = active;
      ui.row.classList.toggle('show', active);
      ui.lastP = -1; ui.lastText = ''; ui.lastLabel = '';
    }
    if (!active) continue;
    const label = `${BUFF_NAMES[kind]} · ${BUFF_WHAT[kind]} ×${b.mult}`;
    if (label !== ui.lastLabel) { ui.label.textContent = label; ui.lastLabel = label; }
    const text = `${b.t.toFixed(1)}s`;
    if (text !== ui.lastText) { ui.time.textContent = text; ui.lastText = text; }
    const p = Math.round(clamp(b.t / Math.max(b.dur, b.t), 0, 1) * 200) / 200;
    if (p !== ui.lastP) { ui.bar.style.setProperty('--p', String(p)); ui.lastP = p; }
    ui.row.classList.toggle('low', b.t < 1.5);
  }
}

function updateHud() {
  const d = `${Math.max(0, Math.floor(player.x / C.PX_PER_METER))} m`;
  const s = `${Math.round((player.speed / C.PX_PER_METER) * 3.6)} km/h`;
  const c = fmt(economy.coins), e = fmt(economy.totalEchoes);
  if (d !== lastDist) { el.distance.textContent = d; lastDist = d; }
  if (s !== lastSpeed) { el.speed.textContent = s; lastSpeed = s; }
  if (c !== lastCoins) { el.coins.textContent = c; if (lastCoins !== '') bumpEl(el.coinsStat); lastCoins = c; }
  if (e !== lastEchoes) { el.echoes.textContent = e; if (lastEchoes !== '') bumpEl(el.echoesStat); lastEchoes = e; }

  if (player.comboCount > 0) {
    const m = `${player.comboCount}x`, p = `+${fmt(player.comboPoints * player.comboCount * player.scoreMult)}`;
    if (m !== lastMult) { el.comboMult.textContent = m; lastMult = m; }
    if (p !== lastPts) { el.comboPts.textContent = p; lastPts = p; }
    el.combo.classList.toggle('overdrive', player.scoreMult > 1);
    el.combo.classList.add('show');
  } else if (performance.now() < bankUntil) {
    el.combo.classList.add('show');
  } else {
    el.combo.classList.remove('show', 'banked', 'overdrive');
  }
  updateBuffs();

  // audio indicator: equalizer bars follow the output level, glow follows the beat
  if (!reducedMotion && !audio.muted) {
    const lv = Math.round(audio.level * 50) / 50, pu = Math.round(audio.pulse * 20) / 20;
    if (lv !== lastLv) { el.audio.style.setProperty('--lv', String(lv)); lastLv = lv; }
    if (pu !== lastPulse) { el.audio.style.setProperty('--pulse', String(pu)); lastPulse = pu; }
  }
}

// ---- Economy wiring (listeners on the long-lived manager are registered once) ----
economy.on('buffEnd', () => audio.onBuffEnd());
function applyGear() { // Resonance Board: base speed + flip torque
  if (!player) return;
  player.speedMult = economy.speedMult();
  player.flipMult = economy.flipMult();
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
  obstacles.on('coinPickup', () => audio.onCoinPickup());
  obstacles.on('multiplierPickup', (e) => audio.onMultiplierPickup(e));
}

function bindEconomy() {
  obstacles.on('coinPickup', () => economy.collectCoin());
  obstacles.on('multiplierPickup', ({ kind }) => {
    const b = economy.activate(kind);
    showTrick(`${BUFF_NAMES[kind]} — ${BUFF_WHAT[kind]} ×${b.mult}`);
  });
  player.on('bank', ({ points }) => economy.bankEchoes(points)); // run score + permanent Echoes
  const extend = () => { // Overdrive Harp flow: clean flip landing or a grind start adds time
    if (economy.extendHarp()) {
      const row = buffEls.harp.row;
      row.classList.remove('extend');
      void row.offsetWidth;
      row.classList.add('extend');
    }
  };
  player.on('flip', extend);
  player.on('grindStart', extend);
}

function reset() {
  economy.startRun();
  terrain = new TerrainManager();
  obstacles = new ObstacleManager(terrain, economy);
  player = new Player(terrain, 0);
  applyGear();
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
    const dist = Math.max(0, Math.floor(player.x / C.PX_PER_METER));
    const best = economy.data.bestDistance;
    const run = economy.endRun(dist);
    el.crashDistance.textContent = `${dist} m${dist > best && best > 0 ? ' · new best!' : ''}`;
    el.crashRun.textContent = `+${fmt(run.coins)} Coins · +${fmt(run.echoes)} Echoes`;
    el.crash.classList.remove('hidden');
  });
  bindAudio();
  bindEconomy();
  audio.onReset();
  camera.snapTo(player);
  obstacles.update(camera, W / camera.unit); // must precede terrain.update (registers chasms first)
  terrain.update(camera, W / camera.unit);
  input.held = input.pressed = false;
  bankUntil = 0;
  el.crash.classList.add('hidden');
  el.trick.classList.remove('show');
  el.combo.classList.remove('show', 'banked', 'bump', 'overdrive');
  lastDist = lastSpeed = lastMult = lastPts = '';
}

// ---- Workshop modal ----
let wsFlash = null; // { id, ok } — card to animate after the next render
let wsMsgTimer = 0;

const pips = (tier, max) => Array.from({ length: max }, (_, i) => `<i class="${i < tier ? 'on' : ''}"></i>`).join('');

function upgradeCard(u) {
  const maxed = u.next === null;
  const label = maxed ? 'Maxed' : `Upgrade · ${fmt(u.cost)} Echoes`;
  return `<article class="card ${u.id}${maxed ? ' maxed' : ''}" data-id="${u.id}">
    <h4>${u.name}<span class="tier">${maxed ? 'MAX' : `Tier ${u.tier}/${u.max}`}</span></h4>
    <p class="blurb">${u.blurb}</p>
    <div class="pips" aria-hidden="true">${pips(u.tier, u.max)}</div>
    <p class="line"><span>Now</span>${u.current}</p>
    <p class="line next"><span>Next</span>${maxed ? 'Fully tuned' : u.next}</p>
    <button class="buy${u.affordable ? '' : ' poor'}" type="button" data-kind="upgrade" data-id="${u.id}"${maxed ? ' disabled' : ''} aria-disabled="${!u.affordable}">${label}</button>
  </article>`;
}
function gearCard(g) {
  const label = g.owned ? 'Owned' : `Unlock · ${fmt(g.cost)} Coins`;
  return `<article class="card gear ${g.id}${g.owned ? ' maxed' : ''}" data-id="${g.id}">
    <h4>${g.name}<span class="tier">${g.owned ? 'OWNED' : 'Permanent'}</span></h4>
    <p class="blurb">${g.blurb}</p>
    <button class="buy${g.affordable ? '' : ' poor'}" type="button" data-kind="gear" data-id="${g.id}"${g.owned ? ' disabled' : ''} aria-disabled="${!g.affordable}">${label}</button>
  </article>`;
}

function renderWorkshop() {
  const d = economy.data;
  el.wsCoins.textContent = fmt(d.coins);
  el.wsEchoes.textContent = fmt(d.totalEchoes);
  el.wsUpgrades.innerHTML = ['chime', 'harp'].map((id) => upgradeCard(economy.describeUpgrade(id))).join('');
  el.wsGear.innerHTML = ['magnet', 'board'].map((id) => gearCard(economy.describeGear(id))).join('');
  el.wsStats.textContent = `Best ${fmt(d.bestDistance)} m · ${fmt(d.runs)} runs · ${fmt(d.lifetimeCoins)} Coins and ${fmt(d.lifetimeEchoes)} Echoes earned`
    + (economy.persistent ? '' : ' · progress will not be saved in this browser');
  if (wsFlash) {
    const card = el.workshop.querySelector(`.card[data-id="${wsFlash.id}"]`);
    if (card) {
      card.classList.add(wsFlash.ok ? 'flash' : 'deny');
      const btn = card.querySelector('.buy');
      if (btn && !btn.disabled) btn.focus({ preventScroll: true });
      else el.wsClose.focus({ preventScroll: true });
    }
    wsFlash = null;
  }
}

function wsMessage(text, ok) {
  el.wsMsg.textContent = text;
  el.wsMsg.classList.toggle('ok', !!ok);
  el.wsMsg.classList.toggle('bad', !ok);
  clearTimeout(wsMsgTimer);
  wsMsgTimer = setTimeout(() => { el.wsMsg.textContent = 'Spend Echoes on pickups, Coins on gear.'; el.wsMsg.classList.remove('ok', 'bad'); }, 2600);
}

function openWorkshop() {
  if (workshopOpen) return;
  workshopOpen = true;
  input.held = input.pressed = false;
  el.workshop.hidden = false;
  el.wsMsg.textContent = 'Spend Echoes on pickups, Coins on gear.';
  el.wsMsg.classList.remove('ok', 'bad');
  renderWorkshop();
  void el.workshop.offsetWidth;
  el.workshop.classList.add('open');
  el.wsClose.focus({ preventScroll: true });
  document.body.classList.add('paused');
}
function closeWorkshop() {
  if (!workshopOpen) return;
  workshopOpen = false;
  el.workshop.classList.remove('open');
  el.workshop.hidden = true;
  document.body.classList.remove('paused');
  input.held = input.pressed = false;
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  economy.flush();
  last = performance.now(); // don't let the paused time leak into the next frame
}

function buy(kind, id) {
  const res = kind === 'gear' ? economy.buyGear(id) : economy.buyUpgrade(id);
  wsFlash = { id, ok: res.ok };
  if (res.ok) { audio.onPurchase(); if (kind === 'gear') applyGear(); }
  wsMessage(res.message, res.ok);
  renderWorkshop();
}

el.workshop.addEventListener('click', (e) => {
  const t = e.target.closest ? e.target : null;
  if (!t) return;
  const btn = t.closest('.buy');
  if (btn) { if (!btn.disabled) buy(btn.dataset.kind, btn.dataset.id); return; }
  if (t.closest('#wsClose') || t === el.workshop) closeWorkshop(); // close button or backdrop
});
el.workshop.addEventListener('animationend', (e) => {
  if (e.target.classList) e.target.classList.remove('flash', 'deny');
});
el.openWorkshop.addEventListener('click', () => { el.openWorkshop.blur(); openWorkshop(); });
economy.on('change', () => { if (workshopOpen && !wsFlash) renderWorkshop(); });

// Keep Tab focus inside the dialog while it is open.
el.workshop.addEventListener('keydown', (e) => {
  if (e.code !== 'Tab') return;
  const f = [...el.workshop.querySelectorAll('button:not([disabled])')];
  if (!f.length) return;
  const first = f[0], lastEl = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); lastEl.focus(); }
  else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); first.focus(); }
});

// ---- Input (mouse / touch / keyboard) ----
function press() {
  if (workshopOpen) return;
  if (player.state === PlayerState.CRASHED) {
    if (performance.now() - player.crashedAt > C.RESTART_DELAY_MS) reset();
    return;
  }
  input.held = true;
  input.pressed = true;
}
function release() { input.held = false; }

window.addEventListener('pointerdown', (e) => {
  // HUD / modal controls are not jumps; leave their default behaviour (clicks) alone.
  if (e.target.closest && e.target.closest('#audioToggle, #openWorkshop, #workshop')) return;
  e.preventDefault();
  press();
}, { passive: false });
window.addEventListener('pointerup', release);
window.addEventListener('pointercancel', release);
window.addEventListener('blur', release);
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyW' && !e.repeat) { workshopOpen ? closeWorkshop() : openWorkshop(); return; }
  if (workshopOpen) {
    if (e.code === 'Escape') closeWorkshop();
    return; // Space / Enter fall through to the focused button
  }
  if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) press(); }
  else if (e.code === 'KeyR') reset();
  else if (e.code === 'KeyM' && !e.repeat) toggleMute();
  else if (e.code === 'KeyN') atmosphere.skipPhase(); // debug: jump to the next time-of-day phase
});
window.addEventListener('keyup', (e) => { if (e.code === 'Space') release(); });
document.addEventListener('touchmove', (e) => {
  if (e.target.closest && e.target.closest('.ws-panel')) return; // let the modal scroll
  e.preventDefault();
}, { passive: false });
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
    chimeActive: economy.buffs.chime.t > 0,
    harpActive: economy.buffs.harp.t > 0,
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
  obstacles.render(ctx, view, atmosphere.palette, atmosphere.glow, atmosphere.time);
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
  const dt = workshopOpen ? 0 : raw * game.timeScale; // the Workshop pauses the simulation

  obstacles.update(camera, W / camera.unit);
  terrain.update(camera, W / camera.unit);
  player.scoreMult = economy.trickMult(); // Overdrive Harp: read when a combo banks
  const steps = Math.max(1, Math.ceil(dt / C.PHYSICS_STEP)), h = dt / steps;
  if (dt > 0) {
    for (let i = 0; i < steps; i++) {
      player.update(h, input, terrain);
      obstacles.resolve(player, h);
    }
    if (player.state !== PlayerState.CRASHED) economy.tickBuffs(dt);
  }
  camera.update(dt, player, terrain);
  atmosphere.update(workshopOpen ? raw : dt, camera, W, H); // the sky keeps drifting behind the menu
  audio.update(raw, audioTelemetry()); // real-time dt: audio smoothing shouldn't stretch with slow-mo
  economy.tickSave(raw);

  updateHud();
  render();
  requestAnimationFrame(frame);
}

// Handles for debugging.
window.harmonicDescent = {
  game, atmosphere, camera, audio, economy,
  openWorkshop, closeWorkshop,
  get player() { return player; },
  get terrain() { return terrain; },
  get obstacles() { return obstacles; },
};

resize();
reset();
requestAnimationFrame(frame);