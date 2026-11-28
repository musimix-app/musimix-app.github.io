// MusiMix — « Tout préparer » dans le navigateur, sans le Studio :
// séparation des pistes → paroles synchronisées (LRCLIB) → tempo, tonalité et accords (analyse de l'audio)
// → accords placés sur les paroles. Une grille déjà saisie par l'utilisateur est gardée telle quelle.

import { db } from './db.js';
import { separateSong } from './separate.js';
import { analyzeAudio } from './analyze.js';
import { lrclibSearch } from './songs.js';
import { parseSheet, parseLRC, attachTimings, fillLineEnds, placeChords } from './sheet.js';

const lyricLines = (doc) => doc.lines.filter((l) => l.type === 'lyric');

function pickLyrics(results, duration) {
  const synced = results.filter((r) => r.syncedLyrics);
  const near = (r) => (duration && r.duration ? Math.abs(r.duration - duration) : 0);
  synced.sort((a, b) => near(a) - near(b));
  const best = synced.find((r) => near(r) <= 4) || synced[0];
  return best || null;
}

export async function prepareSong(songId, { separate = true, quality = 'best', lyrics = true, chords = true, calibrate = true, restart = false, sheet = '', lrc = '', title, artist, onProgress = () => {}, signal } = {}) {
  const report = { separated: false, lyrics: null, chords: 0, bpm: null, key: null };
  let song = await db.getSong(songId);
  if (!song) throw new Error('Morceau introuvable');
  if (title != null && title !== song.title) song.title = title;
  if (artist != null && artist !== song.artist) song.artist = artist;
  await db.putSong(song);

  // ── 1. pistes (0 → 0,75)
  const span = separate ? 0.75 : 0;
  if (separate) {
    song = await separateSong(songId, { quality, signal, onProgress: (p) => onProgress({ progress: p.progress * span, message: p.message }) });
    report.separated = true;
  }
  if (signal?.aborted) throw new DOMException('Annulé', 'AbortError');

  // ── 2. accords et tempo (0,75 → 0,9)
  let ana = null;
  if (chords) {
    const by = (k) => song.stems.find((s) => s.kind === k && s.sep) || null;
    const harmonyStems = ['guitar', 'piano', 'other'].map(by).filter(Boolean);
    const mix = song.stems.find((s) => s.kind === 'mix') || song.stems[0];
    const blob = async (st) => (st ? db.getBlob(st.blobId) : null);
    const harmony = harmonyStems.length ? await Promise.all(harmonyStems.map(blob)) : [await blob(mix)];
    ana = await analyzeAudio({ harmony: harmony.filter(Boolean), bass: await blob(by('bass')), drums: await blob(by('drums')) }, {
      duration: song.duration,
      onProgress: (f, m) => onProgress({ progress: span + (0.9 - span) * f * 0.95, message: m }),
    });
    report.chords = ana.chords.length; report.bpm = ana.bpm; report.key = ana.key;
  }
  if (signal?.aborted) throw new DOMException('Annulé', 'AbortError');

  // ── 3. paroles (0,9 → 0,97)
  let found = null;
  if (lyrics) {
    onProgress({ progress: 0.92, message: 'Recherche des paroles synchronisées…' });
    if (lrc.trim()) found = { syncedLyrics: lrc, trackName: song.title, artistName: song.artist, fromFile: true };
    else try { found = pickLyrics(await lrclibSearch({ title: song.title, artist: song.artist, duration: song.duration }), song.duration); } catch { /* hors ligne */ }
  }

  // ── 4. assemblage (on relit le morceau : il a pu être modifié pendant ce temps)
  onProgress({ progress: 0.97, message: 'Mise en place des paroles et des accords…' });
  const fresh = await db.getSong(songId);
  if (restart) fresh.doc = { meta: fresh.doc.meta || {}, lines: [] };
  if (sheet.trim()) {
    // grille collée (page entière d'un site acceptée : le tri est fait par parseSheet)
    const doc = parseSheet(sheet);
    fresh.doc = { meta: { ...(fresh.doc.meta || {}), ...doc.meta }, lines: doc.lines };
    if (doc.meta.key) fresh.key = doc.meta.key;
    if (doc.meta.capo != null) fresh.capo = doc.meta.capo;
    report.sheet = true;
  }
  const hadLyrics = lyricLines(fresh.doc).length > 0;
  const hadChords = fresh.doc.lines.some((l) => l.chords?.length);
  if (found) {
    const lrc = parseLRC(found.syncedLyrics);
    const timed = lrc.lines.map((l) => ({ text: l.text, s: l.s, words: l.words }));
    if (hadLyrics) {
      const n = attachTimings(fresh.doc.lines, timed);
      // lignes restées sans temps (texte trop différent) : placées entre leurs voisines, pour garder l'ordre
      const ly = lyricLines(fresh.doc);
      ly.forEach((l, k) => {
        if (l.s != null) return;
        const prev = ly.slice(0, k).reverse().find((x) => x.s != null);
        const next = ly.slice(k + 1).find((x) => x.s != null);
        if (prev && next) l.s = (Math.max(prev.s, prev.e ?? prev.s) + next.s) / 2;
        else if (next) l.s = Math.max(0, next.s - 3);
        else if (prev) l.s = (prev.e ?? prev.s) + 1;
        if (l.s != null) l.words = null;
      });
      fillLineEnds(fresh.doc.lines);
      report.lyrics = { source: found.fromFile ? 'fichier' : 'lrclib', kept: true, matched: n, total: lyricLines(fresh.doc).length };
    } else {
      // on part du texte synchronisé lui-même (et pas des paroles « simples », parfois différentes) :
      // chaque ligne a ainsi son temps ; un blanc entre deux couplets crée un saut de strophe
      const sung = timed.filter((l) => /\p{L}/u.test(l.text));
      let txt = '';
      sung.forEach((l, k) => { if (k && l.s - sung[k - 1].s > 9) txt += '\n'; txt += l.text + '\n'; });
      const doc = parseSheet(txt);
      attachTimings(doc.lines, sung);
      fillLineEnds(doc.lines);
      fresh.doc = { meta: fresh.doc.meta || {}, lines: doc.lines };
      report.lyrics = { source: found.fromFile ? 'fichier' : 'lrclib', kept: false, title: found.trackName, artist: found.artistName };
    }
  }
  if (ana) {
    fresh.bpm = ana.bpm;
    if (!fresh.key) fresh.key = ana.key;
    fresh.beats = ana.beats;
    fresh.downbeats = ana.downbeats;
    fresh.detectedChords = ana.chords;
    // une grille saisie à la main reste prioritaire : on ne pose les accords détectés que s'il n'y en a pas
    if (!hadChords) fresh.doc.lines = placeChords(fresh.doc.lines, ana.chords, 60 / ana.bpm);
    report.keptChords = hadChords;
  }
  // ── 5. calage fin sur l'audio : chaque mot sur la voix, chaque accord sur l'harmonie (sans LRC si besoin)
  if (calibrate && fresh.doc.lines.some((l) => (l.type === 'lyric' && l.text?.trim()) || l.chords?.length)) {
    try {
      const { calibrate: cal } = await import('./lyricsync.js');
      const r = await cal(fresh, (id) => db.getBlob(id), { onProgress: (p) => onProgress({ progress: 0.97 + 0.03 * p.progress, message: p.message }) });
      fresh.calUndo = { lines: JSON.stringify(fresh.doc.lines), offset: fresh.prefs?.offset || 0, at: Date.now() };
      fresh.doc.lines = r.lines;
      if (fresh.prefs) fresh.prefs.offset = 0;
      report.cal = { ...r.report, changes: r.changes.length };
    } catch (e) { console.warn('[calage]', e); report.calError = e.message; }
  }
  fresh.doc.meta = { ...(fresh.doc.meta || {}), title: fresh.title, artist: fresh.artist, key: fresh.key, capo: fresh.capo, bpm: fresh.bpm };
  fresh.prepared = { at: Date.now(), by: 'navigateur', ...report };
  await db.putSong(fresh);
  onProgress({ progress: 1, message: 'Terminé' });
  return { song: fresh, report };
}
