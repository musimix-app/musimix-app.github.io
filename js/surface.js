// MusiMix — Zoom R20 (ou toute surface Mackie Control) en USB : transport et faders en direct.
// Le R20 (firmware 2.0+) en mode interface audio envoie le protocole Mackie Control :
//   faders  : pitch bend, canal 0–7 = pistes, canal 8 = master (14 bits)
//   boutons : notes (vélocité 127 = appui) — PLAY 94, STOP 93, REC 95, << 91, >> 92, CYCLE 86,
//             SOLO 8–15, MUTE 16–23, SELECT 24–31, BANK ◀ 46 / ▶ 47
// Événements : 'fader' {ch, v (0–1)}, 'button' {note}, 'devices'.

export const MCU = { PLAY: 94, STOP: 93, REC: 95, REW: 91, FF: 92, CYCLE: 86, BANK_L: 46, BANK_R: 47, SOLO: 8, MUTE: 16, SELECT: 24 };
export const isSurfaceName = (n) => /zoom|r20|mackie|mcu/i.test(n || '');

export class Surface extends EventTarget {
  constructor() { super(); this.access = null; this.ins = []; this.outs = []; this._h = (e) => this._msg(e.data); }
  get supported() { return !!navigator.requestMIDIAccess; }
  get devices() { return this.ins.map((i) => i.name || 'Surface'); }

  async enable() {
    if (this.access) return;
    if (!this.supported) throw new Error('Ce navigateur ne gère pas le MIDI : utilise Chrome ou Edge sur le PC.');
    this.access = await navigator.requestMIDIAccess({ sysex: false });
    this._bind();
    this.access.onstatechange = () => { this._bind(); this.dispatchEvent(new Event('devices')); };
  }

  disable() {
    for (const i of this.ins) i.removeEventListener('midimessage', this._h);
    if (this.access) this.access.onstatechange = null;
    this.access = null; this.ins = []; this.outs = [];
  }

  _bind() {
    for (const i of this.ins) i.removeEventListener('midimessage', this._h);
    this.ins = [...this.access.inputs.values()].filter((i) => isSurfaceName(i.name) || isSurfaceName(i.manufacturer));
    this.outs = [...this.access.outputs.values()].filter((o) => isSurfaceName(o.name) || isSurfaceName(o.manufacturer));
    for (const i of this.ins) i.addEventListener('midimessage', this._h);
  }

  _msg([st, d1, d2]) {
    const cmd = st & 0xf0, ch = st & 0x0f;
    if (cmd === 0xe0) this.dispatchEvent(new CustomEvent('fader', { detail: { ch, v: ((d2 << 7) | d1) / 16383 } }));
    else if (cmd === 0x90 && d2 > 0) this.dispatchEvent(new CustomEvent('button', { detail: { note: d1 } }));
  }

  /** Voyant d'un bouton (si la surface en a). */
  led(note, on) { for (const o of this.outs) { try { o.send([0x90, note, on ? 0x7f : 0]); } catch { /* */ } } }
  /** Renvoie la position d'un fader (faders motorisés ; sans effet sur le R20). */
  fader(ch, v) { const x = Math.round(Math.max(0, Math.min(1, v)) * 16383); for (const o of this.outs) { try { o.send([0xe0 | ch, x & 0x7f, x >> 7]); } catch { /* */ } } }
}

export const surface = new Surface();
