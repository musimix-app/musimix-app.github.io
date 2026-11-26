// MusiMix — Zoom R20 (ou toute surface Mackie Control) en USB : transport et faders en direct.
// Le R20 (firmware 2.0+) en mode interface audio envoie le protocole Mackie Control :
//   faders  : pitch bend, canal 0–7 = pistes, canal 8 = master (14 bits)
//   boutons : notes (vélocité 127 = appui) — PLAY 94, STOP 93, REC 95, << 91, >> 92, CYCLE 86,
//             SOLO 8–15, MUTE 16–23, SELECT 24–31, BANK ◀ 46 / ▶ 47
// Événements : 'fader' {ch, v (0–1)}, 'button' {note}, 'devices'.

export const MCU = { PLAY: 94, STOP: 93, REC: 95, REW: 91, FF: 92, CYCLE: 86, BANK_L: 46, BANK_R: 47, SOLO: 8, MUTE: 16, SELECT: 24 };
export const isSurfaceName = (n) => /zoom|r20|mackie|mcu/i.test(n || '');

export class Surface extends EventTarget {
  constructor() { super(); this.access = null; this.ins = []; this.outs = []; this.port = null; this._h = (e) => this._msg(e.data); }
  get supported() { return !!navigator.requestMIDIAccess; }
  get devices() { return this.ins.map((i) => i.name || 'Surface'); }

  async enable() {
    if (this.access) return;
    if (!this.supported) throw new Error('Ce navigateur ne gère pas le MIDI : utilise Chrome ou Edge sur le PC.');
    // sysex si possible : sert à la poignée de main Mackie Control (sinon on s'en passe)
    try { this.access = await navigator.requestMIDIAccess({ sysex: true }); this.sysex = true; }
    catch { this.access = await navigator.requestMIDIAccess({ sysex: false }); this.sysex = false; }
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
    // port choisi à la main (Tester mon matériel) sinon reconnaissance par le nom
    const pick = (p) => (this.port ? p.name === this.port : isSurfaceName(p.name) || isSurfaceName(p.manufacturer));
    this.ins = [...this.access.inputs.values()].filter(pick);
    this.outs = [...this.access.outputs.values()].filter(pick);
    for (const i of this.ins) { i.addEventListener('midimessage', this._h); i.open?.().catch(() => {}); } // addEventListener n'ouvre pas le port tout seul
    for (const o of this.outs) o.open?.().catch(() => {});
    this.hello();
  }

  /** Poignée de main Mackie Control : « qui es-tu ? » envoyé à la surface (MCU 0x14, extender 0x15). */
  hello() {
    if (!this.sysex) return;
    for (const o of this.outs) for (const id of [0x14, 0x15]) { try { o.send([0xf0, 0x00, 0x00, 0x66, id, 0x00, 0xf7]); } catch { /* */ } }
  }

  _sysex(d) {
    // F0 00 00 66 id 01 <série 7> <défi 4> F7 → réponse 02 <série> <réponse 4>
    if (d.length < 18 || d[1] !== 0 || d[2] !== 0 || d[3] !== 0x66 || d[5] !== 0x01) return;
    const id = d[4], serial = [...d.slice(6, 13)], [c1, c2, c3, c4] = d.slice(13, 17);
    const r = [
      0x7f & (c1 + (c2 ^ 0x0a) - c4),
      0x7f & ((c3 >> 4) ^ (c1 + c4)),
      0x7f & (c4 - (c3 << 2) ^ (c1 | c2)),
      0x7f & (c2 - c3 + (0xf0 ^ (c4 << 4))),
    ];
    for (const o of this.outs) { try { o.send([0xf0, 0x00, 0x00, 0x66, id, 0x02, ...serial, ...r, 0xf7]); } catch { /* */ } }
    this.dispatchEvent(new Event('online'));
  }

  _msg(data) {
    const [st, d1, d2] = data;
    if (st === 0xf0) { this._sysex(data); return; }
    const cmd = st & 0xf0, ch = st & 0x0f;
    if (cmd === 0xe0) this.dispatchEvent(new CustomEvent('fader', { detail: { ch, v: ((d2 << 7) | d1) / 16383 } }));
    else if (cmd === 0x90 && d2 > 0) this.dispatchEvent(new CustomEvent('button', { detail: { note: d1 } }));
    // certaines surfaces envoient les faders en contrôleurs : volume (CC 7) par canal, ou CC 0–8 sur le canal 1
    else if (cmd === 0xb0 && d1 === 7) this.dispatchEvent(new CustomEvent('fader', { detail: { ch, v: d2 / 127 } }));
    else if (cmd === 0xb0 && ch === 0 && d1 <= 8) this.dispatchEvent(new CustomEvent('fader', { detail: { ch: d1, v: d2 / 127 } }));
  }

  /** Voyant d'un bouton (si la surface en a). */
  led(note, on) { for (const o of this.outs) { try { o.send([0x90, note, on ? 0x7f : 0]); } catch { /* */ } } }
  /** Renvoie la position d'un fader (faders motorisés ; sans effet sur le R20). */
  fader(ch, v) { const x = Math.round(Math.max(0, Math.min(1, v)) * 16383); for (const o of this.outs) { try { o.send([0xe0 | ch, x & 0x7f, x >> 7]); } catch { /* */ } } }
}

export const surface = new Surface();
