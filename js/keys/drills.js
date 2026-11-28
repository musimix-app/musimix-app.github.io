// MusiMix Piano — formation musicale : lecture, rythme, oreille, théorie.
// Exercices générés à l'infini (10 questions par série), 5 niveaux, réponses à l'écran,
// au clavier de l'ordinateur ou au clavier MIDI. Portée dessinée en SVG (police Noto Music).

// ───────────────────────────────────────────────────────── solfège de base ──

export const FR = ['Do', 'Ré', 'Mi', 'Fa', 'Sol', 'La', 'Si'];
const LET = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const NAT = [0, 2, 4, 5, 7, 9, 11];
const ACC = { '-2': '𝄫', '-1': '♭', 0: '', 1: '♯', 2: '𝄪' };
const rnd = (n) => Math.floor(Math.random() * n);
const pick = (a) => a[rnd(a.length)];
const shuffle = (a) => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };

/** note écrite { l: 0..6, a: -2..2, o: octave } */
const midiOfW = (n) => 12 * (n.o + 1) + NAT[n.l] + n.a;
const dia = (n) => n.o * 7 + n.l;
const frName = (n, oct = false) => FR[n.l] + (ACC[n.a] || '') + (oct ? (n.o - 1) : '');
const fromDia = (d, a = 0) => ({ l: ((d % 7) + 7) % 7, o: Math.floor(d / 7), a });
/** hauteur MIDI → note écrite (dièses, ou bémols si flat) */
function spell(m, flat = false) {
  const pc = ((m % 12) + 12) % 12, o = Math.floor(m / 12) - 1;
  const i = NAT.indexOf(pc);
  if (i >= 0) return { l: i, a: 0, o };
  return flat ? { l: NAT.indexOf(pc + 1), a: -1, o } : { l: NAT.indexOf(pc - 1), a: 1, o };
}

// ─────────────────────────────────────────────────────────────── portée SVG ──

const CLEF = {
  treble: { ref: dia({ l: 2, o: 4 }), glyph: '𝄞', gy: 6, size: 3.9 },     // ligne du bas = Mi4
  bass: { ref: dia({ l: 4, o: 2 }), glyph: '𝄢', gy: 2, size: 3.3 },       // Sol2
  alto: { ref: dia({ l: 3, o: 3 }), glyph: '𝄡', gy: 4, size: 3.6 },       // Fa3
  tenor: { ref: dia({ l: 1, o: 3 }), glyph: '𝄡', gy: 6, size: 3.6 },      // Ré3
};
const SHARPS = { treble: [38, 35, 39, 36, 33, 37, 34], bass: [24, 21, 25, 22, 19, 23, 20] };
const FLATS = { treble: [34, 37, 33, 36, 32, 35, 31], bass: [20, 23, 19, 22, 18, 21, 17] };

/**
 * Portée : staves = [{ clef, notes: [{ n, x? }] }] (une ou deux portées, accolade si deux)
 * opts : { key (nb d'altérations, >0 dièses, <0 bémols), chord (notes empilées), width, mark: index de note en couleur }
 */
export function staffSVG(staves, { key = 0, chord = false, width = 340, color = 'currentColor' } = {}) {
  const gap = 11, top = 46, staffH = gap * 4, between = 70;
  const H = top + staves.length * staffH + (staves.length - 1) * between + 46;
  const x0 = 14, W = width;
  let s = `<svg class="staff" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Portée" xmlns="http://www.w3.org/2000/svg">`;
  staves.forEach((st, k) => {
    const C = CLEF[st.clef];
    const bottom = top + k * (staffH + between) + staffH;
    const yOf = (d) => bottom - (d - C.ref) * (gap / 2);
    for (let i = 0; i < 5; i++) s += `<line x1="${x0}" x2="${W - 10}" y1="${bottom - i * gap}" y2="${bottom - i * gap}" stroke="${color}" stroke-opacity=".55" stroke-width="1.2"/>`;
    s += `<text x="${x0 + 4}" y="${bottom - C.gy * (gap / 2) + (st.clef === 'treble' ? 1 : 0)}" font-family="'Noto Music'" font-size="${gap * C.size}" fill="${color}" dominant-baseline="alphabetic">${C.glyph}</text>`;
    // armure
    let kx = x0 + 44;
    const kind = key > 0 ? SHARPS : FLATS;
    const list = kind[st.clef === 'bass' ? 'bass' : 'treble'];
    for (let i = 0; i < Math.abs(key); i++) {
      const d = list[i];
      s += `<text x="${kx}" y="${yOf(d) + gap * 0.42}" font-size="${gap * 2.1}" fill="${color}" font-family="'Noto Music', serif">${key > 0 ? '♯' : '♭'}</text>`;
      kx += gap * 0.95;
    }
    const startX = Math.max(kx + 18, x0 + 70);
    const notes = st.notes || [];
    const span = W - startX - 30;
    notes.forEach((nn, i) => {
      const n = nn.n;
      const d = dia(n);
      const x = nn.x ?? (chord ? startX + span / 2 : startX + (notes.length === 1 ? span / 2 : (i * span) / Math.max(1, notes.length - 1)));
      const y = yOf(d);
      const col = nn.color || color;
      // lignes supplémentaires (au-dessous : ref-2, ref-4… ; au-dessus : ref+10, ref+12…)
      for (let ld = C.ref - 2; ld >= d; ld -= 2) s += `<line x1="${x - 13}" x2="${x + 13}" y1="${yOf(ld)}" y2="${yOf(ld)}" stroke="${color}" stroke-opacity=".7" stroke-width="1.3"/>`;
      for (let ld = C.ref + 10; ld <= d; ld += 2) s += `<line x1="${x - 13}" x2="${x + 13}" y1="${yOf(ld)}" y2="${yOf(ld)}" stroke="${color}" stroke-opacity=".7" stroke-width="1.3"/>`;
      if (n.a && !nn.hideAcc) s += `<text x="${x - 24}" y="${y + gap * 0.45}" font-size="${gap * 2}" fill="${col}" font-family="'Noto Music', serif">${ACC[n.a]}</text>`;
      const whole = nn.whole ?? true;
      s += `<ellipse cx="${x}" cy="${y}" rx="${gap * 0.68}" ry="${gap * 0.47}" transform="rotate(-18 ${x} ${y})" fill="${whole ? 'none' : col}" stroke="${col}" stroke-width="${whole ? 2.4 : 1}"/>`;
      if (nn.glow) s += `<ellipse cx="${x}" cy="${y}" rx="${gap * 1.2}" ry="${gap * 0.95}" fill="${col}" opacity=".18"/>`;
    });
  });
  if (staves.length === 2) {
    const y1 = top, y2 = top + 2 * staffH + between;
    const h = y2 - y1, bx = x0 - 3;
    s += `<path d="M${bx} ${y1} C ${bx - 9} ${y1 + h * 0.08} ${bx + 1} ${y1 + h * 0.4} ${bx - 8} ${y1 + h / 2} C ${bx + 1} ${y1 + h * 0.6} ${bx - 9} ${y1 + h * 0.92} ${bx} ${y2}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round"/><line x1="${x0}" x2="${x0}" y1="${y1}" y2="${y2}" stroke="${color}" stroke-width="1.4"/>`;
  }
  return s + '</svg>';
}

/** Rythme sur une ligne : events = [{ d: durée en noires, rest?: bool, dot? }] */
export function rhythmSVG(events, { width = 620, beats = 4, color = 'currentColor', active = -1 } = {}) {
  const H = 120, y = 70, x0 = 30, W = width;
  const total = events.reduce((a, e) => a + e.d, 0);
  const nb = Math.ceil(total / beats - 1e-6), barGap = 34;
  const scale = (W - x0 - 30 - (nb - 1) * barGap) / total;
  const X = (t) => x0 + t * scale + Math.floor(t / beats + 1e-6) * barGap;
  let s = `<svg class="rhythm" viewBox="0 0 ${W} ${H}" width="100%" xmlns="http://www.w3.org/2000/svg">`;
  s += `<line x1="10" x2="${W - 10}" y1="${y}" y2="${y}" stroke="${color}" stroke-opacity=".4"/>`;
  let t = 0;
  const xs = [];
  events.forEach((e) => { xs.push(X(t)); t += e.d; });
  // barres de mesure, au milieu de l'espace entre deux mesures
  for (let b = beats; b < total - 1e-6; b += beats) { const bx = X(b) - barGap / 2 - 2; s += `<line x1="${bx}" x2="${bx}" y1="${y - 22}" y2="${y + 22}" stroke="${color}" stroke-opacity=".55" stroke-width="1.6"/>`; }
  // croches groupées par temps (ligature)
  const beamed = new Set();
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.rest || e.d >= 1) continue;
    const startBeat = Math.floor(sumTo(events, i) + 1e-6);
    const group = [i];
    let j = i + 1;
    while (j < events.length && !events[j].rest && events[j].d < 1 && Math.floor(sumTo(events, j) + 1e-6) === startBeat) group.push(j++);
    if (group.length > 1) {
      group.forEach((g) => beamed.add(g));
      const xa = xs[group[0]] + 7, xb = xs[group[group.length - 1]] + 7;
      s += `<rect x="${xa}" y="${y - 38}" width="${xb - xa + 1.5}" height="5" fill="${color}"/>`;
      // doubles croches : seconde ligature
      for (let k = 0; k < group.length - 1; k++) if (events[group[k]].d <= 0.25 && events[group[k + 1]].d <= 0.25) s += `<rect x="${xs[group[k]] + 7}" y="${y - 30}" width="${xs[group[k + 1]] - xs[group[k]] + 1.5}" height="5" fill="${color}"/>`;
      if (events[group[0]].trip) s += `<text x="${(xa + xb) / 2}" y="${y - 46}" text-anchor="middle" font-size="13" font-weight="700" fill="${color}">3</text>`;
      i = j - 1;
    }
  }
  events.forEach((e, i) => {
    const x = xs[i];
    const col = i === active ? '#ffb52e' : color;
    if (e.rest) {
      const g = e.d >= 4 ? '𝄻' : e.d >= 2 ? '𝄼' : e.d >= 1 ? '𝄽' : e.d >= 0.5 ? '𝄾' : '𝄿';
      s += `<text x="${x}" y="${y + 9}" font-size="34" font-family="'Noto Music'" fill="${col}">${g}</text>`;
      return;
    }
    const open = e.d >= 2;
    s += `<ellipse cx="${x}" cy="${y}" rx="8" ry="5.6" transform="rotate(-18 ${x} ${y})" fill="${open ? 'none' : col}" stroke="${col}" stroke-width="${open ? 2.2 : 1}"/>`;
    if (e.d < 4) s += `<line x1="${x + 7.2}" x2="${x + 7.2}" y1="${y - 2}" y2="${y - 38}" stroke="${col}" stroke-width="1.6"/>`;
    if (e.d < 1 && !beamed.has(i)) s += `<path d="M${x + 7.2} ${y - 38} q 10 8 8 22" fill="none" stroke="${col}" stroke-width="2.4"/>`;
    if (e.dot) s += `<circle cx="${x + 14}" cy="${y + 1}" r="2.4" fill="${col}"/>`;
  });
  return s + '</svg>';
}
function sumTo(ev, i) { let t = 0; for (let k = 0; k < i; k++) t += ev[k].d; return t; }

// ──────────────────────────────────────────────────────── théorie musicale ──

const INT_NAMES = {
  '1:0': 'unisson', '2:1': 'seconde mineure', '2:2': 'seconde majeure', '2:3': 'seconde augmentée',
  '3:2': 'tierce diminuée', '3:3': 'tierce mineure', '3:4': 'tierce majeure', '4:4': 'quarte diminuée', '4:5': 'quarte juste', '4:6': 'quarte augmentée',
  '5:6': 'quinte diminuée', '5:7': 'quinte juste', '5:8': 'quinte augmentée', '6:8': 'sixte mineure', '6:9': 'sixte majeure', '6:10': 'sixte augmentée',
  '7:9': 'septième diminuée', '7:10': 'septième mineure', '7:11': 'septième majeure', '8:12': 'octave juste',
};
function intervalName(a, b) {
  const n = dia(b) - dia(a) + 1, st = midiOfW(b) - midiOfW(a);
  return INT_NAMES[`${n}:${st}`] || null;
}
const EAR_INTS = [
  [1, 'seconde mineure'], [2, 'seconde majeure'], [3, 'tierce mineure'], [4, 'tierce majeure'], [5, 'quarte juste'], [6, 'triton'],
  [7, 'quinte juste'], [8, 'sixte mineure'], [9, 'sixte majeure'], [10, 'septième mineure'], [11, 'septième majeure'], [12, 'octave'],
];
const CHORDS = {
  maj: [[0, 4, 7], 'majeur'], min: [[0, 3, 7], 'mineur'], dim: [[0, 3, 6], 'diminué'], aug: [[0, 4, 8], 'augmenté'],
  maj7: [[0, 4, 7, 11], 'majeur 7 (maj7)'], dom7: [[0, 4, 7, 10], 'septième de dominante (7)'], min7: [[0, 3, 7, 10], 'mineur 7 (m7)'],
  hdim: [[0, 3, 6, 10], 'demi-diminué (m7♭5)'], dim7: [[0, 3, 6, 9], 'septième diminuée (dim7)'], sus4: [[0, 5, 7], 'sus4'],
};
const SCALES = {
  major: [[0, 2, 4, 5, 7, 9, 11, 12], 'majeure'], natmin: [[0, 2, 3, 5, 7, 8, 10, 12], 'mineure naturelle'],
  harmin: [[0, 2, 3, 5, 7, 8, 11, 12], 'mineure harmonique'], melmin: [[0, 2, 3, 5, 7, 9, 11, 12], 'mineure mélodique'],
};
const MODES = [['ionien', [0, 2, 4, 5, 7, 9, 11, 12]], ['dorien', [0, 2, 3, 5, 7, 9, 10, 12]], ['phrygien', [0, 1, 3, 5, 7, 8, 10, 12]], ['lydien', [0, 2, 4, 6, 7, 9, 11, 12]], ['mixolydien', [0, 2, 4, 5, 7, 9, 10, 12]], ['éolien', [0, 2, 3, 5, 7, 8, 10, 12]], ['locrien', [0, 1, 3, 5, 6, 8, 10, 12]]];
const MAJOR_KEYS = { 0: ['Do majeur', 'La mineur'], 1: ['Sol majeur', 'Mi mineur'], 2: ['Ré majeur', 'Si mineur'], 3: ['La majeur', 'Fa♯ mineur'], 4: ['Mi majeur', 'Do♯ mineur'], 5: ['Si majeur', 'Sol♯ mineur'], 6: ['Fa♯ majeur', 'Ré♯ mineur'], 7: ['Do♯ majeur', 'La♯ mineur'], '-1': ['Fa majeur', 'Ré mineur'], '-2': ['Si♭ majeur', 'Sol mineur'], '-3': ['Mi♭ majeur', 'Do mineur'], '-4': ['La♭ majeur', 'Fa mineur'], '-5': ['Ré♭ majeur', 'Si♭ mineur'], '-6': ['Sol♭ majeur', 'Mi♭ mineur'], '-7': ['Do♭ majeur', 'La♭ mineur'] };
const KEY_TONIC = { 0: { l: 0, a: 0 }, 1: { l: 4, a: 0 }, 2: { l: 1, a: 0 }, 3: { l: 5, a: 0 }, 4: { l: 2, a: 0 }, 5: { l: 6, a: 0 }, 6: { l: 3, a: 1 }, 7: { l: 0, a: 1 }, '-1': { l: 3, a: 0 }, '-2': { l: 6, a: -1 }, '-3': { l: 2, a: -1 }, '-4': { l: 5, a: -1 }, '-5': { l: 1, a: -1 }, '-6': { l: 4, a: -1 }, '-7': { l: 0, a: -1 } };

/** Gamme majeure écrite (avec la bonne orthographe) à partir d'une tonique écrite. */
function majorScale(t) {
  const out = [];
  const st = [0, 2, 4, 5, 7, 9, 11];
  const base = midiOfW({ ...t, o: 4 });
  for (let i = 0; i < 7; i++) {
    const n = fromDia(dia({ ...t, o: 4 }) + i);
    n.a = base + st[i] - midiOfW({ ...n, a: 0 });
    out.push(n);
  }
  return out;
}

// ─────────────────────────────────────────────────────────── les exercices ──

export const DRILL_LEVELS = ['Éveil', 'Débutant', 'Intermédiaire', 'Avancé', 'Professionnel'];
export const CATS = { read: 'Lecture de notes', rhythm: 'Rythme', ear: 'Oreille', theory: 'Théorie' };

const noteBtns = (acc = false) => (acc
  ? FR.flatMap((f) => [f + '♭', f, f + '♯']).map((x) => ({ label: x, value: x }))
  : FR.map((f) => ({ label: f, value: f })));

function readQ(clefs, lo, hi, { acc = false, octaveCheck = false } = {}) {
  return () => {
    const clef = pick(clefs);
    let n;
    do { n = spell(lo + rnd(hi - lo + 1), Math.random() < 0.5); } while (!acc && n.a);
    if (!acc) n.a = 0;
    const staves = clef === 'grand' ? [{ clef: 'treble', notes: midiOfW(n) >= 60 ? [{ n }] : [] }, { clef: 'bass', notes: midiOfW(n) < 60 ? [{ n }] : [] }] : [{ clef, notes: [{ n }] }];
    const label = frName(n);
    return {
      prompt: 'Quelle est cette note ?', svg: staffSVG(staves), answers: noteBtns(acc), correct: label,
      midi: (notes) => notes.some((m) => (octaveCheck ? m === midiOfW(n) : ((m - midiOfW(n)) % 12 + 12) % 12 === 0)),
      play: [midiOfW(n)], explain: `${frName(n, true)} (en anglais : ${LET[n.l]}${n.a > 0 ? '♯' : n.a < 0 ? '♭' : ''}${n.o}).`, keyboard: true,
    };
  };
}

function earIntervalQ(set, { harmonic = false, desc = false } = {}) {
  return () => {
    const [st, name] = pick(EAR_INTS.filter(([s]) => set.includes(s)));
    const root = 55 + rnd(12);
    const down = desc && Math.random() < 0.5;
    const notes = down ? [root + st, root] : [root, root + st];
    return {
      prompt: harmonic ? 'Quel intervalle (notes ensemble) ?' : `Quel intervalle${down ? ' (descendant)' : ''} ?`, audio: harmonic ? [notes] : notes.map((m) => [m]),
      answers: EAR_INTS.filter(([s]) => set.includes(s)).map(([, n]) => ({ label: n, value: n })), correct: name, explain: `${name} : ${st} demi-ton${st > 1 ? 's' : ''}.`,
    };
  };
}

function earChordQ(keys, { inv = false } = {}) {
  return () => {
    const k = pick(keys);
    const [iv, name] = CHORDS[k];
    const root = 52 + rnd(10);
    let notes = iv.map((i) => root + i);
    let label = name;
    if (inv) {
      const r = rnd(3);
      for (let i = 0; i < r; i++) { const x = notes.shift(); notes.push(x + 12); }
      label = ['état fondamental', '1er renversement', '2e renversement'][r];
      return { prompt: 'Quel renversement ? (note la plus grave)', audio: [notes, ...notes.map((m) => [m]), notes], answers: ['état fondamental', '1er renversement', '2e renversement'].map((x) => ({ label: x, value: x })), correct: label, explain: `Basse : ${['la fondamentale', 'la tierce', 'la quinte'][r]}.` };
    }
    return { prompt: 'Quel type d’accord ?', audio: [notes, ...notes.map((m) => [m]), notes], answers: keys.map((x) => ({ label: CHORDS[x][1], value: CHORDS[x][1] })), correct: label, explain: `${label} : ${iv.join('-')} demi-tons au-dessus de la fondamentale.` };
  };
}

function earScaleQ(list) {
  return () => {
    const [name, iv] = pick(list);
    const root = 57 + rnd(5);
    return { prompt: 'Quelle gamme ?', audio: iv.map((i) => [root + i]), fast: true, answers: list.map(([n]) => ({ label: n, value: n })), correct: name, explain: `Gamme ${name}.` };
  };
}

function dictationQ(len, pool) {
  return () => {
    const notes = [60];
    for (let i = 1; i < len; i++) notes.push(pick(pool));
    return {
      prompt: `Rejoue ces ${len} notes (la première est le Do du milieu)`, audio: notes.map((m) => [m]), dictation: notes,
      answers: [], correct: null, explain: `C’était : ${notes.map((m) => frName(spell(m))).join(' – ')}.`,
    };
  };
}

function pitchMatchQ(lo, hi) {
  return () => { const m = lo + rnd(hi - lo + 1); return { prompt: 'Rejoue la note entendue', audio: [[m]], dictation: [m], answers: [], correct: null, explain: `C’était ${frName(spell(m), true)}.` }; };
}

function cadenceQ() {
  const C = [60, 64, 67], F = [60, 65, 69], G = [59, 62, 67], G7 = [59, 62, 65, 67], Am = [57, 60, 64], Dm = [57, 62, 65];
  const list = [['cadence parfaite (V → I)', [C, F, G7, C]], ['cadence plagale (IV → I)', [C, Am, F, C]], ['demi-cadence (→ V)', [C, F, Dm, G]], ['cadence rompue (V → VI)', [C, F, G7, Am]]];
  return () => { const [name, seq] = pick(list); return { prompt: 'Quelle cadence ?', audio: seq, slow: true, answers: list.map(([n]) => ({ label: n, value: n })), correct: name, explain: `${name}.` }; };
}

function intervalWrittenQ(hard) {
  return () => {
    let a, b, name;
    do {
      a = { l: rnd(7), a: hard ? pick([-1, 0, 0, 1]) : 0, o: 4 };
      b = fromDia(dia(a) + 1 + rnd(7));
      const target = midiOfW(a) + pick([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].filter((s) => s >= dia(b) - dia(a)));
      b.a = target - midiOfW({ ...b, a: 0 });
      if (Math.abs(b.a) > 1 || (!hard && b.a && Math.random() < 0.5)) { name = null; continue; }
      name = intervalName(a, b);
    } while (!name || name === 'unisson');
    const same = shuffle(Object.values(INT_NAMES).filter((x) => x !== name && x !== 'unisson' && x.split(' ')[0] === name.split(' ')[0]));
    const others = shuffle(Object.values(INT_NAMES).filter((x) => x !== name && x !== 'unisson' && !same.includes(x)));
    const opts = shuffle([name, ...same.slice(0, 2), ...others].slice(0, 4));
    return { prompt: 'Quel est cet intervalle ?', svg: staffSVG([{ clef: 'treble', notes: [{ n: a, x: 150 }, { n: b, x: 230 }] }]), play: [midiOfW(a), midiOfW(b)], answers: opts.map((x) => ({ label: x, value: x })), correct: name, explain: `${frName(a)} → ${frName(b)} : ${dia(b) - dia(a) + 1} notes, ${midiOfW(b) - midiOfW(a)} demi-tons.` };
  };
}

function keySigQ(max, minor = false) {
  return () => {
    const k = rnd(2 * max + 1) - max;
    const [maj, mi] = MAJOR_KEYS[k];
    const want = minor && Math.random() < 0.5 ? 'min' : 'maj';
    const pool = Object.values(MAJOR_KEYS).filter((_, i) => Math.abs(+Object.keys(MAJOR_KEYS)[i]) <= max);
    const answers = shuffle([...new Set([want === 'maj' ? maj : mi, ...shuffle(pool.map((p) => p[want === 'maj' ? 0 : 1])).slice(0, 4)])]);
    return { prompt: want === 'maj' ? 'Quelle tonalité majeure a cette armure ?' : 'Quelle tonalité mineure a cette armure ?', svg: staffSVG([{ clef: 'treble', notes: [] }], { key: k, width: 300 }), answers: answers.map((x) => ({ label: x, value: x })), correct: want === 'maj' ? maj : mi, explain: `${Math.abs(k)} ${k >= 0 ? 'dièse' : 'bémol'}${Math.abs(k) > 1 ? 's' : ''} : ${maj}, relatif ${mi}.` };
  };
}

function scaleNotesQ(max) {
  return () => {
    const k = rnd(2 * max + 1) - max;
    const sc = majorScale(KEY_TONIC[k]);
    const i = 1 + rnd(6);
    const n = sc[i];
    const label = frName(n);
    const wrong = [frName({ ...n, a: n.a + 1 }), frName({ ...n, a: n.a - 1 })].filter((x) => !x.includes('undefined'));
    return { prompt: `Dans la gamme de ${MAJOR_KEYS[k][0]}, quel est le ${['', '2e', '3e', '4e', '5e', '6e', '7e'][i]} degré ?`, answers: shuffle([label, ...wrong, frName(sc[(i + 1) % 7])]).filter((v, j, s) => s.indexOf(v) === j).map((x) => ({ label: x, value: x })), correct: label, explain: `${MAJOR_KEYS[k][0]} : ${sc.map((x) => frName(x)).join(' ')}.` };
  };
}

function chordBuildQ(types) {
  return () => {
    const t = pick(types);
    const root = { l: rnd(7), a: 0, o: 4 };
    const [iv, name] = CHORDS[t];
    const notes = iv.map((st, i) => { const d = [0, 2, 4, 6][i]; const n = fromDia(dia(root) + d); n.a = midiOfW(root) + st - midiOfW({ ...n, a: 0 }); return n; });
    if (notes.some((n) => Math.abs(n.a) > 1)) return chordBuildQ(types)();
    const right = notes.map((n) => frName(n)).join(' – ');
    const alt = (k) => notes.map((n, i) => frName(i === k ? { ...n, a: n.a + (n.a > 0 ? -1 : 1) } : n)).join(' – ');
    const answers = shuffle([right, alt(1), alt(2), notes.length > 3 ? alt(3) : alt(0)]).filter((v, i, s) => s.indexOf(v) === i);
    return { prompt: `Quelles sont les notes de ${frName(root)} ${name} ?`, answers: answers.map((x) => ({ label: x, value: x })), correct: right, play: notes.map(midiOfW), chordPlay: true, midi: (ns) => { const pcs = new Set(ns.map((m) => m % 12)); return notes.every((n) => pcs.has(((midiOfW(n) % 12) + 12) % 12)) && pcs.size === notes.length; }, explain: `${frName(root)} ${name} = ${right}.` };
  };
}

function quiz(list) { return () => { const [q, a, wrong, ex] = pick(list); return { prompt: q, answers: shuffle([a, ...wrong]).map((x) => ({ label: x, value: x })), correct: a, explain: ex || '' }; }; }

const VALUES = [
  ['Combien de noires dans une ronde ?', '4', ['2', '3', '8'], 'Ronde = 4 temps = 4 noires.'],
  ['Combien de croches dans une blanche ?', '4', ['2', '6', '8'], 'Blanche = 2 noires = 4 croches.'],
  ['Une blanche pointée dure…', '3 temps', ['2 temps', '2 temps et demi', '4 temps'], 'Le point ajoute la moitié : 2 + 1 = 3.'],
  ['Combien de doubles croches dans une noire ?', '4', ['2', '3', '8'], ''],
  ['Une noire pointée vaut…', '3 croches', ['2 croches', '4 croches', '1 blanche'], ''],
  ['Le silence qui vaut une noire s’appelle…', 'un soupir', ['une pause', 'une demi-pause', 'un demi-soupir'], 'Pause = ronde, demi-pause = blanche, soupir = noire, demi-soupir = croche.'],
  ['Le silence qui vaut une ronde s’appelle…', 'une pause', ['un soupir', 'une demi-pause', 'un quart de soupir'], ''],
  ['Dans une mesure à 3/4, combien de noires ?', '3', ['4', '2', '6'], ''],
  ['Un triolet de croches dure…', '1 temps (noire)', ['1 temps et demi', '2 temps', 'un demi-temps'], 'Trois croches jouées dans le temps de deux.'],
  ['Une mesure à 6/8 contient…', '2 temps (noires pointées)', ['6 temps', '3 temps', '4 temps'], 'Mesure composée : 2 temps de 3 croches.'],
];
const NAMES_Q = FR.map((f, i) => [`${f} en notation anglaise ?`, LET[i], shuffle(LET.filter((x) => x !== LET[i])).slice(0, 3), `${f} = ${LET[i]}.`]);
const VOCAB = [
  ['« p » (piano) signifie…', 'doux', ['fort', 'lent', 'lié'], ''], ['« f » (forte) signifie…', 'fort', ['doux', 'vite', 'détaché'], ''],
  ['« mf » signifie…', 'moyennement fort', ['très fort', 'moyennement doux', 'en ralentissant'], ''], ['« crescendo » signifie…', 'de plus en plus fort', ['de plus en plus vite', 'de plus en plus doux', 'en retenant'], ''],
  ['« decrescendo » signifie…', 'de plus en plus doux', ['de plus en plus lent', 'de plus en plus fort', 'très lié'], ''], ['Largo, c’est…', 'très lent', ['modéré', 'rapide', 'très rapide'], 'Environ 40-60 à la noire.'],
  ['Andante, c’est…', 'allant (modéré)', ['très lent', 'très rapide', 'rapide'], 'Environ 76-108.'], ['Allegro, c’est…', 'rapide et joyeux', ['lent', 'modéré', 'très lent'], 'Environ 120-156.'],
  ['Presto, c’est…', 'très rapide', ['lent', 'modéré', 'allant'], ''], ['« Legato » signifie…', 'lié', ['détaché', 'accentué', 'fort'], ''],
  ['« Staccato » signifie…', 'détaché, piqué', ['lié', 'doux', 'tenu'], ''], ['« Ritardando » signifie…', 'en ralentissant', ['en accélérant', 'en jouant plus fort', 'au tempo'], ''],
  ['« A tempo » signifie…', 'revenir au tempo', ['accélérer', 'ralentir', 'jouer librement'], ''], ['Un point d’orgue (𝄐) indique…', 'de tenir la note librement', ['de jouer plus vite', 'de répéter', 'de jouer fort'], ''],
];
const DEGREES = [
  ['Le Ier degré s’appelle…', 'la tonique', ['la dominante', 'la sous-dominante', 'la sensible'], ''], ['Le Ve degré s’appelle…', 'la dominante', ['la tonique', 'la médiante', 'la sus-dominante'], ''],
  ['Le IVe degré s’appelle…', 'la sous-dominante', ['la dominante', 'la sensible', 'la sus-tonique'], ''], ['Le VIIe degré (à un demi-ton de la tonique) s’appelle…', 'la sensible', ['la dominante', 'la médiante', 'la sous-tonique'], ''],
  ['En Do majeur, l’accord du Ve degré est…', 'Sol majeur (G)', ['Fa majeur (F)', 'La mineur (Am)', 'Ré mineur (Dm)'], ''], ['En Do majeur, l’accord du IIe degré est…', 'Ré mineur (Dm)', ['Ré majeur (D)', 'Mi mineur (Em)', 'Si diminué'], ''],
  ['En Sol majeur, la dominante est…', 'Ré', ['Do', 'Fa♯', 'La'], ''], ['L’accord V7 en Fa majeur est…', 'Do 7 (C7)', ['Si♭ 7', 'Sol 7', 'Ré m7'], ''],
  ['Le relatif mineur de Mi♭ majeur est…', 'Do mineur', ['Sol mineur', 'Mi♭ mineur', 'Fa mineur'], 'Le relatif mineur est une tierce mineure en dessous.'], ['Dans le cercle des quintes, après Ré majeur vient…', 'La majeur', ['Sol majeur', 'Mi majeur', 'Si majeur'], ''],
  ['Les tonalités voisines de Do majeur sont…', 'Sol, Fa, La m, Mi m, Ré m', ['Ré, Mi, Fa♯', 'Do m, Sol m, Fa m', 'La, Mi, Si'], 'Une altération de différence, et leurs relatifs.'], ['Un accord « 7♭9 » s’entend surtout sur…', 'la dominante', ['la tonique', 'la sous-dominante', 'la médiante'], ''],
];
const TRANSPO = () => {
  const n = { l: rnd(7), a: 0, o: 4 }; const st = pick([2, 3, 5, 7, 9]);
  const r = spell(midiOfW(n) + st, Math.random() < 0.4);
  const right = frName(r);
  const wrong = shuffle(FR.filter((f) => f !== right)).slice(0, 3);
  return { prompt: `${frName(n)} transposé ${st} demi-tons plus haut donne…`, answers: shuffle([right, ...wrong]).map((x) => ({ label: x, value: x })), correct: right, explain: `${frName(n)} + ${st} demi-tons = ${right} (ou son enharmonique).` };
};

function rhythmQ(levelPool) {
  return () => {
    const bars = 2, beats = 4;
    const events = [];
    for (let b = 0; b < bars; b++) {
      let left = beats;
      while (left > 1e-6) {
        const opts = levelPool.filter((g) => g.reduce((a, e) => a + e.d, 0) <= left + 1e-6);
        const g = pick(opts);
        events.push(...g.map((e) => ({ ...e })));
        left -= g.reduce((a, e) => a + e.d, 0);
      }
    }
    return { prompt: 'Écoute le décompte, puis tape le rythme (espace, une touche, ou le bouton)', rhythm: events, beats, answers: [], correct: null };
  };
}
const R = { q: [{ d: 1 }], h: [{ d: 2 }], w: [{ d: 4 }], qr: [{ d: 1, rest: true }], ee: [{ d: 0.5 }, { d: 0.5 }], dq: [{ d: 1.5, dot: true }, { d: 0.5 }], hd: [{ d: 3, dot: true }], syn: [{ d: 0.5 }, { d: 1 }, { d: 0.5 }], ssss: [{ d: 0.25 }, { d: 0.25 }, { d: 0.25 }, { d: 0.25 }], es: [{ d: 0.5 }, { d: 0.25 }, { d: 0.25 }], trip: [{ d: 1 / 3, trip: true }, { d: 1 / 3, trip: true }, { d: 1 / 3, trip: true }], er: [{ d: 0.5, rest: true }, { d: 0.5 }] };

export const DRILLS = [
  // Lecture
  { id: 'd-sol-1', cat: 'read', level: 1, title: 'Clé de sol : Do à Sol', desc: 'Les cinq premières notes, autour du Do du milieu.', gen: readQ(['treble'], 60, 67) },
  { id: 'd-sol-2', cat: 'read', level: 2, title: 'Clé de sol : toute la portée', desc: 'Du Do du milieu au Sol aigu.', gen: readQ(['treble'], 60, 79) },
  { id: 'd-fa-1', cat: 'read', level: 2, title: 'Clé de fa', desc: 'La main gauche : du Fa grave au Do du milieu.', gen: readQ(['bass'], 41, 60) },
  { id: 'd-lignes', cat: 'read', level: 3, title: 'Lignes supplémentaires', desc: 'Notes au-dessus et au-dessous de la portée, deux clés.', gen: readQ(['treble', 'bass'], 36, 86) },
  { id: 'd-grand', cat: 'read', level: 3, title: 'Grande portée', desc: 'Clé de sol et clé de fa ensemble, comme au piano.', gen: readQ(['grand'], 40, 84, { octaveCheck: true }) },
  { id: 'd-alter', cat: 'read', level: 3, title: 'Notes altérées', desc: 'Dièses et bémols en clé de sol.', gen: readQ(['treble'], 60, 79, { acc: true }) },
  { id: 'd-ut', cat: 'read', level: 5, title: 'Clés d’ut 3e et 4e', desc: 'Les clés de l’alto et du ténor.', gen: readQ(['alto', 'tenor'], 48, 69) },
  // Rythme
  { id: 'd-valeurs', cat: 'rhythm', level: 1, title: 'Les valeurs de notes', desc: 'Rondes, blanches, noires, croches, silences.', gen: quiz(VALUES.slice(0, 6)) },
  { id: 'd-tap-1', cat: 'rhythm', level: 1, title: 'Taper : noires et blanches', desc: 'Lire et taper un rythme simple.', gen: rhythmQ([R.q, R.q, R.h, R.w, R.qr]), count: 5 },
  { id: 'd-tap-2', cat: 'rhythm', level: 2, title: 'Taper : les croches', desc: 'Deux croches par temps.', gen: rhythmQ([R.q, R.h, R.ee, R.ee, R.qr]), count: 5 },
  { id: 'd-mesures', cat: 'rhythm', level: 2, title: 'Mesures et temps', desc: 'Points, triolets, mesures composées.', gen: quiz(VALUES.slice(6).concat(VALUES.slice(2, 5))) },
  { id: 'd-tap-3', cat: 'rhythm', level: 3, title: 'Taper : pointées et syncopes', desc: 'Noire pointée-croche, syncopes, demi-soupirs.', gen: rhythmQ([R.q, R.ee, R.dq, R.syn, R.er, R.h]), count: 5 },
  { id: 'd-tap-4', cat: 'rhythm', level: 4, title: 'Taper : doubles croches et triolets', desc: 'Subdivisions fines.', gen: rhythmQ([R.q, R.ee, R.ssss, R.es, R.trip, R.dq]), count: 5 },
  // Oreille
  { id: 'd-hautbas', cat: 'ear', level: 1, title: 'Plus aigu ou plus grave ?', desc: 'Deux notes : la seconde monte-t-elle ?', gen: () => { const a = 55 + rnd(14); let b; do { b = a + rnd(15) - 7; } while (b === a); return { prompt: 'La deuxième note est…', audio: [[a], [b]], answers: [{ label: 'plus aiguë', value: 'up' }, { label: 'plus grave', value: 'down' }], correct: b > a ? 'up' : 'down', explain: b > a ? 'Elle monte.' : 'Elle descend.' }; } },
  { id: 'd-majmin', cat: 'ear', level: 1, title: 'Majeur ou mineur ?', desc: 'La couleur joyeuse ou triste d’un accord.', gen: earChordQ(['maj', 'min']) },
  { id: 'd-note', cat: 'ear', level: 2, title: 'Rejouer une note', desc: 'Écoute, puis trouve la note sur le clavier.', gen: pitchMatchQ(60, 72) },
  { id: 'd-int-1', cat: 'ear', level: 2, title: 'Intervalles : tierces, quinte, octave', desc: 'Les intervalles les plus utiles.', gen: earIntervalQ([3, 4, 7, 12]) },
  { id: 'd-int-2', cat: 'ear', level: 3, title: 'Tous les intervalles', desc: 'De la seconde mineure à l’octave, en montant.', gen: earIntervalQ([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) },
  { id: 'd-acc-4', cat: 'ear', level: 3, title: 'Accords : 4 types', desc: 'Majeur, mineur, diminué, augmenté.', gen: earChordQ(['maj', 'min', 'dim', 'aug']) },
  { id: 'd-gammes', cat: 'ear', level: 3, title: 'Gammes majeures et mineures', desc: 'Majeure, mineures naturelle, harmonique, mélodique.', gen: earScaleQ(Object.values(SCALES).map(([iv, n]) => [n, iv])) },
  { id: 'd-dictee-1', cat: 'ear', level: 3, title: 'Dictée : 4 notes', desc: 'Rejoue une courte mélodie en Do.', gen: dictationQ(4, [60, 62, 64, 65, 67]), count: 6 },
  { id: 'd-int-3', cat: 'ear', level: 4, title: 'Intervalles harmoniques et descendants', desc: 'Notes ensemble ou en descendant.', gen: () => (Math.random() < 0.5 ? earIntervalQ([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], { harmonic: true }) : earIntervalQ([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], { desc: true }))() },
  { id: 'd-acc-7', cat: 'ear', level: 4, title: 'Accords de septième', desc: 'maj7, 7, m7, m7♭5, dim7.', gen: earChordQ(['maj7', 'dom7', 'min7', 'hdim', 'dim7']) },
  { id: 'd-dictee-2', cat: 'ear', level: 4, title: 'Dictée : 6 notes', desc: 'Mélodie diatonique en Do majeur.', gen: dictationQ(6, [59, 60, 62, 64, 65, 67, 69, 71, 72]), count: 6 },
  { id: 'd-renv', cat: 'ear', level: 5, title: 'Renversements', desc: 'État fondamental, 1er et 2e renversement.', gen: earChordQ(['maj', 'min'], { inv: true }) },
  { id: 'd-cadences', cat: 'ear', level: 5, title: 'Cadences', desc: 'Parfaite, plagale, demi-cadence, rompue.', gen: cadenceQ() },
  { id: 'd-modes', cat: 'ear', level: 5, title: 'Les modes', desc: 'Ionien, dorien, phrygien, lydien, mixolydien, éolien, locrien.', gen: earScaleQ(MODES) },
  // Théorie
  { id: 'd-noms', cat: 'theory', level: 1, title: 'Do, Ré, Mi… et C, D, E', desc: 'Les noms français et anglais des notes.', gen: quiz(NAMES_Q) },
  { id: 'd-vocab', cat: 'theory', level: 2, title: 'Nuances et tempos', desc: 'piano, forte, crescendo, Andante, Allegro…', gen: quiz(VOCAB) },
  { id: 'd-int-ecrits', cat: 'theory', level: 3, title: 'Nommer les intervalles', desc: 'Tierce majeure, quinte juste… sur la portée.', gen: intervalWrittenQ(false) },
  { id: 'd-armures', cat: 'theory', level: 3, title: 'Les armures', desc: 'Reconnaître la tonalité d’après l’armure (jusqu’à 4 altérations).', gen: keySigQ(4) },
  { id: 'd-degres-gamme', cat: 'theory', level: 3, title: 'Les notes des gammes', desc: 'Les degrés des gammes majeures.', gen: scaleNotesQ(4) },
  { id: 'd-accords', cat: 'theory', level: 4, title: 'Construire les accords', desc: 'Majeurs, mineurs, diminués, augmentés, septièmes.', gen: chordBuildQ(['maj', 'min', 'dim', 'aug', 'dom7', 'maj7', 'min7']) },
  { id: 'd-fonctions', cat: 'theory', level: 4, title: 'Degrés et fonctions', desc: 'Tonique, dominante, relatifs, cercle des quintes.', gen: quiz(DEGREES) },
  { id: 'd-int-pro', cat: 'theory', level: 5, title: 'Intervalles altérés', desc: 'Augmentés, diminués, avec altérations.', gen: intervalWrittenQ(true) },
  { id: 'd-armures-7', cat: 'theory', level: 5, title: 'Toutes les armures', desc: 'Jusqu’à 7 altérations, majeures et mineures.', gen: keySigQ(7, true) },
  { id: 'd-transpo', cat: 'theory', level: 5, title: 'Transposition', desc: 'Transposer une note d’un intervalle.', gen: TRANSPO },
];

// ──────────────────────────────────────────────────── lecteur d'exercice ──

/**
 * Lance une série. env = { audio(): Promise<ctx>, synth(), midi, onDone(result), onClose() }
 */
export function runDrill(host, drill, env) {
  const count = drill.count || 10;
  let i = 0, score = 0, answered = false, q = null, played = [], tapTimes = [], tapStart = null, tapping = false, timers = [];
  const results = [];
  host.innerHTML = `
    <div class="drill">
      <div class="dr-top"><button class="ib" data-x="close" aria-label="Fermer"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
        <div class="dr-title"><small>${CATS[drill.cat]} · ${DRILL_LEVELS[drill.level - 1]}</small><b>${drill.title}</b></div>
        <div class="dr-dots">${Array.from({ length: count }, () => '<i></i>').join('')}</div></div>
      <div class="dr-card"><div class="dr-prompt"></div><div class="dr-visual"></div><div class="dr-actions"></div><div class="dr-answers"></div><div class="dr-feedback" aria-live="polite"></div></div>
      <div class="dr-bottom"><button class="btn primary" data-x="next" hidden>Suivant</button></div>
    </div>`;
  const $ = (s) => host.querySelector(s);
  const card = $('.dr-card');

  async function play(seq, { gap = 0.62, dur = 0.9 } = {}) {
    const ctx = await env.audio();
    const s = env.synth();
    let t = ctx.currentTime + 0.08;
    for (const chord of seq) {
      for (const m of chord) s.note(m, 0.72, t, dur, { bus: 'live', inst: 'grand' });
      t += gap;
    }
    return t - ctx.currentTime;
  }

  function next() {
    timers.forEach(clearTimeout); timers = [];
    if (i >= count) return finish();
    answered = false; played = []; tapTimes = []; tapping = false;
    q = drill.gen();
    card.classList.remove('ok', 'bad');
    $('.dr-prompt').textContent = q.prompt;
    $('.dr-feedback').textContent = '';
    $('[data-x=next]').hidden = true;
    $('.dr-visual').innerHTML = q.svg || (q.rhythm ? rhythmSVG(q.rhythm, { beats: q.beats }) : '');
    const acts = [];
    if (q.audio) acts.push('<button class="btn" data-x="listen"><span class="wave"><i></i><i></i><i></i><i></i></span>Écouter</button>');
    if (q.rhythm) acts.push('<button class="btn" data-x="model">Écouter le modèle</button><button class="btn primary" data-x="go">Commencer</button>');
    $('.dr-actions').innerHTML = acts.join('');
    $('.dr-answers').innerHTML = q.rhythm ? '<button class="tap" data-x="tap">Tape ici</button>'
      : q.dictation ? `<div class="dict">${q.dictation.map(() => '<i></i>').join('')}</div>${miniKeyboard(q.dictation[0] < 60 ? 48 : 60)}<p class="muted small">Joue sur ton clavier MIDI, sur le clavier ci-dessus ou au clavier de l’ordinateur (Q S D F…).</p>`
      : q.answers.map((a) => `<button class="ans" data-v="${esc(a.value)}">${esc(a.label)}</button>`).join('') + (q.midi ? '<p class="muted small">Tu peux aussi répondre en jouant la note sur ton clavier MIDI.</p>' : '');
    host.querySelectorAll('.dr-dots i').forEach((d, k) => { d.className = k < i ? (results[k] ? 'ok' : 'bad') : k === i ? 'cur' : ''; });
    if (q.audio) timers.push(setTimeout(() => listen(), 350));
  }

  async function listen() {
    if (!q?.audio) return;
    const b = $('[data-x=listen]');
    b?.classList.add('playing');
    const len = await play(q.audio, q.fast ? { gap: 0.36, dur: 0.5 } : q.slow ? { gap: 1.1, dur: 1.2 } : {});
    timers.push(setTimeout(() => b?.classList.remove('playing'), len * 1000));
  }

  function answer(ok, msg) {
    if (answered) return;
    answered = true;
    results[i] = ok;
    if (ok) score++;
    card.classList.add(ok ? 'ok' : 'bad');
    $('.dr-feedback').innerHTML = `<b>${ok ? pick(['Bravo !', 'Exact !', 'Parfait !', 'Oui !']) : 'Pas tout à fait.'}</b> ${esc(msg || q.explain || '')}`;
    host.querySelectorAll('.ans').forEach((b) => { if (b.dataset.v === String(q.correct)) b.classList.add('right'); });
    host.querySelectorAll('.dr-dots i')[i].className = ok ? 'ok' : 'bad';
    i++;
    $('[data-x=next]').hidden = false;
    $('[data-x=next]').textContent = i >= count ? 'Voir le résultat' : 'Suivant';
    $('[data-x=next]').focus();
    if (q.play && !q.audio) play(q.chordPlay ? [q.play] : q.play.map((m) => [m]), { gap: 0.45 });
  }

  // rythme : décompte, puis on compare les frappes
  async function startTap(model = false) {
    const ctx = await env.audio();
    const s = env.synth();
    const bpm = 80, spb = 60 / bpm;
    const t0 = ctx.currentTime + 0.15;
    for (let k = 0; k < q.beats; k++) s.click(t0 + k * spb, k === 0);
    const start = t0 + q.beats * spb;
    let t = 0;
    const onsets = [];
    for (const e of q.rhythm) { if (!e.rest) onsets.push(t); t += e.d; }
    const end = start + t * spb;
    for (let k = 0; k < t; k++) s.click(start + k * spb, k % q.beats === 0);
    if (model) { for (const o of onsets) s.note(72, 0.7, start + o * spb, 0.2, { bus: 'live', inst: 'grand' }); return; }
    tapping = true; tapTimes = [];
    $('.dr-feedback').textContent = 'Écoute le décompte…';
    tapStart = { ctx, start, spb, onsets };
    timers.push(setTimeout(() => { $('.dr-feedback').textContent = 'À toi !'; }, (start - ctx.currentTime) * 1000));
    timers.push(setTimeout(() => {
      tapping = false;
      const exp = onsets.map((o) => start + o * spb);
      const tol = 0.13;
      let hit = 0;
      const used = new Set();
      for (const e of exp) { let best = -1, bd = tol; tapTimes.forEach((tt, k) => { if (!used.has(k) && Math.abs(tt - e) < bd) { bd = Math.abs(tt - e); best = k; } }); if (best >= 0) { used.add(best); hit++; } }
      const extra = tapTimes.length - used.size;
      const pct = Math.max(0, Math.round(100 * (hit - extra * 0.5) / exp.length));
      answer(pct >= 75, `${hit}/${exp.length} frappes en place${extra ? `, ${extra} en trop` : ''} (${pct} %).`);
    }, (end - ctx.currentTime + 0.35) * 1000));
  }
  function tap() {
    if (!tapping) return;
    const { ctx } = tapStart;
    tapTimes.push(ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0));
    const b = $('.tap'); b?.classList.remove('hit'); void b?.offsetWidth; b?.classList.add('hit');
  }

  /** Notes jouées (MIDI, écran, clavier) */
  function onNotes(m) {
    if (!q || answered) return;
    if (q.rhythm) { tap(); return; }
    if (q.dictation) {
      played.push(m);
      const k = played.length - 1;
      const dots = host.querySelectorAll('.dict i');
      const good = m === q.dictation[k];
      if (dots[k]) { dots[k].className = good ? 'ok' : 'bad'; dots[k].textContent = FR[spell(m).l] + (spell(m).a ? '♯' : ''); }
      if (!good) return answer(false);
      if (played.length === q.dictation.length) answer(true);
      return;
    }
    if (q.midi) {
      if (q.chordPlay) { played.push(m); clearTimeout(onNotes._t); onNotes._t = setTimeout(() => { answer(q.midi(played)); played = []; }, 280); return; }
      answer(q.midi([m]));
    }
  }

  function finish() {
    const pct = Math.round((100 * score) / count);
    env.onDone?.({ accuracy: pct, score, count });
    const stars = pct >= 97 ? 3 : pct >= 90 ? 2 : pct >= 75 ? 1 : 0;
    $('.dr-card').innerHTML = `<div class="res-drill"><div class="stars">${[1, 2, 3].map((k) => `<span class="star ${k <= stars ? 'lit' : ''}" style="--d:${k * 0.18}s">★</span>`).join('')}</div>
      <div class="big-acc">${pct}<small> %</small></div><p>${score} bonne${score > 1 ? 's' : ''} réponse${score > 1 ? 's' : ''} sur ${count}</p>
      <div class="row"><button class="btn ghost" data-x="close">Retour</button><button class="btn primary" data-x="again">Recommencer</button></div></div>`;
    $('[data-x=next]').hidden = true;
  }

  host.addEventListener('pointerdown', (e) => {
    const k = e.target.closest('.mk [data-m]');
    if (!k) return;
    const m = +k.dataset.m;
    env.press(m, true);
    k.classList.add('down');
    const up = () => { env.press(m, false); k.classList.remove('down'); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointerup', up);
  });
  host.addEventListener('click', (e) => {
    const x = e.target.closest('[data-x]')?.dataset.x;
    const ans = e.target.closest('.ans');
    if (ans && !answered) { const ok = ans.dataset.v === String(q.correct); if (!ok) ans.classList.add('wrong'); answer(ok); return; }
    if (x === 'close') { stop(); env.onClose?.(); }
    if (x === 'next') next();
    if (x === 'listen') listen();
    if (x === 'hear' && q?.play) play(q.chordPlay ? [q.play] : q.play.map((m) => [m]), { gap: 0.45 });
    if (x === 'model') startTap(true);
    if (x === 'go') startTap(false);
    if (x === 'tap') tap();
    if (x === 'again') { i = 0; score = 0; results.length = 0; host.querySelector('.dr-card').innerHTML = '<div class="dr-prompt"></div><div class="dr-visual"></div><div class="dr-actions"></div><div class="dr-answers"></div><div class="dr-feedback" aria-live="polite"></div>'; next(); }
  });
  const onKey = (e) => {
    if (e.code === 'Space' && q?.rhythm) { e.preventDefault(); e.stopPropagation(); tap(); }
    if (e.code === 'Enter' && answered) { e.preventDefault(); next(); }
  };
  window.addEventListener('keydown', onKey, true);
  const onMidi = (e) => onNotes(e.detail.note);
  env.notes.addEventListener('note', onMidi);
  function stop() { timers.forEach(clearTimeout); window.removeEventListener('keydown', onKey, true); env.notes.removeEventListener('note', onMidi); }
  next();
  return { stop };
}

function miniKeyboard(from) {
  let w = '', b = '';
  let wi = 0;
  for (let m = from; m <= from + 24; m++) {
    const pc = m % 12;
    if ([1, 3, 6, 8, 10].includes(pc)) b += `<i class="bk" data-m="${m}" style="left:calc(${wi} * var(--kw) - var(--kw) * .3)"></i>`;
    else { w += `<i class="wk" data-m="${m}">${pc === 0 ? `<span>Do${Math.floor(m / 12) - 2}</span>` : ''}</i>`; wi++; }
  }
  return `<div class="mk" style="--n:${wi}">${w}${b}</div>`;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
