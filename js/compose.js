// MusiMix — atelier de composition : théorie (suites, transitions, variantes, doigtés enchaînés)
// et son (accords joués à la guitare ou au piano, grille jouée en boucle avec un rythme du style choisi).
import { parseChord, guessKeyFromChords, spelling, FLAT, SHARP } from './theory.js';
import { voicings } from './diagrams.js';

const mod = (n) => ((n % 12) + 12) % 12;

// ───────────────────────────────────────────────────────────── styles ──
// deg : qualité de chaque degré (majeur : I ii iii IV V vi vii° ; mineur : i ii° bIII iv v bVI bVII)
export const STYLES = {
  pop: { label: 'Pop', bpm: 100, maj: ['', 'm', 'm', '', '', 'm', 'dim'], min: ['m', 'dim', '', 'm', 'm', '', ''], color: ['add9', 'sus2', 'sus4', 'maj7', '6'], rhythm: 'pop', feel: 'straight' },
  rock: { label: 'Rock', bpm: 120, maj: ['', 'm', 'm', '', '', 'm', 'dim'], min: ['m', 'dim', '', 'm', 'm', '', ''], color: ['5', 'sus4', 'add9', '7#9'], rhythm: 'rock', feel: 'straight', borrow: true },
  blues: { label: 'Blues', bpm: 90, maj: ['7', 'm7', 'm7', '7', '7', 'm7', 'm7b5'], min: ['m7', 'm7b5', 'maj7', 'm7', '7', 'maj7', '7'], color: ['9', '13', '7#9', '6'], rhythm: 'shuffle', feel: 'swing' },
  jazz: { label: 'Jazz', bpm: 130, maj: ['maj7', 'm7', 'm7', 'maj7', '7', 'm7', 'm7b5'], min: ['m7', 'm7b5', 'maj7', 'm7', '7', 'maj7', '7'], color: ['maj9', 'm9', '9', '13', '6', '7b9', 'm6'], rhythm: 'jazz', feel: 'swing', jazz: true },
  bossa: { label: 'Bossa nova', bpm: 125, maj: ['maj7', 'm7', 'm7', 'maj7', '7', 'm7', 'm7b5'], min: ['m7', 'm7b5', 'maj7', 'm7', '7', 'maj7', '7'], color: ['maj9', 'm9', '9', '6', '69', '7b9'], rhythm: 'bossa', feel: 'straight', jazz: true },
  folk: { label: 'Folk / acoustique', bpm: 95, maj: ['', 'm', 'm', '', '', 'm', 'dim'], min: ['m', 'dim', '', 'm', 'm', '', ''], color: ['sus2', 'sus4', 'add9', '7'], rhythm: 'folk', feel: 'straight' },
  funk: { label: 'Funk / soul', bpm: 105, maj: ['9', 'm7', 'm7', '9', '9', 'm7', 'm7b5'], min: ['m7', 'm7b5', 'maj7', 'm9', '7#9', 'maj7', '9'], color: ['m9', '13', '7#9', '9'], rhythm: 'funk', feel: 'straight' },
  chanson: { label: 'Chanson / ballade', bpm: 78, maj: ['', 'm', 'm', '', '', 'm', 'dim'], min: ['m', 'dim', '', 'm', '7', '', ''], color: ['maj7', 'add9', 'sus4', '6', 'm7'], rhythm: 'arpeggio', feel: 'straight' },
  reggae: { label: 'Reggae', bpm: 80, maj: ['', 'm', 'm', '', '', 'm', 'dim'], min: ['m', 'dim', '', 'm', 'm', '', ''], color: ['7', 'm7', 'sus4'], rhythm: 'reggae', feel: 'straight' },
};

const MAJ_STEPS = [0, 2, 4, 5, 7, 9, 11];
const MIN_STEPS = [0, 2, 3, 5, 7, 8, 10];
const ROMAN_MAJ = ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°'];
const ROMAN_MIN = ['i', 'ii°', 'III', 'iv', 'v', 'VI', 'VII'];

export function name(rootPc, suffix, key, bassPc = null) {
  const k = key || { pc: 0, minor: false };
  let sp; try { sp = spelling(k); } catch { sp = null; }
  // notes hors tonalité : bémols pour les degrés abaissés (bII, bIII, bVI, bVII), sinon l'orthographe de la tonalité
  const nm = (pc) => { const iv = mod(pc - k.pc); return [1, 3, 8, 10].includes(iv) && !(k.minor && [3, 8, 10].includes(iv) && sp) ? FLAT[mod(pc)] : (sp ? sp[mod(pc)] : FLAT[mod(pc)]); };
  return nm(rootPc) + suffix + (bassPc == null || mod(bassPc) === mod(rootPc) ? '' : '/' + nm(bassPc));
}

/** Accord du degré d (0..6) de la tonalité, dans le style. */
export function degree(key, d, style) {
  const st = STYLES[style] || STYLES.pop;
  const steps = key.minor ? MIN_STEPS : MAJ_STEPS;
  let suf = (key.minor ? st.min : st.maj)[d];
  if (key.minor && d === 4 && style !== 'rock' && style !== 'folk' && style !== 'reggae') suf = st.jazz || style === 'blues' || style === 'funk' ? '7' : ''; // V majeur (mineur harmonique)
  return name(key.pc + steps[d], suf, key);
}

/** Degré (0..6) d'un accord dans la tonalité, ou -1. */
function degOf(ch, key) {
  const steps = key.minor ? MIN_STEPS : MAJ_STEPS;
  return steps.indexOf(mod(ch.root - key.pc));
}

export function roman(nm, key) {
  const ch = parseChord(nm);
  if (!ch || !key) return '';
  const d = degOf(ch, key);
  if (d >= 0) return (key.minor ? ROMAN_MIN : ROMAN_MAJ)[d];
  const iv = mod(ch.root - key.pc);
  return ({ 1: 'bII', 3: 'bIII', 6: '#IV', 8: 'bVI', 10: 'bVII' })[iv] || '';
}

export function guessKey(names) {
  const k = guessKeyFromChords(names.filter(Boolean).map((n) => ({ name: n, w: 1 })));
  return k || { pc: 0, minor: false };
}

const isDom = (ch) => /^(7|9|11|13|7b9|7#9|7sus4|7b5|7#5|13b9)/.test(ch.suffix);
const isMin = (ch) => ch.minor;

// ──────────────────────────────────────────────────────── suggestions ──
/** Accords qui peuvent suivre « prev » (ou commencer si prev est vide). [{ name, why }] */
export function nextChords(prev, key, style) {
  const st = STYLES[style] || STYLES.pop;
  const out = [];
  const add = (nm, why) => { if (nm && !out.some((x) => x.name === nm) && nm !== prev) out.push({ name: nm, why }); };
  const D = (d) => degree(key, d, style);
  const p = prev && parseChord(prev);
  if (!p) {
    add(D(0), 'la tonique : le point de départ naturel');
    add(D(5), key.minor ? 'accord majeur lumineux' : 'départ mélancolique (relatif mineur)');
    add(D(3), 'départ en suspens');
    add(D(1), key.minor ? '' : 'départ jazz (ii)');
    return out.filter((x) => x.name);
  }
  // accord de dominante (7) : il veut se résoudre une quinte plus bas
  if (isDom(p)) {
    const target = mod(p.root + 5);
    const tq = st.jazz ? (degOf({ root: target }, key) >= 0 ? null : 'maj7') : '';
    const dd = degOf({ root: target }, key);
    add(dd >= 0 ? D(dd) : name(target, tq || '', key), 'résolution : la dominante retombe une quinte plus bas');
    if (style === 'blues') add(name(p.root + 5, '7', key), 'blues : IV7');
  }
  const d = degOf(p, key);
  const maj = {
    0: [[3, 'IV : ouverture, très courant'], [4, 'V : tension qui appelle le retour'], [5, 'vi : couleur mélancolique'], [1, 'ii : prépare le V']],
    1: [[4, 'ii → V : l’enchaînement roi'], [6, 'vers vii°'], [3, 'ii → IV : en douceur']],
    2: [[5, 'iii → vi : descente par quintes'], [3, 'iii → IV']],
    3: [[4, 'IV → V : montée vers la tension'], [0, 'IV → I : cadence « amen »'], [1, 'IV → ii']],
    4: [[0, 'V → I : cadence parfaite'], [5, 'V → vi : cadence rompue (surprise)'], [3, 'V → IV : très rock / pop']],
    5: [[3, 'vi → IV : la suite pop (vi IV I V)'], [1, 'vi → ii : descente par quintes'], [4, 'vi → V'], [2, 'vi → iii']],
    6: [[0, 'vii° → I'], [2, 'vii° → iii']],
  };
  const min = {
    0: [[5, 'i → VI : épique'], [3, 'i → iv'], [6, 'i → VII'], [4, 'i → V']],
    1: [[4, 'ii° → V : cadence mineure']],
    2: [[5, 'III → VI'], [6, 'III → VII'], [3, 'III → iv']],
    3: [[4, 'iv → V'], [0, 'iv → i'], [6, 'iv → VII']],
    4: [[0, 'V → i : cadence'], [5, 'V → VI : cadence rompue']],
    5: [[6, 'VI → VII → i : montée épique'], [3, 'VI → iv'], [2, 'VI → III']],
    6: [[0, 'VII → i'], [2, 'VII → III'], [5, 'VII → VI']],
  };
  if (d >= 0) for (const [nd, why] of (key.minor ? min : maj)[d] || []) add(D(nd), why);
  // couleurs du style
  if (style === 'blues') { add(name(key.pc + 5, '7', key), 'blues : IV7'); add(name(key.pc + 7, '7', key), 'blues : V7 (turnaround)'); add(name(key.pc, '7', key), 'blues : retour au I7'); }
  if (st.borrow || style === 'pop') {
    if (!key.minor) { add(name(key.pc + 10, '', key), 'bVII emprunté : son rock'); add(name(key.pc + 8, '', key), 'bVI emprunté : épique'); add(name(key.pc + 5, 'm', key), 'iv mineur emprunté : nostalgique'); }
  }
  if (st.jazz) {
    // ii-V vers n'importe quel accord diatonique
    const tgt = degOf(p, key) >= 0 ? mod(p.root + 5) : key.pc;
    add(name(tgt + 7, '7', key), 'dominante secondaire');
  }
  if (d < 0 && !isDom(p)) { add(D(0), 'retour à la tonique'); add(D(4), 'vers la dominante'); }
  return out.slice(0, 9);
}

/** Accords de passage entre a et b (à jouer sur la 2e moitié de la mesure de a). [{ names:[…], why }] */
export function transitions(a, b, key, style) {
  const st = STYLES[style] || STYLES.pop;
  const A = parseChord(a), B = parseChord(b);
  if (!A || !B) return [];
  const out = [];
  const add = (names, why) => { const k = names.join(' '); if (!out.some((x) => x.names.join(' ') === k) && !names.includes(a) && !names.includes(b)) out.push({ names, why }); };
  add([name(B.root + 7, '7', key)], `dominante de ${b} : il « tire » vers lui`);
  if (st.jazz || style === 'pop' || style === 'chanson' || style === 'funk') add([name(B.root + 2, isMin(B) ? 'm7b5' : 'm7', key), name(B.root + 7, isMin(B) ? '7b9' : '7', key)], `ii–V vers ${b}`);
  if (st.jazz || style === 'blues' || style === 'funk') add([name(B.root + 1, '7', key)], 'substitution tritonique : approche chromatique par le haut');
  add([SHARP[mod(B.root - 1)] + 'dim7'], 'diminué de passage : monte d’un demi-ton vers l’accord suivant');
  add([name(B.root, 'sus4', key)], `${name(B.root, 'sus4', key)} → ${b} : suspension qui se résout`);
  // basse qui marche : A/x où x est entre la basse de A et la fondamentale de B
  const bassA = A.bass ?? A.root, dist = mod(B.root - bassA);
  if (dist === 9) add([name(A.root, A.suffix, key, bassA - 1)], 'la basse descend vers l’accord suivant');
  if (dist === 10) add([name(A.root, A.suffix, key, bassA - 1)], 'la basse descend d’un demi-ton');
  if (dist >= 2 && dist <= 4) add([name(A.root, A.suffix, key, bassA + (dist === 2 ? 1 : 2))], 'la basse monte vers l’accord suivant');
  if (mod(A.root - key.pc) === 5 && mod(B.root - key.pc) === 0 && !key.minor) add([name(key.pc + 5, 'm', key)], 'IV → iv → I : nostalgique (emprunt mineur)');
  if (style === 'rock' || st.borrow) add([name(B.root - 2, '', key)], 'un ton en dessous : montée rock');
  add([name(B.root + 1, B.suffix, key)], 'même accord un demi-ton au-dessus : glissé chromatique');
  return out.slice(0, 8);
}

/** Variantes d'un accord : couleurs, renversements, substitutions. [{ name, why }] */
export function variations(c, key, style) {
  const st = STYLES[style] || STYLES.pop;
  const C = parseChord(c);
  if (!C) return [];
  const out = [];
  const add = (nm, why) => { if (nm && nm !== c && !out.some((x) => x.name === nm) && parseChord(nm)) out.push({ name: nm, why }); };
  const r = C.root;
  if (isDom(C)) {
    ['9', '13', '7sus4', '7b9', '7#9'].forEach((s) => add(name(r, s, key), s === '7sus4' ? 'suspendu : plus ouvert' : `couleur ${s}`));
    add(name(r + 6, '7', key), 'substitution tritonique');
    add(name(r + 7, 'm7', key) + '', 'ii de cette dominante (jouer ii–V)');
  } else if (isMin(C)) {
    ['m7', 'm9', 'm6', 'madd9', 'm11'].forEach((s) => add(name(r, s, key), `couleur ${s.slice(1) || 'mineure'}`));
    add(name(r + 3, '', key), 'relatif majeur (mêmes notes ou presque)');
    add(name(r - 4, 'maj7', key), 'accord à la tierce en dessous');
    add(name(r, '', key), 'version majeure : plus lumineuse');
  } else {
    ['maj7', 'add9', '6', 'sus2', 'sus4', '7'].forEach((s) => add(name(r, s, key), { maj7: 'doux, jazzy', add9: 'ouvert, moderne', 6: 'rétro, chaleureux', sus2: 'aérien', sus4: 'suspendu', 7: 'bluesy, appelle la suite' }[s]));
    add(name(r + 9, 'm', key), 'relatif mineur : plus mélancolique');
    add(name(r + 4, 'm', key), 'accord à la tierce au-dessus');
    if (st.borrow || style === 'rock') add(name(r, '5', key), 'power chord : brut');
  }
  // renversements
  const pcs = C.intervals.map((i) => mod(r + i));
  if (pcs[1] != null) add(name(r, C.suffix, key, pcs[1]), 'renversement : tierce à la basse (plus doux)');
  if (pcs[2] != null) add(name(r, C.suffix, key, pcs[2]), 'renversement : quinte à la basse');
  // couleurs du style en tête
  const pref = st.color.map((s) => name(r, isMin(C) && !s.startsWith('m') && !['5', 'sus2', 'sus4'].includes(s) ? 'm' + (s === 'maj7' ? '7' : s) : s, key));
  out.sort((x, y) => (pref.includes(y.name) ? 1 : 0) - (pref.includes(x.name) ? 1 : 0));
  return out.slice(0, 12);
}

// ─────────────────────────────────────────────────── doigtés enchaînés ──
const center = (v) => { const f = v.frets.filter((x) => x > 0); return f.length ? f.reduce((a, b) => a + b, 0) / f.length : 1.5; };
const moveCost = (a, b) => {
  if (!a || !b) return 0;
  let s = 0, n = 0;
  for (let i = 0; i < Math.min(a.frets.length, b.frets.length); i++) {
    const x = a.frets[i], y = b.frets[i];
    if (x > 0 && y > 0) { s += Math.abs(x - y); n++; } else if ((x > 0) !== (y > 0)) s += 0.8;
  }
  return Math.abs(center(a) - center(b)) * 1.4 + s / Math.max(1, n) + (n ? 0 : 1);
};
const ZONES = { low: 1.5, mid: 6, high: 10 };

/**
 * Choisit un doigté pour chaque accord de la suite en limitant les déplacements de la main
 * (programmation dynamique). locked : { index → numéro de doigté imposé }. zone : 'low' | 'mid' | 'high' | null.
 * Renvoie les numéros de doigté.
 */
export function chainVoicings(names, instrument = 'guitar', { locked = {}, zone = null } = {}) {
  if (instrument === 'piano') return names.map(() => 0);
  const V = names.map((n) => voicings(n, instrument));
  const n = names.length;
  if (!n) return [];
  const zc = zone ? ZONES[zone] : null;
  const own = (i, k) => (locked[i] != null && locked[i] !== k ? 1e6 : 0) + k * 0.35 + (zc != null ? Math.abs(center(V[i][k]) - zc) * 0.9 : 0);
  const cost = [], from = [];
  for (let i = 0; i < n; i++) {
    cost.push([]); from.push([]);
    const m = Math.max(1, V[i].length);
    for (let k = 0; k < m; k++) {
      if (i === 0 || !V[i].length) { cost[i][k] = (i ? Math.min(...cost[i - 1]) : 0) + (V[i].length ? own(i, k) : 0); from[i][k] = i ? cost[i - 1].indexOf(Math.min(...cost[i - 1])) : -1; continue; }
      let best = Infinity, bi = 0;
      const pm = Math.max(1, V[i - 1].length);
      for (let j = 0; j < pm; j++) {
        const c = cost[i - 1][j] + (V[i - 1].length ? moveCost(V[i - 1][j], V[i][k]) : 0);
        if (c < best) { best = c; bi = j; }
      }
      cost[i][k] = best + own(i, k); from[i][k] = bi;
    }
  }
  const res = new Array(n);
  let k = cost[n - 1].indexOf(Math.min(...cost[n - 1]));
  for (let i = n - 1; i >= 0; i--) { res[i] = k; k = from[i][k]; }
  return res.map((x) => x ?? 0);
}

/** Doigtés d'un accord classés selon la proximité avec ses voisins. [{ index, cost, pos }] */
export function voicingOptions(nm, prevV, nextV, instrument = 'guitar') {
  const list = voicings(nm, instrument);
  return list.map((v, index) => {
    const fr = v.frets.filter((f) => f > 0);
    const pos = fr.length ? Math.min(...fr) : 0;
    return { index, pos, cost: moveCost(prevV, v) + moveCost(v, nextV) + index * 0.2 };
  }).sort((a, b) => a.cost - b.cost);
}

export function voicingOf(nm, idx, instrument = 'guitar') { return voicings(nm, instrument)[idx || 0] || null; }

// ──────────────────────────────────────────────────────────────── son ──
const OPEN = { guitar: [40, 45, 50, 55, 59, 64], ukulele: [67, 60, 64, 69] };
let ctx = null, master = null, noiseBuf = null;

function audio() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain(); master.gain.value = 0.8;
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 4;
    master.connect(comp).connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

/** Notes MIDI d'un accord pour l'instrument (doigté choisi pour la guitare). */
export function chordMidi(nm, instrument = 'guitar', vIdx = 0) {
  const ch = parseChord(nm);
  if (!ch) return [];
  if (instrument === 'guitar' || instrument === 'ukulele') {
    const v = voicings(nm, instrument)[vIdx || 0];
    if (v) return v.frets.map((f, i) => (f >= 0 ? OPEN[instrument][i] + f : null)).filter((x) => x != null);
  }
  // piano : basse + accord serré autour du do central
  const root = 48 + ch.root, out = [36 + (ch.bass ?? ch.root)];
  for (const iv of ch.intervals) { let m = root + iv; while (m > 67) m -= 12; while (m < 55) m += 12; if (!out.includes(m)) out.push(m); }
  return out.sort((a, b) => a - b);
}

const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);

function pluck(t, midi, { dur = 1.6, vel = 0.5, tone = 'guitar', out = master }) {
  const c = audio();
  const g = c.createGain(), f = c.createBiquadFilter();
  f.type = 'lowpass';
  const o1 = c.createOscillator(), o2 = c.createOscillator();
  if (tone === 'piano') {
    o1.type = 'triangle'; o2.type = 'sine'; o2.frequency.value = hz(midi) * 2;
    f.frequency.setValueAtTime(hz(midi) * 8, t); f.frequency.exponentialRampToValueAtTime(Math.max(300, hz(midi) * 2), t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vel * 0.5, t + 0.006); g.gain.exponentialRampToValueAtTime(vel * 0.18, t + 0.35); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  } else if (tone === 'bass') {
    o1.type = 'sine'; o2.type = 'triangle'; o2.frequency.value = hz(midi);
    f.frequency.value = 700;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vel * 0.9, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  } else {
    o1.type = 'sawtooth'; o2.type = 'triangle'; o2.frequency.value = hz(midi); o2.detune.value = 6;
    f.Q.value = 1.2;
    f.frequency.setValueAtTime(Math.min(9000, hz(midi) * 12), t); f.frequency.exponentialRampToValueAtTime(Math.max(250, hz(midi) * 1.5), t + Math.min(dur, 0.9));
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vel * 0.32, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  }
  o1.frequency.value = hz(midi);
  o1.connect(f); o2.connect(f); f.connect(g).connect(out);
  o1.start(t); o2.start(t); o1.stop(t + dur + 0.05); o2.stop(t + dur + 0.05);
}

function drum(t, kind, vel = 0.6) {
  const c = audio();
  if (kind === 'kick') {
    const o = c.createOscillator(), g = c.createGain();
    o.frequency.setValueAtTime(120, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    g.gain.setValueAtTime(vel, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    o.connect(g).connect(master); o.start(t); o.stop(t + 0.3);
    return;
  }
  const s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
  s.buffer = noiseBuf;
  f.type = kind === 'hat' ? 'highpass' : 'bandpass'; f.frequency.value = kind === 'hat' ? 7000 : 1800;
  const d = kind === 'hat' ? 0.04 : 0.16;
  g.gain.setValueAtTime(vel * (kind === 'hat' ? 0.25 : 0.5), t); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
  s.connect(f).connect(g).connect(master); s.start(t); s.stop(t + d + 0.02);
}

/** Joue un accord tout de suite (gratté). */
export function playChord(nm, instrument = 'guitar', vIdx = 0, { dur = 1.8 } = {}) {
  const c = audio(), notes = chordMidi(nm, instrument, vIdx), t = c.currentTime + 0.02;
  const tone = instrument === 'piano' ? 'piano' : 'guitar';
  notes.forEach((m, i) => pluck(t + (tone === 'piano' ? 0 : i * 0.018), m, { dur, vel: 0.55, tone }));
}

// rythmes : [temps dans la mesure (en noires), type] — d = coup vers le bas, u = vers le haut, b = basse, a = arpège
const RHYTHMS = {
  pop: [[0, 'b'], [0, 'd'], [1, 'd'], [1.5, 'u'], [2.5, 'u'], [3, 'd'], [3.5, 'u']],
  folk: [[0, 'b'], [0.5, 'd'], [1, 'd'], [1.5, 'u'], [2, 'b5'], [2.5, 'u'], [3, 'd'], [3.5, 'u']],
  rock: [[0, 'b'], [0, 'p'], [0.5, 'p'], [1, 'p'], [1.5, 'p'], [2, 'p'], [2.5, 'p'], [3, 'p'], [3.5, 'p']],
  shuffle: [[0, 'b'], [0, 'p'], [0.67, 'p'], [1, 'p'], [1.67, 'p'], [2, 'b5'], [2, 'p'], [2.67, 'p'], [3, 'p'], [3.67, 'p']],
  jazz: [[0, 'b'], [1, 'b5'], [2, 'b'], [3, 'b5'], [0, 's'], [1.67, 's'], [3, 's']],
  bossa: [[0, 'b'], [1.5, 'b5'], [2, 'b'], [3.5, 'b5'], [0, 's'], [0.75, 's'], [1.5, 's'], [2.5, 's'], [3.25, 's']],
  funk: [[0, 'b'], [0, 's'], [0.75, 's'], [1.5, 's'], [2.25, 's'], [2.5, 'b5'], [3, 's'], [3.5, 's']],
  arpeggio: [[0, 'b'], [0, 'a0'], [0.5, 'a1'], [1, 'a2'], [1.5, 'a3'], [2, 'a4'], [2.5, 'a3'], [3, 'a2'], [3.5, 'a1']],
  reggae: [[0, 'b'], [0.5, 's'], [1.5, 's'], [2, 'b5'], [2.5, 's'], [3.5, 's']],
};
const DRUMS = {
  straight: [[0, 'kick'], [1, 'snare'], [2, 'kick'], [3, 'snare'], ...[0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map((x) => [x, 'hat'])],
  swing: [[0, 'kick'], [1, 'snare'], [2, 'kick'], [3, 'snare'], ...[0, 0.67, 1, 1.67, 2, 2.67, 3, 3.67].map((x) => [x, 'hat'])],
  reggae: [[2, 'kick'], [2, 'snare'], ...[0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map((x) => [x, 'hat'])],
};

/**
 * Lecteur de grille : events = [{ bar, beat, dur, name, v }] (temps en noires), joue en boucle.
 * onPos(index d'événement) pour surligner la case jouée.
 */
export class GridPlayer {
  constructor() { this.on = false; }
  start(events, { bpm = 100, style = 'pop', instrument = 'guitar', drums = true, loop = true, from = 0, onPos } = {}) {
    this.stop();
    if (!events.length) return;
    const c = audio();
    this.on = true;
    const st = STYLES[style] || STYLES.pop, spb = 60 / bpm;
    const rh = RHYTHMS[st.rhythm] || RHYTHMS.pop;
    const dr = style === 'reggae' ? DRUMS.reggae : st.feel === 'swing' ? DRUMS.swing : DRUMS.straight;
    const totalBeats = Math.max(...events.map((e) => e.beat0 + e.dur));
    const tone = instrument === 'piano' ? 'piano' : 'guitar';
    let t0 = c.currentTime + 0.1 - (events[from]?.beat0 || 0) * spb, lastBeat = events[from]?.beat0 || 0;
    const sched = () => {
      if (!this.on) return;
      const horizon = c.currentTime + 0.25;
      while (t0 + lastBeat * spb < horizon) {
        // un « pas » de 1/12 de temps pour couvrir binaire, ternaire et doubles-croches
        const b0 = lastBeat, b1 = lastBeat + 0.25;
        for (const ev of events) {
          if (ev.beat0 + ev.dur <= b0 || ev.beat0 >= b1 + 1e-6) continue;
          const notes = chordMidi(ev.name, instrument, ev.v);
          const ch = parseChord(ev.name);
          for (const [pos, kind] of rh) {
            // position du coup dans la mesure de l'événement
            const barStart = ev.barBeat0;
            const at = barStart + pos;
            if (at < ev.beat0 - 1e-6 || at >= ev.beat0 + ev.dur - 1e-6 || at < b0 - 1e-6 || at >= b1 - 1e-6) continue;
            const t = t0 + at * spb;
            if (kind === 'b' || kind === 'b5') { const r = (ch?.bass ?? ch?.root ?? 0) + (kind === 'b5' ? 7 : 0); pluck(t, 36 + (r % 12) + (r % 12 > 7 ? -12 : 0) + 12, { dur: spb * 1.2, vel: 0.5, tone: 'bass' }); continue; }
            if (kind[0] === 'a') { const k = +kind.slice(1); const nn = notes.slice(-5); const m = nn[Math.min(k, nn.length - 1)]; if (m) pluck(t, m, { dur: spb * 2.2, vel: 0.45, tone }); continue; }
            const short = kind === 's' || kind === 'p';
            const seq = kind === 'u' ? [...notes].reverse().slice(0, 4) : notes;
            seq.forEach((m, i) => pluck(t + (tone === 'piano' ? 0 : i * (kind === 'u' ? 0.01 : 0.014)), m, { dur: short ? spb * (kind === 'p' ? 0.35 : 0.5) : spb * 1.4, vel: kind === 'u' ? 0.3 : kind === 'p' ? 0.38 : 0.45, tone }));
          }
          if (drums) for (const [pos, kind] of dr) {
            const at = ev.barBeat0 + pos;
            if (ev.firstOfBar && at >= b0 - 1e-6 && at < b1 - 1e-6 && at < ev.barBeat0 + 4) drum(t0 + at * spb, kind, kind === 'hat' ? 0.4 : 0.6);
          }
        }
        const cur = events.findIndex((e) => b0 >= e.beat0 - 1e-6 && b0 < e.beat0 + e.dur - 1e-6);
        if (cur >= 0 && Math.abs(b0 - events[cur].beat0) < 1e-6) { const at = t0 + b0 * spb; const delay = Math.max(0, (at - c.currentTime) * 1000); setTimeout(() => this.on && onPos?.(cur), delay); }
        lastBeat = b1;
        if (lastBeat >= totalBeats - 1e-6) {
          if (!loop) { setTimeout(() => this.stop(), (t0 + totalBeats * spb - c.currentTime) * 1000 + 200); this.on = 'ending'; return; }
          t0 += totalBeats * spb; lastBeat = 0;
        }
      }
      this.timer = setTimeout(sched, 40);
    };
    sched();
    this.onStop = () => onPos?.(-1);
  }
  stop() { this.on = false; clearTimeout(this.timer); this.onStop?.(); this.onStop = null; }
}
