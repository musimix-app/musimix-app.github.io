// MusiMix Piano — modèle du morceau pour la vue « notes qui tombent ».
// Rassemble : notes MIDI (+ .synthesia), grille d'accords, paroles synchronisées, pistes audio.
//
// KeysSong = {
//   title, artist, key, bpm, duration, beats[], downbeats[], bookmarks[{ t, label }],
//   lines[]   (lignes MusiMix : { type, text, chords[{pos,name,t?}], words[{s,e}], s, e, label }),
//   chords[]  ({ name, s, e } : grille minutée),
//   tracks[]  ({ id, name, family, isDrum, program, notes[], role, vol, mute, solo, kind: 'midi' | 'grid' }),
//   stems[]   ({ id, label, kind, blob, vol, mute, solo }),
//   midiOffset (s), gridStyle, info[] }
// note = { t, d, pitch, vel, ch, program, part? ('L'|'R'|'B'|'X'), finger?, fingerHand? }

import { parseMidi, familyOf, karaokeLines, chordsFromNotes, keyNameOf } from '../midi.js';
import { parseSheet, parseLRC, attachTimings, fillLineEnds, docFromSongJson, looksLikeLRC } from '../sheet.js';
import { parseChord, chordPcs } from '../theory.js';
import { readZip } from '../zip.js';
import { synthesiaId, parseSynthesia, pickSynthesiaSong, applyParts, applyFingers } from './synthesia.js';

export const ROLE_LABELS = {
  meta: 'Selon le fichier', right: 'Main droite', left: 'Main gauche', both: 'Deux mains', bg: 'Accompagnement', off: 'Couper',
};

const AUDIO_EXT = /\.(mp3|wav|flac|m4a|aac|ogg|oga|opus|webm|aif|aiff|mp4)$/i;
const MIDI_EXT = /\.(mid|midi|kar|rmi)$/i;
const SHEET_EXT = /\.(cho|chopro|chordpro|crd|pro|txt)$/i;

const STEM_LABELS = { vocals: 'Voix', backing: 'Chœurs', drums: 'Batterie', bass: 'Basse', guitar: 'Guitare', piano: 'Piano', other: 'Autres', instrumental: 'Instrumental', mix: 'Morceau', take: 'Ma prise' };
const STEM_ORDER = ['take', 'vocals', 'backing', 'drums', 'bass', 'guitar', 'piano', 'other', 'instrumental', 'mix'];

/** Même reconnaissance des pistes que MusiMix (songs.js › stemKind). */
export function stemKind(filename) {
  const n = filename.toLowerCase().replace(/\.[^.]+$/, '');
  if (/(instrumental|no[ _-]?vocals?|karaoke|accompan|backing[ _-]?track|\binst\b|minus[ _-]?one)/.test(n)) return 'instrumental';
  if (/(backing[ _-]?vocals?|back[ _-]?vocals?|ch(oe|œ)urs?|choir|\bbv\b|harmon(y|ies)\b)/.test(n)) return 'backing';
  if (/(vocals?|voix|voice|chant|lead|acapella|a[ _-]?cappella)/.test(n)) return 'vocals';
  if (/(drums?|batterie|percu)/.test(n)) return 'drums';
  if (/(bass|basse)/.test(n)) return 'bass';
  if (/(guitars?|guitare|gtr)/.test(n)) return 'guitar';
  if (/(piano|keys|keyboard|clavier|synth)/.test(n)) return 'piano';
  if (/(other|autres?|rest)/.test(n)) return 'other';
  return null;
}

function guessTitleArtist(filename) {
  let n = filename.replace(/\.[^.]+$/, '').replace(/_/g, ' ').replace(/\((vocals|instrumental|drums|bass|guitar|piano|other|no vocals)\)/gi, '').replace(/^\d+[ .-]+/, '').trim();
  const m = n.split(/\s+[-–—]\s+/);
  return m.length >= 2 ? { artist: m[0].trim(), title: m.slice(1).join(' - ').trim() } : { artist: '', title: n };
}

const uid = () => Math.random().toString(36).slice(2, 9);

export function emptySong() {
  return {
    title: '', artist: '', key: '', bpm: null, duration: 0, beats: [], downbeats: [], bookmarks: [], lines: [], chords: [],
    tracks: [], stems: [], midiOffset: 0, gridStyle: 'bar', info: [], mixHint: null, pedal: [],
  };
}

// ─────────────────────────────────────────────────────── import de fichiers ──

/** Fichiers déposés (File[]) → KeysSong. Accepte ZIP MusiMix, .mid/.kar, .synthesia, audio, .cho/.txt, .lrc, song.json. */
export async function loadFiles(fileList) {
  // les ZIP sont dépliés : chaque entrée devient un « fichier »
  const files = [];
  for (const f of fileList) {
    if (/\.zip$/i.test(f.name)) {
      for (const e of await readZip(f)) {
        if (e.name.endsWith('/')) continue;
        files.push({ name: e.base || e.name.split('/').pop(), path: e.name, blob: (type) => e.blob(type), text: () => e.text(), arrayBuffer: async () => (await e.blob()).arrayBuffer(), zip: f.name });
      }
    } else files.push({ name: f.name, blob: async () => f, text: () => f.text(), arrayBuffer: () => f.arrayBuffer() });
  }
  const song = emptySong();
  const zipName = fileList.find?.((f) => /\.zip$/i.test(f.name))?.name;

  // 1. song.json (pack MusiMix), grille, .lrc
  const json = files.find((f) => /(^|\/)song\.json$/i.test(f.name) || /\.musimix\.json$/i.test(f.name));
  let choText = null, lrcText = null;
  for (const f of files.filter((x) => SHEET_EXT.test(x.name) || /\.lrc$/i.test(x.name))) {
    if (/readme|lisez/i.test(f.name)) continue;
    const t = await f.text();
    if (/\.lrc$/i.test(f.name) || looksLikeLRC(t)) { lrcText ??= t; } else choText ??= t;
  }
  let doc = { meta: {}, lines: [] };
  let meta = null;
  if (json) {
    meta = JSON.parse(await json.text());
    doc = docFromSongJson(meta, choText);
    Object.assign(song, {
      title: meta.title || doc.meta.title || '', artist: meta.artist || doc.meta.artist || '', key: meta.key || doc.meta.key || '',
      bpm: meta.bpm || null, beats: meta.beats || [], downbeats: meta.downbeats || [], duration: meta.duration || 0, mixHint: meta.mix || null,
    });
    song.detected = meta.chordsDetected || [];
    song.info.push('Pack MusiMix');
  } else if (choText) {
    doc = parseSheet(choText);
    Object.assign(song, { title: doc.meta.title || '', artist: doc.meta.artist || '', key: doc.meta.key || '', bpm: doc.meta.bpm || null });
    song.info.push('Grille d’accords');
  }
  if (lrcText && !doc.lines.some((l) => l.s != null)) {
    const lrc = parseLRC(lrcText);
    if (!doc.lines.some((l) => l.type === 'lyric')) doc.lines = lrc.lines.map((l) => ({ type: 'lyric', text: l.text, chords: [] }));
    attachTimings(doc.lines, lrc.lines.map((l) => ({ text: l.text, s: l.s, words: l.words })));
    song.title ||= lrc.meta.title || '';
    song.artist ||= lrc.meta.artist || '';
    song.info.push('Paroles minutées (.lrc)');
  }

  // 2. pistes audio
  const stemMap = meta?.stems || {};
  for (const f of files.filter((x) => AUDIO_EXT.test(x.name))) {
    const declared = Object.entries(stemMap).find(([, n]) => n === f.name || n === f.path)?.[0];
    const kind = declared || stemKind(f.name) || 'mix';
    const blob = await f.blob(mime(f.name));
    let label = STEM_LABELS[kind] || 'Piste';
    if (song.stems.some((s) => s.label === label)) label += ' ' + (song.stems.filter((s) => s.label.startsWith(label)).length + 1);
    song.stems.push({ id: 'a-' + uid(), label, kind, blob, name: f.name, vol: 1, mute: false, solo: false });
  }
  song.stems.sort((a, b) => STEM_ORDER.indexOf(a.kind) - STEM_ORDER.indexOf(b.kind));
  // MusiMix coupe l'instrumental quand les pistes détaillées sont là (doublon) : pareil ici
  const kinds = new Set(song.stems.map((s) => s.kind));
  if (kinds.has('instrumental') && ['drums', 'bass', 'guitar', 'piano', 'other'].some((k) => kinds.has(k))) for (const s of song.stems) if (s.kind === 'instrumental') s.mute = true;
  if (song.stems.some((s) => s.kind === 'mix') && song.stems.length > 1) for (const s of song.stems) if (s.kind === 'mix') s.mute = true;

  // 3. MIDI (+ .synthesia)
  const midFile = files.find((x) => MIDI_EXT.test(x.name));
  if (midFile) {
    const buf = await midFile.arrayBuffer();
    const synthFiles = files.filter((x) => /\.synthesia$/i.test(x.name) || /\.xml$/i.test(x.name));
    let entry = null;
    if (synthFiles.length) {
      const id = synthesiaId(buf);
      for (const sf of synthFiles) {
        try { entry = pickSynthesiaSong(parseSynthesia(await sf.text()), id); } catch { /* pas un .synthesia */ }
        if (entry) break;
      }
    }
    addMidi(song, parseMidi(buf), midFile.name, entry, { hasDoc: doc.lines.some((l) => l.type === 'lyric'), hasAudio: song.stems.length > 0 });
  }

  // 4. paroles + grille minutée
  if (doc.lines.length) { fillLineEnds(doc.lines); song.lines = doc.lines; }
  if (!song.chords.length || doc.lines.some((l) => l.chords?.length)) {
    const fromDoc = chordTimeline(doc.lines);
    if (fromDoc.length) { song.chords = fromDoc; song.chordSource = 'grid'; }
    else if (song.detected?.length) { song.chords = song.detected.map((c) => ({ name: c.name, s: c.s ?? c.t, e: c.e })); song.chordSource ||= json ? 'analysis' : 'detected'; }
  }
  if (!song.title) Object.assign(song, guessTitleArtist(midFile?.name || song.stems[0]?.name || zipName || 'Morceau'));
  if (!song.key && doc.meta.key) song.key = doc.meta.key;
  finish(song);
  return song;
}

function mime(name) {
  const ext = name.split('.').pop().toLowerCase();
  return { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', webm: 'audio/webm' }[ext] || '';
}

/** Ajoute les pistes d'un MIDI lu par parseMidi (MusiMix). */
export function addMidi(song, mid, fileName, synth, { hasDoc = false, hasAudio = false } = {}) {
  const lyricTracks = new Set(mid.lyrics.map((x) => x.track));
  const families = new Map(mid.tracks.map((t) => [t, familyOf(t, lyricTracks)]));
  let hasParts = false;
  if (synth) {
    hasParts = applyParts(mid.tracks, synth.parts, mid.downbeats);
    const f = applyFingers(mid.tracks, synth.fingerHints, mid.downbeats);
    if (synth.title) song.title = synth.title;
    if (synth.composer && !song.artist) song.artist = synth.composer;
    song.synthesia = synth;
    song.info.push('Fichier .synthesia' + (hasParts ? ' : mains' : '') + (f ? ` : ${f} doigtés` : ''));
    song.bookmarks = synth.bookmarks.map((b) => ({ t: mid.downbeats[b.measure - 1] ?? 0, label: b.label || `Mesure ${b.measure}` }));
  }
  const tracks = mid.tracks.map((t, i) => {
    const fam = families.get(t);
    const isDrum = t.channels.includes(9);
    let name = t.name || (isDrum ? 'Batterie' : `Piste ${i + 1}`);
    if (mid.tracks.filter((x) => x.index === t.index).length > 1) name += ` (canal ${t.channels[0] + 1})`;
    return { id: 'm-' + i, name, family: fam, isDrum, program: t.notes[0]?.program ?? 0, notes: t.notes, role: 'bg', vol: hasAudio ? 0 : 0.8, mute: false, solo: false, kind: 'midi', fileTrack: t.index };
  });
  guessRoles(tracks, hasParts);
  // pédale de sustain du fichier : la note sonne jusqu'au relâchement de la pédale
  const pedByCh = {};
  for (const t of mid.tracks) for (const p of t.pedal || []) (pedByCh[p.ch] ||= []).push(p);
  for (const list of Object.values(pedByCh)) list.sort((a, b) => a.t - b.t);
  for (const t of mid.tracks) for (const n of t.notes) {
    const ps = pedByCh[n.ch];
    if (!ps) continue;
    const end = n.t + n.d;
    let down = false, k = 0;
    while (k < ps.length && ps[k].t <= end + 0.001) { down = ps[k].down; k++; }
    if (!down) continue;
    while (k < ps.length && ps[k].down) k++;
    const up = ps[k]?.t ?? end + 4;
    n.ring = Math.min(14, up - n.t);
  }
  // la pédale à afficher dans la cascade (pistes jouables, hors batterie)
  const chans = Object.keys(pedByCh).filter((c) => +c !== 9);
  if (chans.length && !song.pedal?.length) song.pedal = pedalIntervals(chans.map((c) => pedByCh[c]), mid.duration);
  song.tracks.push(...tracks);
  song.duration = Math.max(song.duration, mid.duration + 0.5);
  if (!song.beats.length) { song.beats = mid.beats; song.downbeats = mid.downbeats; }
  song.bpm ||= mid.bpm;
  if (!song.key) song.key = keyNameOf(mid, families);
  if (!hasDoc) {
    const lines = karaokeLines(mid);
    if (lines.length) { song._midiLines = lines; song.info.push('Paroles karaoké'); }
  }
  song.detected = chordsFromNotes(mid, families);
  song.chords = song.detected;
  song.chordSource = 'detected';
  song.info.push(`MIDI : ${tracks.length} piste${tracks.length > 1 ? 's' : ''} (${fileName})`);
}

/** Messages de pédale (un tableau par canal) → intervalles [{ s, e }] où la pédale est enfoncée (réunion des canaux). */
export function pedalIntervals(lists, end = 0) {
  const all = [];
  for (const list of lists) {
    let down = null;
    for (const p of list) {
      if (p.down && down == null) down = p.t;
      else if (!p.down && down != null) { if (p.t - down > 0.02) all.push({ s: down, e: p.t }); down = null; }
    }
    if (down != null) all.push({ s: down, e: Math.max(end, down + 1) });
  }
  all.sort((a, b) => a.s - b.s);
  const out = [];
  for (const iv of all) { const l = out[out.length - 1]; if (l && iv.s <= l.e + 0.005) l.e = Math.max(l.e, iv.e); else out.push({ ...iv }); }
  return out;
}

/** Qui joue quoi, par défaut. */
function guessRoles(tracks, hasParts) {
  if (hasParts) {
    for (const t of tracks) {
      const p = new Set(t.notes.map((n) => n.part));
      t.role = p.has('L') || p.has('R') ? 'meta' : p.size === 1 && p.has('X') ? 'off' : 'bg';
    }
    return;
  }
  const R = /(right|droite|\brh\b|treble|main ?d|r\.?h\.?|upper|melod)/i, L = /(left|gauche|\blh\b|bass ?clef|main ?g|l\.?h\.?|lower)/i;
  let named = false;
  for (const t of tracks) {
    if (t.isDrum) continue;
    if (L.test(t.name)) { t.role = 'left'; named = true; } else if (R.test(t.name)) { t.role = 'right'; named = true; }
  }
  if (named) return;
  const avg = (t) => t.notes.reduce((a, n) => a + n.pitch, 0) / t.notes.length;
  const piano = tracks.filter((t) => !t.isDrum && t.family === 'piano').sort((a, b) => b.notes.length - a.notes.length).slice(0, 2);
  if (piano.length === 2 && Math.abs(avg(piano[0]) - avg(piano[1])) > 5) {
    const [hi, lo] = avg(piano[0]) > avg(piano[1]) ? piano : [piano[1], piano[0]];
    hi.role = 'right'; lo.role = 'left';
  } else if (piano.length) piano[0].role = 'both';
  else {
    const mel = tracks.find((t) => t.family === 'vocals') || tracks.filter((t) => !t.isDrum).sort((a, b) => avg(b) - avg(a))[0];
    if (mel) mel.role = 'right';
  }
}

// ───────────────────────────────────────────────────── grille minutée ──

/** Temps d'un accord posé à la position pos d'une ligne (sur le mot qui le porte). */
function timeAt(line, pos) {
  if (!line.words?.length) return line.s ?? null;
  let k = 0, i = 0;
  for (const m of line.text.matchAll(/\S+/g)) { if (m.index <= pos) k = i; i++; }
  return line.words[Math.min(k, line.words.length - 1)]?.s ?? line.s ?? null;
}

/** Accords des lignes (MusiMix) → [{ name, s, e }] triés. */
export function chordTimeline(lines) {
  const out = [];
  for (const l of lines) {
    for (const c of l.chords || []) {
      const t = c.t ?? (l.type === 'lyric' ? timeAt(l, c.pos) : null);
      if (t != null && isFinite(t)) out.push({ name: c.name, s: t });
    }
  }
  out.sort((a, b) => a.s - b.s);
  // plusieurs accords sur le même mot (« mim [A#m7] [Am7] [D] ») : on les répartit jusqu'au suivant
  for (let i = 0; i < out.length;) {
    let j = i;
    while (j + 1 < out.length && Math.abs(out[j + 1].s - out[i].s) < 0.02) j++;
    if (j > i) {
      const next = out[j + 1]?.s ?? out[i].s + 2 * (j - i + 1);
      const step = (next - out[i].s) / (j - i + 1);
      for (let k = i; k <= j; k++) out[k].s = out[i].s + (k - i) * step;
    }
    i = j + 1;
  }
  for (let i = 0; i < out.length; i++) out[i].e = out[i + 1]?.s ?? out[i].s + 4;
  return out.filter((c) => c.e - c.s > 0.05 && parseChord(c.name));
}

/** Notes jouables d'une grille : basse main gauche, accord main droite (enchaînement au plus près). */
export function gridNotes(chords, style = 'bar', { beats = [], downbeats = [] } = {}) {
  const notes = [];
  let prev = null;
  const grid = style === 'beat' ? beats : style === 'bar' ? downbeats : [];
  for (const c of chords) {
    const ch = parseChord(c.name);
    if (!ch) continue;
    const pcs = [...new Set(chordPcs(ch))];
    const bassPc = ch.bass ?? ch.root;
    const bass = 41 + ((bassPc - 41) % 12 + 12) % 12;            // Fa1..Mi2 (MIDI 41-52)
    const right = voicing(pcs.length > 4 ? pcs.filter((p, i) => i !== 2) : pcs, prev);
    prev = right;
    // attaques : début de l'accord + chaque temps / mesure de la grille à l'intérieur
    const hits = [c.s, ...grid.filter((g) => g > c.s + 0.12 && g < c.e - 0.12)];
    hits.forEach((h, i) => {
      const end = hits[i + 1] ?? c.e;
      const d = Math.max(0.12, (end - h) * 0.94);
      notes.push({ t: h, d, pitch: bass, vel: 0.75, part: 'L', chord: c.name });
      for (const p of right) notes.push({ t: h, d, pitch: p, vel: 0.62, part: 'R', chord: c.name });
    });
  }
  return notes;
}

function voicing(pcs, prev) {
  const center = prev ? prev.reduce((a, b) => a + b, 0) / prev.length : 64;
  let best = null, bs = Infinity;
  for (let low = 55; low <= 69; low++) {
    if (!pcs.includes(low % 12)) continue;
    const v = [low];
    for (const pc of pcs) if (pc !== low % 12) v.push(low + ((pc - low) % 12 + 12) % 12);
    v.sort((a, b) => a - b);
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    const score = prev ? v.reduce((a, p, i) => a + Math.abs(p - (prev[i] ?? prev[prev.length - 1])), 0) : Math.abs(mean - center);
    if (score < bs) { bs = score; best = v; }
  }
  return best || pcs.map((p) => 60 + p);
}

/** Piste « Grille d'accords » (régénérée quand on change de style). */
export function makeGridTrack(song, existing) {
  const notes = gridNotes(song.chords, song.gridStyle, song);
  const noMidi = !song.tracks.some((t) => t.kind === 'midi');
  return {
    id: 'grid', name: 'Grille d’accords', family: 'piano', isDrum: false, program: 0, notes, kind: 'grid',
    role: existing?.role ?? (noMidi ? 'meta' : 'off'), vol: existing?.vol ?? (song.stems.length ? 0 : 0.7),
    mute: existing?.mute ?? false, solo: existing?.solo ?? false,
  };
}

function finish(song) {
  if (!song.lines.some((l) => l.type === 'lyric') && song._midiLines) song.lines = song._midiLines;
  delete song._midiLines;
  if (song.chords.length) {
    const i = song.tracks.findIndex((t) => t.id === 'grid');
    const g = makeGridTrack(song, song.tracks[i]);
    if (i >= 0) song.tracks[i] = g; else song.tracks.push(g);
  }
  const lastNote = Math.max(0, ...song.tracks.flatMap((t) => t.notes.slice(-40).map((n) => n.t + n.d)));
  const lastLine = Math.max(0, ...song.lines.map((l) => l.e || 0));
  song.duration = Math.max(song.duration || 0, lastNote + 0.5, lastLine + 0.5, song.chords.at(-1)?.e || 0);
  // sections (repères) d'après la partition
  if (!song.bookmarks.length) {
    for (let i = 0; i < song.lines.length; i++) {
      const l = song.lines[i];
      if (l.type !== 'section') continue;
      const next = song.lines.slice(i + 1).find((x) => x.s != null || x.chords?.some((c) => c.t != null));
      const t = next?.s ?? next?.chords?.find((c) => c.t != null)?.t;
      if (t != null) song.bookmarks.push({ t, label: l.label || l.text });
    }
  }
  return song;
}

// ───────────────────────────────────── depuis un morceau de la bibliothèque ──

/**
 * Pour l'intégration dans MusiMix : morceau de la bibliothèque → KeysSong.
 * getBlob(blobId) = db.getBlob ; song.midi?.blobId = le .mid d'origine s'il a été gardé.
 */
export async function fromMusimixSong(ms, getBlob) {
  const song = emptySong();
  Object.assign(song, { title: ms.title, artist: ms.artist, key: ms.key, bpm: ms.bpm, beats: ms.beats || [], downbeats: ms.downbeats || [], duration: ms.duration || 0 });
  for (const st of ms.stems || []) {
    const m = ms.mix?.[st.id] || {};
    const blob = await getBlob(st.blobId);
    if (blob) song.stems.push({ id: st.id, label: st.label, kind: st.kind, blob, vol: m.vol ?? 1, mute: !!m.mute, solo: !!m.solo });
  }
  if (ms.midi?.blobId) {
    const b = await getBlob(ms.midi.blobId);
    // morceau importé d'un MIDI : ses pistes audio ne sont que le rendu des notes → on joue les notes
    // directement (la partie que tu joues n'est alors pas doublée par l'audio)
    const fromMidi = ms.source === 'midi';
    if (b) addMidi(song, parseMidi(await b.arrayBuffer()), ms.midi.name || 'morceau.mid', null, { hasDoc: true, hasAudio: !fromMidi && song.stems.length > 0 });
    if (b && fromMidi) for (const st of song.stems) st.mute = true;
  }
  const lines = structuredClone(ms.doc?.lines || []);
  fillLineEnds(lines);
  song.lines = lines;
  const tl = chordTimeline(lines);
  song.chords = tl.length ? tl : (ms.detectedChords || []).map((c) => ({ name: c.name, s: c.s ?? c.t, e: c.e }));
  song.chordSource = tl.length ? 'grid' : 'analysis';
  return finish(song);
}

// ─────────────────────────────────────────────────────────── démo ──

/** Petit morceau d'essai (air traditionnel, domaine public) : mélodie, grille, paroles. */
export function demoSong() {
  const song = emptySong();
  song.title = 'Au clair de la lune';
  song.artist = 'Traditionnel';
  song.key = 'C';
  song.bpm = 100;
  const beat = 60 / 100;
  // mélodie (main droite) : [note, temps]
  const mel = [[60, 1], [60, 1], [60, 1], [62, 1], [64, 2], [62, 2], [60, 1], [64, 1], [62, 1], [62, 1], [60, 4],
    [60, 1], [60, 1], [60, 1], [62, 1], [64, 2], [62, 2], [60, 1], [64, 1], [62, 1], [62, 1], [60, 4]];
  const start = 4 * beat; // une mesure de décompte
  let t = start;
  const notes = [];
  for (const [p, d] of mel) { notes.push({ t, d: d * beat * 0.92, pitch: p + 12, vel: 0.8, part: 'R' }); t += d * beat; }
  const end = t;
  song.beats = []; song.downbeats = [];
  for (let b = 0, x = 0; x <= end + 0.01; b++, x = b * beat) { song.beats.push(x); if (b % 4 === 0) song.downbeats.push(x); }
  song.tracks.push({ id: 'm-0', name: 'Mélodie', family: 'piano', isDrum: false, program: 0, notes, role: 'right', vol: 0.8, mute: false, solo: false, kind: 'midi' });
  const grid = ['C', 'C', 'G', 'C', 'C', 'C', 'G', 'C'];
  song.chords = grid.map((name, i) => ({ name, s: start + i * 4 * beat, e: start + (i + 1) * 4 * beat }));
  song.chordSource = 'grid';
  const words = (txt, s0, durs) => {
    const ws = txt.split(' ');
    let s = s0;
    return ws.map((_, i) => { const w = { s, e: s + durs[i] * beat }; s += durs[i] * beat; return w; });
  };
  const d1 = [1, 1, 1, 1, 2, 2, 1, 1, 1, 1, 4];
  // syllabes regroupées en mots : on garde un mot par note pour le karaoké
  const l1 = 'Au clair de la lu- ne mon a- mi Pier- rot';
  const l2 = 'Prê- te- moi ta plu- me pour é- crire un mot';
  const mk = (text, s0, chords) => {
    const w = words(text, s0, d1);
    return { type: 'lyric', text, words: w, s: w[0].s, e: w.at(-1).e, chords };
  };
  song.lines = [
    { type: 'section', label: 'Couplet', text: 'Couplet', chords: [] },
    mk(l1, start, [{ pos: 0, name: 'C' }, { pos: l1.indexOf('mon'), name: 'G' }, { pos: l1.indexOf('rot'), name: 'C' }]),
    mk(l2, start + 16 * beat, [{ pos: 0, name: 'C' }, { pos: l2.indexOf('pour'), name: 'G' }, { pos: l2.indexOf('mot'), name: 'C' }]),
  ];
  song.info.push('Démo intégrée');
  return finish(song);
}
