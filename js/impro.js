// MusiMix — aide à l'improvisation : notes de la tonalité sur le manche ou le clavier,
// avec en plus les notes de l'accord qui joue.
//   accord en cours  → notes les plus sûres à cet instant (ambre, pleines)
//   pentatonique     → « toujours bonnes » sur tout le morceau (bleu-vert, pleines)
//   reste de la gamme→ notes de passage (cerclées)
//   note blues       → option (violet)

import { parseChord, chordPcs, pcName, keyName } from './theory.js';
import { esc } from './ui.js';

export const SCALES = {
  major: { scale: [0, 2, 4, 5, 7, 9, 11], penta: [0, 2, 4, 7, 9], blues: 3, label: 'majeure' },
  minor: { scale: [0, 2, 3, 5, 7, 8, 10], penta: [0, 3, 5, 7, 10], blues: 6, label: 'mineure' },
};
const NECKS = { guitar: [40, 45, 50, 55, 59, 64], ukulele: [67, 60, 64, 69] };
const DEG_MAJ = ['1', '♭2', '2', '♭3', '3', '4', '♭5', '5', '♭6', '6', '♭7', '7'];
const FR = { C: 'Do', D: 'Ré', E: 'Mi', F: 'Fa', G: 'Sol', A: 'La', B: 'Si' };
export const frName = (n) => (FR[n[0]] || n[0]) + n.slice(1).replace('#', '♯').replace('b', '♭');

/** Classe de chaque note (0–11) : 'chord' | 'penta' | 'scale' | 'blues' | null */
export function improLayers(key, chord, { penta = true, scale = true, current = true, blues = false } = {}) {
  const S = SCALES[key.minor ? 'minor' : 'major'];
  const cls = new Array(12).fill(null);
  const pcs = (arr) => arr.map((i) => (key.pc + i) % 12);
  if (scale) for (const p of pcs(S.scale)) cls[p] = 'scale';
  if (blues) cls[(key.pc + S.blues) % 12] = 'blues';
  if (penta) for (const p of pcs(S.penta)) cls[p] = 'penta';
  const ch = current && chord ? parseChord(chord) : null;
  const chordSet = new Set(ch ? chordPcs(ch) : []);
  if (ch && ch.bass != null) chordSet.add(ch.bass);
  for (const p of chordSet) cls[p] = 'chord';
  return { cls, chordRoot: ch ? ch.root : null, keyRoot: key.pc, scalePcs: pcs(S.scale), pentaPcs: pcs(S.penta) };
}

function dot(cx, cy, r, c, label, isRoot) {
  if (!c) return '';
  return `<g class="im-n im-${c}${isRoot ? ' im-root' : ''}"><circle cx="${cx}" cy="${cy}" r="${r}"/><text x="${cx}" y="${cy}">${esc(label)}</text></g>`;
}

/** Manche (guitare / ukulélé), corde aiguë en haut comme une tablature. */
export function neckSvg(L, key, { instrument = 'guitar', capo = 0, frets = 15, names = 'notes' } = {}) {
  const strings = NECKS[instrument] || NECKS.guitar;
  const n = strings.length;
  const fw = 52, sh = 26, x0 = 62, y0 = 18;
  const W = x0 + fw * (frets + 0.5) + 10, H = y0 + sh * (n - 1) + 34;
  const fx = (f) => (f === 0 ? x0 - 22 : x0 + fw * (f - 0.5));
  let g = '';
  // cases
  for (let f = 1; f <= frets; f++) g += `<line class="im-fret" x1="${x0 + fw * f}" y1="${y0}" x2="${x0 + fw * f}" y2="${y0 + sh * (n - 1)}"/>`;
  g += `<line class="im-nut" x1="${x0}" y1="${y0 - 2}" x2="${x0}" y2="${y0 + sh * (n - 1) + 2}"/>`;
  for (const f of [3, 5, 7, 9, 15, 17]) if (f <= frets) g += `<circle class="im-inlay" cx="${fx(f)}" cy="${y0 + (sh * (n - 1)) / 2}" r="5"/>`;
  if (frets >= 12) for (const k of [-1, 1]) g += `<circle class="im-inlay" cx="${fx(12)}" cy="${y0 + sh * ((n - 1) / 2 + k)}" r="5"/>`;
  for (let f = 1; f <= frets; f += f < 3 ? 2 : f < 9 ? 2 : 3) g += `<text class="im-fnum" x="${fx(f)}" y="${y0 + sh * (n - 1) + 24}">${f}</text>`;
  if (capo) g += `<rect class="im-capo-zone" x="${x0 - 30}" y="${y0 - 10}" width="${fw * capo + 30}" height="${sh * (n - 1) + 20}"/><rect class="im-capo" x="${x0 + fw * capo - 7}" y="${y0 - 9}" width="8" height="${sh * (n - 1) + 18}" rx="3"/>`;
  // cordes (aiguë en haut)
  const order = strings.map((m, i) => ({ m, i })).reverse();
  order.forEach(({ m }, row) => {
    const y = y0 + row * sh;
    g += `<line class="im-str" x1="${x0}" y1="${y}" x2="${x0 + fw * frets}" y2="${y}" style="stroke-width:${0.8 + (row / Math.max(1, n - 1)) * 1.6}"/>`;
    g += `<text class="im-sname" x="11" y="${y}">${esc(pcName(m % 12, key))}</text>`;
    for (let f = capo; f <= frets; f++) {
      const p = (m + f) % 12;
      const c = L.cls[p];
      if (!c) continue;
      const lab = names === 'degrees' ? DEG_MAJ[(p - key.pc + 12) % 12] : pcName(p, key);
      g += dot(f === capo && capo ? x0 + fw * capo - 20 : fx(f), y, c === 'chord' ? 11 : c === 'scale' ? 8.5 : 10, c, lab, p === key.pc);
    }
  });
  return `<svg class="im-neck" viewBox="0 0 ${W} ${H}" style="min-width:${Math.round(W * 0.82)}px">${g}</svg>`;
}

/** Clavier de 2 octaves (Do à Si). */
export function keysSvg(L, key, { octaves = 2, names = 'notes' } = {}) {
  const ww = 34, wh = 120, bw = 22, bh = 74;
  const whites = [0, 2, 4, 5, 7, 9, 11], blacks = { 1: 0, 3: 1, 6: 3, 8: 4, 10: 5 };
  const W = ww * 7 * octaves + 2, H = wh + 4;
  let g = '', top = '';
  for (let o = 0; o < octaves; o++) {
    whites.forEach((p, i) => {
      const x = 1 + (o * 7 + i) * ww;
      const c = L.cls[p];
      g += `<rect class="im-wk ${c ? 'im-k-' + c : ''}" x="${x}" y="1" width="${ww}" height="${wh}" rx="4"/>`;
      if (c) g += dot(x + ww / 2, wh - 18, c === 'chord' ? 11 : 9, c, names === 'degrees' ? DEG_MAJ[(p - key.pc + 12) % 12] : pcName(p, key), p === key.pc);
    });
    for (const [p, wi] of Object.entries(blacks)) {
      const x = 1 + (o * 7 + wi + 1) * ww - bw / 2;
      const c = L.cls[+p];
      top += `<rect class="im-bk ${c ? 'im-k-' + c : ''}" x="${x}" y="1" width="${bw}" height="${bh}" rx="3"/>`;
      if (c) top += dot(x + bw / 2, bh - 15, c === 'chord' ? 10 : 8.5, c, names === 'degrees' ? DEG_MAJ[(+p - key.pc + 12) % 12] : pcName(+p, key), +p === key.pc);
    }
  }
  return `<svg class="im-keys" viewBox="0 0 ${W} ${H}">${g}${top}</svg>`;
}

export const ALL_KEYS = [...Array(12).keys()].flatMap((pc) => [{ pc, minor: false }, { pc, minor: true }]);
export const keyLabelFr = (k) => `${frName(pcName(k.pc, k))} ${SCALES[k.minor ? 'minor' : 'major'].label}`;
export { keyName };
