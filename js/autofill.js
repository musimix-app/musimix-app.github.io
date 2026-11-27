// MusiMix — remplissage intelligent de la grille de composition.
// Les cases vides sont complétées par une recherche en faisceau (beam search) qui note chaque enchaînement :
//  · probabilité de passage d'un degré à l'autre (selon le style et le mode),
//  · rôle de la mesure dans la partie (début de couplet, fin de phrase, fin de partie, fin du morceau…),
//  · cohérence : reprise de la progression 4 mesures plus tôt, ou de la même partie ailleurs (couplet ↔ couplet),
//  · liaison avec les accords déjà posés (avant ET après le trou).
// Plusieurs propositions différentes sont tirées en ajoutant un peu de hasard contrôlé.
import { parseChord } from './theory.js';
import { name as chordName, degree } from './compose.js';

const mod = (n) => ((n % 12) + 12) % 12;

// ─────────────────────────────────────────────── états (accords possibles) ──
// id : degré dans la tonalité ('1'…'7'), emprunts ('b7', 'b6', 'm4'), dominantes secondaires ('V/V', 'V/ii', 'V/vi')
function statesFor(key, style) {
  const out = [];
  const add = (id, nm) => { if (nm && !out.some((s) => s.name === nm)) out.push({ id, name: nm }); };
  if (style === 'blues') {
    const r = key.pc;
    add('1', chordName(r, key.minor ? 'm7' : '7', key));
    add('4', chordName(r + 5, key.minor ? 'm7' : '7', key));
    add('5', chordName(r + 7, '7', key));
    add('2', chordName(r + 2, 'm7', key));
    add('6', chordName(r + 9, '7', key));
    return out;
  }
  for (let d = 0; d < 7; d++) add(String(d + 1), degree(key, d, style));
  if (!key.minor) {
    if (['rock', 'pop', 'folk', 'chanson', 'reggae'].includes(style)) { add('b7', chordName(key.pc + 10, '', key)); add('b6', chordName(key.pc + 8, '', key)); add('m4', chordName(key.pc + 5, style === 'chanson' ? 'm6' : 'm', key)); }
    if (['jazz', 'bossa', 'funk', 'chanson', 'pop'].includes(style)) { add('V/V', chordName(key.pc + 2, '7', key)); add('V/ii', chordName(key.pc + 9, '7', key)); add('V/vi', chordName(key.pc + 4, '7', key)); }
  } else {
    add('V/iv', chordName(key.pc, '7', key));
    if (['jazz', 'bossa'].includes(style)) add('V/III', chordName(key.pc + 10, '7', key));
  }
  return out;
}

// probabilités de passage (mode majeur / mineur), lignes = départ
const MAJ = {
  1: { 4: 0.3, 5: 0.22, 6: 0.22, 2: 0.1, 3: 0.04, b7: 0.05, 'V/vi': 0.04, 'V/ii': 0.04, 'V/V': 0.03 },
  2: { 5: 0.55, 4: 0.12, 7: 0.04, 1: 0.08, 6: 0.08, 3: 0.04, 'V/V': 0.04 },
  3: { 6: 0.45, 4: 0.28, 2: 0.1, 1: 0.05, 'V/vi': 0.05 },
  4: { 5: 0.34, 1: 0.28, 2: 0.08, 6: 0.1, m4: 0.08, 3: 0.04, b7: 0.05 },
  5: { 1: 0.55, 6: 0.22, 4: 0.13, 'V/ii': 0.03 },
  6: { 4: 0.33, 2: 0.24, 5: 0.18, 3: 0.08, 1: 0.1, 'V/V': 0.03 },
  7: { 1: 0.7, 3: 0.15, 6: 0.1 },
  b7: { 1: 0.45, 4: 0.35, 5: 0.08, b6: 0.08 },
  b6: { b7: 0.5, 5: 0.18, 1: 0.2, 4: 0.08 },
  m4: { 1: 0.7, 5: 0.15, b7: 0.1 },
  'V/V': { 5: 0.75, 2: 0.15 },
  'V/ii': { 2: 0.8, 4: 0.1 },
  'V/vi': { 6: 0.8, 4: 0.1 },
};
const MIN = {
  1: { 6: 0.24, 4: 0.2, 7: 0.2, 5: 0.15, 3: 0.1, 2: 0.04, 'V/iv': 0.04 },
  2: { 5: 0.7, 1: 0.1, 3: 0.05 },
  3: { 6: 0.3, 7: 0.25, 4: 0.25, 1: 0.1, 'V/III': 0.03 },
  4: { 5: 0.3, 1: 0.3, 7: 0.2, 6: 0.12 },
  5: { 1: 0.65, 6: 0.25, 4: 0.05 },
  6: { 7: 0.35, 4: 0.2, 3: 0.2, 1: 0.15, 5: 0.1 },
  7: { 1: 0.35, 3: 0.35, 6: 0.2, 4: 0.05 },
  'V/iv': { 4: 0.85 },
  'V/III': { 3: 0.85 },
};
const BLUES = {
  1: { 4: 0.42, 1: 0.3, 5: 0.15, 6: 0.08, 2: 0.05 },
  4: { 1: 0.52, 4: 0.22, 5: 0.2 },
  5: { 4: 0.42, 1: 0.52 },
  2: { 5: 0.85 },
  6: { 2: 0.85 },
};
// fréquence générale de chaque degré (début de morceau, et frein aux accords rares)
const PRIOR_MAJ = { 1: 0.22, 4: 0.16, 5: 0.17, 6: 0.14, 2: 0.1, 3: 0.05, 7: 0.012, b7: 0.035, b6: 0.025, m4: 0.025, 'V/V': 0.02, 'V/ii': 0.02, 'V/vi': 0.02 };
const PRIOR_MIN = { 1: 0.24, 4: 0.14, 5: 0.15, 6: 0.14, 7: 0.13, 3: 0.1, 2: 0.025, 'V/iv': 0.02, 'V/III': 0.02 };
const PRIOR_BLUES = { 1: 0.4, 4: 0.3, 5: 0.2, 2: 0.05, 6: 0.05 };
const prior = (id, key, style) => (style === 'blues' ? PRIOR_BLUES : key.minor ? PRIOR_MIN : PRIOR_MAJ)[id] ?? 0.02;

// couleur du style : certains enchaînements sont plus typiques
const TWEAK = {
  jazz: { '1>6': 1.6, '6>2': 1.9, '2>5': 1.3, '5>1': 1.2, '4>5': 0.55, '1>4': 0.75, '3>6': 1.4, '1>V/ii': 2, '1>V/vi': 1.5 },
  bossa: { '1>6': 1.4, '6>2': 1.7, '2>5': 1.3, '1>V/V': 1.8, '4>m4': 1.5 },
  rock: { '1>b7': 2.2, 'b7>4': 1.6, '4>1': 1.3, '1>4': 1.2, 'b6>b7': 1.5, '5>4': 1.4 },
  pop: { '6>4': 1.4, '4>1': 1.15, '1>5': 1.2, '5>6': 1.3 },
  reggae: { '1>4': 1.5, '4>5': 1.2, '1>6': 1.2 },
  funk: { '1>4': 1.4, '2>5': 1.2 },
  chanson: { '1>6': 1.3, '6>2': 1.3, '4>m4': 1.6, '1>V/vi': 1.4 },
};

const SELF = { pop: 0.12, rock: 0.15, blues: 0.3, jazz: 0.06, bossa: 0.1, folk: 0.14, funk: 0.4, chanson: 0.1, reggae: 0.18 };

// progressions-types (modèles de grille) : bonus si la proposition les suit
const BLUES12 = ['1', '1', '1', '1', '4', '4', '1', '1', '5', '4', '1', '5'];
const BLUES8 = ['1', '5', '4', '4', '1', '5', '1', '5'];

function transitionScore(a, b, key, style, states) {
  const sb = states.find((s) => s.name === b);
  const rare = sb ? 0.25 * Math.log(prior(sb.id, key, style) / 0.15) : 0; // freine les accords rares
  if (!a) return (sb ? Math.log(prior(sb.id, key, style)) : Math.log(0.03)) + rare;
  const sa = states.find((s) => s.name === a);
  if (sa && sb) {
    if (sa.id === sb.id) return Math.log(SELF[style] ?? 0.12) + rare;
    const table = style === 'blues' ? BLUES : key.minor ? MIN : MAJ;
    const tw = (!key.minor && TWEAK[style]?.[`${sa.id}>${sb.id}`]) || 1;
    return Math.log(Math.max(0.012, (table[sa.id]?.[sb.id] ?? 0.012) * tw)) + rare;
  }
  // accord hors grille connue : on juge le mouvement de la fondamentale
  const A = parseChord(a), B = parseChord(b);
  if (!A || !B) return Math.log(0.04);
  if (a === b) return Math.log(0.12);
  const mv = mod(B.root - A.root), dom = /^(7|9|13|7b9|7#9|7sus4)/.test(A.suffix);
  if (dom && mv === 5) return Math.log(0.6);
  return Math.log({ 5: 0.22, 7: 0.14, 2: 0.1, 10: 0.1, 9: 0.08, 3: 0.08, 0: 0.12 }[mv] ?? 0.04);
}

/** Bonus selon la place de la mesure : début / fin de partie, fin de phrase, fin du morceau. */
function positionScore(st, slot, key, style) {
  const id = st?.id, k = slot.kind, p = slot.pos, n = slot.n;
  let s = 0;
  const is = (...ids) => ids.includes(id);
  if (p === 0 && slot.h === 0) {
    if (k === 'chorus') s += is('1') ? 0.9 : is('4') ? 0.8 : is('6') ? 0.5 : 0;
    else if (k === 'prechorus') s += is('4') ? 0.9 : is('2') ? 0.8 : is('6') ? 0.5 : is('1') ? -0.3 : 0;
    else if (k === 'bridge') s += is('4', '6') ? 0.8 : is('b6', '2', '3') ? 0.45 : is('1') ? -0.7 : 0;
    else s += is('1') ? 1.2 : is('6') ? (key.minor ? 0.3 : 0.55) : 0;
  }
  const lastOfSection = p === n - 1 && slot.lastHalf;
  if (slot.songEnd) s += is('1') ? 2.6 : is('5', 'V/V') ? -1.2 : -0.6;
  else if (lastOfSection) {
    if (k === 'prechorus') s += is('5') ? 1.6 : is('4') ? 0.5 : 0;
    else if (k === 'intro' || k === 'bridge') s += is('5') ? 1.1 : is('4') ? 0.4 : 0;
    else s += is('5') ? 0.9 : is('4') ? 0.45 : is('1') ? -0.2 : 0;
  } else if (p % 4 === 3 && slot.lastHalf) s += is('5') ? 0.45 : is('4') ? 0.3 : 0;
  else if (p % 4 === 0 && p > 0 && slot.h === 0) s += is('1', '6') ? 0.25 : 0;
  // modèles de blues
  if (style === 'blues' && slot.h === 0) {
    const tpl = n === 12 ? BLUES12 : n === 8 ? BLUES8 : null;
    if (tpl) s += tpl[p] === id ? 2.6 : -0.6;
  }
  return s;
}

// hasard reproductible
function rng(seed) { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; }; }
const gumbel = (r) => -Math.log(-Math.log(Math.max(1e-9, r())));

/**
 * Remplit les cases vides.
 * comp : la composition ; inScope(si, bi) : la case peut-elle être remplie ?
 * Renvoie jusqu'à `count` propositions : [[{ si, bi, h, name }]] (les plus vraisemblables d'abord), et les cases visées.
 */
export function autofill(comp, key, { inScope = () => true, count = 3, seed = Date.now() } = {}) {
  const style = comp.style || 'pop', states = statesFor(key, style);
  // suite des cases (mesures, ou demi-mesures si la mesure est coupée)
  const slots = [];
  comp.sections.forEach((s, si) => {
    s.bars.forEach((b, bi) => {
      const halves = b.c.length > 1 ? 2 : 1;
      for (let h = 0; h < halves; h++) {
        const nm = b.c[h] || '', sug = !!b.s?.[h];
        const target = (!nm || sug) && inScope(si, bi);
        slots.push({ si, bi, h, kind: s.kind, pos: bi, n: s.bars.length, lastHalf: h === halves - 1, fixed: target ? null : nm || null });
      }
    });
  });
  const targets = slots.filter((x) => !x.fixed && inScope(x.si, x.bi));
  if (!targets.length) return { sets: [], targets: [] };
  // fin du morceau : dernière case de la dernière partie
  const lastSlot = slots[slots.length - 1];
  lastSlot.songEnd = true;
  // même partie ailleurs (couplet ↔ couplet…) : la progression déjà écrite sert de modèle
  const model = new Map();
  comp.sections.forEach((s, si) => {
    const twin = comp.sections.map((t, ti) => ({ t, ti })).filter(({ t, ti }) => ti !== si && t.kind === s.kind)
      .sort((a, b) => b.t.bars.filter((x) => x.c[0] && !x.s?.[0]).length - a.t.bars.filter((x) => x.c[0] && !x.s?.[0]).length)[0];
    if (!twin) return;
    s.bars.forEach((_, bi) => {
      const tb = twin.t.bars[bi % twin.t.bars.length];
      if (tb?.c[0] && !tb.s?.[0]) model.set(`${si}.${bi}`, tb.c.length > 1 ? null : tb.c[0]);
    });
  });

  const runs = [];
  const nRuns = Math.max(count * 4, 10);
  for (let run = 0; run < nRuns; run++) {
    const r = rng(seed + run * 7919);
    const temp = run === 0 ? 0 : 0.35 + (run % 4) * 0.25;   // 1er passage : le plus probable
    const repW = run % 3 === 2 ? 0.6 : 1.4;                  // certains passages répètent moins
    const twinW = run % 4 === 3 ? 0.4 : 1.6;
    let beam = [{ seq: [], score: 0, clean: 0 }];
    for (let i = 0; i < slots.length; i++) {
      const sl = slots[i];
      const cands = sl.fixed ? [{ id: states.find((s) => s.name === sl.fixed)?.id || null, name: sl.fixed }] : states;
      const next = [];
      for (const b of beam) {
        const prev = b.seq[i - 1]?.name || null;
        for (const c of cands) {
          let sc = 0, noise = 0;
          sc += transitionScore(prev, c.name, key, style, states);
          if (!sl.fixed) {
            sc += positionScore(c, sl, key, style);
            // reprise de la phrase précédente (même partie, 4 et 8 mesures plus tôt, même moitié)
            for (const back of [4, 8]) {
              const j = slots.findIndex((x) => x.si === sl.si && x.bi === sl.bi - back && x.h === sl.h);
              if (j >= 0 && j < i && b.seq[j]?.name === c.name && !(sl.pos === sl.n - 1)) sc += repW * (back === 4 ? 1 : 0.6);
            }
            // le refrain et le pont se distinguent du couplet
            if (['chorus', 'bridge', 'prechorus'].includes(sl.kind) && sl.h === 0) {
              const vj = slots.findIndex((x) => x.kind === 'verse' && x.bi === sl.bi && x.h === 0);
              const vn = vj >= 0 ? (slots[vj].fixed || (vj < i ? b.seq[vj]?.name : null)) : null;
              if (vn && vn === c.name) sc -= sl.kind === 'bridge' ? 0.7 : 0.4;
            }
            const tw = model.get(`${sl.si}.${sl.bi}`);
            if (tw && sl.h === 0) sc += tw === c.name ? twinW * 1.5 : 0;
            // trois fois le même accord de suite : à éviter
            if (b.seq[i - 1]?.name === c.name && b.seq[i - 2]?.name === c.name) sc -= 1.6;
            // va-et-vient A B A B : monotone
            if (b.seq[i - 2]?.name === c.name && b.seq[i - 1]?.name === b.seq[i - 3]?.name && b.seq[i - 1]?.name !== c.name) sc -= 0.9;
            // une phrase de 4 mesures gagne à avoir 3 ou 4 accords différents
            if (sl.lastHalf && sl.pos % 4 === 3 && style !== 'blues' && style !== 'funk') {
              const ph = [c.name];
              for (let j = i - 1; j >= 0 && slots[j].si === sl.si && slots[j].bi > sl.bi - 4; j--) ph.push(b.seq[j]?.name);
              const d = new Set(ph.filter(Boolean)).size;
              sc += d <= 1 ? -2.2 : d === 2 ? -1.3 : d === 3 ? 0.35 : 0.5;
            }
            if (temp) noise = temp * gumbel(r);
          }
          next.push({ seq: [...b.seq.slice(0, i), c], score: b.score + sc + noise, clean: b.clean + sc });
        }
      }
      next.sort((a, b) => b.score - a.score);
      // garde un faisceau varié : pas deux fois le même dernier accord avec le même avant-dernier
      const seen = new Set(), kept = [];
      for (const x of next) {
        const sig = `${x.seq[i]?.name}|${x.seq[i - 1]?.name}`;
        if (seen.has(sig) && kept.length > 8) continue;
        seen.add(sig); kept.push(x);
        if (kept.length >= 28) break;
      }
      beam = kept;
    }
    for (const b of beam.slice(0, 3)) runs.push(b);
  }
  // propositions différentes les unes des autres (au moins un quart des cases change)
  runs.sort((a, b) => b.clean - a.clean);
  const tIdx = slots.map((s, i) => (s.fixed ? -1 : i)).filter((i) => i >= 0);
  const sets = [];
  for (const r of runs) {
    const names = tIdx.map((i) => r.seq[i].name);
    const differs = sets.every((s) => names.filter((n, k) => n !== s.names[k]).length >= Math.max(1, Math.ceil(names.length / 4)));
    if (differs) sets.push({ names, score: r.clean });
    if (sets.length >= count) break;
  }
  return {
    targets: tIdx.map((i) => slots[i]),
    sets: sets.map((s) => tIdx.map((i, k) => ({ si: slots[i].si, bi: slots[i].bi, h: slots[i].h, name: s.names[k] }))),
  };
}

/** Autres accords possibles pour une case, d'après ses voisins (les plus vraisemblables d'abord). */
export function slotAlternatives(comp, key, si, bi, h, current) {
  const style = comp.style || 'pop', states = statesFor(key, style);
  const flat = [];
  comp.sections.forEach((s, i) => s.bars.forEach((b, j) => (b.c.length ? b.c : ['']).forEach((nm, k) => flat.push({ si: i, bi: j, h: k, name: nm, kind: s.kind, n: s.bars.length, halves: Math.max(1, b.c.length) }))));
  const idx = flat.findIndex((x) => x.si === si && x.bi === bi && x.h === h);
  if (idx < 0) return [];
  const prev = [...flat.slice(0, idx)].reverse().find((x) => x.name)?.name || null;
  const next = flat.slice(idx + 1).find((x) => x.name)?.name || null;
  const me = flat[idx];
  const slot = { kind: me.kind, pos: bi, n: me.n, h, lastHalf: h === me.halves - 1, songEnd: idx === flat.length - 1 };
  return states
    .filter((s) => s.name !== current)
    .map((s) => ({ name: s.name, score: transitionScore(prev, s.name, key, style, states) + (next ? transitionScore(s.name, next, key, style, states) : 0) + positionScore(s, slot, key, style) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map((x) => x.name);
}
