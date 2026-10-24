import { CONFIG as C } from './config.js';

/*
 Harmonic Descent audio engine: 100% procedural Web Audio, no sample files.

 Signal chain:
   layer gains (pad, sub, shimmer, kick, hats, arp, lead, fx) -> bus
   bus -> master low-pass (380 Hz on the ground .. 7500 Hz high in the air)
        -> dry ----------------------------------------------\
        -> reverb send -> convolver (generated impulse) ------+-> pre-comp -> compressor -> master gain -> out
        -> delay send -> ping-pong stereo delay (dotted 8th) -/

 Time: a lookahead scheduler (setInterval, independent of the render loop) places 16th-note events
 on the AudioContext clock. Step length follows `ts` = game.timeScale * crash slow-down, so slow-mo
 and crashes drag the tempo.
 Movement: update(dt, telemetry) is called every frame and maps speed, boost, altitude, time of day,
 time scale and crash state onto gains, filter, detune and reverb.
*/

const TAU = Math.PI * 2;
const FLOOR = 0.0001;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const L = C.AUDIO_LAYER_GAINS;
const SCALE = C.SCALE_FREQS;

// Arp pattern, semitone offsets above the chord root (root / octave / fifth only, so it fits every chord).
const ARP = [0, 12, 7, 12, 0, 7, 12, 19];

export class AudioEngine {
  constructor() {
    this.AC = globalThis.AudioContext || globalThis.webkitAudioContext || null;
    this.supported = !!this.AC;
    this.ctx = null;
    this.ready = false;
    this.muted = false;

    // continuous state (smoothed in update, readable by the HUD / visuals)
    this.energy = 0;      // 0..1 from speed + boost; drives percussion and arp
    this.alt = 0;         // 0..1 smoothed altitude (drives filter + shimmer)
    this.pulse = 0;       // 1 on each quarter note, decays; for visuals
    this.flash = 0;       // 1 on stingers, decays; for visuals
    this.level = 0;       // analyser RMS 0..1; for visuals
    this.cutoffHz = C.FILTER_GROUND_HZ;
    this.filterKick = 0;
    this.crashAmt = 0;
    this.timeScaleSm = 1;
    this.ts = 1;          // effective tempo multiplier

    // clock
    this.step = 0;
    this.nextNoteTime = 0;
    this.chordIdx = 0;
    this._resync = true;
    this._timer = null;
    this._pulseQueue = [];
    this._writeAcc = 0;

    // musical state
    this.leadOn = false;
    this.leadIdx = 0;
    this.flipChain = 0;   // chimes played since the last ground touchdown
    this.flipsHeard = 0;  // flips already chimed in the current rotation tally
    this.lastAirRot = 0;
    this.jumpCount = 0;
    this._takeoffTimer = null;
    this._lastPluck = -1;
    this.coinChain = 0;   // consecutive coins picked up within 1.1 s: pitch climbs the pentatonic scale
    this._lastCoin = -10;
    this.buffLevel = 0;   // 0..1 smoothed presence of the multiplier shimmer

    this.tel = { speed: 0, boost: 0, heightAboveGround: 0, nightFactor: 0, timeScale: 1, state: 'GROUNDED', airRotation: 0, combo: 0, chimeActive: false, harpActive: false };
  }

  // ---------- lifecycle ----------
  // Call from a user gesture (pointerdown / keydown / touchend). Safe to call repeatedly.
  unlock() {
    if (!this.AC) return false;
    if (!this.ctx) {
      try { this.ctx = new this.AC({ latencyHint: 'interactive' }); } catch (e) { this.AC = null; this.supported = false; return false; }
      this._build();
    }
    if (this.ctx.state === 'suspended') { const p = this.ctx.resume(); if (p && p.catch) p.catch(() => {}); }
    return true;
  }

  suspend() { if (this.ctx && this.ctx.state === 'running') { const p = this.ctx.suspend(); if (p && p.catch) p.catch(() => {}); } }
  resume() { if (this.ctx && this.ctx.state === 'suspended') { const p = this.ctx.resume(); if (p && p.catch) p.catch(() => {}); } }

  dispose() {
    clearInterval(this._timer); this._timer = null;
    clearTimeout(this._takeoffTimer);
    if (this.ctx) { const p = this.ctx.close(); if (p && p.catch) p.catch(() => {}); }
    this.ctx = null; this.ready = false;
  }

  setMuted(m) {
    this.muted = !!m;
    if (this.ctx && this.ready) this.master.gain.setTargetAtTime(this.muted ? 0 : L.master, this.ctx.currentTime, 0.05);
  }
  toggleMute() { this.setMuted(!this.muted); return this.muted; }

  getState() {
    return { running: !!this.ctx && this.ctx.state === 'running', step: this.step, chord: C.CHORDS[this.chordIdx].name, energy: this.energy, alt: this.alt, cutoffHz: this.cutoffHz, tempo: C.AUDIO_BPM * this.ts, crashAmt: this.crashAmt, leadOn: this.leadOn };
  }

  // ---------- graph ----------
  _build() {
    const ctx = this.ctx;
    const gain = (v) => { const n = ctx.createGain(); n.gain.value = v; return n; };
    const filter = (type, hz, q = 0.7) => { const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = hz; f.Q.value = q; return f; };

    // output stage
    this.master = gain(this.muted ? 0 : L.master);
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -18; this.comp.knee.value = 24; this.comp.ratio.value = 4;
    this.comp.attack.value = 0.006; this.comp.release.value = 0.22;
    this.preComp = gain(1);
    this.preComp.connect(this.comp); this.comp.connect(this.master); this.master.connect(ctx.destination);
    this.analyser = ctx.createAnalyser(); this.analyser.fftSize = 256;
    this._abuf = new Float32Array(this.analyser.fftSize);
    this.comp.connect(this.analyser);

    // master low-pass + sends
    this.bus = gain(1);
    this.lp = filter('lowpass', C.FILTER_GROUND_HZ, 0.8);
    this.bus.connect(this.lp);
    this.lp.connect(this.preComp); // dry

    this.verbSend = gain(C.REVERB_WET_DAY);
    this.verb = ctx.createConvolver();
    this.verb.buffer = this._makeImpulse();
    this.lp.connect(this.verbSend); this.verbSend.connect(this.verb); this.verb.connect(this.preComp);

    this.delaySend = gain(C.DELAY_WET_DAY);
    this.delayL = ctx.createDelay(2); this.delayR = ctx.createDelay(2);
    const fb1 = gain(C.DELAY_FEEDBACK), fb2 = gain(C.DELAY_FEEDBACK);
    const panL = ctx.createStereoPanner(), panR = ctx.createStereoPanner();
    panL.pan.value = -0.65; panR.pan.value = 0.65;
    const delayOut = gain(1);
    this.lp.connect(this.delaySend); this.delaySend.connect(this.delayL);
    this.delayL.connect(panL); panL.connect(delayOut);
    this.delayL.connect(fb1); fb1.connect(this.delayR);
    this.delayR.connect(panR); panR.connect(delayOut);
    this.delayR.connect(fb2); fb2.connect(this.delayL);
    delayOut.connect(this.preComp);
    const dt0 = this._delayTime();
    this.delayL.delayTime.value = dt0; this.delayR.delayTime.value = dt0;

    // shared noise buffer
    const nlen = ctx.sampleRate, nb = ctx.createBuffer(1, nlen, ctx.sampleRate), nd = nb.getChannelData(0);
    for (let i = 0; i < nlen; i++) nd[i] = Math.random() * 2 - 1;
    this.noiseBuf = nb;

    // sustained voices (pad, sub, shimmer): oscillators run forever, chords just glide their pitch
    this.sustained = [];
    const chord0 = C.CHORDS[0];
    const sust = (type, midi, detune, dest) => {
      const o = ctx.createOscillator(); o.type = type; o.frequency.value = mtof(midi); o.detune.value = detune;
      o.connect(dest); o.start(); const v = { osc: o, base: detune }; this.sustained.push(v); return v;
    };

    this.padGain = gain(0); this.padGain.connect(this.bus);
    this.padFilter = filter('lowpass', C.PAD_CUTOFF_DAY, 0.5); this.padFilter.connect(this.padGain);
    this.sawBus = gain(0.045); this.triBus = gain(0.08);
    this.sawBus.connect(this.padFilter); this.triBus.connect(this.padFilter);
    this.padVoices = chord0.notes.map((m) => [sust('sawtooth', m, -9, this.sawBus), sust('sawtooth', m, 9, this.sawBus), sust('triangle', m, 0, this.triBus)]);

    this.subGain = gain(0); this.subGain.connect(this.bus);
    const subS = gain(0.5), subT = gain(0.12);
    subS.connect(this.subGain); subT.connect(this.subGain);
    this.subVoices = [sust('sine', chord0.root, 0, subS), sust('triangle', chord0.root + 12, 0, subT)];

    this.shimmerGain = gain(0); this.shimmerGain.connect(this.bus);
    const trem = gain(0.75); trem.connect(this.shimmerGain);
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.35;
    const lfoDepth = gain(0.25); lfo.connect(lfoDepth); lfoDepth.connect(trem.gain); lfo.start();
    this.shimmerVoices = chord0.notes.slice(2).map((m, i) => {
      const g = gain(0.2); g.connect(trem);
      return sust(i === 1 ? 'triangle' : 'sine', m + 24, i * 3 - 3, g);
    });

    // multiplier-buff shimmer: three high sines on the chord (bypass the master low-pass so it stays airy),
    // tremolo-modulated; faster tremolo for the Overdrive Harp than for the Gilded Chime.
    this.buffGain = gain(0);
    this.buffGain.connect(this.preComp);
    const buffVerb = gain(0.6); this.buffGain.connect(buffVerb); buffVerb.connect(this.verb);
    const buffTrem = gain(0.7); buffTrem.connect(this.buffGain);
    this.buffLfo = ctx.createOscillator(); this.buffLfo.frequency.value = 4.5;
    const buffDepth = gain(0.3); this.buffLfo.connect(buffDepth); buffDepth.connect(buffTrem.gain); this.buffLfo.start();
    this.buffVoices = [0, 2, 3].map((n, i) => {
      const g = gain(0.33); g.connect(buffTrem);
      return sust(i === 1 ? 'triangle' : 'sine', chord0.notes[n] + 36, i * 4 - 4, g);
    });

    // rhythm + lead layers
    this.kickGain = gain(0); this.kickGain.connect(this.bus);
    this.hatGain = gain(0); this.hatGain.connect(this.bus);
    this.arpGain = gain(0); this.arpGain.connect(this.bus);
    this.arpFilter = filter('lowpass', 900, 1.2); this.arpFilter.connect(this.arpGain);
    this.leadGain = gain(0); this.leadGain.connect(this.bus);
    this.fxGain = gain(L.fx); this.fxGain.connect(this.bus);

    this.ready = true;
    this._resync = true;
    this._timer = setInterval(() => this._tick(), C.AUDIO_SCHEDULER_MS);
    this._tick();
  }

  _makeImpulse() { // dark, exponentially decaying stereo noise
    const ctx = this.ctx, rate = ctx.sampleRate, len = Math.floor(rate * C.REVERB_SECONDS);
    const buf = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        lp += ((Math.random() * 2 - 1) * Math.pow(1 - t, C.REVERB_DECAY_POW) - lp) * lerp(0.6, 0.12, t);
        d[i] = lp;
      }
    }
    return buf;
  }

  // ---------- per-frame modulation ----------
  update(dt, tel) {
    dt = clamp(dt || 0, 0, 0.1);
    if (tel) Object.assign(this.tel, tel);
    const T = this.tel, crashed = T.state === 'CRASHED', k = (tc) => 1 - Math.exp(-dt / tc);

    this.crashAmt += ((crashed ? 1 : 0) - this.crashAmt) * k(crashed ? 0.35 : 0.6);
    this.timeScaleSm += (clamp(T.timeScale, 0.1, 2) - this.timeScaleSm) * k(0.15);
    this.ts = Math.max(0.12, this.timeScaleSm * (1 - 0.8 * this.crashAmt));

    const speedT = clamp((T.speed - C.AUDIO_ENERGY_SPEED_MIN) / (C.AUDIO_ENERGY_SPEED_MAX - C.AUDIO_ENERGY_SPEED_MIN), 0, 1);
    const boostT = clamp(T.boost / (C.BOOST_SPEED_BONUS * C.MAX_BOOST_STACK), 0, 1);
    this.energy += ((crashed ? 0 : clamp(speedT * 0.75 + boostT * 0.5, 0, 1)) - this.energy) * k(0.5);
    this.alt += (smooth(T.heightAboveGround / C.FILTER_ALT_MAX_PX) - this.alt) * k(0.08);
    this.filterKick *= Math.exp(-dt / 0.5);
    this.pulse *= Math.exp(-dt / 0.18);
    this.flash *= Math.exp(-dt / 0.35);

    this._detectFlips(T.airRotation || 0);

    // master cutoff: ground (+ small speed lift) -> open at altitude, boosted by stingers, dragged by slow-mo, swept down by a crash
    const ground = C.FILTER_GROUND_HZ * Math.pow(2, this.energy * C.FILTER_SPEED_LIFT_OCT);
    let hz = ground * Math.pow(C.FILTER_AIR_HZ / ground, this.alt);
    hz *= 1 + this.filterKick * C.FILTER_KICK_MULT;
    hz *= Math.pow(clamp(this.timeScaleSm, 0.1, 1), 0.75);
    hz = clamp(hz, 60, 12000);
    hz *= Math.pow(C.FILTER_CRASH_HZ / hz, this.crashAmt);
    this.cutoffHz = clamp(hz, 60, 12000);

    if (!this.ctx || !this.ready) return;
    const ctx = this.ctx, now = ctx.currentTime;

    while (this._pulseQueue.length && this._pulseQueue[0] <= now) { this._pulseQueue.shift(); this.pulse = 1; }
    this.analyser.getFloatTimeDomainData(this._abuf);
    let sum = 0;
    for (let i = 0; i < this._abuf.length; i++) sum += this._abuf[i] * this._abuf[i];
    this.level = Math.max(clamp(Math.sqrt(sum / this._abuf.length) * 3.5, 0, 1), this.level * Math.exp(-dt / 0.12));

    this._writeAcc += dt;
    if (this._writeAcc < 0.04) return; // write audio params at ~25 Hz
    const wdt = this._writeAcc; // time since the last parameter write
    this._writeAcc = 0;

    const night = clamp(T.nightFactor, 0, 1), set = (p, v, tc) => p.setTargetAtTime(v, now, tc);
    set(this.lp.frequency, this.cutoffHz, 0.06);
    set(this.lp.Q, 0.8 + this.crashAmt * 3, 0.1);
    set(this.padGain.gain, L.pad * (1 - 0.25 * this.energy), 0.3);
    set(this.subGain.gain, L.sub, 0.3);
    set(this.shimmerGain.gain, L.shimmer * this.alt, 0.12);
    const wantBuff = (T.chimeActive || T.harpActive) && !crashed ? 1 : 0;
    this.buffLevel += (wantBuff - this.buffLevel) * (1 - Math.exp(-wdt / 0.25));
    set(this.buffGain.gain, L.buff * this.buffLevel, 0.08);
    set(this.buffLfo.frequency, T.harpActive ? 7.5 : 4.5, 0.1);
    set(this.padFilter.frequency, lerp(C.PAD_CUTOFF_DAY, C.PAD_CUTOFF_NIGHT, night), 0.5);
    set(this.sawBus.gain, 0.045 * lerp(1, 0.35, night), 0.5);   // brighter saws by day...
    set(this.triBus.gain, 0.08 * lerp(0.5, 1.1, night), 0.5);   // ...rounder triangles by night
    set(this.verbSend.gain, lerp(C.REVERB_WET_DAY, C.REVERB_WET_NIGHT, night), 0.5);
    set(this.delaySend.gain, lerp(C.DELAY_WET_DAY, C.DELAY_WET_NIGHT, night), 0.5);
    set(this.kickGain.gain, L.kick * smooth((this.energy - 0.12) / 0.3), 0.1);
    set(this.hatGain.gain, L.hat * smooth((this.energy - 0.28) / 0.35), 0.1);
    set(this.arpGain.gain, L.arp * smooth((this.energy - 0.2) / 0.35), 0.1);
    set(this.arpFilter.frequency, 500 + 2200 * this.energy, 0.1);
    const dTime = this._delayTime();
    set(this.delayL.delayTime, dTime, 0.1); set(this.delayR.delayTime, dTime, 0.1);

    // tape effect: sustained voices sag in pitch on a crash and in slow-mo
    const tape = C.TAPE_CRASH_CENTS * this.crashAmt + C.TAPE_SLOWMO_CENTS_PER_OCT * Math.log2(clamp(this.timeScaleSm, 0.25, 1));
    for (const v of this.sustained) set(v.osc.detune, v.base + tape, 0.08);
  }

  _delayTime() { return clamp(C.DELAY_BEATS * 60 / (C.AUDIO_BPM * (this.ts || 1)), 0.05, 1.9); }
  _stepDur() { return 60 / (C.AUDIO_BPM * this.ts) / 4; }

  // ---------- 16th-note scheduler ----------
  _tick() {
    const ctx = this.ctx;
    if (!ctx || !this.ready || ctx.state !== 'running' || this.muted) { this._resync = true; return; }
    const now = ctx.currentTime;
    if (this._resync || this.nextNoteTime < now - 0.05) {
      this._resync = false;
      this.nextNoteTime = now + 0.04;
      this._applyChord(Math.floor(this.step / (16 * C.CHORD_BARS)) % C.CHORDS.length, now, 0.1);
    }
    const horizon = now + C.AUDIO_LOOKAHEAD;
    for (let guard = 0; this.nextNoteTime < horizon && guard < 16; guard++) {
      this._scheduleStep(this.step, this.nextNoteTime);
      this.nextNoteTime += this._stepDur();
      this.step++;
    }
  }

  _applyChord(idx, t, tc) {
    const chord = C.CHORDS[idx];
    this.chordIdx = idx;
    this.padVoices.forEach((group, n) => { for (const v of group) v.osc.frequency.setTargetAtTime(mtof(chord.notes[n]), t, tc); });
    this.subVoices[0].osc.frequency.setTargetAtTime(mtof(chord.root), t, tc);
    this.subVoices[1].osc.frequency.setTargetAtTime(mtof(chord.root + 12), t, tc);
    this.shimmerVoices.forEach((v, i) => v.osc.frequency.setTargetAtTime(mtof(chord.notes[i + 2] + 24), t, tc * 1.5));
    this.buffVoices.forEach((v, i) => v.osc.frequency.setTargetAtTime(mtof(chord.notes[[0, 2, 3][i]] + 36), t, tc * 1.5));
  }

  _scheduleStep(step, t) {
    const s = step % 16, bar = Math.floor(step / (16 * C.CHORD_BARS)) % C.CHORDS.length;
    if (step % (16 * C.CHORD_BARS) === 0) this._applyChord(bar, t, 0.35);
    this.chordIdx = bar;
    if (s % 4 === 0) { this._pulseQueue.push(t); if (this._pulseQueue.length > 16) this._pulseQueue.shift(); }

    const e = this.energy, live = this.crashAmt < 0.3;
    if (live && e > 0.12) {
      if (s % 4 === 0) this._kick(t, 0.55 + 0.45 * e);
      else if (s === 14 && e > 0.7) this._kick(t, 0.5);
    }
    if (live && e > 0.28) {
      if (e > 0.55 ? s % 2 === 1 : s % 4 === 2) this._hat(t, (s % 4 === 2 ? 0.8 : 0.45) * (0.5 + 0.5 * e), false);
      if (s === 14 && e > 0.45) this._hat(t, 0.7, true);
    }
    if (live && e > 0.2) {
      const on = e > 0.6 ? true : e > 0.38 ? s % 2 === 0 : (s % 4 === 0 || s === 6 || s === 10);
      if (on) this._voice({
        type: 'sawtooth', freq: mtof(C.CHORDS[bar].root + 12 + ARP[s % ARP.length]), t, a: 0.003, d: 0.16,
        peak: s % 4 === 0 ? 0.9 : 0.6, dest: this.arpFilter,
      });
    }
    if (this.leadOn) this._leadNote(t);
  }

  // Nearest 32nd-note grid point that is still in the future.
  _quantize(time) {
    const grid = this._stepDur() / 2, ref = this.nextNoteTime || time;
    let q = ref + Math.round((time - ref) / grid) * grid;
    if (q < time + 0.004) q += grid;
    return q;
  }

  // ---------- voices ----------
  _voice(o) {
    const ctx = this.ctx, osc = ctx.createOscillator(), env = ctx.createGain();
    const a = Math.max(o.a, 0.002), end = o.t + a + o.d;
    osc.type = o.type;
    osc.frequency.setValueAtTime(o.freq, o.t);
    if (o.sweepTo) osc.frequency.exponentialRampToValueAtTime(o.sweepTo, o.t + (o.sweepTime || o.d));
    if (o.detune) osc.detune.value = o.detune;
    env.gain.setValueAtTime(FLOOR, o.t);
    env.gain.exponentialRampToValueAtTime(Math.max(o.peak, FLOOR * 2), o.t + a);
    env.gain.exponentialRampToValueAtTime(FLOOR, end);
    if (o.filterHz) {
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = o.filterHz;
      osc.connect(f); f.connect(env);
    } else osc.connect(env);
    env.connect(o.dest);
    osc.start(o.t);
    osc.stop(end + 0.05);
  }

  _noise(t, dur, o) {
    const ctx = this.ctx, src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), env = ctx.createGain();
    src.buffer = this.noiseBuf;
    f.type = o.type || 'highpass'; f.frequency.value = o.hz; f.Q.value = o.q || 0.7;
    env.gain.setValueAtTime(Math.max(o.peak, FLOOR * 2), t);
    env.gain.exponentialRampToValueAtTime(FLOOR, t + dur);
    src.connect(f); f.connect(env); env.connect(o.dest);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.02);
  }

  _kick(t, vel) {
    this._voice({ type: 'sine', freq: 150, sweepTo: 46, sweepTime: 0.12, t, a: 0.003, d: 0.26, peak: vel, dest: this.kickGain });
    this._noise(t, 0.02, { hz: 3000, peak: 0.25 * vel, dest: this.kickGain });
  }

  _hat(t, vel, open) {
    this._noise(t, open ? 0.16 : 0.045, { hz: 7500, peak: vel, dest: this.hatGain });
  }

  _leadNote(t) {
    const f = SCALE[this.leadIdx % SCALE.length];
    this.leadIdx = (this.leadIdx + 1) % SCALE.length; // ascends one scale step per 16th, then loops
    this._voice({ type: 'square', freq: f, t, a: 0.003, d: 0.2, peak: 0.5, filterHz: 3600, dest: this.leadGain });
    this._voice({ type: 'triangle', freq: f * 2, t, a: 0.003, d: 0.14, peak: 0.25, dest: this.leadGain });
  }

  _pluck(t, vel) { // soft upward-swept pluck
    this._lastPluck = t;
    const f = SCALE[this.jumpCount++ % 5];
    this._voice({ type: 'sine', freq: f, sweepTo: f * 2, sweepTime: 0.16, t, a: 0.004, d: 0.3, peak: 0.5 * vel, filterHz: 2400, dest: this.fxGain });
    this._voice({ type: 'triangle', freq: f * 2, sweepTo: f * 4, sweepTime: 0.16, t, a: 0.004, d: 0.18, peak: 0.12 * vel, filterHz: 3000, dest: this.fxGain });
  }

  _chime() { // bright bell; pitch climbs with every consecutive flip until the next ground touchdown
    const t = this.ctx.currentTime + 0.005, f = SCALE[clamp(6 + 2 * this.flipChain, 0, 14)];
    this.flipChain++;
    this.filterKick = Math.max(this.filterKick, 0.5);
    this.flash = Math.max(this.flash, 0.35);
    if (!this.ready || this.muted) return;
    [[1, 0.5, 1.4], [2.01, 0.28, 0.9], [3.99, 0.14, 0.5]].forEach(([r, g, d]) => {
      this._voice({ type: 'sine', freq: f * r, t, a: 0.002, d, peak: g, dest: this.fxGain });
    });
  }

  // ---------- flip detection (chimes during the rotation, not at the landing) ----------
  _detectFlips(rot) {
    if (rot < this.lastAirRot - 0.3) this.flipsHeard = 0; // tally was settled by a rail / rock / landing
    const n = Math.floor(rot / TAU + (1 - C.FLIP_COUNT_THRESHOLD));
    while (this.flipsHeard < n) { this.flipsHeard++; this._live() && this._chime(); }
    this.lastAirRot = rot;
  }
  _live() { return !!this.ctx && this.ready && !this.muted && this.ctx.state === 'running'; }

  // ---------- game events (hook these to player.on / obstacles.on) ----------
  onJump() {
    clearTimeout(this._takeoffTimer);
    this.filterKick = Math.max(this.filterKick, 0.25);
    if (this._live()) this._pluck(this._quantize(this.ctx.currentTime), 1);
  }

  onTakeoff() { // crest launches have no 'jump' event: wait in case one follows, and ignore tiny hops
    clearTimeout(this._takeoffTimer);
    this._takeoffTimer = setTimeout(() => {
      if (!this._live() || this.tel.state !== 'AIRBORNE') return;
      if (this.tel.heightAboveGround < 30 || this.ctx.currentTime - this._lastPluck < 0.35) return;
      this._pluck(this._quantize(this.ctx.currentTime), 0.55);
    }, 90);
  }

  onFlip(e) { // fallback: chime any flips the telemetry detector did not hear yet
    const missing = (e && e.flips ? e.flips : 1) - this.flipsHeard;
    for (let i = 0; i < missing; i++) { this.flipsHeard++; this._live() && this._chime(); }
  }

  onGrindStart() {
    this.leadOn = true;
    this.leadIdx = 1;
    this.filterKick = Math.max(this.filterKick, 0.35);
    if (!this._live()) return;
    const t = this.ctx.currentTime + 0.005;
    this.leadGain.gain.setTargetAtTime(L.lead, this.ctx.currentTime, 0.01);
    this._voice({ type: 'square', freq: SCALE[0], t, a: 0.003, d: 0.2, peak: 0.5, filterHz: 3600, dest: this.leadGain });
    this._voice({ type: 'triangle', freq: SCALE[0] * 2, t, a: 0.003, d: 0.14, peak: 0.25, dest: this.leadGain });
  }

  onGrindEnd() {
    this.leadOn = false;
    if (this.ready) this.leadGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.12);
  }

  onLand(e) {
    this.flipChain = 0; this.flipsHeard = 0;
    const impact = Math.abs((e && e.impact) || 0);
    if (this._live() && impact > 200) {
      this._noise(this.ctx.currentTime + 0.002, 0.14, { type: 'lowpass', hz: 420, peak: Math.min(impact / 1200, 0.5) * 0.6, dest: this.fxGain });
    }
  }

  onBank(e) { // lush pentatonic chord + sub drop, both scaled by the combo multiplier
    const count = (e && e.count) || 1;
    this.filterKick = clamp(0.6 + 0.08 * count, 0, 1);
    this.flash = 1;
    if (!this._live()) return;
    const t = this._quantize(this.ctx.currentTime), k = clamp(2 + count, 3, 7);
    for (let i = 0; i < k; i++) {
      const f = SCALE[2 + i * 2], st = t + i * 0.035, peak = 0.2 / Math.sqrt(k) * (1 - i * 0.04);
      this._voice({ type: 'sawtooth', freq: f, detune: -7, t: st, a: 0.02, d: 1.6, peak, filterHz: 3200, dest: this.fxGain });
      this._voice({ type: 'sawtooth', freq: f, detune: 7, t: st, a: 0.02, d: 1.6, peak, filterHz: 3200, dest: this.fxGain });
    }
    this._voice({ type: 'sine', freq: 120, sweepTo: 36, sweepTime: 0.7, t, a: 0.01, d: 0.9, peak: 0.35 + 0.1 * Math.min(count, 6), dest: this.fxGain });
  }

  // Crisp pentatonic ding. Consecutive coins climb the scale (resets after 1.1 s without a pickup).
  onCoinPickup() {
    this.filterKick = Math.max(this.filterKick, 0.4);
    if (!this._live()) return;
    const now = this.ctx.currentTime;
    if (now - this._lastCoin > 1.1) this.coinChain = 0;
    this._lastCoin = now;
    const i = 5 + this.coinChain, f = SCALE[i], f2 = SCALE[Math.min(i + 2, SCALE.length - 1)], t = now + 0.002;
    this.coinChain = Math.min(9, this.coinChain + 1);
    this._voice({ type: 'sine', freq: f, t, a: 0.002, d: 0.32, peak: 0.34, dest: this.fxGain });
    this._voice({ type: 'triangle', freq: f * 2, t, a: 0.002, d: 0.16, peak: 0.1, dest: this.fxGain });
    this._voice({ type: 'sine', freq: f2, t: t + 0.065, a: 0.002, d: 0.5, peak: 0.3, dest: this.fxGain });
    this._voice({ type: 'sine', freq: f2 * 2.01, t: t + 0.065, a: 0.002, d: 0.3, peak: 0.08, dest: this.fxGain });
  }

  // kind 'chime': four-note golden strum rising through the scale; 'harp': fast ten-note glissando with a sparkle on top.
  onMultiplierPickup(e) {
    const harp = !!e && e.kind === 'harp';
    this.filterKick = 0.9;
    this.flash = 1;
    if (!this._live()) return;
    const t = this.ctx.currentTime + 0.003;
    if (harp) {
      for (let i = 0; i < 10; i++) {
        const f = SCALE[Math.min(SCALE.length - 1, 3 + Math.floor(i * 1.15))], st = t + i * 0.034;
        this._voice({ type: 'triangle', freq: f, t: st, a: 0.002, d: 0.9, peak: 0.2, filterHz: 5200, dest: this.fxGain });
        this._voice({ type: 'sine', freq: f * 2, t: st, a: 0.002, d: 0.5, peak: 0.07, dest: this.fxGain });
      }
      this._voice({ type: 'sine', freq: SCALE[SCALE.length - 1] * 2, t: t + 0.36, a: 0.002, d: 1.2, peak: 0.16, dest: this.fxGain });
    } else {
      [7, 9, 11, 13].forEach((idx, i) => {
        const f = SCALE[idx], st = t + i * 0.055;
        this._voice({ type: 'sine', freq: f, t: st, a: 0.002, d: 1.1, peak: 0.28, dest: this.fxGain });
        this._voice({ type: 'sine', freq: f * 2.01, t: st, a: 0.002, d: 0.6, peak: 0.1, dest: this.fxGain });
        this._voice({ type: 'triangle', freq: f * 3, t: st, a: 0.002, d: 0.3, peak: 0.04, dest: this.fxGain });
      });
    }
  }

  onBuffEnd() { // soft two-note descent when a multiplier runs out
    if (!this._live()) return;
    const t = this.ctx.currentTime + 0.003;
    this._voice({ type: 'sine', freq: SCALE[8], t, a: 0.004, d: 0.35, peak: 0.16, dest: this.fxGain });
    this._voice({ type: 'sine', freq: SCALE[5], t: t + 0.09, a: 0.004, d: 0.5, peak: 0.16, dest: this.fxGain });
  }

  onPurchase() { // Workshop confirm: bright rising fifth (works while the game is paused)
    this.flash = Math.max(this.flash, 0.6);
    if (!this._live()) return;
    const t = this.ctx.currentTime + 0.003;
    [[6, 0], [10, 0.08], [13, 0.16]].forEach(([idx, dt]) => {
      this._voice({ type: 'sine', freq: SCALE[idx], t: t + dt, a: 0.003, d: 0.8, peak: 0.25, dest: this.fxGain });
      this._voice({ type: 'triangle', freq: SCALE[idx] * 2, t: t + dt, a: 0.003, d: 0.4, peak: 0.06, dest: this.fxGain });
    });
  }

  onRockSmash(e) { // crisp noise crack + a short stabbed Cm add9 shatter
    this.filterKick = Math.max(this.filterKick, 0.45);
    this.flash = Math.max(this.flash, 0.5);
    if (!this._live()) return;
    const t = this.ctx.currentTime + 0.003, up = e && e.bounce ? 1.5 : 1;
    this._noise(t, 0.18, { hz: 2500, peak: 0.45, dest: this.fxGain });
    [5, 7, 8, 10].forEach((idx, i) => {
      this._voice({ type: 'square', freq: SCALE[idx] * (i === 3 ? up : 1), sweepTo: SCALE[idx] * 0.97, sweepTime: 0.2, t: t + i * 0.012, a: 0.002, d: 0.22, peak: 0.12, filterHz: 5000, dest: this.fxGain });
    });
  }

  onCrash() { // thud now; the tape-stop filter/pitch/tempo sweep follows from telemetry (state CRASHED)
    this.leadOn = false;
    this.flipChain = 0; this.flipsHeard = 0;
    this.filterKick = 0;
    this.crashAmt = Math.max(this.crashAmt, 0.05);
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    this.leadGain.gain.setTargetAtTime(0, now, 0.05);
    if (!this._live()) return;
    this._voice({ type: 'sine', freq: 140, sweepTo: 38, sweepTime: 0.6, t: now + 0.002, a: 0.003, d: 0.7, peak: 0.7, dest: this.fxGain });
    this._noise(now + 0.002, 0.3, { type: 'lowpass', hz: 900, peak: 0.5, dest: this.fxGain });
  }

  onReset() { // recovery of filter / pitch / tempo happens smoothly because state leaves CRASHED
    this.leadOn = false;
    this.flipChain = 0; this.flipsHeard = 0; this.lastAirRot = 0;
    this.filterKick = 0;
    if (this.ready) this.leadGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
  }
}