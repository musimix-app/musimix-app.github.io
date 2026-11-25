// MusiMix — repérage des pistes vides (silence ou presque), pour ne pas les montrer dans le mixage.
// Le niveau de chaque piste est mesuré une fois puis gardé dans la fiche du morceau (stem.level).

import { db } from './db.js';
import { decodeAt } from './wav.js';

/** Seuil : en dessous de ~-50 dBFS de niveau moyen, la piste est considérée comme vide. */
const EMPTY_RMS = 0.003;

export function levelOf(channels) {
  let s = 0, n = 0, peak = 0;
  for (const c of channels) for (let i = 0; i < c.length; i += 4) { const v = Math.abs(c[i]); s += v * v; n++; if (v > peak) peak = v; }
  return { rms: +Math.sqrt(s / Math.max(1, n)).toFixed(5), peak: +peak.toFixed(4) };
}

export async function measureBlob(blob) {
  const buf = await decodeAt(blob, 8000);
  return levelOf(Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i)));
}

export function isEmptyStem(st) {
  return !!st?.level && st.kind !== 'mix' && st.level.rms < EMPTY_RMS && st.level.peak < 0.1;
}

/** Mesure les pistes pas encore mesurées. Retourne true si la fiche a changé. */
export async function ensureLevels(song) {
  let changed = false;
  for (const st of song.stems || []) {
    if (st.level || !st.blobId) continue;
    try {
      const blob = await db.getBlob(st.blobId);
      if (!blob) continue;
      st.level = await measureBlob(blob);
      changed = true;
    } catch { st.level = { rms: 1, peak: 1, err: true }; changed = true; }
  }
  return changed;
}

let scanning = false;
/** Passe en arrière-plan sur toute la bibliothèque (morceaux à plusieurs pistes). */
export async function scanLibraryLevels(onSong = () => {}) {
  if (scanning) return;
  scanning = true;
  try {
    const idle = () => new Promise((r) => (window.requestIdleCallback ? requestIdleCallback(() => r(), { timeout: 2000 }) : setTimeout(r, 200)));
    for (const s of await db.allSongs()) {
      if ((s.stems || []).length < 2 || s.stems.every((st) => st.level || !st.blobId)) continue;
      await idle();
      const fresh = await db.getSong(s.id);
      if (fresh && (await ensureLevels(fresh))) { await db.putSong(fresh); onSong(fresh); }
    }
  } finally { scanning = false; }
}
