// Calage automatique : écoute l'audio pour trouver
//  - le décalage des paroles (où la voix chante vraiment, comparé aux temps du .lrc),
//  - le début de la musique (pour poser la 1re note de la partition).
import { db } from './db.js';
import { isEmptyStem } from './levels.js';

const HOP = 0.02; // 50 images par seconde

async function decodeMono(blob) {
  const buf = await blob.arrayBuffer();
  const ctx = new OfflineAudioContext(1, 1, 22050);
  const ab = await ctx.decodeAudioData(buf);
  const n = ab.length, out = new Float32Array(n);
  for (let c = 0; c < ab.numberOfChannels; c++) { const d = ab.getChannelData(c); for (let i = 0; i < n; i++) out[i] += d[i] / ab.numberOfChannels; }
  return { data: out, sr: ab.sampleRate };
}

/** Enveloppe d'énergie (dB) à 50 images/s. */
function envelope({ data, sr }) {
  const hop = Math.round(sr * HOP), n = Math.floor(data.length / hop), env = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let s = 0; const o = f * hop;
    for (let i = 0; i < hop; i++) { const v = data[o + i]; s += v * v; }
    env[f] = 10 * Math.log10(s / hop + 1e-12);
  }
  return env;
}

const pct = (arr, p) => { const a = Float32Array.from(arr).sort(); return a[Math.min(a.length - 1, Math.floor(p * a.length))]; };

async function stemEnv(song, kinds) {
  const stems = (song.stems || []).filter((s) => s.blobId && kinds.includes(s.kind) && !isEmptyStem(s));
  let sum = null;
  for (const st of stems) {
    const blob = await db.getBlob(st.blobId);
    if (!blob) continue;
    const e = envelope(await decodeMono(blob));
    if (!sum) sum = Float32Array.from(e, (v) => 10 ** (v / 10));
    else for (let i = 0; i < Math.min(sum.length, e.length); i++) sum[i] += 10 ** (e[i] / 10);
  }
  return sum ? sum.map((v) => 10 * Math.log10(v + 1e-12)) : null;
}

/**
 * Décalage des paroles : compare « la voix chante » (piste Voix) à « une ligne est en cours » (temps du LRC).
 * Renvoie { shift, conf } : shift > 0 = la voix arrive après les temps du .lrc (les paroles sont en avance).
 */
export async function alignLyrics(song, onStep) {
  onStep?.('Écoute de la voix…');
  let env = await stemEnv(song, ['vocals']);
  let src = 'voix';
  if (!env) { env = await stemEnv(song, ['mix', 'instrumental', 'other', 'guitar', 'piano']); src = 'morceau'; }
  if (!env) throw new Error('Pas d’audio exploitable pour ce morceau');
  const hi = pct(env, 0.97), lo = Math.max(pct(env, 0.2), hi - 40);
  const act = Float32Array.from(env, (v) => Math.min(1, Math.max(0, (v - lo) / (hi - lo + 1e-6))));
  const n = act.length;
  // activité attendue d'après les paroles
  const lines = (song.doc?.lines || []).filter((l) => l.type === 'lyric' && l.s != null);
  if (lines.length < 3) throw new Error('Il faut des paroles déjà calées (au moins 3 lignes)');
  const L = new Float32Array(n);
  lines.forEach((l, i) => {
    const segs = l.words?.length ? l.words.map((w) => [w.s, w.e ?? w.s + 0.3]) : [[l.s, Math.min(l.e ?? lines[i + 1]?.s ?? l.s + 4, l.s + 8)]];
    for (const [a, b] of segs) for (let f = Math.max(0, Math.floor(a / HOP)); f < Math.min(n, Math.ceil(b / HOP)); f++) L[f] = 1;
  });
  const mean = act.reduce((s, v) => s + v, 0) / n;
  const ac = act.map((v) => v - mean);
  onStep?.('Comparaison avec les paroles…');
  const K = Math.round(12 / HOP), score = new Float32Array(2 * K + 1);
  for (let k = -K; k <= K; k++) {
    let s = 0;
    for (let f = Math.max(0, k); f < Math.min(n, n + k); f++) if (L[f - k]) s += ac[f];
    score[k + K] = s;
  }
  let best = 0;
  for (let i = 1; i < score.length; i++) if (score[i] > score[best]) best = i;
  // fiabilité : pic net par rapport au meilleur score à plus de 0,6 s
  let second = -Infinity;
  for (let i = 0; i < score.length; i++) if (Math.abs(i - best) * HOP > 0.6 && score[i] > second) second = score[i];
  const conf = score[best] > 0 ? Math.max(0, Math.min(1, 1 - Math.max(0, second) / score[best])) : 0;
  return { shift: Math.round((best - K) * HOP * 100) / 100, conf, src };
}

/** Début de la musique (s) : premier moment où l'ensemble des pistes devient vraiment audible. */
export async function musicStart(song, onStep) {
  onStep?.('Écoute du début du morceau…');
  const env = await stemEnv(song, ['mix', 'instrumental', 'vocals', 'backing', 'drums', 'bass', 'guitar', 'piano', 'other']);
  if (!env) throw new Error('Pas d’audio exploitable pour ce morceau');
  const thr = pct(env, 0.95) - 30, need = Math.round(0.25 / HOP);
  let run = 0;
  for (let f = 0; f < env.length; f++) {
    run = env[f] > thr ? run + 1 : 0;
    if (run >= need) { // recule jusqu'à l'attaque
      let g = f - need + 1;
      while (g > 0 && env[g - 1] > thr - 12) g--;
      return g * HOP;
    }
  }
  return 0;
}

const norm = (w) => w.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

/**
 * Décalage des paroles d'après les paroles écrites dans la partition (déjà calée sur l'audio) :
 * pour chaque ligne, on cherche dans la partition une suite de syllabes qui commence comme elle.
 * Renvoie { shift, conf, n } ou null.
 */
export function alignFromScore(song, syl) {
  if (!syl?.length) return null;
  // flux de mots de la partition (les syllabes « some- » « day » se recollent)
  const words = [];
  for (const s of syl) {
    const raw = s.w.replace(/\s+/g, ' ');
    for (const part of raw.split(' ')) {
      const p = norm(part);
      if (!p) continue;
      const prev = words[words.length - 1];
      if (prev?.open) { prev.w += p; prev.open = /-$/.test(part); }
      else words.push({ w: p, t: s.t, open: /-$/.test(part) });
    }
  }
  const lines = (song.doc?.lines || []).filter((l) => l.type === 'lyric' && l.s != null && l.text);
  const diffs = [];
  for (const l of lines) {
    const lw = l.text.split(/\s+/).map(norm).filter(Boolean).slice(0, 3);
    if (lw.length < 2) continue;
    let best = null;
    for (let i = 0; i + lw.length <= words.length; i++) {
      if (Math.abs(words[i].t - l.s) > 20) continue;
      let ok = 0;
      for (let k = 0; k < lw.length; k++) if (words[i + k].w === lw[k] || (lw[k].length > 3 && words[i + k].w.startsWith(lw[k].slice(0, 4)))) ok++;
      if (ok >= lw.length - (lw.length > 2 ? 1 : 0) && (!best || Math.abs(words[i].t - l.s) < Math.abs(best - l.s))) best = words[i].t;
    }
    if (best != null) diffs.push(best - l.s);
  }
  if (diffs.length < 3) return null;
  // valeur la plus partagée (à 0,4 s près)
  let top = null;
  for (const d of diffs) {
    const near = diffs.filter((x) => Math.abs(x - d) < 0.4);
    if (!top || near.length > top.length) top = near;
  }
  const med = top.slice().sort((a, b) => a - b)[top.length >> 1];
  return { shift: Math.round(med * 100) / 100, conf: top.length / diffs.length, n: top.length, of: lines.length };
}

/**
 * Minutage mot à mot d'après la partition : chaque mot des paroles prend le temps de la syllabe
 * correspondante écrite sous les notes (la partition étant calée sur l'audio).
 * Modifie song.doc ; renvoie { lines, words, total } ou null si trop peu de correspondances.
 */
export async function wordsFromScore(song, syl) {
  const { tokenize, alignSequences, interpolateWords, fillLineEnds } = await import('./sheet.js');
  if (!syl?.length) return null;
  const sw = [];
  syl.forEach((s, si) => {
    const parts = s.w.split(/\s+/).filter((x) => norm(x));
    // un texte de plusieurs mots posé sur un seul temps : les mots s'étalent jusqu'au texte suivant
    const next = syl[si + 1]?.t ?? s.t + parts.length * 0.35;
    const step = parts.length > 1 ? Math.min(0.4, Math.max(0.12, (next - s.t) / parts.length)) : 0;
    parts.forEach((part, k) => {
      const p = norm(part);
      const prev = sw[sw.length - 1];
      if (prev?.open) { prev.w += p; prev.open = /-$/.test(part); }
      else sw.push({ w: p, t: s.t + k * step, open: /-$/.test(part) });
    });
  });
  sw.forEach((x, i) => { x.e = sw[i + 1] ? Math.min(sw[i + 1].t, x.t + 1.2) : x.t + 0.6; });
  const lines = (song.doc?.lines || []).filter((l) => l.type === 'lyric' && l.text?.trim());
  const dw = [];
  lines.forEach((l, li) => tokenize(l.text).forEach((tk, wi) => dw.push({ li, wi, w: norm(tk.w) })));
  const eq = (a, b) => a === b || (a.length >= 3 && b.length >= 3 && (a.startsWith(b) || b.startsWith(a)));
  const pairs = alignSequences(dw.map((x) => x.w), sw.map((x) => x.w), eq);
  if (pairs.length < dw.length * 0.4) return null;
  const res = lines.map((l) => new Array(tokenize(l.text).length).fill(null));
  for (const [i, j] of pairs) res[dw[i].li][dw[i].wi] = { s: sw[j].t, e: sw[j].e };
  let nl = 0;
  lines.forEach((l, li) => {
    const r = res[li], known = r.filter(Boolean);
    if (known.length < Math.max(1, r.length * 0.3)) return; // pas dans la partition : on garde son minutage actuel
    const s = known[0].s, e = known[known.length - 1].e;
    l.words = interpolateWords(r, s, e);
    l.s = l.words?.[0]?.s ?? s; l.e = e;
    nl++;
  });
  fillLineEnds(song.doc.lines);
  return { lines: nl, words: pairs.length, total: dw.length };
}
