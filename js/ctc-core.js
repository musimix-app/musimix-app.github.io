// MusiMix — cœur du calage des paroles par reconnaissance vocale (sans dépendance au navigateur) :
//   · descripteurs « log-mel » du modèle NeMo FastConformer (80 bandes, 10 ms, normalisés par bande) ;
//   · découpage des mots en morceaux du vocabulaire (SentencePiece, découpe gloutonne) ;
//   · alignement forcé CTC (Viterbi) des paroles connues sur les probabilités du modèle, avec un
//     « rembourrage » facultatif entre les lignes (passages chantés absents du texte, ad-libs, chœurs).
// Le modèle lui-même tourne dans js/workers/ctc-worker.js (onnxruntime-web).

import FFT from './vendor/unblend/vendor/fft.js';

export const SR = 16000;
export const FRAME = 0.08; // une sortie du modèle toutes les 80 ms (sous-échantillonnage × 8)

// ───────────────────────────────────────────────────────── log-mel NeMo ──

let FB = null;
function melBank(sr = SR, nFft = 512, nMels = 80, fmin = 0, fmax = 8000) {
  // banc de filtres mel « slaney » (comme librosa / NeMo)
  const hz2mel = (f) => (f >= 1000 ? 15 + Math.log(f / 1000) / (Math.log(6.4) / 27) : f / (200 / 3));
  const mel2hz = (m) => (m >= 15 ? 1000 * Math.exp((Math.log(6.4) / 27) * (m - 15)) : (200 / 3) * m);
  const nb = nFft / 2 + 1;
  const freqs = Float64Array.from({ length: nb }, (_, i) => (i * sr) / nFft);
  const m0 = hz2mel(fmin), m1 = hz2mel(fmax);
  const pts = Float64Array.from({ length: nMels + 2 }, (_, i) => mel2hz(m0 + ((m1 - m0) * i) / (nMels + 1)));
  const W = Array.from({ length: nMels }, () => new Float32Array(nb));
  for (let i = 0; i < nMels; i++) {
    const enorm = 2 / (pts[i + 2] - pts[i]);
    for (let k = 0; k < nb; k++) {
      const lo = (freqs[k] - pts[i]) / (pts[i + 1] - pts[i]);
      const up = (pts[i + 2] - freqs[k]) / (pts[i + 2] - pts[i + 1]);
      const v = Math.max(0, Math.min(lo, up));
      W[i][k] = v * enorm;
    }
  }
  // bornes utiles de chaque filtre (pour aller vite)
  return W.map((w) => { let a = 0, b = w.length - 1; while (a < b && !w[a]) a++; while (b > a && !w[b]) b--; return { w, a, b }; });
}

/** pcm 16 kHz mono → Float32Array (80 × T) rangée par bande, et T. */
export function logMel(pcm) {
  FB ||= melBank();
  const nFft = 512, win = 400, hop = 160, off = (nFft - win) >> 1;
  const n = pcm.length;
  const T = 1 + Math.floor(n / hop);
  const x = new Float32Array(n);
  if (n) x[0] = pcm[0];
  for (let i = 1; i < n; i++) x[i] = pcm[i] - 0.97 * pcm[i - 1];
  const w = new Float64Array(nFft);
  for (let i = 0; i < win; i++) w[off + i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / win);
  const fft = new FFT(nFft);
  const inp = new Float64Array(nFft), out = fft.createComplexArray(), pow = new Float64Array(nFft / 2 + 1);
  const mel = new Float32Array(80 * T);
  const G = 2 ** -24;
  for (let t = 0; t < T; t++) {
    const start = t * hop - nFft / 2; // centré, bords à zéro
    for (let i = 0; i < nFft; i++) { const j = start + i; inp[i] = j >= 0 && j < n ? x[j] * w[i] : 0; }
    fft.realTransform(out, inp);
    for (let k = 0; k <= nFft / 2; k++) pow[k] = out[2 * k] * out[2 * k] + out[2 * k + 1] * out[2 * k + 1];
    for (let m = 0; m < 80; m++) {
      const { w: fw, a, b } = FB[m];
      let s = 0; for (let k = a; k <= b; k++) s += fw[k] * pow[k];
      mel[m * T + t] = Math.log(s + G);
    }
  }
  // normalisation par bande (moyenne 0, écart-type 1)
  for (let m = 0; m < 80; m++) {
    let s = 0; for (let t = 0; t < T; t++) s += mel[m * T + t];
    const mu = s / T;
    let v = 0; for (let t = 0; t < T; t++) { const d = mel[m * T + t] - mu; v += d * d; }
    const sd = Math.sqrt(v / Math.max(1, T - 1)) + 1e-5;
    for (let t = 0; t < T; t++) mel[m * T + t] = (mel[m * T + t] - mu) / sd;
  }
  return { mel, T };
}

// ─────────────────────────────────────────────── vocabulaire du modèle ──

/** tokens.txt → { blank, V, low: Map(morceau en minuscules → [ids]), pieces: Set } */
export function parseTokens(text) {
  const toks = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const i = line.lastIndexOf(' ');
    toks[+line.slice(i + 1)] = line.slice(0, i);
  }
  const low = new Map();
  toks.forEach((t, i) => { if (t === '<blk>' || t === '<unk>') return; const k = t.toLowerCase(); if (!low.has(k)) low.set(k, []); low.get(k).push(i); });
  return { toks, V: toks.length, blank: toks.indexOf('<blk>'), low };
}

export function normWord(w) {
  return String(w).toLowerCase().replace(/[’‘`´]/g, "'").replace(/œ/g, 'oe').replace(/æ/g, 'ae').replace(/[^\p{L}\p{N}']/gu, '');
}

/** Mot → morceaux du vocabulaire (le plus long d'abord), « ▁ » marque le début du mot. */
export function tokenizeWord(w, voc) {
  const s = '▁' + normWord(w);
  const out = [];
  let i = 0;
  while (i < s.length) {
    let L = Math.min(14, s.length - i);
    for (; L > 0; L--) { const p = s.slice(i, i + L); if (voc.low.has(p)) { out.push(p); break; } }
    if (!L) i++; else i += L;
  }
  return out.length ? out : ['▁'];
}

// ─────────────────────────────────────────────── alignement forcé CTC ──

/**
 * lp : Float32Array (T × V) log-probabilités du modèle ; lines : [[mots]].
 * Retourne { words: [[{ s, e, conf }]] (secondes), lines: [{ s, e, conf }] }.
 * gpen : pénalité du rembourrage entre deux lignes (plus grand = moins de passages ignorés).
 */
export function ctcAlign(lp, T, voc, lines, { gpen = 4, frame = FRAME } = {}) {
  const V = voc.V, BL = voc.blank;
  const kind = [], piece = [], owner = [];
  const add = (k, p = null, o = null) => { kind.push(k); piece.push(p); owner.push(o); };
  add(0);
  lines.forEach((words, li) => {
    if (li) { add(2); add(0); }
    words.forEach((w, wi) => { for (const p of tokenizeWord(w, voc)) { add(1, p, li * 100000 + wi); add(0); } });
  });
  const N = kind.length;
  // émissions : morceau = meilleure casse ; blanc ; rembourrage = n'importe quel son, avec pénalité
  const uniq = [...new Set(piece.filter(Boolean))];
  const pidx = new Map(uniq.map((p, i) => [p, i]));
  const em = new Float32Array(T * uniq.length);
  const bl = new Float32Array(T), gm = new Float32Array(T);
  for (let t = 0; t < T; t++) {
    const row = t * V;
    let mx = -1e30;
    for (let v = 0; v < V; v++) if (v !== BL && lp[row + v] > mx) mx = lp[row + v];
    bl[t] = lp[row + BL];
    gm[t] = Math.max(mx, bl[t]) - gpen;
    uniq.forEach((p, u) => { let b = -1e30; for (const id of voc.low.get(p)) if (lp[row + id] > b) b = lp[row + id]; em[t * uniq.length + u] = b; });
  }
  const U = uniq.length;
  const sIdx = Int32Array.from(piece.map((p) => (p ? pidx.get(p) : -1)));
  const kindA = Int8Array.from(kind);
  const j2 = new Uint8Array(N);
  for (let s = 2; s < N; s++) {
    if (kind[s] === 1 && kind[s - 2] === 1 && piece[s] !== piece[s - 2]) j2[s] = 1;
    if (kind[s] === 0 && kind[s - 1] === 2) j2[s] = 1;
  }
  const NEG = -1e30;
  let dp = new Float64Array(N).fill(NEG), nx = new Float64Array(N);
  const bp = new Int8Array(T * N);
  const e0 = (s, t) => (kindA[s] === 0 ? bl[t] : kindA[s] === 2 ? gm[t] : em[t * U + sIdx[s]]);
  dp[0] = e0(0, 0); if (N > 1) dp[1] = e0(1, 0);
  for (let t = 1; t < T; t++) {
    const base = t * N;
    for (let s = 0; s < N; s++) {
      let m = dp[s], arg = 0;
      if (s > 0 && dp[s - 1] > m) { m = dp[s - 1]; arg = 1; }
      if (j2[s] && dp[s - 2] > m) { m = dp[s - 2]; arg = 2; }
      nx[s] = m <= NEG / 2 ? NEG : m + e0(s, t);
      bp[base + s] = arg;
    }
    const tmp = dp; dp = nx; nx = tmp;
  }
  let s = N > 1 && dp[N - 2] > dp[N - 1] ? N - 2 : N - 1;
  const path = new Int32Array(T);
  for (let t = T - 1; t >= 0; t--) { path[t] = s; s -= bp[t * N + s]; }
  // premières / dernières trames de chaque mot, et confiance (log-proba moyenne de ses morceaux)
  const words = lines.map((ws) => ws.map(() => ({ a: -1, b: -1, sc: 0, n: 0 })));
  for (let t = 0; t < T; t++) {
    const st = path[t];
    if (kindA[st] !== 1) continue;
    const o = owner[st], li = Math.floor(o / 100000), wi = o % 100000;
    const r = words[li][wi];
    if (r.a < 0) r.a = t;
    r.b = t; r.sc += em[t * U + sIdx[st]]; r.n++;
  }
  const out = words.map((ws) => ws.map((r) => ({ s: r.a < 0 ? null : r.a * frame, e: r.b < 0 ? null : (r.b + 1) * frame, conf: r.n ? Math.exp(r.sc / r.n) : 0 })));
  // mots sans trame (très rare) : entre leurs voisins
  out.forEach((ws) => ws.forEach((w, i) => {
    if (w.s != null) return;
    const p = ws.slice(0, i).reverse().find((x) => x.s != null), q = ws.slice(i + 1).find((x) => x.s != null);
    w.s = p ? p.e : q ? Math.max(0, q.s - 0.2) : 0; w.e = q ? q.s : w.s + 0.2; w.conf = 0;
  }));
  const lineInfo = out.map((ws) => ({ s: ws[0]?.s ?? null, e: ws[ws.length - 1]?.e ?? null, conf: ws.reduce((a, w) => a + w.conf, 0) / Math.max(1, ws.length) }));
  return { words: out, lines: lineInfo };
}
