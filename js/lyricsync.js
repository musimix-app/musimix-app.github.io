// MusiMix — calage des paroles et des accords sur l'audio (« tout avaler, s'améliorer avec ce qu'on a ») :
//   1. Mots : la piste Voix (séparée) est écoutée par un modèle de reconnaissance vocale (worker ctc-worker.js) ;
//      les paroles connues (grille, partition, LRC…) y sont posées mot à mot par alignement forcé. Pas besoin de LRC.
//   2. Accords : la suite d'accords de la grille (dans son ordre, avec ses noms) est posée sur les temps de
//      l'audio d'après l'harmonie des instruments (chroma) ; chaque accord est guidé par le mot sous lequel la
//      grille l'écrit (à quelques mots près) — ce qui lève l'ambiguïté des grilles qui se répètent.
//   3. Chaque accord est rattaché au mot chanté à l'instant où il change.
// Les parties pures (alignChords, wordAt, chordTemplate, bestShift, beatChroma) sont testables en ligne de commande.

import { tokenize } from './sheet.js';
import { parseChord } from './theory.js';

// ───────────────────────────────────────────────────────── gabarits ──

/** Gabarit d'accord (12 classes de hauteur, normalisé) ; shift = transposition entre la grille et l'audio. */
export function chordTemplate(name, shift = 0) {
  const ch = parseChord(name);
  if (!ch) return null;
  const t = new Float32Array(12);
  ch.intervals.forEach((iv) => {
    const w = iv === 0 ? 1 : iv === 7 ? 0.8 : iv === 3 || iv === 4 ? 0.9 : 0.6;
    t[(ch.root + iv + shift + 120) % 12] += w;
  });
  normIn(t);
  const bass = ((ch.bass ?? ch.root) + shift + 120) % 12;
  return { t, bass, root: (ch.root + shift + 120) % 12 };
}
function normIn(v) { let s = 0; for (let i = 0; i < v.length; i++) s += v[i] * v[i]; s = Math.sqrt(s) || 1; for (let i = 0; i < v.length; i++) v[i] /= s; return v; }
const dot = (a, b) => { let s = 0; for (let i = 0; i < 12; i++) s += a[i] * b[i]; return s; };

/**
 * Transposition la plus probable entre les noms de la grille et l'audio (capo écrit autrement, accordage un
 * demi-ton plus bas…) : 0 sauf si un autre décalage colle nettement mieux.
 */
export function bestShift(names, grid) {
  const avg = new Float32Array(12);
  for (const b of grid) for (let k = 0; k < 12; k++) avg[k] += b.h[k];
  normIn(avg);
  const score = (sh) => {
    const acc = new Float32Array(12);
    for (const n of names) { const tp = chordTemplate(n, sh); if (tp) for (let k = 0; k < 12; k++) acc[k] += tp.t[k]; }
    normIn(acc);
    return dot(acc, avg);
  };
  const sc = Array.from({ length: 12 }, (_, s) => score(s));
  let best = 0;
  for (let s = 1; s < 12; s++) if (sc[s] > sc[best]) best = s;
  return sc[best] > sc[0] + 0.04 ? best : 0;
}

// ───────────────────────────────────────────────── accords sur les temps ──

/**
 * grid : [{ s, e, h (chroma harmonie, normalisé), b (chroma basse, normalisé), down, half, sub }]
 * seq : [{ name, exp (temps attendu d'après le mot de la grille, ou null) }]
 * Retourne pour chaque accord l'indice de la case de la grille où il commence (ou -1 s'il est en trop).
 * Programmation dynamique : chaque case appartient à un accord (dans l'ordre de la grille) ou à un « trou »
 * (passage absent de la grille) ; score = ressemblance harmonique + basse + début de mesure + proximité du mot.
 */
export function alignChords(grid, seq, { shift = 0, sigma = 1.2, anchorW = 1.1, maxLen = 48, gap = 0.5, skip = 2.5 } = {}) {
  const B = grid.length, M = seq.length;
  if (!B || !M) return seq.map(() => -1);
  const tpl = seq.map((c) => chordTemplate(c.name, shift));
  const cum = seq.map((_, i) => {
    const tp = tpl[i];
    const c = new Float64Array(B + 1);
    for (let j = 0; j < B; j++) c[j + 1] = c[j] + (tp ? dot(grid[j].h, tp.t) + 0.35 * (grid[j].b[tp.bass] - 0.3) : 0.4);
    return c;
  });
  const startBonus = grid.map((b) => (b.down ? 0.35 : b.half ? 0.12 : 0) - (b.sub ? 0.15 : 0));
  const anchor = (i, j) => {
    const x = seq[i].exp;
    if (x == null) return 0;
    return -anchorW * Math.min(4, Math.abs(grid[j].s - x) / sigma);
  };
  const NEG = -1e18;
  const f = Array.from({ length: M + 1 }, () => new Float64Array(B + 1).fill(NEG));
  const how = Array.from({ length: M + 1 }, () => new Int32Array(B + 1)); // >0 : longueur ; 0 : trou ; -1 : accord sauté
  f[0][0] = 0;
  for (let i = 0; i <= M; i++) {
    for (let j = 0; j <= B; j++) {
      const v = f[i][j];
      if (v <= NEG / 2) continue;
      if (j < B) { const w = v + gap - 0.08; if (w > f[i][j + 1]) { f[i][j + 1] = w; how[i][j + 1] = 0; } }
      if (i === M) continue;
      { const w = v - skip; if (w > f[i + 1][j]) { f[i + 1][j] = w; how[i + 1][j] = -1; } }
      if (j < B) {
        const base = v + startBonus[j] + anchor(i, j);
        for (let L = 1; L <= maxLen && j + L <= B; L++) {
          const w = base + cum[i][j + L] - cum[i][j];
          if (w > f[i + 1][j + L]) { f[i + 1][j + L] = w; how[i + 1][j + L] = L; }
        }
      }
    }
  }
  const start = new Array(M).fill(-1);
  let i = M, j = B;
  while (i > 0 || j > 0) {
    const h = how[i][j];
    if (h === 0) j--;
    else if (h === -1) { i--; start[i] = -1; }
    else { i--; j -= h; start[i] = j; }
    if (i < 0 || j < 0) break;
  }
  return start;
}

// ───────────────────────────────────────── accords rattachés aux mots ──

/**
 * lines : lignes de paroles calées ({ text, s, e, words: [{ s, e }] }) ; t : temps où l'accord change.
 * Retourne { li, pos, k } : la ligne, la position (caractère) et l'indice du mot chanté à ce moment.
 * Le mot qui commence le plus près du changement (±0,35 s) ; sinon le mot en cours ; entre deux lignes,
 * l'accord va au début de la ligne qui suit (si elle commence dans la seconde) ou après celle qui précède.
 */
export function wordAt(lines, t, { near = 0.35 } = {}) {
  let best = null;
  lines.forEach((l, li) => {
    if (!l.words?.length) return;
    const toks = tokenize(l.text);
    l.words.forEach((w, k) => {
      const d = Math.abs(w.s - t);
      if (d <= near && (!best || d < best.d)) best = { li, pos: toks[k]?.start ?? 0, d, k };
    });
  });
  if (best) return best;
  for (let li = 0; li < lines.length; li++) {
    const l = lines[li];
    if (!l.words?.length) continue;
    const toks = tokenize(l.text);
    for (let k = 0; k < l.words.length; k++) if (l.words[k].s <= t && t < (l.words[k].e ?? l.words[k].s + 0.5)) return { li, pos: toks[k]?.start ?? 0, k };
  }
  let prev = -1, next = -1;
  lines.forEach((l, li) => { if (l.s == null || !l.words?.length) return; if (l.s <= t) prev = li; else if (next < 0) next = li; });
  if (next >= 0 && lines[next].s - t <= 1.0) return { li: next, pos: 0, k: 0, before: true };
  if (prev >= 0) return { li: prev, pos: (lines[prev].text || '').length + 1, k: -1, after: true };
  return null;
}

// ─────────────────────────────────────────────────────── chroma par temps ──

/** Cases de la grille rythmique (demi-temps pour les tempos lents) avec le chroma moyen de l'harmonie et de la basse. */
export function beatChroma(ch, cb, beats, downbeats, duration) {
  const per = beats.length > 1 ? (beats[beats.length - 1] - beats[0]) / (beats.length - 1) : 0.5;
  const sub = per > 0.3; // demi-temps : un accord peut changer « sur le et » (anticipation, fréquente en pop)
  const grid = [];
  const dset = new Set((downbeats || []).map((x) => Math.round(x * 20)));
  beats.forEach((b, k) => {
    const e = beats[k + 1] ?? Math.min(duration, b + per);
    const down = dset.has(Math.round(b * 20));
    if (sub) { const m = (b + e) / 2; grid.push({ s: b, e: m, down }); grid.push({ s: m, e, sub: true }); }
    else grid.push({ s: b, e, down });
  });
  let lastDown = -1;
  grid.forEach((g, i) => { if (g.down) lastDown = i; else if (lastDown >= 0 && !g.sub && i - lastDown === (sub ? 4 : 2)) g.half = true; });
  const avg = (C, s, e) => {
    const v = new Float32Array(12);
    for (let f = Math.max(0, Math.floor((s - C.t0) * C.fps)); f < C.frames.length && f / C.fps + C.t0 < e; f++) for (let k = 0; k < 12; k++) v[k] += C.frames[f][k];
    return normIn(v);
  };
  for (const g of grid) { g.h = avg(ch, g.s, g.e); g.b = avg(cb, g.s, g.e); }
  return grid;
}

/** Temps attendu de chaque accord d'après le mot (calé) sous lequel la grille l'écrit. */
export function expectedTimes(lines, refs) {
  return refs.map(({ li, c }) => {
    const l = lines[li];
    if (l.type !== 'lyric' || !l.words?.length) return { name: c.name, exp: null };
    const toks = tokenize(l.text);
    let k = 0; for (let i = 0; i < toks.length; i++) if (toks[i].start <= c.pos) k = i;
    const after = toks.length && c.pos >= toks[toks.length - 1].end;
    return { name: c.name, exp: after ? (l.e ?? l.words[l.words.length - 1].e) + 0.2 : l.words[k]?.s ?? null };
  });
}

/** Déplace les accords sur le mot chanté au moment où ils changent ; renvoie la liste des changements. */
export function moveChords(lines, refs, times) {
  const changes = [];
  const moves = [];
  refs.forEach((r, i) => {
    const t = times[i];
    if (t == null) return;
    r.c.t = +t.toFixed(3);
    r.c.cal = true; // calé sur l'audio : le lecteur ne le déplace plus
    if (lines[r.li].type !== 'lyric') return; // ligne d'accords seule (intro, pont) : place gardée, temps posé
    const at = wordAt(lines.map((l) => (l.type === 'lyric' ? l : { text: '' })), t);
    if (!at || Math.abs(at.li - r.li) > 1) return; // trop loin : on ne touche pas à la grille
    if (at.li !== r.li || at.pos !== r.c.pos) moves.push({ r, at, t });
  });
  for (const { r, at, t } of moves) {
    const from = lines[r.li], to = lines[at.li];
    changes.push({ name: r.c.name, from: wordOf(from.text, r.c.pos), to: at.after ? '(fin de ligne)' : wordOf(to.text, at.pos), line: to.text, t, li: at.li, fromLi: r.li });
    from.chords = from.chords.filter((x) => x !== r.c);
    r.c.pos = at.pos;
    to.chords = [...(to.chords || []).filter((x) => !(x.pos === at.pos && x !== r.c)), r.c].sort((a, b) => a.pos - b.pos);
  }
  return changes;
}

function wordOf(text, pos) {
  const toks = tokenize(text);
  if (!toks.length) return '(ligne)';
  if (pos >= toks[toks.length - 1].end) return '(fin de ligne)';
  let k = 0; for (let i = 0; i < toks.length; i++) if (toks[i].start <= pos) k = i;
  return toks[k].w;
}

// ─────────────────────────────────────────────────────────── orchestration ──

let worker = null, reqId = 0;
const pending = new Map();
function ctcWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./workers/ctc-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    if (e.data.type === 'progress') p.onProgress?.(e.data);
    else { pending.delete(e.data.id); if (e.data.type === 'done') p.ok(e.data.result); else p.ko(new Error(e.data.message)); }
  };
  worker.onerror = (e) => { for (const p of pending.values()) p.ko(new Error(e.message || 'Calcul interrompu')); pending.clear(); worker = null; };
  return worker;
}
function ask(msg, onProgress, transfer) {
  const id = ++reqId;
  return new Promise((ok, ko) => { pending.set(id, { ok, ko, onProgress }); ctcWorker().postMessage({ ...msg, id }, transfer || []); });
}

async function monoAt(blobs, sr) {
  const { decodeAt } = await import('./wav.js');
  let out = null;
  for (const b of blobs) {
    if (!b) continue;
    const buf = await decodeAt(b, sr);
    if (!out) out = new Float32Array(buf.length);
    for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); const n = Math.min(d.length, out.length); for (let i = 0; i < n; i++) out[i] += d[i] / buf.numberOfChannels; }
  }
  return out;
}

/**
 * Cale les paroles (mot à mot) et les accords d'un morceau MusiMix. Ne modifie pas le morceau : renvoie
 * { lines (nouvelles lignes du doc), changes (accords déplacés), report }. getBlob(blobId) → Blob.
 */
export async function calibrate(song, getBlob, { onProgress = () => {}, words = true, chords = true } = {}) {
  const stem = (k) => song.stems.find((s) => s.kind === k && s.sep) || song.stems.find((s) => s.kind === k);
  const mix = song.stems.find((s) => s.kind === 'mix') || song.stems[0];
  const lines = JSON.parse(JSON.stringify(song.doc.lines));
  const lyr = lines.filter((l) => l.type === 'lyric' && tokenize(l.text).length);
  const report = { words: 0, lines: lyr.length, chords: 0, moved: 0, voice: !!stem('vocals'), shift: 0, lowConf: 0 };
  if (!lyr.length && !lines.some((l) => l.chords?.length)) throw new Error('Pas de paroles ni d’accords à caler');
  if (!mix) throw new Error('Pas d’audio dans ce morceau');

  // ── 1. mots (voix)
  if (words && lyr.length) {
    const vb = await getBlob((stem('vocals') || mix).blobId);
    onProgress({ progress: 0.02, message: 'Lecture de la piste Voix…' });
    const pcm = await monoAt([vb], 16000);
    await ask({ type: 'probs', pcm }, (p) => onProgress({ progress: 0.03 + 0.62 * p.progress, message: p.message }), [pcm.buffer]);
    onProgress({ progress: 0.66, message: 'Pose des mots sur la voix…' });
    const res = await ask({ type: 'align', lines: lyr.map((l) => tokenize(l.text).map((x) => x.w)) });
    const off = (song.prefs?.offset || 0) / 1000; // ancien minutage (LRC…) = temps audio + décalage
    lyr.forEach((l, i) => {
      const ws = res.words[i];
      const unsure = res.lines[i].conf < 0.005; // la voix ne ressemble pas au texte (vocalises, chœurs, autre texte)
      const s = ws[0].s;
      // filet de sécurité : ligne peu sûre et très loin de l'ancien minutage (LRC) → on garde l'ancien
      if (unsure && l.s != null && Math.abs(l.s - off - s) > 1.5) {
        const d = -off;
        l.s += d; if (l.e != null) l.e += d; l.words?.forEach((w) => { w.s += d; if (w.e != null) w.e += d; });
        l.sync = 'lrc'; report.keptLrc = (report.keptLrc || 0) + 1;
        return;
      }
      if (unsure) report.lowConf++;
      l.words = ws.map((w) => ({ s: +w.s.toFixed(3), e: +w.e.toFixed(3) }));
      l.s = l.words[0].s; l.e = l.words[l.words.length - 1].e;
      l.sync = 'voix';
      report.words += ws.length;
    });
    // les lignes sans paroles calées gardent leur ancien temps, ramené à l'audio
    for (const l of lines) if (l.type === 'lyric' && !lyr.includes(l) && l.s != null && off) { l.s -= off; if (l.e != null) l.e -= off; }
  }

  // ── 2. accords (harmonie)
  let changes = [];
  const refs = [];
  lines.forEach((l, li) => (l.chords || []).forEach((c) => refs.push({ li, c })));
  if (chords && refs.length) {
    onProgress({ progress: 0.7, message: 'Écoute de l’harmonie…' });
    const A = await import('./analyze.js');
    const harm = ['guitar', 'piano', 'other'].map((k) => song.stems.find((s) => s.kind === k && s.sep)).filter(Boolean);
    const xh = await monoAt(await Promise.all((harm.length ? harm : [mix]).map((s) => getBlob(s.blobId))), A.ANALYSIS_SR);
    const bassSt = song.stems.find((s) => s.kind === 'bass' && s.sep);
    const xb = bassSt ? await monoAt([await getBlob(bassSt.blobId)], A.ANALYSIS_SR) : xh;
    let beats = song.beats, downs = song.downbeats;
    if (!beats?.length) {
      onProgress({ progress: 0.75, message: 'Écoute du rythme…' });
      const drums = song.stems.find((s) => s.kind === 'drums' && s.sep);
      const xr = drums ? await monoAt([await getBlob(drums.blobId)], A.ANALYSIS_SR) : xh;
      const { env, fps } = await A.onsetEnvelope(xr);
      beats = A.trackBeats(env, fps, A.tempo(env, fps));
      downs = beats.filter((_, i) => i % 4 === 0);
    }
    onProgress({ progress: 0.82, message: 'Pose des accords sur les temps…' });
    const ch = await A.chromaFrames(xh, 90, 2500);
    const cb = await A.chromaFrames(xb, 35, 260);
    const grid = beatChroma(ch, cb, beats, downs, song.duration || xh.length / A.ANALYSIS_SR);
    const seq = expectedTimes(lines, refs);
    report.shift = bestShift(seq.map((x) => x.name), grid);
    const start = alignChords(grid, seq, { shift: report.shift });
    report.chords = start.filter((x) => x >= 0).length;
    changes = moveChords(lines, refs, start.map((j) => (j >= 0 ? grid[j].s : null)));
    report.moved = changes.length;
  }
  onProgress({ progress: 1, message: 'Calage terminé' });
  return { lines, changes, report };
}
