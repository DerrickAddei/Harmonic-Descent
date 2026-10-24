import { CONFIG as C } from './config.js';
import { Emitter } from './player.js';

/*
 Dual-currency economy.
   Gold Coins : scarce hard currency, picked up on the slope, spent on permanent gear.
   Echoes     : banked trick score, spent on Gilded Chime / Overdrive Harp upgrade tiers.
 Everything persistent lives under localStorage key C.SAVE_KEY. Writes are batched (dirty flag +
 tickSave) and flushed on purchases, run end and page hide.
 Events: change, buff ({kind,...buff}), buffEnd ({kind}).
*/

const defaults = () => ({
  version: 1,
  coins: 0, totalEchoes: 0, lifetimeCoins: 0, lifetimeEchoes: 0,
  bestDistance: 0, bestRunEchoes: 0, runs: 0,
  upgrades: { chime: 0, harp: 0 },
  gear: { magnet: false, board: false },
});
const int = (v, lo, hi, dflt) => { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.floor(v))) : dflt; };
const emptyBuff = () => ({ t: 0, dur: 0, mult: 1, cap: 0 });

export class EconomyManager extends Emitter {
  // storage: any object with getItem/setItem (defaults to localStorage); pass null to disable persistence.
  constructor(storage) {
    super();
    this.storage = storage !== undefined ? storage : EconomyManager.defaultStorage();
    this.persistent = !!this.storage;
    this.data = defaults();
    this.dirty = false;
    this._saveTimer = 0;
    this.run = this._newRun();
    this.buffs = { chime: emptyBuff(), harp: emptyBuff() };
    this.load();
  }

  static defaultStorage() {
    try {
      const s = globalThis.localStorage;
      if (!s) return null;
      s.setItem('__hd_probe', '1'); s.removeItem('__hd_probe');
      return s;
    } catch (e) { return null; } // blocked (private mode, sandboxed iframe)
  }

  // ---------- persistence ----------
  load() {
    if (!this.storage) return;
    let raw = null;
    try { raw = this.storage.getItem(C.SAVE_KEY); } catch (e) { return; }
    if (!raw) return;
    try {
      const j = JSON.parse(raw);
      if (!j || typeof j !== 'object') return;
      const d = defaults(), up = j.upgrades || {}, gear = j.gear || {};
      d.coins = int(j.coins, 0, 1e9, 0);
      d.totalEchoes = int(j.totalEchoes, 0, 1e12, 0);
      d.lifetimeCoins = int(j.lifetimeCoins, 0, 1e12, d.coins);
      d.lifetimeEchoes = int(j.lifetimeEchoes, 0, 1e12, d.totalEchoes);
      d.bestDistance = int(j.bestDistance, 0, 1e9, 0);
      d.bestRunEchoes = int(j.bestRunEchoes, 0, 1e12, 0);
      d.runs = int(j.runs, 0, 1e9, 0);
      d.upgrades.chime = int(up.chime, 0, C.UPGRADES.chime.costs.length, 0);
      d.upgrades.harp = int(up.harp, 0, C.UPGRADES.harp.costs.length, 0);
      d.gear.magnet = gear.magnet === true;
      d.gear.board = gear.board === true;
      this.data = d;
    } catch (e) { /* corrupted save: keep defaults, next flush overwrites it */ }
  }

  flush() {
    this.dirty = false;
    this._saveTimer = 0;
    if (!this.storage) return false;
    try { this.storage.setItem(C.SAVE_KEY, JSON.stringify(this.data)); return true; }
    catch (e) { this.persistent = false; return false; } // quota or blocked
  }

  tickSave(dt) { // call with real-time dt
    if (!this.dirty) return;
    this._saveTimer += dt;
    if (this._saveTimer >= 1.5) this.flush();
  }

  _touch() { this.dirty = true; this.emit('change'); }

  // ---------- read-only views ----------
  get coins() { return this.data.coins; }
  get totalEchoes() { return this.data.totalEchoes; }
  tier(id) { return this.data.upgrades[id]; }
  hasGear(id) { return this.data.gear[id]; }
  chimeChance() { return C.UPGRADES.chime.spawn[this.tier('chime')]; }
  magnetRadius() { return this.data.gear.magnet ? C.GEAR.magnet.radius : 0; }
  speedMult() { return this.data.gear.board ? C.GEAR.board.speedMult : 1; }
  flipMult() { return this.data.gear.board ? C.GEAR.board.flipMult : 1; }
  coinMult() { return this.buffs.chime.t > 0 ? this.buffs.chime.mult : 1; }
  trickMult() { return this.buffs.harp.t > 0 ? this.buffs.harp.mult : 1; }

  // ---------- runs ----------
  _newRun() { return { coins: 0, echoes: 0, pickups: 0 }; }

  startRun() {
    this.run = this._newRun();
    this.buffs = { chime: emptyBuff(), harp: emptyBuff() };
    this.emit('change');
  }

  endRun(distanceM) {
    const d = this.data;
    d.runs++;
    d.bestDistance = Math.max(d.bestDistance, Math.floor(distanceM));
    d.bestRunEchoes = Math.max(d.bestRunEchoes, this.run.echoes);
    this.flush();
    this.emit('change');
    return { ...this.run };
  }

  // ---------- earning ----------
  collectCoin() { // returns coins gained (Gilded Chime multiplies)
    const n = C.COIN_VALUE * this.coinMult(), d = this.data;
    d.coins += n; d.lifetimeCoins += n; this.run.coins += n;
    this._touch();
    return n;
  }

  // points are already multiplied by the Overdrive Harp (Player.scoreMult) when the bank event fires.
  bankEchoes(points) {
    points = Math.max(0, Math.round(points));
    const d = this.data;
    d.totalEchoes += points; d.lifetimeEchoes += points; this.run.echoes += points;
    this._touch();
    return points;
  }

  // ---------- buffs ----------
  activate(kind) {
    const u = C.UPGRADES[kind], tier = this.tier(kind), b = this.buffs[kind];
    b.dur = u.durations[tier];
    b.t = b.dur;
    b.mult = u.mults[tier];
    b.cap = kind === 'harp' ? b.dur * C.HARP_EXTEND_CAP : b.dur;
    this.run.pickups++;
    this.emit('buff', { kind, ...b });
    return { ...b };
  }

  extendHarp() { // clean flip or grind while Overdrive is running; returns true if time was added
    const b = this.buffs.harp;
    if (b.t <= 0) return false;
    const before = b.t;
    b.t = Math.min(b.cap, b.t + C.HARP_EXTEND);
    return b.t > before;
  }

  tickBuffs(dt) { // game-time dt; caller skips it while crashed or paused
    if (!(dt > 0)) return;
    for (const kind of ['chime', 'harp']) {
      const b = this.buffs[kind];
      if (b.t <= 0) continue;
      b.t = Math.max(0, b.t - dt);
      if (b.t === 0) this.emit('buffEnd', { kind });
    }
  }

  // ---------- workshop ----------
  describeUpgrade(id) {
    const u = C.UPGRADES[id], tier = this.tier(id), max = u.costs.length;
    const stat = (t) => {
      const base = `${id === 'chime' ? 'Coins' : 'Tricks'} ×${u.mults[t]} for ${u.durations[t]} s`;
      return id === 'chime' ? `${base}, ${Math.round((u.spawn[t] / u.spawn[0]) * 100)}% spawn rate` : base;
    };
    const cost = tier < max ? u.costs[tier] : null;
    return {
      id, name: u.name, blurb: u.blurb, tier, max, current: stat(tier), next: tier < max ? stat(tier + 1) : null,
      cost, affordable: cost !== null && this.data.totalEchoes >= cost, currency: 'Echoes',
    };
  }

  describeGear(id) {
    const g = C.GEAR[id], owned = this.data.gear[id];
    return { id, name: g.name, blurb: g.blurb, owned, cost: g.cost, affordable: !owned && this.data.coins >= g.cost, currency: 'Coins' };
  }

  buyUpgrade(id) {
    const u = C.UPGRADES[id];
    if (!u) return { ok: false, message: 'Unknown upgrade' };
    const tier = this.tier(id);
    if (tier >= u.costs.length) return { ok: false, message: `${u.name} is at max tier` };
    const cost = u.costs[tier];
    if (this.data.totalEchoes < cost) return { ok: false, message: `Need ${cost - this.data.totalEchoes} more Echoes` };
    this.data.totalEchoes -= cost;
    this.data.upgrades[id] = tier + 1;
    this.flush();
    this.emit('change');
    return { ok: true, message: `${u.name} upgraded to Tier ${tier + 1}` };
  }

  buyGear(id) {
    const g = C.GEAR[id];
    if (!g) return { ok: false, message: 'Unknown gear' };
    if (this.data.gear[id]) return { ok: false, message: `${g.name} is already owned` };
    if (this.data.coins < g.cost) return { ok: false, message: `Need ${g.cost - this.data.coins} more Coins` };
    this.data.coins -= g.cost;
    this.data.gear[id] = true;
    this.flush();
    this.emit('change');
    return { ok: true, message: `${g.name} unlocked` };
  }

  resetSave() { this.data = defaults(); this.flush(); this.emit('change'); }
}