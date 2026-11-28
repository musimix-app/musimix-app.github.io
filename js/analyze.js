// MusiMix — analyse de l'audio dans le navigateur : tempo, temps, mesures, tonalité et accords.
// Méthode classique (sans réseau de neurones) : enveloppe d'attaques → tempo par autocorrélation →
// temps par programmation dynamique (Ellis) ; chroma synchronisé sur les temps → gabarits d'accords
// (majeur, mineur, 7, m7) + note de basse → lissage de Viterbi → tonalité d'après les accords. Une bonne base, à vérifier.

import FFT from './vendor/unblend/vendor/fft.js';
import { decodeAt } from './wav.js';

const SR = 22050;
const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const QUAL = [
  { suf: '', iv: [0, 4, 7], w: [1, 0.8, 0.9], bonus: 0 },
  { suf: 'm', iv: [0, 3, 7], w: [1, 0.8, 0.9], bonus: 0 },
  { suf: '7', iv: [0, 4, 7, 10], w: [1, 0.7, 0.8, 0.6], bonus: -0.06 },
  { suf: 'm7', iv: [0, 3, 7, 10], w: [1, 0.7, 0.8, 0.6], bonus: -0.06 },
];

const tick = () => new Promise((r) => setTimeout(r, 0));

async function mono(blobs) {
  let out = null;
  for (const b of blobs) {
    if (!b) continue;
    const buf = await decodeAt(b, SR);
    const n = buf.length;
    if (!out) out = new Float32Array(n);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      const k = Math.min(n, out.length);
      for (let i = 0; i < k; i++) out[i] += d[i] / buf.numberOfChannels;
    }
  }
  return out;
}

/** Spectres de magnitude, trame par trame. cb(frameIndex, mag) */
async function stft(x, N, hop, cb) {
  const fft = new FFT(N);
  const win = new Float32Array(N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  const inp = new Float64Array(N), out = fft.createComplexArray(), mag = new Float32Array(N / 2);
  const frames = Math.max(1, Math.floor((x.length - N) / hop) + 1);
  for (let f = 0; f < frames; f++) {
    const o = f * hop;
    for (let i = 0; i < N; i++) inp[i] = (x[o + i] || 0) * win[i];
    fft.realTransform(out, inp);
    for (let k = 0; k < N / 2; k++) mag[k] = Math.hypot(out[2 * k], out[2 * k + 1]);
    cb(f, mag);
    if (f % 200 === 199) await tick();
  }
  return frames;
}

// ── temps
async function onsetEnvelope(x) {
  const N = 1024, hop = 512;
  let prev = null;
  const env = [];
  await stft(x, N, hop, (f, mag) => {
    const lg = mag.map((m) => Math.log1p(100 * m));
    let s = 0;
    if (prev) for (let k = 1; k < N / 2; k++) { const d = lg[k] - prev[k]; if (d > 0) s += d; }
    env.push(s);
    prev = lg;
  });
  const e = Float32Array.from(env);
  // retire la tendance lente, normalise
  const w = 16, out = new Float32Array(e.length);
  for (let i = 0; i < e.length; i++) {
    let m = 0, c = 0;
    for (let j = Math.max(0, i - w); j <= Math.min(e.length - 1, i + w); j++) { m += e[j]; c++; }
    out[i] = Math.max(0, e[i] - m / c);
  }
  let sd = 0; for (const v of out) sd += v * v; sd = Math.sqrt(sd / out.length) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= sd;
  return { env: out, fps: SR / hop };
}

function tempo(env, fps) {
  const acf = (L) => { let s = 0; for (let i = L; i < env.length; i++) s += env[i] * env[i - L]; return s / (env.length - L); };
  const minL = Math.round((60 / 200) * fps), maxL = Math.round((60 / 55) * fps);
  let best = 0, bestL = Math.round((60 / 100) * fps);
  for (let L = minL; L <= maxL; L++) {
    const bpm = (60 * fps) / L;
    const wgt = Math.exp(-0.5 * (Math.log2(bpm / 110) / 0.9) ** 2);
    const v = acf(L) * wgt;
    if (v > best) { best = v; bestL = L; }
  }
  // erreurs d'octave : un tempo lent dont le double est presque aussi marqué est en général le double
  let bpm = (60 * fps) / bestL;
  if (bpm < 85) {
    const half = bestL / 2, a = Math.max(acf(Math.floor(half)), acf(Math.ceil(half)));
    if (a > 0.35 * acf(bestL)) bpm *= 2;
  } else if (bpm > 165) {
    const a = acf(bestL * 2);
    if (a > 0.8 * acf(bestL)) bpm /= 2;
  }
  return bpm;
}

function trackBeats(env, fps, bpm) {
  const p = (60 / bpm) * fps;
  const n = env.length, score = new Float32Array(n), back = new Int32Array(n).fill(-1);
  const alpha = 100;
  for (let t = 0; t < n; t++) {
    let best = 0, bi = -1;
    for (let q = Math.max(0, Math.round(t - 2 * p)); q <= t - Math.round(p / 2); q++) {
      const v = score[q] - alpha * Math.log((t - q) / p) ** 2;
      if (bi < 0 || v > best) { best = v; bi = q; }
    }
    score[t] = env[t] + (bi >= 0 ? best : 0);
    back[t] = bi;
  }
  // part de la meilleure fin dans le dernier temps
  let t = n - 1, bs = -Infinity;
  for (let i = Math.max(0, Math.round(n - p)); i < n; i++) if (score[i] > bs) { bs = score[i]; t = i; }
  const beats = [];
  while (t >= 0) { beats.push(t / fps); t = back[t]; }
  return beats.reverse();
}

// ── chroma
async function chromaFrames(x, lo, hi) {
  const N = 8192, hop = 2048;
  const binPc = new Int8Array(N / 2).fill(-1), binW = new Float32Array(N / 2);
  for (let k = 1; k < N / 2; k++) {
    const f = (k * SR) / N;
    if (f < lo || f > hi) continue;
    const midi = 69 + 12 * Math.log2(f / 440);
    const near = Math.round(midi);
    const dev = Math.abs(midi - near);
    if (dev > 0.4) continue;
    binPc[k] = ((near % 12) + 12) % 12;
    binW[k] = 1 - dev * 1.5;
  }
  const frames = [];
  await stft(x, N, hop, (f, mag) => {
    const c = new Float32Array(12);
    for (let k = 1; k < N / 2; k++) if (binPc[k] >= 0) c[binPc[k]] += Math.sqrt(mag[k]) * binW[k];
    frames.push(c);
  });
  return { frames, fps: SR / hop, t0: N / 2 / SR };
}

function beatSync(ch, beats, dur) {
  const out = [];
  for (let b = 0; b < beats.length; b++) {
    const s = beats[b], e = beats[b + 1] ?? Math.min(dur, s + (beats[b] - (beats[b - 1] ?? s - 0.5)));
    const c = new Float32Array(12);
    let n = 0;
    for (let f = Math.max(0, Math.floor((s - ch.t0) * ch.fps)); f < ch.frames.length && f / ch.fps + ch.t0 < e; f++) {
      for (let k = 0; k < 12; k++) c[k] += ch.frames[f][k];
      n++;
    }
    out.push({ s, e, c, n });
  }
  return out;
}

const norm = (v) => { let s = 0; for (const x of v) s += x * x; s = Math.sqrt(s); return s ? v.map((x) => x / s) : v; };

/** Tonalité d'après la durée des accords : diatoniques, avec du poids pour la tonique et la dominante. */
function keyFromChords(path, states, bh) {
  const dur = new Map();
  path.forEach((s, t) => { if (s < states.length) dur.set(s, (dur.get(s) || 0) + (bh[t].e - bh[t].s)); });
  let best = { score: -Infinity, root: 0, mode: 'maj' };
  for (let r = 0; r < 12; r++) for (const mode of ['maj', 'min']) {
    const key = { root: r, mode };
    const dia = diatonic(key);
    let sc = 0;
    for (const [s, d] of dur) {
      const st = states[s];
      const triad = st.q.iv.slice(0, 3);
      if (dia(st.root, triad)) sc += d;
      const tonic = st.root === r && (mode === 'maj' ? st.q.suf === '' || st.q.suf === '7' : st.q.suf.startsWith('m'));
      if (tonic) sc += 0.6 * d;
      if (st.root === (r + 7) % 12) sc += 0.2 * d;
    }
    if (mode === 'min') sc -= 0.01; // à égalité, majeur
    if (sc > best.score) best = { score: sc, root: r, mode };
  }
  return best;
}

function useFlats(key) {
  const majRoot = key.mode === 'maj' ? key.root : (key.root + 3) % 12;
  return [5, 10, 3, 8, 1, 6].includes(majRoot); // F Bb Eb Ab Db Gb
}

function diatonic(key) {
  const majRoot = key.mode === 'maj' ? key.root : (key.root + 3) % 12;
  const scale = [0, 2, 4, 5, 7, 9, 11].map((x) => (x + majRoot) % 12);
  return (root, iv) => iv.every((i) => scale.includes((root + i) % 12));
}

/**
 * blobs : { harmony: [Blob…] (guitare, piano, autres, ou le morceau), bass: Blob|null, drums: Blob|null }
 * Retourne { bpm, beats, downbeats, key, chords: [{ s, e, name }] }.
 */
export async function analyzeAudio({ harmony, bass, drums }, { duration, onProgress = () => {} } = {}) {
  onProgress(0, 'Écoute du rythme…');
  const xr = await mono([drums || harmony[0]].concat(drums ? [] : harmony.slice(1)));
  const { env, fps } = await onsetEnvelope(xr);
  const bpm = tempo(env, fps);
  let beats = trackBeats(env, fps, bpm);
  const dur = duration || xr.length / SR;
  // prolonge la grille jusqu'au début / à la fin
  const per = 60 / bpm;
  while (beats.length && beats[0] - per > 0.05) beats.unshift(beats[0] - per);
  onProgress(0.35, 'Écoute des accords…');
  const xh = await mono(harmony.concat(bass ? [bass] : []));
  const ch = await chromaFrames(xh, 90, 2500);
  onProgress(0.7, 'Écoute de la basse…');
  const xb = bass ? await mono([bass]) : xh;
  const cb = await chromaFrames(xb, 35, 260);
  const bh = beatSync(ch, beats, dur), bb = beatSync(cb, beats, dur);

  // états : 12 fondamentales × qualités + « pas d'accord »
  const states = [];
  for (let r = 0; r < 12; r++) for (const q of QUAL) {
    const tpl = new Float32Array(12);
    q.iv.forEach((iv, k) => { tpl[(r + iv) % 12] = q.w[k]; });
    states.push({ root: r, q, tpl: norm(tpl) });
  }
  const energy = bh.map((b) => b.c.reduce((s, v) => s + v, 0) / Math.max(1, b.n));
  const eRef = [...energy].sort((a, b) => a - b)[Math.floor(energy.length * 0.6)] || 1;
  const base = bh.map((b, i) => {
    const c = norm(b.c), bc = norm(bb[i].c);
    const sc = states.map((st) => {
      let s = 0; for (let k = 0; k < 12; k++) s += c[k] * st.tpl[k];
      return s + 0.25 * bc[st.root] + st.q.bonus;
    });
    sc.push(energy[i] < eRef * 0.08 ? 1.2 : 0.2); // « N »
    return sc;
  });

  // Viterbi (pénalité de changement plus faible en début de mesure)
  const run = (emit, downPhase) => {
    const S = emit[0].length, T = emit.length;
    let prev = emit[0].slice();
    const bp = [];
    for (let t = 1; t < T; t++) {
      const pen = downPhase == null ? 0.22 : (t % 4 === downPhase ? 0.12 : t % 2 === downPhase % 2 ? 0.2 : 0.34);
      let bi = 0; for (let s = 1; s < S; s++) if (prev[s] > prev[bi]) bi = s;
      const cur = new Float32Array(S), arg = new Int16Array(S);
      for (let s = 0; s < S; s++) {
        const stay = prev[s], jump = prev[bi] - pen;
        if (stay >= jump) { cur[s] = stay + emit[t][s]; arg[s] = s; } else { cur[s] = jump + emit[t][s]; arg[s] = bi; }
      }
      bp.push(arg); prev = cur;
    }
    let s = 0; for (let k = 1; k < prev.length; k++) if (prev[k] > prev[s]) s = k;
    const path = [s];
    for (let t = bp.length - 1; t >= 0; t--) { s = bp[t][s]; path.push(s); }
    return path.reverse();
  };
  // 1er passage sans a priori → mesures et tonalité (d'après les accords trouvés)
  let path = run(base, null);
  const changes = [0, 0, 0, 0];
  for (let t = 1; t < path.length; t++) if (path[t] !== path[t - 1]) changes[t % 4]++;
  const down = changes.indexOf(Math.max(...changes));
  const key = keyFromChords(path, states, bh);
  const names = useFlats(key) ? FLAT : SHARP;
  const isDia = diatonic(key);
  // 2e passage : léger avantage aux accords de la tonalité, changements plutôt en début de mesure
  const emit = base.map((sc) => sc.map((v, k) => (k < states.length && isDia(states[k].root, states[k].q.iv) ? v + 0.05 : v)));
  path = run(emit, down);
  states.forEach((st) => { st.name = names[st.root] + st.q.suf; });

  const chords = [];
  path.forEach((s, t) => {
    const name = s === states.length ? null : states[s].name;
    const b = bh[t];
    const last = chords[chords.length - 1];
    if (last && last.name === name) last.e = b.e;
    else chords.push({ s: b.s, e: b.e, name });
  });
  const out = chords.filter((c) => c.name);
  onProgress(1, 'Analyse terminée');
  const downbeats = beats.filter((_, i) => i % 4 === down);
  return {
    bpm: Math.round(bpm),
    beats: beats.map((x) => +x.toFixed(3)),
    downbeats: downbeats.map((x) => +x.toFixed(3)),
    key: names[key.root] + (key.mode === 'min' ? 'm' : ''),
    chords: out.map((c) => ({ s: +c.s.toFixed(3), e: +c.e.toFixed(3), name: c.name })),
  };
}

// briques réutilisées par le calage des paroles et des accords (lyricsync.js)
export { onsetEnvelope, tempo, trackBeats, chromaFrames, beatSync, SR as ANALYSIS_SR };
