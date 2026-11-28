// MusiMix Piano — doigtés automatiques (pour les MIDI qui n'en ont pas).
// Programmation dynamique sur les notes d'une main : coût d'écart entre deux doigts d'après les
// écarts confortables / possibles de la main (règles de Parncutt et al., 1997, simplifiées),
// pénalités pour le pouce et le 5e doigt sur les touches noires, et accords doigtés de bas en haut.

// écarts (demi-tons, main droite, doigt a → doigt b avec a < b) : [min possible, min confort, max confort, max possible]
// (confort élargi par rapport à Parncutt pour les tierces entre doigts voisins, courantes dans les arpèges)
const SPAN = {
  '1-2': [-5, 1, 5, 10], '1-3': [-4, 3, 7, 12], '1-4': [-3, 5, 9, 14], '1-5': [-1, 7, 10, 15],
  '2-3': [1, 1, 4, 5], '2-4': [1, 3, 5, 7], '2-5': [2, 5, 7, 9],
  '3-4': [1, 1, 3, 4], '3-5': [1, 3, 5, 7], '4-5': [1, 1, 3, 4],
};
const BLACK = new Set([1, 3, 6, 8, 10]);
const isBlack = (p) => BLACK.has(((p % 12) + 12) % 12);
const WI = [0, 0.5, 1, 1.5, 2, 3, 3.5, 4, 4.5, 5, 5.5, 6];
/** Rang de la touche blanche (les noires entre deux) ; marche aussi pour les hauteurs inversées (main gauche). */
const white = (p) => { const a = Math.abs(p); const w = Math.floor(a / 12) * 7 + WI[a % 12]; return p < 0 ? -w : w; };

/** Coût du passage du doigt fa (hauteur pa) au doigt fb (hauteur pb), main droite (pour la gauche, hauteurs inversées). */
function stepCost(fa, pa, fb, pb, chord) {
  if (fa === fb) {
    if (pa === pb) return chord ? 50 : 0.4; // note répétée : même doigt possible
    return chord ? 50 : 6 + Math.abs(pb - pa) * 0.5; // même doigt sur deux touches : à éviter
  }
  let lo = fa, hi = fb, d = pb - pa;
  if (fa > fb) { lo = fb; hi = fa; d = -d; }
  const [pMin, cMin, cMax, pMax] = SPAN[`${lo}-${hi}`];
  let c = 0;
  if (lo === 1 && d < 0 && !chord) {
    // passage du pouce (sous le 2e, 3e ou 4e doigt) ou du doigt par-dessus le pouce : normal dans les gammes et arpèges
    const lim = { 2: 7, 3: 8, 4: 6, 5: 2 }[hi];
    c += 3 + 0.3 * -d + (hi >= 4 ? 1.5 : 0);
    if (-d > lim) c += (-d - lim) * 8;
  } else {
    if (d < cMin) c += (cMin - d) * 1.2; else if (d > cMax) c += (d - cMax) * 1.2;
    if (d < pMin) c += (pMin - d) * 8; else if (d > pMax) c += (d - pMax) * 8;
    // position « un doigt par touche » : l'écart des doigts suit l'écart des touches blanches (Do-Mi-Sol = 1-3-5)
    const dw = Math.abs(white(pb) - white(pa));
    if (d > 0 && dw <= 4) c += 0.5 * Math.abs((hi - lo) - dw) * (chord ? 0.8 : 1);
  }
  // le 4e après le 3e (ou l'inverse) est faible
  if (lo === 3 && hi === 4) c += 0.6;
  if (chord && d <= 0) c += 50; // dans un accord : doigts dans l'ordre des hauteurs
  return c;
}
function keyCost(f, p) {
  if (!isBlack(p)) return 0;
  return f === 1 ? 2.2 : f === 5 ? 1.2 : 0;
}

/**
 * notes : [{ t, pitch }] d'une main (triées par t) ; hand 'R' | 'L'. Renvoie un tableau de doigts (1-5), même ordre.
 */
export function autoFingers(notes, hand = 'R') {
  const n = notes.length;
  if (!n) return [];
  const sgn = hand === 'L' ? -1 : 1;
  // ordre de jeu : dans un accord (même instant à 40 ms), du grave à l'aigu pour la main droite, de l'aigu au grave pour la gauche
  const idx = notes.map((x, i) => i).sort((a, b) => notes[a].t - notes[b].t || sgn * (notes[a].pitch - notes[b].pitch));
  const P = idx.map((i) => notes[i].pitch * sgn);
  const T = idx.map((i) => notes[i].t);
  const cost = Array.from({ length: n }, () => new Float64Array(6).fill(Infinity));
  const prev = Array.from({ length: n }, () => new Int8Array(6));
  for (let f = 1; f <= 5; f++) cost[0][f] = keyCost(f, notes[idx[0]].pitch) + (f === 1 || f === 2 || f === 3 ? 0 : 0.3);
  for (let i = 1; i < n; i++) {
    const chord = T[i] - T[i - 1] < 0.04;
    const gap = T[i] - T[i - 1];
    for (let f = 1; f <= 5; f++) {
      const kc = keyCost(f, notes[idx[i]].pitch);
      let best = Infinity, arg = 1;
      for (let g = 1; g <= 5; g++) {
        if (cost[i - 1][g] === Infinity) continue;
        // après un silence ou une note longue, la main peut se déplacer : les écarts comptent moins
        const relax = !chord && gap > 0.6 ? 0.35 : 1;
        const c = cost[i - 1][g] + stepCost(g, P[i - 1], f, P[i], chord) * relax + kc;
        if (c < best) { best = c; arg = g; }
      }
      cost[i][f] = best; prev[i][f] = arg;
    }
  }
  let f = 1, m = Infinity;
  for (let g = 1; g <= 5; g++) if (cost[n - 1][g] < m) { m = cost[n - 1][g]; f = g; }
  const out = new Array(n);
  for (let i = n - 1; i >= 0; i--) { out[idx[i]] = f; f = prev[i][f]; }
  return out;
}
