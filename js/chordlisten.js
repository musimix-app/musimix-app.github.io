// MusiMix — écoute d'un accord au micro (guitare, piano…) : chroma en direct (énergie de chaque note
// de Do à Si, toutes octaves confondues) et reconnaissance de l'accord joué.
import { parseChord } from './theory.js';

const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const QUAL = [['', [0, 4, 7]], ['m', [0, 3, 7]], ['7', [0, 4, 7, 10]], ['m7', [0, 3, 7, 10]], ['maj7', [0, 4, 7, 11]], ['sus4', [0, 5, 7]], ['sus2', [0, 2, 7]], ['dim', [0, 3, 6]], ['5', [0, 7]]];

/** Notes (classes de hauteur) attendues pour un nom d'accord. */
export function chordSet(name) {
  const ch = parseChord(name);
  if (!ch) return null;
  const s = new Set(ch.intervals.map((i) => (ch.root + i) % 12));
  if (ch.bass != null) s.add(ch.bass);
  return { set: s, root: ch.root, fifth: (ch.root + 7) % 12, third: ch.intervals.includes(4) ? (ch.root + 4) % 12 : ch.intervals.includes(3) ? (ch.root + 3) % 12 : null };
}

function cosine(c, tpl) {
  let dot = 0, n1 = 0, n2 = 0;
  for (let i = 0; i < 12; i++) { dot += c[i] * tpl[i]; n1 += c[i] * c[i]; n2 += tpl[i] * tpl[i]; }
  return n1 && n2 ? dot / Math.sqrt(n1 * n2) : 0;
}

/** Accord le plus probable pour un chroma. */
export function recognize(chroma) {
  let best = null;
  for (let r = 0; r < 12; r++) for (const [suf, iv] of QUAL) {
    const t = new Array(12).fill(0);
    iv.forEach((i, k) => { t[(r + i) % 12] = k === 0 ? 1.15 : i === 7 ? 0.8 : 1; });
    const sc = cosine(chroma, t) - (iv.length > 3 ? 0.03 : 0) - (suf === '5' ? 0.06 : 0);
    if (!best || sc > best.score) best = { name: NAMES[r] + suf, score: sc };
  }
  return best;
}

/** Juge le chroma entendu par rapport à l'accord demandé. */
export function judge(chroma, target) {
  const T = chordSet(target);
  const max = Math.max(...chroma, 1e-9);
  const heard = chroma.map((v) => v / max);
  if (!T) return { level: 'free', heard };
  const tpl = new Array(12).fill(0);
  T.set.forEach((p) => { tpl[p] = p === T.root ? 1.15 : p === T.fifth ? 0.8 : 1; });
  const fit = cosine(chroma, tpl);
  const wrong = [], missing = [];
  for (let p = 0; p < 12; p++) if (!T.set.has(p) && heard[p] > 0.55) wrong.push(p);
  for (const p of T.set) if (heard[p] < 0.22 && p !== T.fifth) missing.push(p);
  const level = wrong.length && fit < 0.9 ? 'bad' : missing.length ? 'partial' : fit >= 0.8 ? 'ok' : 'bad';
  return { level, heard, fit, wrong, missing, set: T.set };
}

export class ChordListener {
  constructor() { this.on = false; this.chroma = new Array(12).fill(0); }

  async start(deviceId) {
    this.stop();
    const constraints = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    if (deviceId) constraints.deviceId = { ideal: deviceId };
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.an = this.ctx.createAnalyser();
    this.an.fftSize = 16384;
    this.an.smoothingTimeConstant = 0.35;
    src.connect(this.an);
    this.buf = new Float32Array(this.an.frequencyBinCount);
    this.tbuf = new Float32Array(2048);
    this.on = true;
    this.chroma = new Array(12).fill(0);
    const loop = () => { if (!this.on) return; this.frame(); this.timer = setTimeout(loop, 90); };
    loop();
  }

  stop() {
    this.on = false; clearTimeout(this.timer);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close?.();
    this.stream = null; this.ctx = null;
  }

  frame() {
    const an = this.an, sr = this.ctx.sampleRate, n = an.fftSize;
    an.getFloatTimeDomainData(this.tbuf);
    let rms = 0; for (const v of this.tbuf) rms += v * v;
    rms = Math.sqrt(rms / this.tbuf.length);
    an.getFloatFrequencyData(this.buf);
    const B = this.buf, c = new Array(12).fill(0);
    const lo = Math.floor((65 / sr) * n), hi = Math.min(B.length - 2, Math.ceil((2100 / sr) * n));
    // bruit de fond : médiane des niveaux
    const slice = Array.from(B.subarray(lo, hi)).sort((a, b) => a - b);
    const floor = slice[slice.length >> 1] + 12;
    for (let i = lo; i < hi; i++) {
      const v = B[i];
      if (v < floor || v < B[i - 1] || v < B[i + 1]) continue; // pics seulement
      const f = ((i + (B[i + 1] - B[i - 1]) / (2 * (2 * v - B[i - 1] - B[i + 1]) || 1)) * sr) / n;
      const midi = 69 + 12 * Math.log2(f / 440);
      const pc = ((Math.round(midi) % 12) + 12) % 12;
      const dev = Math.abs(midi - Math.round(midi));
      if (dev > 0.35) continue;
      const amp = Math.pow(10, (v - floor) / 20);
      // les fondamentales (graves) comptent plus que les harmoniques aiguës
      c[pc] += amp * (1 - dev) * (f < 400 ? 1.3 : f < 900 ? 1 : 0.7);
    }
    const sum = c.reduce((a, b) => a + b, 0);
    this.rms = rms;
    this.active = rms > 0.008 && sum > 0;
    if (this.active) { const m = Math.max(...c); for (let k = 0; k < 12; k++) this.chroma[k] = this.chroma[k] * 0.45 + (c[k] / m) * 0.55; }
    else for (let k = 0; k < 12; k++) this.chroma[k] *= 0.6;
    this.onFrame?.(this);
  }
}

export { NAMES as CHROMA_NAMES };
