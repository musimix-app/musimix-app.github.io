// MusiMix Piano — parcours de méthode : exercices générés et morceaux du domaine public
// arrangés pour la méthode (mélodies traditionnelles ; arrangements MusiMix).
//
// Notation des voix : jetons séparés par des espaces, « | » pour la lisibilité.
//   C4q  D#4e  Bb3h.  [C3E3G3]w  rq   durée : w ronde, h blanche, q noire, e croche, s double, t croche de triolet ; « . » pointée
//   :3 après la note = doigté (pour un accord, un chiffre par note, du grave à l'aigu). La durée se répète si on l'omet.

import { emptySong, makeGridTrack } from './model.js';
import { BWV846, MAPLE_LEAF } from './scores.js';
import { CLAIR_DE_LUNE } from './score-clair-de-lune.js';

const DUR = { w: 4, h: 2, q: 1, e: 0.5, s: 0.25, t: 1 / 3 };
const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
export const midiOf = (n) => { const m = /^([A-G])(#|b)?(-?\d)$/.exec(n); return 12 * (+m[3] + 1) + PC[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0); };

function parseVoice(src, part) {
  const notes = [];
  let t = 0, dur = 1;
  for (const tok of src.trim().split(/\s+/)) {
    if (!tok || tok === '|') continue;
    const m = /^(\[[^\]]+\]|[A-G](?:#|b)?-?\d|r)([whqest])?(\.)?(?::(\d+))?$/.exec(tok);
    if (!m) throw new Error('Notation inconnue : ' + tok);
    if (m[2]) dur = DUR[m[2]] * (m[3] ? 1.5 : 1);
    else if (m[3]) dur *= 1.5;
    if (m[1] !== 'r') {
      const ps = m[1].startsWith('[') ? m[1].slice(1, -1).match(/[A-G](?:#|b)?-?\d/g) : [m[1]];
      const fs = m[4] ? m[4].split('') : [];
      ps.forEach((p, i) => notes.push({ b: t, len: dur, pitch: midiOf(p), part, finger: fs[i] ? +fs[i] : undefined, fingerHand: part }));
    }
    t += dur;
  }
  return { notes, beats: t };
}

/** Grille « C:w G:h r:q … » → [{ name, b, len }] */
function parseChords(src) {
  const out = [];
  let t = 0;
  for (const tok of src.trim().split(/\s+/)) {
    if (!tok || tok === '|') continue;
    const [name, d] = tok.split(':');
    const len = DUR[d[0]] * (d.endsWith('.') ? 1.5 : 1);
    if (name !== 'r') out.push({ name, b: t, len });
    t += len;
  }
  return out;
}

/** Leçon → morceau jouable dans la vue Piano. */
export function buildLesson(item) {
  const L = typeof item.make === 'function' ? { ...item, ...item.make() } : item;
  const spb = 60 / L.bpm;
  const song = emptySong();
  song.title = L.title;
  song.artist = L.composer || (L.kind === 'exercise' ? 'Exercice' : 'Traditionnel');
  song.key = L.key || '';
  song.bpm = L.bpm;
  const lead = 0; // la vue démarre 2 s avant la première note
  const meter = L.meter || [4, 4];
  const bar = meter[0] * (4 / meter[1]);
  const pick = L.pickup || 0;
  const tracks = [];
  const toNotes = (v) => v.notes.map((n) => ({ t: lead + n.b * spb, d: Math.max(0.08, n.len * spb * (L.legato ?? 0.92)), pitch: n.pitch, vel: L.vel ?? 0.72, ch: 0, program: 0, part: n.part, finger: n.finger, fingerHand: n.fingerHand }));
  let total = 0;
  let rv = null;
  if (L.rh) { rv = parseVoice(L.rh, 'R'); total = Math.max(total, rv.beats); tracks.push({ id: 'm-R', name: 'Main droite', family: 'piano', isDrum: false, program: 0, notes: toNotes(rv), role: 'right', vol: 0.8, mute: false, solo: false, kind: 'midi' }); }
  if (L.lh) { const lv = parseVoice(L.lh, 'L'); total = Math.max(total, lv.beats); tracks.push({ id: 'm-L', name: 'Main gauche', family: 'piano', isDrum: false, program: 0, notes: toNotes(lv), role: 'left', vol: 0.8, mute: false, solo: false, kind: 'midi' }); }
  if (L.notes) { // partition importée (scores.js)
    const S = L.notes;
    const R = [], Lh = [];
    for (let i = 0; i < S.notes.length; i += 4) {
      const n = { t: lead + S.notes[i] * spb, d: Math.max(0.06, S.notes[i + 1] * spb * 0.95), pitch: S.notes[i + 2], vel: 0.7, ch: 0, program: 0 };
      (S.notes[i + 3] === 1 ? R : Lh).push({ ...n, part: S.notes[i + 3] === 1 ? 'R' : 'L' });
      total = Math.max(total, S.notes[i] + S.notes[i + 1]);
    }
    tracks.push({ id: 'm-R', name: 'Main droite', family: 'piano', isDrum: false, program: 0, notes: R, role: 'right', vol: 0.8, mute: false, solo: false, kind: 'midi' });
    tracks.push({ id: 'm-L', name: 'Main gauche', family: 'piano', isDrum: false, program: 0, notes: Lh, role: 'left', vol: 0.8, mute: false, solo: false, kind: 'midi' });
    song.downbeats = S.downbeats.map((b) => lead + b * spb);
  }
  if (L.perf) { // interprétation MIDI minutée en secondes (nuances et pédale du fichier)
    const S = L.perf;
    const R = [], Lh = [];
    for (let i = 0; i < S.notes.length; i += 6) {
      const right = S.notes[i + 3] === 1;
      const n = { t: lead + S.notes[i], d: S.notes[i + 1], pitch: S.notes[i + 2], vel: S.notes[i + 4] / 127, ch: 0, program: 0, part: right ? 'R' : 'L' };
      if (S.notes[i + 5]) n.ring = S.notes[i + 5];
      (right ? R : Lh).push(n);
    }
    tracks.push({ id: 'm-R', name: 'Main droite', family: 'piano', isDrum: false, program: 0, notes: R, role: 'right', vol: 0.8, mute: false, solo: false, kind: 'midi' });
    tracks.push({ id: 'm-L', name: 'Main gauche', family: 'piano', isDrum: false, program: 0, notes: Lh, role: 'left', vol: 0.8, mute: false, solo: false, kind: 'midi' });
    song.downbeats = S.downbeats.map((t) => lead + t);
    song.beats = S.beats.map((t) => lead + t);
    song.bookmarks = (S.bookmarks || []).map((b) => ({ t: lead + b.t, label: b.label }));
    song.pedal = (S.pedal || []).map(([a, b]) => ({ s: lead + a, e: lead + b }));
    total = S.duration / spb;
  }
  for (const t of tracks) t.notes.sort((a, b) => a.t - b.t || a.pitch - b.pitch);
  song.tracks = tracks;
  // temps et mesures
  if (!song.downbeats.length) {
    for (let b = pick; b <= total + 0.001; b += bar) song.downbeats.push(lead + b * spb);
    if (pick) song.downbeats.unshift(lead);
  }
  if (!song.beats.length) for (let b = 0; b <= total + 0.001; b += 4 / meter[1]) song.beats.push(lead + b * spb);
  // grille
  if (L.chords) {
    song.chords = parseChords(L.chords).map((c) => ({ name: c.name, s: lead + c.b * spb, e: lead + (c.b + c.len) * spb }));
    song.chordSource = 'grid';
  }
  // paroles : une syllabe par note de la main droite (« _ » saute une note, « / » change de ligne)
  if (L.lyrics && rv) {
    const heads = [];
    for (const n of rv.notes) if (!heads.length || Math.abs(heads[heads.length - 1].b - n.b) > 1e-6) heads.push(n);
    let k = 0, line = null;
    const lines = [];
    const flush = () => { if (line?.words.length) lines.push(line); line = null; };
    for (const tok of L.lyrics.split(/\s+/)) {
      if (tok === '/') { flush(); continue; }
      const n = heads[k++];
      if (!n || tok === '_') continue;
      line ||= { type: 'lyric', text: '', words: [], chords: [] };
      line.text += (line.text ? ' ' : '') + tok;
      const next = heads[k];
      line.words.push({ s: lead + n.b * spb, e: lead + (next ? Math.min(next.b, n.b + n.len) : n.b + n.len) * spb });
    }
    flush();
    for (const l of lines) { l.s = l.words[0].s; l.e = l.words[l.words.length - 1].e; }
    song.lines = lines;
  }
  song.duration = lead + total * spb + 1;
  song.info = [L.kind === 'exercise' ? 'Exercice du parcours' : 'Morceau du parcours'];
  if (song.chords.length) song.tracks.push(makeGridTrack(song));
  song.lesson = item.id;
  return song;
}

// ───────────────────────────────────────────────── générateurs d'exercices ──

const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const nm = (m) => NAMES[((m % 12) + 12) % 12].replace('Eb', 'D#').replace('Ab', 'G#').replace('Bb', 'A#') + (Math.floor(m / 12) - 1);
const tok = (m, d = '', f) => `${nm(m)}${d}${f ? ':' + f : ''}`;

/** Gamme majeure (ou mineure harmonique) sur n octaves, montée et descente, doigtés standards. */
function scale(rootMidi, hand, { octaves = 1, minor = false, dur = 'q', fingers } = {}) {
  const steps = minor ? [2, 1, 2, 2, 1, 3, 1] : [2, 2, 1, 2, 2, 2, 1];
  const up = [rootMidi];
  for (let o = 0; o < octaves; o++) for (const s of steps) up.push(up[up.length - 1] + s);
  const seq = [...up, ...up.slice(0, -1).reverse()];
  const f = fingers || (hand === 'R' ? [1, 2, 3, 1, 2, 3, 4] : [5, 4, 3, 2, 1, 3, 2]);
  const fUp = up.map((_, i) => (i === up.length - 1 ? (hand === 'R' ? 5 : 1) : f[i % 7]));
  const fs = [...fUp, ...fUp.slice(0, -1).reverse()];
  return seq.map((m, i) => tok(m, i === 0 ? dur : i === seq.length - 1 ? 'h' : '', fs[i])).join(' ');
}

function hanon1(base, hand, reps = 1) {
  const white = [0, 2, 4, 5, 7, 9, 11];
  const at = (deg) => base + 12 * Math.floor(deg / 7) + white[((deg % 7) + 7) % 7];
  const out = [];
  const fu = hand === 'R' ? [1, 2, 3, 4, 5, 4, 3, 2] : [5, 4, 3, 2, 1, 2, 3, 4];
  for (let r = 0; r < reps; r++) {
    for (let k = 0; k < 14; k++) [0, 2, 3, 4, 5, 4, 3, 2].forEach((d, i) => out.push(tok(at(k + d), out.length ? '' : 's', k === 0 || i === 0 ? fu[i] : undefined)));
    for (let k = 18; k > 4; k--) [0, -2, -3, -4, -5, -4, -3, -2].forEach((d) => out.push(tok(at(k + d))));
  }
  out.push(tok(at(0), 'w', hand === 'R' ? 1 : 5));
  return out.join(' ');
}

function arpeggio(root, quality, hand, octaves = 2) {
  const iv = quality === 'm' ? [0, 3, 7] : [0, 4, 7];
  const up = [];
  for (let o = 0; o < octaves; o++) for (const i of iv) up.push(root + 12 * o + i);
  up.push(root + 12 * octaves);
  const seq = [...up, ...up.slice(0, -1).reverse()];
  const fR = [1, 2, 3, 1, 2, 3, 5], fL = [5, 4, 2, 1, 4, 2, 1];
  const fu = up.map((_, i) => (hand === 'R' ? fR : fL)[Math.min(i, 6)]);
  const fs = [...fu, ...fu.slice(0, -1).reverse()];
  return seq.map((m, i) => tok(m, i === 0 ? 'e' : i === seq.length - 1 ? 'h' : '', fs[i])).join(' ');
}

function iiVI(keyPc) {
  // voicings sans fondamentale (main droite) + basses (main gauche), en blanches
  const k = (m) => m + keyPc;
  const rh = [[65, 69, 72, 76], [65, 69, 71, 76], [64, 67, 71, 74]]; // Dm9, G13, Cmaj9 (en do)
  const lh = [38, 43, 36];
  const names = ['m9', '13', 'maj9'];
  const roots = [2, 7, 0];
  let R = '', Lh = '', C = '';
  for (let rep = 0; rep < 2; rep++) {
    rh.forEach((v, i) => {
      const shift = keyPc > 5 ? -12 : 0;
      R += `[${v.map((m) => nm(k(m) + shift)).join('')}]${i === 2 ? 'w' : 'h'} `;
      Lh += `${nm(k(lh[i]))}${i === 2 ? 'w' : 'h'} `;
      C += `${NAMES[(roots[i] + keyPc) % 12]}${names[i]}:${i === 2 ? 'w' : 'h'} `;
    });
  }
  return { rh: R, lh: Lh, chords: C };
}

// ────────────────────────────────────────────────────────── le parcours ──

const C_LH5 = 'C3q:5 D3:4 E3:3 F3:2 G3:1 F3:2 E3:3 D3:4 | C3:5 D3:4 E3:3 F3:2 G3:1 F3:2 E3:3 D3:4 | C3w:5';
const C_RH5 = 'C4q:1 D4:2 E4:3 F4:4 G4:5 F4:4 E4:3 D4:2 | C4:1 D4:2 E4:3 F4:4 G4:5 F4:4 E4:3 D4:2 | C4w:1';

const AU_CLAIR = 'C4q:1 C4 C4 D4:2 | E4h:3 D4:2 | C4q:1 E4:3 D4:2 D4 | C4w:1 | C4q:1 C4 C4 D4:2 | E4h:3 D4:2 | C4q:1 E4:3 D4:2 D4 | C4w:1';
const AU_CLAIR_LY = 'Au clair de la lu- ne, mon a- mi Pier- rot, / Prê- te- moi ta plu- me pour é- crire un mot.';
const AU_CLAIR_CH = 'C:w C:h G:h C:h G:h C:w C:w C:h G:h C:h G:h C:w';
const FRERE = 'C4q:1 D4:2 E4:3 C4:1 | C4 D4 E4 C4 | E4:3 F4:4 G4h:5 | E4q:3 F4:4 G4h:5 | G4e:4 A4:5 G4:4 F4:3 E4q:2 C4:1 | G4e:4 A4:5 G4:4 F4:3 E4q:2 C4:1 | C4q:2 G3:1 C4h:2 | C4q:2 G3:1 C4h:2';
const FRERE_LY = 'Frè- re Jac- ques, frè- re Jac- ques, / dor- mez- vous ? dor- mez- vous ? / Son- nez les ma- ti- nes, son- nez les ma- ti- nes, / ding, daing, dong ! ding, daing, dong !';
const ODE = 'E4q:3 E4 F4:4 G4:5 | G4 F4:4 E4:3 D4:2 | C4:1 C4 D4:2 E4:3 | E4q.:3 D4e:2 D4h:2 | E4q:3 E4 F4:4 G4:5 | G4 F4:4 E4:3 D4:2 | C4:1 C4 D4:2 E4:3 | D4q.:2 C4e:1 C4h:1';
const ODE_CH = 'C:w G:w C:w C:h G:h C:w G:w C:w G:h C:h';
const AH_VOUS = 'C4q:1 C4 G4:4 G4 | A4:5 A4 G4h:4 | F4q:4 F4 E4:3 E4 | D4:2 D4 C4h:1 | G4q:5 G4 F4:4 F4 | E4:3 E4 D4h:2 | G4q:5 G4 F4:4 F4 | E4:3 E4 D4h:2 | C4q:1 C4 G4:4 G4 | A4:5 A4 G4h:4 | F4q:4 F4 E4:3 E4 | D4:2 D4 C4h:1';
const AH_VOUS_LY = 'Ah ! vous di- rai- je, ma- man, ce qui cau- se mon tour- ment ? / Pa- pa veut que je rai- son- ne comme une grande per- son- ne. / Moi, je dis que les bon- bons va- lent mieux que la rai- son.';

export const LEVELS = [
  { id: 1, name: 'Éveil', tag: 'Premiers pas', goal: 'Trouver le Do, jouer avec les cinq doigts de la main droite.' },
  { id: 2, name: 'Débutant 1', tag: 'La main gauche', goal: 'Les cinq doigts de la main gauche, la clé de fa sous les doigts.' },
  { id: 3, name: 'Débutant 2', tag: 'Les deux mains', goal: 'Coordonner les mains : mouvement parallèle, contraire, mélodie et basse.' },
  { id: 4, name: 'Intermédiaire 1', tag: 'Les accords', goal: 'Accords parfaits, renversements, accompagner une mélodie.' },
  { id: 5, name: 'Intermédiaire 2', tag: 'Les gammes', goal: 'Passage du pouce, gammes majeures et mineures, Hanon.' },
  { id: 6, name: 'Avancé 1', tag: 'Arpèges et accompagnements', goal: 'Arpèges, basse d’Alberti, morceaux à deux mains plus longs.' },
  { id: 7, name: 'Avancé 2', tag: 'Les classiques', goal: 'Beethoven, Bach, Petzold : premiers grands classiques.' },
  { id: 8, name: 'Professionnel', tag: 'Vélocité et répertoire', goal: 'Gammes à deux mains, harmonie jazz, ragtime, tempo de concert.' },
];

export const LESSONS = [
  // ── 1 · Éveil
  { id: 'l1-5doigts', level: 1, kind: 'exercise', title: 'Cinq doigts en Do', hands: 'R', bpm: 72, rh: C_RH5, chords: 'C:w C:w C:w', tip: 'Pouce sur le Do du milieu, un doigt par touche.' },
  { id: 'l1-blanches', level: 1, kind: 'exercise', title: 'Noires et blanches', hands: 'R', bpm: 76, rh: 'C4q:1 C4 D4h:2 | E4q:3 E4 F4h:4 | G4q:5 G4 F4h:4 | E4q:3 D4 C4h:1 | E4h:3 G4:5 | F4h:4 D4:2 | C4w:1' },
  { id: 'l1-sauts', level: 1, kind: 'exercise', title: 'Les sauts : Do, Mi, Sol', hands: 'R', bpm: 72, rh: 'C4q:1 E4:3 G4:5 E4:3 | C4:1 E4:3 G4h:5 | G4q:5 E4:3 C4:1 E4:3 | G4:5 E4:3 C4h:1 | C4q:1 D4:2 E4:3 G4:5 | C4w:1', chords: 'C:w C:w C:w C:w C:w C:w' },
  { id: 'l1-auclair', level: 1, kind: 'song', title: 'Au clair de la lune', hands: 'R', bpm: 92, rh: AU_CLAIR, lyrics: AU_CLAIR_LY, chords: AU_CLAIR_CH },
  { id: 'l1-frere', level: 1, kind: 'song', title: 'Frère Jacques', hands: 'R', bpm: 100, rh: FRERE, lyrics: FRERE_LY, chords: 'C:w C:w C:w C:w C:w C:w C:w C:w' },
  { id: 'l1-ode', level: 1, kind: 'song', title: 'Ode à la joie', composer: 'Beethoven', hands: 'R', bpm: 96, rh: ODE, chords: ODE_CH },
  // ── 2 · Débutant 1
  { id: 'l2-5doigts', level: 2, kind: 'exercise', title: 'Cinq doigts main gauche', hands: 'L', bpm: 72, lh: C_LH5, tip: 'Auriculaire (5) sur le Do grave, le pouce sur le Sol.' },
  { id: 'l2-basses', level: 2, kind: 'exercise', title: 'Basses Do, Fa, Sol', hands: 'L', bpm: 76, lh: 'C3w:5 | F3w:2 | G3w:1 | C3w:5 | C3h:5 F3h:2 | G3h:1 C3h:5 | F3h:2 G3h:1 | C3w:5', chords: 'C:w F:w G:w C:w C:h F:h G:h C:h F:h G:h C:w' },
  { id: 'l2-alternance', level: 2, kind: 'exercise', title: 'Question, réponse', hands: 'RL', bpm: 80, rh: 'C4q:1 D4:2 E4:3 F4:4 | G4w:5 | rw | rw | G4q:5 F4:4 E4:3 D4:2 | C4w:1 | rw | rw', lh: 'rw | rw | C3q:5 D3:4 E3:3 F3:2 | G3w:1 | rw | rw | G3q:1 F3:2 E3:3 D3:4 | C3w:5', tip: 'Une main joue, l’autre attend : prépare-la au-dessus des touches.' },
  { id: 'l2-ode-mg', level: 2, kind: 'song', title: 'Ode à la joie (main gauche)', composer: 'Beethoven', hands: 'L', bpm: 88, lh: 'E3q:3 E3 F3:2 G3:1 | G3 F3:2 E3:3 D3:4 | C3:5 C3 D3:4 E3:3 | E3q.:3 D3e:4 D3h:4 | E3q:3 E3 F3:2 G3:1 | G3 F3:2 E3:3 D3:4 | C3:5 C3 D3:4 E3:3 | D3q.:4 C3e:5 C3h:5', chords: ODE_CH },
  { id: 'l2-auclair-mg', level: 2, kind: 'song', title: 'Au clair de la lune (main gauche)', hands: 'L', bpm: 88, lh: 'C3q:5 C3 C3 D3:4 | E3h:3 D3:4 | C3q:5 E3:3 D3:4 D3 | C3w:5 | C3q:5 C3 C3 D3:4 | E3h:3 D3:4 | C3q:5 E3:3 D3:4 D3 | C3w:5', chords: AU_CLAIR_CH },
  // ── 3 · Débutant 2
  { id: 'l3-parallele', level: 3, kind: 'exercise', title: 'Mouvement parallèle', hands: 'RL', bpm: 72, rh: C_RH5, lh: C_LH5, tip: 'Les deux mains montent ensemble, à une octave d’écart.' },
  { id: 'l3-contraire', level: 3, kind: 'exercise', title: 'Mouvement contraire', hands: 'RL', bpm: 72, rh: 'C4q:1 D4:2 E4:3 F4:4 G4:5 F4:4 E4:3 D4:2 | C4:1 D4:2 E4:3 F4:4 G4:5 F4:4 E4:3 D4:2 | C4w:1', lh: 'C3q:1 B2:2 A2:3 G2:4 F2:5 G2:4 A2:3 B2:2 | C3:1 B2:2 A2:3 G2:4 F2:5 G2:4 A2:3 B2:2 | C3w:1', tip: 'Les deux pouces partent d’un Do (à une octave d’écart), puis les mains s’écartent en miroir.' },
  { id: 'l3-auclair', level: 3, kind: 'song', title: 'Au clair de la lune (deux mains)', hands: 'RL', bpm: 88, rh: AU_CLAIR, lh: 'C3w:5 | C3h:5 G3:1 | C3h:5 G3:1 | C3w:5 | C3w:5 | C3h:5 G3:1 | C3h:5 G3:1 | C3w:5', lyrics: AU_CLAIR_LY, chords: AU_CLAIR_CH },
  { id: 'l3-ahvous', level: 3, kind: 'song', title: 'Ah ! vous dirai-je, maman', hands: 'RL', bpm: 96, rh: AH_VOUS, lh: 'C3w:5 | F3h:2 C3:5 | G3h:1 C3:5 | G3h:1 C3:5 | C3h:5 G3:1 | C3h:5 G3:1 | C3h:5 G3:1 | C3h:5 G3:1 | C3w:5 | F3h:2 C3:5 | G3h:1 C3:5 | G3h:1 C3:5', lyrics: AH_VOUS_LY, chords: 'C:w F:h C:h G:h C:h G:h C:h C:h G:h C:h G:h C:h G:h C:h G:h C:w F:h C:h G:h C:h G:h C:h' },
  { id: 'l3-frere', level: 3, kind: 'song', title: 'Frère Jacques (deux mains)', hands: 'RL', bpm: 96, rh: FRERE, lh: 'C3h:5 G3:1 | C3h:5 G3:1 | C3h:5 G3:1 | C3h:5 G3:1 | C3h:5 G3:1 | C3h:5 G3:1 | C3h:5 G3:1 | C3w:5', lyrics: FRERE_LY, chords: 'C:w C:w C:w C:w C:w C:w C:w C:w' },
  { id: 'l3-anniversaire', level: 3, kind: 'song', title: 'Joyeux anniversaire', hands: 'RL', bpm: 100, meter: [3, 4], pickup: 1, rh: 'G4e.:1 G4s:1 | A4q:2 G4:1 C5:4 | B4h:3 G4e.:1 G4s:1 | A4q:2 G4:1 D5:5 | C5h:4 G4e.:1 G4s:1 | G5q:5 E5:3 C5:1 | B4:4 A4:3 F5e.:5 F5s:5 | E5q:4 C5:2 D5:3 | C5h.:2', lh: 'rq | C3h.:5 | G3h.:1 | G3h.:1 | C3h.:5 | C3h.:5 | F3h.:2 | C3h:5 G3q:1 | C3h.:5', lyrics: 'Joy- eux an- ni- ver- saire, / joy- eux an- ni- ver- saire, / joy- eux an- ni- ver- sai- re, / joy- eux an- ni- ver- saire !', chords: 'r:q C:h. G:h. G:h. C:h. C:h. F:h. C:h G:q C:h.' },
  // ── 4 · Intermédiaire 1
  { id: 'l4-accords', level: 4, kind: 'exercise', title: 'Accords Do, Fa, Sol', hands: 'L', bpm: 72, lh: '[C3E3G3]w:531 | [C3F3A3]w:521 | [B2D3G3]w:531 | [C3E3G3]w:531 | [C3E3G3]h:531 [C3F3A3]:521 | [B2D3G3]h:531 [C3E3G3]:531 | [C3F3A3]h:521 [B2D3G3]:531 | [C3E3G3]w:531', chords: 'C:w F:w G:w C:w C:h F:h G:h C:h F:h G:h C:w', tip: 'Le Do reste sous le 5 : seuls les doigts du haut bougent.' },
  { id: 'l4-renversements', level: 4, kind: 'exercise', title: 'Renversements de Do', hands: 'R', bpm: 66, rh: '[C4E4G4]h:135 [E4G4C5]:125 | [G4C5E5]h:135 [E4G4C5]:125 | [C4E4G4]w:135 | [C4E4G4]q:135 [E4G4C5]:125 [G4C5E5]:135 [C5E5G5]:135 | [G4C5E5]:135 [E4G4C5]:125 [C4E4G4]h:135', chords: 'C:w C:w C:w C:w C:w' },
  { id: 'l4-pop', level: 4, kind: 'exercise', title: 'La progression pop (Do, Sol, La m, Fa)', hands: 'RL', bpm: 80, rh: '[C4E4G4]w:135 | [B3D4G4]:125 | [C4E4A4]:125 | [C4F4A4]:135 | [C4E4G4]h:135 [C4E4G4] | [B3D4G4]h:125 [B3D4G4] | [C4E4A4]h:125 [C4E4A4] | [C4F4A4]h:135 [C4F4A4] | [C4E4G4]w:135', lh: 'C3w:5 | G2:5 | A2:5 | F2:5 | C3h:5 G3:1 | G2h:5 D3:1 | A2h:5 E3:1 | F2h:5 C3:1 | C3w:5', chords: 'C:w G:w Am:w F:w C:w G:w Am:w F:w C:w', tip: 'La main droite bouge le moins possible d’un accord à l’autre.' },
  { id: 'l4-jingle', level: 4, kind: 'song', title: 'Jingle Bells', composer: 'J. Pierpont', hands: 'RL', bpm: 112, rh: 'E4q:3 E4 E4h | E4q E4 E4h | E4q:3 G4:5 C4q.:1 D4e:2 | E4w:3 | F4q:4 F4 F4q. F4e | F4q E4:3 E4 E4e E4 | E4q D4:2 D4 E4:3 | D4h:2 G4h:5 | E4q:3 E4 E4h | E4q E4 E4h | E4q G4:5 C4q.:1 D4e:2 | E4w:3 | F4q:4 F4 F4q. F4e | F4q E4:3 E4 E4e E4 | G4q:5 G4 F4:4 D4:2 | C4w:1', lh: '[C3E3G3]w:531 | [C3E3G3] | [C3E3G3] | [C3E3G3] | [C3F3A3]:521 | [C3E3G3]:531 | [B2D3G3]:531 | [B2D3G3] | [C3E3G3]:531 | [C3E3G3] | [C3E3G3] | [C3E3G3] | [C3F3A3]:521 | [C3E3G3]:531 | [B2D3G3]:531 | [C3E3G3]:531', chords: 'C:w C:w C:w C:w F:w C:w G:w G:w C:w C:w C:w C:w F:w C:w G:w C:w' },
  { id: 'l4-canon', level: 4, kind: 'song', title: 'Canon (version facile)', composer: 'Pachelbel', key: 'D', hands: 'RL', bpm: 64, rh: 'F#5h E5 | D5 C#5 | B4 A4 | B4 C#5 | D5h C#5 | B4 A4 | G4 F#4 | G4 E4 | D5q F#5 A5 G5 | F#5 D5 F#5 E5 | D5 B4 D5 A5 | G5 B5 A5 G5 | F#5h E5 | D5 C#5 | B4 A4 | B4 C#5 | D5w', lh: 'D3h A2 | B2 F#2 | G2 D2 | G2 A2 | D3h A2 | B2 F#2 | G2 D2 | G2 A2 | D3h A2 | B2 F#2 | G2 D2 | G2 A2 | D3h A2 | B2 F#2 | G2 D2 | G2 A2 | D3w', chords: 'D:h A:h Bm:h F#m:h G:h D:h G:h A:h D:h A:h Bm:h F#m:h G:h D:h G:h A:h D:h A:h Bm:h F#m:h G:h D:h G:h A:h D:h A:h Bm:h F#m:h G:h D:h G:h A:h D:w' },
  // ── 5 · Intermédiaire 2
  { id: 'l5-do-md', level: 5, kind: 'exercise', title: 'Gamme de Do (main droite)', hands: 'R', bpm: 80, make: () => ({ rh: scale(60, 'R') }), tip: 'Le pouce passe sous le 3 après le Mi ; en descendant, le 3 passe par-dessus le pouce.' },
  { id: 'l5-do-mg', level: 5, kind: 'exercise', title: 'Gamme de Do (main gauche)', hands: 'L', bpm: 80, make: () => ({ lh: scale(48, 'L') }), tip: 'Le 3 passe par-dessus le pouce après le Sol.' },
  { id: 'l5-do-2m', level: 5, kind: 'exercise', title: 'Gamme de Do (deux mains)', hands: 'RL', bpm: 72, make: () => ({ rh: scale(60, 'R'), lh: scale(48, 'L') }) },
  { id: 'l5-sol', level: 5, kind: 'exercise', title: 'Gamme de Sol', key: 'G', hands: 'RL', bpm: 72, make: () => ({ rh: scale(67, 'R'), lh: scale(43, 'L') }), tip: 'Un seul dièse : le Fa♯.' },
  { id: 'l5-fa', level: 5, kind: 'exercise', title: 'Gamme de Fa', key: 'F', hands: 'RL', bpm: 72, make: () => ({ rh: scale(65, 'R', { fingers: [1, 2, 3, 4, 1, 2, 3] }), lh: scale(53, 'L') }), tip: 'Un seul bémol : le Si♭. Main droite 1 2 3 4, puis le pouce passe sous le 4 pour jouer le Do.' },
  { id: 'l5-lam', level: 5, kind: 'exercise', title: 'La mineur harmonique', key: 'Am', hands: 'RL', bpm: 72, make: () => ({ rh: scale(69, 'R', { minor: true }), lh: scale(45, 'L', { minor: true }) }), tip: 'Le Sol♯ (sensible) donne la couleur orientale de la mineure harmonique.' },
  { id: 'l5-hanon', level: 5, kind: 'exercise', title: 'Hanon n° 1', composer: 'C.-L. Hanon', hands: 'RL', bpm: 60, make: () => ({ rh: hanon1(60, 'R'), lh: hanon1(48, 'L') }), tip: 'Doigts arrondis, chaque note égale. Monte le tempo de 4 en 4.' },
  { id: 'l5-ode-2m', level: 5, kind: 'song', title: 'Ode à la joie (deux mains)', composer: 'Beethoven', hands: 'RL', bpm: 100, rh: ODE, lh: '[C3E3G3]h:531 [C3E3G3] | [B2D3G3]h:531 [B2D3G3] | [C3E3G3]h:531 [C3E3G3] | [C3E3G3]h:531 [B2D3G3]:531 | [C3E3G3]h:531 [C3E3G3] | [B2D3G3]h:531 [B2D3G3] | [C3E3G3]h:531 [C3E3G3] | [B2D3G3]h:531 [C3E3G3]:531', chords: ODE_CH },
  // ── 6 · Avancé 1
  { id: 'l6-arp-do', level: 6, kind: 'exercise', title: 'Arpège de Do (2 octaves)', hands: 'RL', bpm: 72, make: () => ({ rh: arpeggio(60, '', 'R'), lh: arpeggio(48, '', 'L') }) },
  { id: 'l6-arp-sol-lam', level: 6, kind: 'exercise', title: 'Arpèges de Sol et La mineur', hands: 'RL', bpm: 72, make: () => ({ rh: arpeggio(67, '', 'R') + ' ' + arpeggio(69, 'm', 'R'), lh: arpeggio(43, '', 'L') + ' ' + arpeggio(45, 'm', 'L') }) },
  { id: 'l6-alberti', level: 6, kind: 'exercise', title: 'Basse d’Alberti', hands: 'L', bpm: 76, lh: 'C3e:5 G3:1 E3:3 G3:1 C3 G3 E3 G3 | C3:5 A3:1 F3:2 A3:1 C3:5 A3 F3 A3 | B2:5 G3:1 D3:3 G3:1 B2 G3 D3 G3 | C3:5 G3:1 E3:3 G3:1 C3h:5', chords: 'C:w F:w G:w C:w' },
  { id: 'l6-greensleeves', level: 6, kind: 'song', title: 'Greensleeves', composer: 'Traditionnel anglais', key: 'Am', hands: 'RL', bpm: 96, meter: [3, 4], pickup: 1, rh: 'A4q | C5h D5q | E5q. F5e E5q | D5h B4q | G4q. A4e B4q | C5h A4q | A4q. G#4e A4q | B4h G#4q | E4h A4q | C5h D5q | E5q. F5e E5q | D5h B4q | G4q. A4e B4q | C5q. B4e A4q | G#4q. F#4e G#4q | A4h.', lh: 'rq | [A2E3]h. | [C3G3] | [G2D3] | [E2B2] | [A2E3] | [E2B2] | [E2B2] | [A2E3] | [A2E3] | [C3G3] | [G2D3] | [E2B2] | [A2E3] | [E2B2] | [A2E3]', chords: 'r:q Am:h. C:h. G:h. Em:h. Am:h. E:h. E:h. Am:h. Am:h. C:h. G:h. Em:h. Am:h. E:h. Am:h.' },
  { id: 'l6-douce-nuit', level: 6, kind: 'song', title: 'Douce nuit', composer: 'F. Gruber', hands: 'RL', bpm: 84, meter: [3, 4], rh: 'G4q. A4e G4q | E4h. | G4q. A4e G4q | E4h. | D5h D5q | B4h. | C5h C5q | G4h. | A4h A4q | C5q. B4e A4q | G4q. A4e G4q | E4h. | A4h A4q | C5q. B4e A4q | G4q. A4e G4q | E4h. | D5h D5q | F5q. D5e B4q | C5h. | E5h. | C5q. G4e E4q | G4q. F4e D4q | C4h. | C4h.', lh: '[C3G3]h. | [C3G3] | [C3G3] | [C3G3] | [G2F3] | [G2F3] | [C3G3] | [C3G3] | [F2C3] | [F2C3] | [C3G3] | [C3G3] | [F2C3] | [F2C3] | [C3G3] | [C3G3] | [G2F3] | [G2F3] | [C3G3] | [C3G3] | [C3G3] | [G2F3] | [C3G3] | [C3G3]', chords: 'C:h. C:h. C:h. C:h. G7:h. G7:h. C:h. C:h. F:h. F:h. C:h. C:h. F:h. F:h. C:h. C:h. G7:h. G7:h. C:h. C:h. C:h. G7:h. C:h. C:h.' },
  // ── 7 · Avancé 2
  { id: 'l7-menuet', level: 7, kind: 'song', title: 'Menuet en sol', composer: 'C. Petzold (attr. Bach)', key: 'G', hands: 'RL', bpm: 112, meter: [3, 4], rh: 'D5q G4e A4 B4 C5 | D5q G4 G4 | E5q C5e D5 E5 F#5 | G5q G4 G4 | C5q D5e C5 B4 A4 | B4q C5e B4 A4 G4 | F#4q G4e A4 B4 G4 | A4h. | D5q G4e A4 B4 C5 | D5q G4 G4 | E5q C5e D5 E5 F#5 | G5q G4 G4 | C5q D5e C5 B4 A4 | B4q C5e B4 A4 G4 | A4q B4e A4 G4 F#4 | G4h.', lh: '[G3B3]h. | B3 | C4 | B3 | A3 | G3 | D4 | [D3F#3] | [G3B3] | B3 | C4 | B3 | A3 | G3 | D3 | G2', chords: 'G:h. G:h. C:h. G:h. Am:h. G:h. D:h. D:h. G:h. G:h. C:h. G:h. Am:h. G:h. D:h. G:h.', tip: 'Main gauche simplifiée. Les croches bien égales, légères.' },
  { id: 'l7-elise', level: 7, kind: 'song', title: 'Lettre à Élise (thème)', composer: 'Beethoven', key: 'Am', hands: 'RL', bpm: 72, meter: [3, 8], pickup: 0.5, rh: 'E5s:5 D#5:4 | E5:5 D#5:4 E5:5 B4:2 D5:4 C5:3 | A4e:1 rs C4s:1 E4:2 A4:3 | B4e:4 rs E4s:1 G#4:3 B4:4 | C5e:5 rs E4s:1 E5:5 D#5:4 | E5:5 D#5:4 E5:5 B4:2 D5:4 C5:3 | A4e:1 rs C4s:1 E4:2 A4:3 | B4e:4 rs E4s:1 C5:4 B4:3 | A4q.:2', lh: 're | rq. | A2s:5 E3:2 A3:1 re. | E2s:5 E3:2 G#3:1 re. | A2s:5 E3:2 A3:1 re. | rq. | A2s:5 E3:2 A3:1 re. | E2s:5 E3:2 G#3:1 re. | A2s:5 E3:2 A3:1 re.', chords: 'r:e r:q. Am:q. E:q. Am:q. r:q. Am:q. E:q. Am:q.' },
  { id: 'l7-prelude', level: 7, kind: 'song', title: 'Prélude en do (BWV 846)', composer: 'J.-S. Bach', key: 'C', hands: 'RL', bpm: 60, notes: BWV846, tip: 'Commence à 60 % avec « Attendre ». Chaque mesure est un accord brisé : repère sa forme.' },
  { id: 'l7-hanon-vite', level: 7, kind: 'exercise', title: 'Hanon n° 1, deux fois', composer: 'C.-L. Hanon', hands: 'RL', bpm: 76, make: () => ({ rh: hanon1(60, 'R', 2), lh: hanon1(48, 'L', 2) }) },
  // ── 8 · Professionnel
  { id: 'l8-gammes-re-la', level: 8, kind: 'exercise', title: 'Gammes de Ré et La (2 octaves)', hands: 'RL', bpm: 96, make: () => ({ rh: scale(62, 'R', { octaves: 2, dur: 'e' }) + ' ' + scale(69, 'R', { octaves: 2, dur: 'e' }), lh: scale(50, 'L', { octaves: 2, dur: 'e' }) + ' ' + scale(45, 'L', { octaves: 2, dur: 'e' }) }) },
  { id: 'l8-gammes-mi-si', level: 8, kind: 'exercise', title: 'Gammes de Mi et Si (2 octaves)', hands: 'RL', bpm: 96, make: () => ({ rh: scale(64, 'R', { octaves: 2, dur: 'e' }) + ' ' + scale(71, 'R', { octaves: 2, dur: 'e' }), lh: scale(52, 'L', { octaves: 2, dur: 'e' }) + ' ' + scale(47, 'L', { octaves: 2, dur: 'e', fingers: [4, 3, 2, 1, 4, 3, 2] }) }) },
  { id: 'l8-251', level: 8, kind: 'exercise', title: 'II-V-I jazz en Do, Fa et Si♭', hands: 'RL', bpm: 84, make: () => { const a = iiVI(0), b = iiVI(5), c = iiVI(10); return { rh: `${a.rh} ${b.rh} ${c.rh}`, lh: `${a.lh} ${b.lh} ${c.lh}`, chords: `${a.chords} ${b.chords} ${c.chords}` }; }, tip: 'Voicings sans fondamentale : la basse est à la main gauche, la main droite joue tierce, septième et neuvième.' },
  { id: 'l8-prelude', level: 8, kind: 'song', title: 'Prélude en do, tempo de concert', composer: 'J.-S. Bach', key: 'C', hands: 'RL', bpm: 76, notes: BWV846 },
  { id: 'l8-maple', level: 8, kind: 'song', title: 'Maple Leaf Rag', composer: 'Scott Joplin', key: 'Ab', hands: 'RL', bpm: 92, notes: MAPLE_LEAF, tip: 'Commence main par main à 50 %. La main gauche saute : regarde loin devant.' },
  { id: 'l8-clair-de-lune', level: 8, kind: 'song', title: 'Clair de lune', composer: 'Claude Debussy', key: 'Db', hands: 'RL', bpm: 53, meter: [9, 8], perf: CLAIR_DE_LUNE, tip: 'Pianissimo et beaucoup de pédale : écoute les nuances du fichier. Travaille d’abord chaque section à 60 % avec « Attendre » (repères sur la barre de progression).' },
];

/** Morceaux de la bibliothèque (tous les « song » du parcours). */
export const LIBRARY = LESSONS.filter((l) => l.kind === 'song');

// ──────────────────────────────────────────────────────────── progression ──

const KEY = 'mmx-piano:progress';
export function loadProgress() { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } }
export function saveResult(id, { accuracy, wait, rate, hit, wrong, miss }) {
  const P = loadProgress();
  const full = !wait && rate >= 0.999;
  const stars = accuracy >= 97 && full ? 3 : accuracy >= 90 ? 2 : accuracy >= 75 ? 1 : 0;
  const prev = P[id] || { best: 0, stars: 0, plays: 0 };
  const rec = { best: Math.max(prev.best, accuracy), stars: Math.max(prev.stars, stars), plays: prev.plays + 1, last: Date.now(), lastAcc: accuracy, hit, wrong, miss };
  P[id] = rec;
  try { localStorage.setItem(KEY, JSON.stringify(P)); } catch { /* aperçu sans stockage */ }
  return { ...rec, newStars: stars, improved: accuracy > prev.best, full };
}
export function levelStats(level, P = loadProgress(), list = LESSONS) {
  const items = list.filter((l) => l.level === level);
  const done = items.filter((l) => (P[l.id]?.stars || 0) >= 1).length;
  const stars = items.reduce((a, l) => a + (P[l.id]?.stars || 0), 0);
  return { total: items.length, done, stars, max: items.length * 3 };
}
/** Prochaine étape conseillée : la première leçon pas encore validée, dans l'ordre. */
export function nextLesson(P = loadProgress()) { return LESSONS.find((l) => !(P[l.id]?.stars >= 1)) || LESSONS[LESSONS.length - 1]; }
