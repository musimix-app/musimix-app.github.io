// MusiMix — suggestion de capo : pour chaque position 0–7, note la facilité des formes d'accords
// qu'on jouerait (pondérée par le nombre d'occurrences dans le morceau) et propose la meilleure.

import { parseChord } from './theory.js';
import { chordDisplay } from './render.js';

const N = (s) => s.split(' ');
// Formes « ouvertes » faciles, par qualité. Tout le reste coûte un barré.
const EASY = {
  guitar: {
    maj: N('C A G E D'), min: N('Am Em Dm'), 7: N('A7 B7 C7 D7 E7 G7'), m7: N('Am7 Em7 Dm7'),
    maj7: N('Cmaj7 Fmaj7 Amaj7 Dmaj7 Emaj7 Gmaj7'), sus: N('Asus2 Asus4 Dsus2 Dsus4 Esus4'), add9: N('Cadd9 Gadd9 Aadd9 Dadd9'),
    medium: N('F Bm Fmaj7 Bm7 F#m Bb Dm7 Cmaj7'),
  },
  ukulele: {
    maj: N('C F G A D'), min: N('Am Dm Gm Em'), 7: N('C7 G7 A7 D7 E7'), m7: N('Am7 Dm7 Gm7 Em7'),
    maj7: N('Cmaj7 Fmaj7 Gmaj7 Amaj7'), sus: N('Csus4 Gsus4 Dsus4 Asus4'), add9: N('Cadd9'),
    medium: N('Bb E Bm Eb B7 F7'),
  },
};
function quality(ch) {
  const s = ch.suffix || '';
  if (s === '' ) return 'maj';
  if (s === 'm') return 'min';
  if (s === '7') return '7';
  if (s === 'm7') return 'm7';
  if (/^(maj7|M7|Δ7?)$/.test(s)) return 'maj7';
  if (/^sus[24]?$/.test(s)) return 'sus';
  if (/^add9$/.test(s)) return 'add9';
  return null;
}
const plain = (ch) => ch.rootName + (ch.suffix || '');

/** Coût d'une forme (0 = forme ouverte facile, 1 = petit barré, 2.5 = barré). */
export function shapeCost(name, instrument = 'guitar') {
  const ch = parseChord(name);
  if (!ch) return 1;
  const E = EASY[instrument] || EASY.guitar;
  const q = quality(ch);
  const base = q && (E[q] || []).includes(plain(ch)) ? 0
    : E.medium.includes(plain(ch)) ? 1
    : q && E.maj.includes(ch.rootName) ? 1.6 // qualité un peu exotique sur une fondamentale ouverte
    : 2.5;
  // basse ajoutée : facile si c'est une note jouable à vide ou proche (C/G, D/F#, G/B, Am/G…), sinon +0,5
  const bass = ch.bassName ? (['E', 'A', 'D', 'G', 'B', 'F#', 'C'].includes(ch.bassName) ? 0.2 : 0.6) : 0;
  return base + bass;
}

/** Classement des positions de capo. Retourne [{ capo, cost, shapes: [noms joués] }] trié. */
export function rankCapos(song, { instrument = 'guitar', max = 7 } = {}) {
  const counts = new Map();
  for (const l of song.doc?.lines || []) for (const c of l.chords || []) counts.set(c.name, (counts.get(c.name) || 0) + 1);
  if (!counts.size) return [];
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const tr = song.prefs?.transpose || 0;
  const out = [];
  for (let capo = 0; capo <= max; capo++) {
    const show = chordDisplay(song, tr, capo);
    let cost = 0;
    const shapes = [];
    for (const [name, n] of counts) {
      const s = show(name);
      cost += shapeCost(s, instrument) * n;
      if (!shapes.includes(s)) shapes.push(s);
    }
    // petite préférence pour un capo bas (son plus grave, moins de manipulations)
    out.push({ capo, cost: cost / total + capo * 0.04, shapes });
  }
  return out.sort((a, b) => a.cost - b.cost);
}

/** Suggestion si elle vaut vraiment mieux que la position actuelle, sinon null. */
export function suggestCapo(song, opts) {
  const r = rankCapos(song, opts);
  if (!r.length) return null;
  const cur = r.find((x) => x.capo === (song.prefs?.capo || 0));
  const best = r[0];
  if (!cur || best.capo === cur.capo || cur.cost - best.cost < 0.3) return null;
  return { ...best, gain: cur.cost - best.cost, current: cur };
}
