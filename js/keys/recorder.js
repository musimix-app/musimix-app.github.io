// MusiMix Piano — enregistrer sa prise : notes, nuances et pédale jouées au clavier,
// réécoute, export MIDI (fichier standard) et audio (rendu hors ligne avec les mêmes sons).

import { KeysSynth } from './synth.js';

/** events : [{ t (s), type: 'on'|'off'|'ped', pitch, vel, down }] → notes { t, d, ring, pitch, vel } + pédale [{ s, e }]. */
export function takeNotes(events) {
  const ev = [...events].sort((a, b) => a.t - b.t);
  const open = new Map(), notes = [], pedal = [];
  let pedDown = null;
  const end = ev.length ? ev[ev.length - 1].t : 0;
  for (const e of ev) {
    if (e.type === 'on') {
      if (open.has(e.pitch)) { const n = open.get(e.pitch); n.d = Math.max(0.03, e.t - n.t); }
      const n = { t: e.t, d: 0, pitch: e.pitch, vel: e.vel };
      open.set(e.pitch, n); notes.push(n);
    } else if (e.type === 'off') {
      const n = open.get(e.pitch);
      if (n) { n.d = Math.max(0.03, e.t - n.t); open.delete(e.pitch); }
    } else if (e.type === 'ped') {
      if (e.down && pedDown == null) pedDown = e.t;
      else if (!e.down && pedDown != null) { pedal.push({ s: pedDown, e: e.t }); pedDown = null; }
    }
  }
  for (const n of open.values()) n.d = Math.max(0.1, end - n.t + 0.3);
  if (pedDown != null) pedal.push({ s: pedDown, e: end + 0.5 });
  // résonance avec la pédale : la note sonne jusqu'au relâchement (ou jusqu'à la même touche rejouée)
  for (const n of notes) {
    const off = n.t + n.d;
    const p = pedal.find((x) => x.s <= off + 0.001 && x.e > off);
    if (p) n.ring = p.e - n.t;
  }
  for (const n of notes) {
    if (!n.ring) continue;
    const nx = notes.find((x) => x.pitch === n.pitch && x.t > n.t + 0.01);
    if (nx && n.t + n.ring > nx.t) n.ring = Math.max(n.d, nx.t - n.t);
  }
  return { notes, pedal, duration: Math.max(0, ...notes.map((n) => n.t + (n.ring || n.d))) };
}

/** Fichier MIDI standard (format 0, 120 bpm, 480 ticks par noire) : notes, nuances, pédale. */
export function takeToMidi(events, name = 'Ma prise') {
  const ev = [...events].sort((a, b) => a.t - b.t || (a.type === 'off' ? -1 : 1));
  const t0 = ev[0]?.t ?? 0;
  const bytes = [];
  const vlq = (v) => { const out = [v & 0x7f]; while ((v >>= 7)) out.unshift((v & 0x7f) | 0x80); bytes.push(...out); };
  const nameB = [...new TextEncoder().encode(name)];
  vlq(0); bytes.push(0xff, 0x03); vlq(nameB.length); bytes.push(...nameB);
  vlq(0); bytes.push(0xff, 0x51, 0x03, 0x07, 0xa1, 0x20); // 500 000 µs par noire
  vlq(0); bytes.push(0xc0, 0x00); // piano
  let last = 0;
  for (const e of ev) {
    const tick = Math.max(last, Math.round((e.t - t0) * 960));
    vlq(tick - last); last = tick;
    if (e.type === 'on') bytes.push(0x90, e.pitch & 0x7f, Math.max(1, Math.min(127, Math.round(e.vel * 127))));
    else if (e.type === 'off') bytes.push(0x80, e.pitch & 0x7f, 64);
    else bytes.push(0xb0, 64, e.down ? 127 : 0);
  }
  vlq(480); bytes.push(0xff, 0x2f, 0x00);
  const head = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xe0];
  const len = bytes.length;
  const trk = [0x4d, 0x54, 0x72, 0x6b, (len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255];
  return new Blob([new Uint8Array([...head, ...trk, ...bytes])], { type: 'audio/midi' });
}

/** Rendu audio hors ligne (mêmes sons que l'appli) → Blob Ogg Opus, ou WAV si l'encodage Opus manque. */
export async function renderTake(events, { inst = 'grand', master = 0.9, soundsBase = 'sounds/' } = {}) {
  const { notes } = takeNotes(events);
  if (!notes.length) throw new Error('Rien à exporter');
  const t0 = notes[0].t - 0.3;
  const dur = Math.max(...notes.map((n) => n.t - t0 + (n.ring || n.d))) + 2.5;
  const rate = 48000;
  const off = new OfflineAudioContext(2, Math.ceil(dur * rate), rate);
  const sy = new KeysSynth(off, off.destination, soundsBase);
  sy.out.gain.value = master;
  await sy.bank.load(inst).catch(() => {});
  for (const n of notes) sy.note(n.pitch, n.vel, n.t - t0, Math.max(0.08, n.ring || n.d), { bus: 'live', inst });
  const buf = await off.startRendering();
  const ch = [buf.getChannelData(0), buf.getChannelData(1)];
  try {
    const { encodeOpus, opusSupported } = await import('../opus.js');
    if (opusSupported()) return { blob: await encodeOpus(ch, rate, { bitrate: 192000 }), ext: 'ogg' };
  } catch { /* WAV ci-dessous */ }
  const { encodeWav } = await import('../wav.js');
  return { blob: encodeWav(ch, rate, 16), ext: 'wav' };
}

export function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
