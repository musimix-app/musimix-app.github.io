// MusiMix Piano — moteur de son : pistes MIDI (une sortie par piste, pour le mixage),
// instruments échantillonnés (sounds.js) avec repli sur une synthèse simple tant qu'un son
// n'est pas chargé, batterie, clic de métronome et son des touches jouées en direct.

import { sharedBank } from './sounds.js';

export class KeysSynth {
  constructor(ctx, destination, soundsBase = 'sounds/') {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 0.9;
    // un peu d'espace : réverbe courte synthétique
    this.rev = ctx.createConvolver();
    this.rev.buffer = impulse(ctx, 1.8, 2.6);
    this.revSend = ctx.createGain(); this.revSend.gain.value = 0.18;
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -10; this.comp.ratio.value = 4; this.comp.attack.value = 0.004; this.comp.release.value = 0.2;
    this.out.connect(this.comp);
    this.out.connect(this.revSend).connect(this.rev).connect(this.comp);
    this.comp.connect(destination || ctx.destination);
    this.buses = new Map();
    this.voices = new Set();
    this.live = new Map();
    this.sustain = false;
    this.sustained = new Set();
    this.noise = noiseBuffer(ctx);
    this.bank = sharedBank(soundsBase);
    this.liveInst = 'grand';
    this.liveBus = this.bus('live');
    this.clickBus = this.bus('click');
  }

  bus(id) {
    let g = this.buses.get(id);
    if (!g) { g = this.ctx.createGain(); g.connect(this.out); this.buses.set(id, g); }
    return g;
  }
  setBus(id, v) { this.bus(id).gain.setTargetAtTime(v, this.ctx.currentTime, 0.02); }

  /** Programme une note. when = temps du contexte audio. */
  note(pitch, vel, when, dur, { bus = 'live', program = 0, drum = false, inst = null } = {}) {
    if (this.voices.size > 140) this._steal();
    const dest = this.bus(bus);
    const I = this.bank.get(drum ? (inst?.startsWith('drums') ? inst : 'drums') : inst);
    if (I && I.zones.length) {
      const v = I.noteOn(this.ctx, dest, pitch, vel, when);
      if (v) {
        v.stopAt = v.end;
        this.voices.add(v);
        v.src.addEventListener('ended', () => this.voices.delete(v));
        if (!drum) I.noteOff(this.ctx, v, when + dur, dest);
        return v;
      }
    }
    if (drum) return this._drum(pitch, vel, when, dest);
    return this._tone(pitch, vel, when, dur, program, dest);
  }

  _tone(pitch, vel, when, dur, program, dest) {
    const ctx = this.ctx;
    const f = 440 * 2 ** ((pitch - 69) / 12);
    const fam = family(program);
    const g = ctx.createGain();
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    const amp = 0.18 * (0.35 + vel * 0.75) * (pitch < 48 ? 1.15 : pitch > 84 ? 0.75 : 1);
    const oscs = [];
    const add = (type, mult, gain, detune = 0) => {
      const o = ctx.createOscillator(); o.type = type; o.frequency.value = f * mult; o.detune.value = detune;
      const og = ctx.createGain(); og.gain.value = gain; o.connect(og).connect(filt); oscs.push(o);
    };
    let release = 0.25, endAt;
    g.gain.setValueAtTime(0, when);
    if (fam === 'organ' || fam === 'pad' || fam === 'strings') {
      add('sawtooth', 1, 0.35, -6); add('sawtooth', 1, 0.35, 6); add('sine', 2, 0.2);
      filt.frequency.value = fam === 'organ' ? 3200 : 1800; filt.Q.value = 0.4;
      const att = fam === 'organ' ? 0.01 : 0.12;
      g.gain.linearRampToValueAtTime(amp * 0.75, when + att);
      endAt = when + Math.max(dur, att + 0.02);
      g.gain.setValueAtTime(amp * 0.75, endAt);
      release = fam === 'organ' ? 0.06 : 0.35;
      g.gain.setTargetAtTime(0, endAt, release / 3);
    } else if (fam === 'bass') {
      add('triangle', 1, 0.8); add('sawtooth', 1, 0.25);
      filt.frequency.setValueAtTime(380 + vel * 900, when); filt.frequency.exponentialRampToValueAtTime(240, when + 0.4);
      g.gain.linearRampToValueAtTime(amp * 1.3, when + 0.006);
      g.gain.setTargetAtTime(amp * 0.7, when + 0.01, 0.3);
      endAt = when + dur; release = 0.08;
      g.gain.setTargetAtTime(0, endAt, release / 3);
    } else if (fam === 'guitar') {
      add('triangle', 1, 0.6); add('sawtooth', 1, 0.25, 4); add('sine', 2, 0.15);
      filt.frequency.setValueAtTime(2600 + vel * 2000, when); filt.frequency.exponentialRampToValueAtTime(700, when + 0.6);
      g.gain.linearRampToValueAtTime(amp, when + 0.004);
      g.gain.setTargetAtTime(0, when + 0.005, 0.45);
      endAt = when + Math.min(dur, 2.5); release = 0.1;
      g.gain.setTargetAtTime(0, endAt, release / 3);
    } else {
      // piano : attaque franche, harmoniques qui s'éteignent plus vite que la fondamentale
      add('triangle', 1, 0.75); add('sine', 2, 0.3, 3); add('sine', 3, 0.1, -4); add('sine', 1, 0.25, 7);
      const bright = 1400 + vel * 3600 + (pitch - 60) * 30;
      filt.frequency.setValueAtTime(Math.max(600, bright), when);
      filt.frequency.setTargetAtTime(Math.max(400, bright * 0.35), when + 0.01, 0.5);
      g.gain.linearRampToValueAtTime(amp * 1.25, when + 0.004);
      const decay = 0.6 + Math.max(0, (84 - pitch)) * 0.045;
      g.gain.setTargetAtTime(amp * 0.25, when + 0.006, decay);
      endAt = when + dur; release = 0.18;
      g.gain.setTargetAtTime(0, endAt, release / 3);
    }
    filt.connect(g).connect(dest);
    const stopAt = endAt + release * 4 + 0.05;
    for (const o of oscs) { o.start(when); o.stop(stopAt); }
    const v = { g, oscs, stopAt };
    this.voices.add(v);
    oscs[0].onended = () => { this.voices.delete(v); try { g.disconnect(); } catch { /* */ } };
    return v;
  }

  _drum(p, vel, when, dest) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.connect(dest);
    const a = 0.5 * (0.4 + vel * 0.8);
    const noise = (type, freq, q, len, gain) => {
      const s = ctx.createBufferSource(); s.buffer = this.noise;
      const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
      const e = ctx.createGain(); e.gain.setValueAtTime(gain, when); e.gain.exponentialRampToValueAtTime(0.0008, when + len);
      s.connect(f).connect(e).connect(g); s.start(when, Math.random() * 0.5); s.stop(when + len + 0.02);
      return s;
    };
    const tone = (f0, f1, len, gain) => {
      const o = ctx.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(f0, when); o.frequency.exponentialRampToValueAtTime(f1, when + len * 0.6);
      const e = ctx.createGain(); e.gain.setValueAtTime(gain, when); e.gain.exponentialRampToValueAtTime(0.0008, when + len);
      o.connect(e).connect(g); o.start(when); o.stop(when + len + 0.02);
      return o;
    };
    let src;
    if (p === 35 || p === 36) src = tone(140, 45, 0.38, a * 1.6);
    else if (p === 38 || p === 40 || p === 37 || p === 39) { tone(220, 160, 0.12, a * 0.6); src = noise('bandpass', 1800, 0.7, 0.2, a * 1.1); }
    else if (p === 42 || p === 44) src = noise('highpass', 8000, 0.5, 0.05, a * 0.5);
    else if (p === 46) src = noise('highpass', 7500, 0.5, 0.3, a * 0.45);
    else if (p === 49 || p === 57 || p === 52 || p === 55) src = noise('highpass', 5000, 0.4, 1.4, a * 0.5);
    else if (p === 51 || p === 59 || p === 53) src = noise('bandpass', 6500, 2, 0.6, a * 0.35);
    else if (p >= 41 && p <= 50) src = tone(80 + (p - 41) * 18, 50 + (p - 41) * 10, 0.3, a * 1.1);
    else src = noise('bandpass', 3000, 1, 0.12, a * 0.5);
    const v = { g, oscs: [src], stopAt: when + 1.5 };
    this.voices.add(v);
    src.onended = () => { this.voices.delete(v); };
    return v;
  }

  click(when, accent) {
    const ctx = this.ctx;
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = accent ? 1760 : 1175;
    const e = ctx.createGain(); e.gain.setValueAtTime(0.0001, when); e.gain.exponentialRampToValueAtTime(accent ? 0.5 : 0.32, when + 0.002);
    e.gain.exponentialRampToValueAtTime(0.0001, when + 0.06);
    o.connect(e).connect(this.clickBus); o.start(when); o.stop(when + 0.08);
  }

  // ─────────────────────────────────────────────── touches jouées en direct ──
  liveOn(pitch, vel) {
    this.liveOff(pitch, true);
    this.sustained.delete(pitch); // touche refrappée et tenue : le relâchement de la pédale ne doit pas la couper
    const when = this.ctx.currentTime; // tout de suite : pas de retard ajouté
    const I = this.bank.get(this.liveInst);
    const v = I?.zones.length ? I.noteOn(this.ctx, this.liveBus, pitch, vel, when) : this._tone(pitch, vel, when, 30, 0, this.liveBus);
    if (v) this.live.set(pitch, v);
  }
  liveOff(pitch, force = false) {
    const v = this.live.get(pitch);
    if (!v) return;
    if (this.sustain && !force) { this.sustained.add(pitch); return; }
    this.live.delete(pitch);
    this._release(v);
  }
  setSustain(down) {
    if (down !== this.sustain) this.bank.get(this.liveInst)?.pedalNoise?.(this.ctx, this.liveBus, down, this.ctx.currentTime);
    this.sustain = down;
    if (!down) { for (const p of this.sustained) { const v = this.live.get(p); if (v) { this.live.delete(p); this._release(v); } } this.sustained.clear(); }
  }
  _release(v, t = 0.12) {
    const now = this.ctx.currentTime;
    if (v.inst && !v.drum && t >= 0.1) { v.inst.noteOff(this.ctx, v, now, this.liveBus); return; }
    try { v.g.gain.cancelScheduledValues(now); v.g.gain.setValueAtTime(v.g.gain.value, now); v.g.gain.setTargetAtTime(0, now, t / 3); } catch { /* */ }
    for (const o of v.oscs || [v.src]) { try { o.stop(now + t * 3); } catch { /* */ } }
    try { v.relSrc?.stop(); } catch { /* */ }
  }
  /** Coupe tout ce qui a été programmé (saut, pause). */
  stopAll() {
    const live = new Set(this.live.values());
    for (const v of this.voices) if (!live.has(v)) this._release(v, 0.05);
    this.voices.clear();
  }
  _steal() {
    let old = null;
    for (const v of this.voices) { if (!old || v.stopAt < old.stopAt) old = v; }
    if (old) { this._release(old, 0.03); this.voices.delete(old); }
  }
}

function family(p) {
  if (p >= 16 && p <= 23) return 'organ';
  if (p >= 24 && p <= 31) return 'guitar';
  if (p >= 32 && p <= 39) return 'bass';
  if (p >= 40 && p <= 55) return 'strings';
  if (p >= 88 && p <= 103) return 'pad';
  if (p >= 56 && p <= 87) return 'strings';
  return 'piano';
}

function noiseBuffer(ctx) {
  const b = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
}

function impulse(ctx, secs, decay) {
  const n = Math.floor(ctx.sampleRate * secs);
  const b = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n) ** decay;
  }
  return b;
}
