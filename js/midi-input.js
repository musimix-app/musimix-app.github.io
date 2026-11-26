// MusiMix — clavier MIDI en direct (Web MIDI) : notes tenues, pédale de sustain, touche « avancer » apprise.
// Événements : 'notes' (detail: { notes: number[] }), 'advance', 'devices', 'learned' (detail: note).

import { parseChord, chordPcs } from './theory.js';
import { isSurfaceName } from './surface.js';

const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const QUALITIES = [
  ['', [0, 4, 7]], ['m', [0, 3, 7]], ['7', [0, 4, 7, 10]], ['m7', [0, 3, 7, 10]], ['maj7', [0, 4, 7, 11]],
  ['sus4', [0, 5, 7]], ['sus2', [0, 2, 7]], ['dim', [0, 3, 6]], ['aug', [0, 4, 8]], ['6', [0, 4, 7, 9]], ['m6', [0, 3, 7, 9]],
  ['add9', [0, 2, 4, 7]], ['m7b5', [0, 3, 6, 10]], ['5', [0, 7]],
];
export const noteName = (n) => NAMES[n % 12] + (Math.floor(n / 12) - 1);

/** Nom d'accord pour un ensemble de notes MIDI (ou null). La basse départage les renversements. */
export function nameChord(notes) {
  if (!notes.length) return null;
  const pcs = new Set(notes.map((n) => n % 12));
  const bass = Math.min(...notes) % 12;
  let best = null;
  for (let r = 0; r < 12; r++) {
    for (const [suf, iv] of QUALITIES) {
      const ch = iv.map((i) => (r + i) % 12);
      const core = iv.length >= 3 ? ch.filter((_, k) => iv[k] !== 7) : ch; // la quinte peut manquer
      if (!core.every((p) => pcs.has(p)) || ![...pcs].every((p) => ch.includes(p))) continue;
      const score = ch.filter((p) => pcs.has(p)).length * 2 - iv.length + (r === bass ? 1.5 : 0);
      if (!best || score > best.score) best = { score, name: NAMES[r] + suf + (r !== bass ? '/' + NAMES[bass] : '') };
    }
  }
  return best?.name || null;
}

/** Les notes tenues forment-elles cet accord ? (quinte facultative, basse libre, aucune note étrangère) */
export function matchesChord(notes, name) {
  const ch = parseChord(name);
  if (!ch || notes.length < 2) return false;
  const pcs = new Set(notes.map((n) => n % 12));
  const want = chordPcs(ch);
  if (ch.bass != null) want.push(ch.bass);
  const fifth = (ch.root + 7) % 12;
  const required = want.filter((p, i) => !(p === fifth && want.length >= 3) && want.indexOf(p) === i);
  return required.every((p) => pcs.has(p)) && [...pcs].every((p) => want.includes(p));
}

export class Midi extends EventTarget {
  constructor() {
    super();
    this.access = null;
    this.held = new Set();
    this.sustain = false;
    this.advanceNote = null; // note MIDI qui sert de touche « avancer »
    this.learning = false;
    this._t = 0;
  }
  get supported() { return !!navigator.requestMIDIAccess; }
  get devices() { return this.access ? [...this.access.inputs.values()].map((i) => i.name || 'Clavier MIDI') : []; }

  async enable() {
    if (this.access) return true;
    if (!this.supported) throw new Error('Ce navigateur ne gère pas le MIDI (utilise Chrome ou Edge ; Safari et iPhone ne le permettent pas).');
    this.access = await navigator.requestMIDIAccess({ sysex: false });
    this._bind();
    this.access.onstatechange = () => { this._bind(); this.dispatchEvent(new Event('devices')); };
    return true;
  }
  disable() {
    if (!this.access) return;
    for (const i of this.access.inputs.values()) i.onmidimessage = null;
    this.access.onstatechange = null;
    this.access = null;
    this.held.clear();
  }
  learn() { this.learning = true; }
  // le Zoom R20 (surface de contrôle) n'est pas un clavier : ses boutons ne doivent pas jouer d'accords
  _bind() { for (const i of this.access.inputs.values()) i.onmidimessage = this.skipSurface && (this.surfacePort ? i.name === this.surfacePort : isSurfaceName(i.name)) ? null : (e) => this._msg(e.data); }
  _emit() {
    clearTimeout(this._t);
    // laisse 70 ms pour que toutes les notes d'un accord arrivent
    this._t = setTimeout(() => this.dispatchEvent(new CustomEvent('notes', { detail: { notes: [...this.held].sort((a, b) => a - b) } })), 70);
  }
  _msg([st, d1, d2]) {
    const cmd = st & 0xf0;
    if (cmd === 0x90 && d2 > 0) {
      if (this.learning) { this.learning = false; this.advanceNote = d1; this.dispatchEvent(new CustomEvent('learned', { detail: d1 })); return; }
      if (d1 === this.advanceNote) { this.dispatchEvent(new Event('advance')); return; }
      this.held.add(d1); this._emit();
    } else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) {
      if (d1 === this.advanceNote) return;
      if (this.held.delete(d1)) this._emit();
    } else if (cmd === 0xb0 && d1 === 64) {
      const down = d2 >= 64;
      if (down && !this.sustain) this.dispatchEvent(new Event('advance'));
      this.sustain = down;
    }
  }
}

export const midi = new Midi();
