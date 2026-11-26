// MusiMix — enregistrer sa prise au micro par-dessus le morceau.
// Capture PCM brute (AudioWorklet), horloge du contexte reliée au temps entendu du morceau
// (displayTime du moteur, latence de sortie comprise) moins la latence d'entrée du micro.
// Résultat : une piste mono de la longueur du morceau, calée sur la chanson.

const WORKLET = `class Rec extends AudioWorkletProcessor {
  constructor() { super(); this.on = true; this.port.onmessage = (e) => { if (e.data === 'stop') this.on = false; }; }
  process(inputs) {
    const chs = inputs[0];
    if (chs && chs.length && this.on) {
      // toutes les entrées reçues sont mélangées (avec le R20, le micro peut être sur n'importe quel canal)
      const out = chs[0].slice(0);
      for (let c = 1; c < chs.length; c++) { const x = chs[c]; for (let i = 0; i < out.length; i++) out[i] += x[i]; }
      if (chs.length > 1) for (let i = 0; i < out.length; i++) out[i] = Math.max(-1, Math.min(1, out[i]));
      this.port.postMessage({ frame: currentFrame, data: out });
    }
    return this.on;
  }
}
registerProcessor('mm-rec', Rec);`;

export class TakeRecorder {
  constructor(engine, { micId = null } = {}) {
    this.engine = engine;
    this.micId = micId;
    this.chunks = [];
    this.pairs = [];
    this.peak = 0;
  }

  /** Ouvre le micro (à appeler avant de lancer la lecture). */
  async open() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: this.micId ? { ideal: this.micId } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 8 } } });
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    await this.ctx.resume().catch(() => {});
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    await this.ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    this.src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'mm-rec', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 8, channelCountMode: 'max', channelInterpretation: 'discrete' });
    this.node.port.onmessage = (e) => {
      if (!this.armed) return;
      const d = e.data.data;
      for (let i = 0; i < d.length; i += 8) { const v = Math.abs(d[i]); if (v > this.peak) this.peak = v; }
      this.chunks.push(e.data);
    };
    this.src.connect(this.node);
    const st = this.stream.getAudioTracks()[0]?.getSettings?.() || {};
    this.inLatency = typeof st.latency === 'number' && st.latency > 0 && st.latency < 0.3 ? st.latency : 0.01;
    this.sr = this.ctx.sampleRate;
  }

  /** Commence à garder le son ; relevés d'horloge à chaque image tant que ça enregistre. */
  start() {
    this.armed = true;
    this.t0 = performance.now();
    const tick = () => {
      if (!this.armed) return;
      this._raf = requestAnimationFrame(tick);
      if (!this.engine.playing) return;
      const ts = this.ctx.getOutputTimestamp?.();
      const now = performance.now();
      const ctxNow = ts && ts.performanceTime ? ts.contextTime + (now - ts.performanceTime) / 1000 : this.ctx.currentTime;
      this.pairs.push({ c: ctxNow, s: this.engine.displayTime });
    };
    tick();
  }

  get elapsed() { return this.armed ? (performance.now() - this.t0) / 1000 : 0; }
  get level() { const p = this.peak; this.peak *= 0.85; return p; }

  /** Arrête et rend { channel, sampleRate, start, end } (temps du morceau) ou null si rien d'exploitable. */
  async stop(duration) {
    this.armed = false;
    cancelAnimationFrame(this._raf);
    this.node?.port.postMessage('stop');
    this.src?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    const sr = this.sr;
    await this.ctx?.close().catch(() => {});
    if (!this.chunks.length || this.pairs.length < 5) return null;
    // décalage horloge micro → temps du morceau (médiane, robuste aux à-coups d'affichage)
    const ds = this.pairs.map((p) => p.s - p.c).sort((a, b) => a - b);
    const off = ds[ds.length >> 1] - this.inLatency;
    // on ne garde que ce qui a été capté pendant la lecture
    const cMin = this.pairs[0].c - 0.05, cMax = this.pairs[this.pairs.length - 1].c + 0.05;
    const dur = Math.max(duration || 0, cMax + off + 1);
    const out = new Float32Array(Math.ceil(dur * sr));
    let start = Infinity, end = 0;
    for (const ch of this.chunks) {
      const c = ch.frame / sr;
      if (c + ch.data.length / sr < cMin || c > cMax) continue;
      const at = Math.round((c + off) * sr);
      for (let i = 0; i < ch.data.length; i++) {
        const j = at + i;
        const ci = c + i / sr;
        if (j < 0 || j >= out.length || ci < cMin || ci > cMax) continue;
        out[j] = ch.data[i];
      }
      start = Math.min(start, Math.max(0, at / sr)); end = Math.max(end, (at + ch.data.length) / sr);
    }
    // fondu de 10 ms aux bords pour éviter les clics
    const f = Math.round(0.01 * sr), a = Math.round(start * sr), b = Math.min(out.length, Math.round(end * sr));
    for (let i = 0; i < f; i++) { const g = i / f; if (a + i < out.length) out[a + i] *= g; if (b - 1 - i >= 0) out[b - 1 - i] *= g; }
    return { channel: out, sampleRate: sr, start, end, offset: off };
  }

  cancel() {
    this.armed = false;
    cancelAnimationFrame(this._raf);
    try { this.src?.disconnect(); } catch {}
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => {});
  }
}
