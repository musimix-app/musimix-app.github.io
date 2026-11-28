// MusiMix Piano — fichiers .synthesia (métadonnées XML d'un morceau MIDI) :
// titre, compositeur, mains (Parts), doigtés (FingerHints), repères (Bookmarks).
// Format décrit sur github.com/Synthesia-LLC/metadata-editor/wiki.

// ─────────────────────────────────────────────── MD5 (identifiant du MIDI) ──

const K = new Int32Array(64).map((_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) | 0);
const R = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];

function md5(bytes) {
  const n = bytes.length;
  const words = ((n + 8) >> 6) + 1;
  const m = new Int32Array(words * 16);
  for (let i = 0; i < n; i++) m[i >> 2] |= bytes[i] << ((i % 4) * 8);
  m[n >> 2] |= 0x80 << ((n % 4) * 8);
  m[words * 16 - 2] = (n * 8) | 0;
  m[words * 16 - 1] = Math.floor(n / 0x20000000);
  let a0 = 0x67452301, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476;
  for (let w = 0; w < words * 16; w += 16) {
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      const tmp = d; d = c; c = b;
      const x = (a + f + K[i] + m[w + g]) | 0;
      const s = R[(i >> 4) * 4 + (i % 4)];
      b = (b + ((x << s) | (x >>> (32 - s)))) | 0;
      a = tmp;
    }
    a0 = (a0 + a) | 0; b0 = (b0 + b) | 0; c0 = (c0 + c) | 0; d0 = (d0 + d) | 0;
  }
  const out = new Uint8Array(16);
  [a0, b0, c0, d0].forEach((v, k) => { for (let j = 0; j < 4; j++) out[k * 4 + j] = (v >>> (j * 8)) & 255; });
  return out;
}

/** Identifiant Synthesia d'un fichier : MD5 en base 64. */
export function synthesiaId(buf) {
  const h = md5(new Uint8Array(buf));
  return btoa(String.fromCharCode(...h));
}
export function md5Hex(buf) { return [...md5(new Uint8Array(buf))].map((b) => b.toString(16).padStart(2, '0')).join(''); }

// ─────────────────────────────────────────────────────── lecture du XML ──

export function parseSynthesia(xml) {
  const dom = new DOMParser().parseFromString(xml, 'application/xml');
  if (dom.querySelector('parsererror')) throw new Error('Fichier .synthesia illisible.');
  return [...dom.querySelectorAll('Songs > Song')].map((el) => {
    const g = (k) => el.getAttribute(k) || '';
    return {
      uniqueId: g('UniqueId'), title: g('Title'), subtitle: g('Subtitle'), composer: g('Composer'), arranger: g('Arranger'),
      madeFamousBy: g('MadeFamousBy'), difficulty: g('Difficulty'), parts: g('Parts'), fingerHints: g('FingerHints'),
      bookmarks: g('Bookmarks').split(';').map((s) => s.trim()).filter(Boolean).map((s) => {
        const [m, ...lab] = s.split(',');
        return { measure: Math.max(1, parseInt(m, 10) || 1), label: lab.join(',').trim() };
      }),
    };
  });
}

/** L'entrée qui correspond au MIDI (par son MD5), ou la seule du fichier. */
export function pickSynthesiaSong(entries, uniqueId) {
  return entries.find((e) => e.uniqueId === uniqueId) || (entries.length === 1 ? entries[0] : null);
}

// ─────────────────────────────── notes d'une piste, dans l'ordre du fichier ──

function notesByFileTrack(tracks) {
  const map = new Map();
  for (const tr of tracks) for (const n of tr.notes) (map.get(tr.index) || map.set(tr.index, []).get(tr.index)).push(n);
  for (const list of map.values()) list.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || a.t - b.t);
  return map;
}

/** Première note (index) qui commence dans la mesure m (1 = début). */
function firstInMeasure(list, m, downbeats) {
  if (m <= 1 || !downbeats?.length) return 0;
  const t = downbeats[Math.min(m - 1, downbeats.length - 1)] - 0.002;
  const i = list.findIndex((n) => n.t >= t);
  return i < 0 ? list.length : i;
}

/** Applique « Parts » : note.part = 'L' | 'R' | 'B' (fond) | 'X' (ignorée). */
export function applyParts(tracks, parts, downbeats) {
  if (!parts) return false;
  const map = notesByFileTrack(tracks);
  for (const list of map.values()) for (const n of list) n.part = 'B';
  let list = map.get(0) || [], ptr = 0, any = false;
  const re = /t(\d+):|m(\d+):|([LRBX-])(A|\d+)?/gi;
  for (const m of String(parts).matchAll(re)) {
    if (m[1] != null) { list = map.get(+m[1]) || []; ptr = 0; continue; }
    if (m[2] != null) { ptr = firstInMeasure(list, +m[2], downbeats); continue; }
    const h = m[3].toUpperCase();
    if (m[4] && m[4].toUpperCase() === 'A') { if (h !== '-') for (const n of list) n.part = h; ptr = 0; any = true; continue; }
    const cnt = m[4] ? +m[4] : 1;
    for (let k = 0; k < cnt && ptr < list.length; k++, ptr++) if (h !== '-') { list[ptr].part = h; any = true; }
  }
  return any;
}

/** Applique « FingerHints » : note.finger = 1..5, note.fingerHand = 'L' | 'R'. */
export function applyFingers(tracks, hints, downbeats) {
  if (!hints) return 0;
  const map = notesByFileTrack(tracks);
  let list = map.get(0) || [], ptr = 0, count = 0;
  const re = /t(\d+):|m(\d+):|([0-9])((?:s[0-9])*)|(-)/g;
  for (const m of String(hints).matchAll(re)) {
    if (m[1] != null) { list = map.get(+m[1]) || []; ptr = 0; continue; }
    if (m[2] != null) { ptr = firstInMeasure(list, +m[2], downbeats); continue; }
    if (m[5]) { ptr++; continue; }
    const d = +m[3];
    const n = list[ptr++];
    if (!n) continue;
    n.finger = d >= 1 && d <= 5 ? d : d === 0 ? 5 : d - 5;
    n.fingerHand = d >= 1 && d <= 5 ? 'L' : 'R';
    count++;
  }
  return count;
}
