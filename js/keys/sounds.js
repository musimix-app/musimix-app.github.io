// MusiMix Piano — banque de sons échantillonnés.
// Piano à queue : Salamander Grand Piano V3 (Yamaha C5 enregistré par Alexander Holm,
// CC BY 3.0), 8 nuances de frappe × 30 notes (Opus 160 kb/s stéréo) + étouffoirs et pédale.
// Guitares, basses, cordes, vents, cuivres : vrais enregistrements (tonejs-instruments, CC BY 3.0).
// Claviers, électro, chœur : banque MusyngKite (gleitz/midi-js-soundfonts, CC BY-SA 3.0).
//
// Chaque son = deux fichiers : <nom>.json (index : { zones[], rel[], pedal, gain, sustain }, positions o/l)
// et <nom>.ogg (les échantillons Ogg Opus enchaînés, un flux par note).

export const INSTRUMENTS = [
  { id: 'grand', name: 'Piano à queue (Yamaha C5)', group: 'Pianos', files: ['grand-v9', 'grand-v13', 'grand-v6', 'grand-v16', 'grand-v11', 'grand-v3', 'grand-v14', 'grand-v1', 'grand-rel'], gm: [0, 1, 2, 3], star: true },
  { id: 'epiano', name: 'Piano électrique (Rhodes)', group: 'Pianos', files: ['epiano'], gm: [4] },
  { id: 'dx', name: 'Piano électrique FM', group: 'Pianos', files: ['dx'], gm: [5] },
  { id: 'harpsichord', name: 'Clavecin', group: 'Pianos', files: ['harpsichord'], gm: [6, 7] },
  { id: 'organ', name: 'Orgue Hammond', group: 'Orgues', files: ['organ'], gm: [16, 17, 18], sustain: true },
  { id: 'church', name: 'Grand orgue', group: 'Orgues', files: ['church'], gm: [19, 20], sustain: true },
  { id: 'accordion', name: 'Accordéon', group: 'Orgues', files: ['accordion'], gm: [21, 22, 23], sustain: true },
  { id: 'vibes', name: 'Vibraphone', group: 'Percussions', files: ['vibes'], gm: [11, 8, 9, 14] },
  { id: 'marimba', name: 'Marimba', group: 'Percussions', files: ['marimba'], gm: [12, 15] },
  { id: 'xylophone', name: 'Xylophone', group: 'Percussions', files: ['xylophone'], gm: [13] },
  { id: 'musicbox', name: 'Boîte à musique', group: 'Percussions', files: ['musicbox'], gm: [10] },
  { id: 'nylon', name: 'Guitare classique', group: 'Guitares', files: ['nylon'], gm: [24, 104, 105, 106, 107] },
  { id: 'steel', name: 'Guitare folk', group: 'Guitares', files: ['steel'], gm: [25] },
  { id: 'eguitar', name: 'Guitare électrique', group: 'Guitares', files: ['eguitar'], gm: [26, 27, 28, 31] },
  { id: 'distguitar', name: 'Guitare saturée', group: 'Guitares', files: ['distguitar'], gm: [29, 30] },
  { id: 'abass', name: 'Contrebasse', group: 'Basses', files: ['abass'], gm: [32] },
  { id: 'ebass', name: 'Basse électrique', group: 'Basses', files: ['ebass'], gm: [33, 34] },
  { id: 'fretless', name: 'Basse fretless', group: 'Basses', files: ['fretless'], gm: [35] },
  { id: 'slapbass', name: 'Basse slap', group: 'Basses', files: ['slapbass'], gm: [36, 37] },
  { id: 'violin', name: 'Violon', group: 'Cordes', files: ['violin'], gm: [40, 41, 110], sustain: true },
  { id: 'cello', name: 'Violoncelle', group: 'Cordes', files: ['cello'], gm: [42, 43], sustain: true },
  { id: 'strings', name: 'Ensemble de cordes', group: 'Cordes', files: ['strings'], gm: [44, 45, 48, 49, 50, 51], sustain: true },
  { id: 'harp', name: 'Harpe', group: 'Cordes', files: ['harp'], gm: [46] },
  { id: 'trumpet', name: 'Trompette', group: 'Cuivres', files: ['trumpet'], gm: [56, 59], sustain: true },
  { id: 'trombone', name: 'Trombone', group: 'Cuivres', files: ['trombone'], gm: [57], sustain: true },
  { id: 'horn', name: 'Cor', group: 'Cuivres', files: ['horn'], gm: [60], sustain: true },
  { id: 'tuba', name: 'Tuba', group: 'Cuivres', files: ['tuba'], gm: [58], sustain: true },
  { id: 'brass', name: 'Section de cuivres', group: 'Cuivres', files: ['brass'], gm: [61], sustain: true },
  { id: 'sax', name: 'Saxophone', group: 'Bois', files: ['sax'], gm: [64, 65, 66, 67], sustain: true },
  { id: 'clarinet', name: 'Clarinette', group: 'Bois', files: ['clarinet'], gm: [71], sustain: true },
  { id: 'oboe', name: 'Hautbois', group: 'Bois', files: ['oboe'], gm: [68, 69], sustain: true },
  { id: 'bassoon', name: 'Basson', group: 'Bois', files: ['bassoon'], gm: [70], sustain: true },
  { id: 'flute', name: 'Flûte', group: 'Bois', files: ['flute'], gm: [72, 73, 74, 75, 76, 77, 78, 79], sustain: true },
  { id: 'choir', name: 'Chœur', group: 'Voix', files: ['choir'], gm: [52, 53, 54, 85, 91], sustain: true },
  { id: 'synthbass', name: 'Basse synthé', group: 'Électro', files: ['synthbass'], gm: [38] },
  { id: 'synthbass2', name: 'Basse synthé 2', group: 'Électro', files: ['synthbass2'], gm: [39] },
  { id: 'lead', name: 'Synthé solo (scie)', group: 'Électro', files: ['lead'], gm: [81, 82, 83, 84, 86, 87], sustain: true },
  { id: 'square', name: 'Synthé solo (carré)', group: 'Électro', files: ['square'], gm: [80], sustain: true },
  { id: 'synthbrass', name: 'Cuivres synthé', group: 'Électro', files: ['synthbrass'], gm: [62, 63], sustain: true },
  { id: 'polysynth', name: 'Synthé polyphonique', group: 'Électro', files: ['polysynth'], gm: [90, 92, 96, 97, 98], sustain: true },
  { id: 'pad', name: 'Nappe chaude', group: 'Électro', files: ['pad'], gm: [88, 89, 93, 94, 100, 101, 102, 103], sustain: true },
  { id: 'sweep', name: 'Nappe balayée', group: 'Électro', files: ['sweep'], gm: [95], sustain: true },
  { id: 'atmos', name: 'Atmosphère', group: 'Électro', files: ['atmos'], gm: [99], sustain: true },
];

export const DRUM_KITS = [
  { id: 'drums', name: 'Batterie acoustique', group: 'Batteries', files: ['drums'] },
  { id: 'drums-techno', name: 'Boîte à rythmes techno', group: 'Batteries', files: ['drums-techno'] },
  { id: 'drums-linn', name: 'Boîte à rythmes années 80', group: 'Batteries', files: ['drums-linn'] },
  { id: 'drums-cr78', name: 'Boîte à rythmes vintage', group: 'Batteries', files: ['drums-cr78'] },
];


export const CREDITS = 'Piano : Salamander Grand Piano V3 (Yamaha C5), Alexander Holm, CC BY 3.0. Guitares, basse, cordes, vents et cuivres : tonejs-instruments (Université de l’Iowa, Karoryfer, VSCO 2 Community), CC BY 3.0. Autres sons : MusyngKite (gleitz/midi-js-soundfonts), CC BY-SA 3.0. Batteries : Tone.js.';

const BY_ID = Object.fromEntries([...INSTRUMENTS, ...DRUM_KITS].map((i) => [i.id, i]));

/** Instrument de la banque le plus proche d'un programme General MIDI. */
export function instrumentForProgram(p = 0) {
  const hit = INSTRUMENTS.find((i) => i.gm.includes(p));
  if (hit) return hit.id;
  if (p >= 104 && p <= 111) return 'nylon';
  if (p >= 112 && p <= 119) return 'marimba';
  return 'grand';
}

let shared = null;
/**
 * Banque unique pour toute l'appli (Piano, Composition, import MIDI) : chaque son n'est
 * téléchargé et décodé qu'une fois. Le décodage passe par un OfflineAudioContext : les
 * AudioBuffer servent ensuite dans n'importe quel contexte (lecture ou rendu hors ligne).
 */
export function sharedBank(base) {
  if (!shared) {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    shared = new SoundBank(new OAC(2, 1, 48000), base || new URL('../../assets/sounds/', import.meta.url).href);
  }
  return shared;
}

export class SoundBank extends EventTarget {
  constructor(ctx, base = 'sounds/') {
    super();
    this.ctx = ctx;
    this.base = base;
    this.inst = new Map();    // id → Instrument
    this.loading = new Map(); // id → Promise
  }
  get(id) { return this.inst.get(id); }
  ready(id) { const i = this.inst.get(id); return !!i && i.zones.length > 0; }

  /** Charge un instrument (le piano arrive par nuances : jouable dès la première). */
  load(id) {
    if (this.loading.has(id)) return this.loading.get(id);
    const def = BY_ID[id];
    if (!def) return Promise.resolve(null);
    const inst = new Instrument(def);
    this.inst.set(id, inst);
    const p = (async () => {
      let done = 0;
      for (const f of def.files) {
        try {
          const [meta, buf] = await Promise.all([
            fetch(this.base + f + '.json').then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); }),
            fetch(this.base + f + '.ogg').then((r) => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); }),
          ]);
          await inst.addPack(this.ctx, meta, buf);
        } catch (e) { console.warn('Son non chargé', f, e); inst.failed = true; }
        done++;
        this.dispatchEvent(new CustomEvent('progress', { detail: { id, done, total: def.files.length } }));
      }
      inst.complete = true;
      this.dispatchEvent(new CustomEvent('loaded', { detail: { id } }));
      return inst;
    })();
    this.loading.set(id, p);
    return p;
  }
}

class Instrument {
  constructor(def) {
    this.def = def;
    this.zones = [];       // { root, lo, hi, vlo, vhi, buffer, tune, loop }
    this.rel = new Map();  // touche → AudioBuffer (bruit d'étouffoir)
    this.pedal = {};
    this.gain = 1;
    this.sustain = !!def.sustain;
    this.drumMap = null;
  }

  async addPack(ctx, meta, buf) {
    const dec = (o, l) => ctx.decodeAudioData(buf.slice(o, o + l));
    if (meta.gain) this.gain = meta.gain;
    if (meta.sustain != null) this.sustain = meta.sustain;
    if (meta.drums) this.drumMap = meta.drums;
    const zones = await Promise.all((meta.zones || []).map(async (z) => ({ ...z, buffer: await dec(z.o, z.l) })));
    this.zones.push(...zones);
    for (const r of meta.rel || []) this.rel.set(r.key, await dec(r.o, r.l));
    for (const [k, r] of Object.entries(meta.pedal || {})) this.pedal[k] = await dec(r.o, r.l);
  }

  zoneFor(pitch, vel127) {
    let best = null, bs = Infinity;
    for (const z of this.zones) {
      const kd = pitch < z.lo ? z.lo - pitch : pitch > z.hi ? pitch - z.hi : 0;
      const vd = vel127 < z.vlo ? z.vlo - vel127 : vel127 > z.vhi ? vel127 - z.vhi : 0;
      const s = kd * 100 + vd + Math.abs(pitch - z.root) * 0.01;
      if (s < bs) { bs = s; best = z; }
    }
    return best;
  }

  /** Joue une note ; retourne la voix (pour l'arrêter). */
  noteOn(ctx, dest, pitch, vel, when) {
    if (this.drumMap) return this._drum(ctx, dest, pitch, vel, when);
    const v127 = Math.max(1, Math.min(127, Math.round(vel * 127)));
    const z = this.zoneFor(pitch, v127);
    if (!z) return null;
    const src = ctx.createBufferSource();
    src.buffer = z.buffer;
    src.playbackRate.value = 2 ** ((pitch - z.root + (z.tune || 0) / 100) / 12);
    if (z.loop) { src.loop = true; src.loopStart = z.loop[0]; src.loopEnd = z.loop[1]; }
    const g = ctx.createGain();
    // nuance à l'intérieur d'une couche : léger, les couches font déjà le gros du travail
    const within = z.vhi > z.vlo ? (v127 - z.vlo) / (z.vhi - z.vlo) : 1;
    const layered = this.zones.some((x) => x !== z && x.root === z.root);
    // les couches du Salamander gardent leur niveau d'origine (~12 dB entre pp et ff) : on élargit un peu
    const amp = this.gain * (layered ? (0.5 + 0.5 * vel ** 1.3) * (0.82 + 0.18 * within) : 0.12 + 0.88 * vel ** 1.6);
    g.gain.setValueAtTime(amp, when);
    src.connect(g).connect(dest);
    src.start(when);
    const voice = { src, g, pitch, vel, amp, inst: this, end: when + z.buffer.duration / src.playbackRate.value };
    src.onended = () => { try { g.disconnect(); } catch { /* */ } voice.done = true; };
    return voice;
  }

  /** Relâche une voix (étouffoir). */
  noteOff(ctx, voice, when, dest) {
    if (!voice || voice.done || voice.released) return;
    voice.released = true;
    // pas d'étouffoirs au-dessus de Fa#6 sur un vrai piano : les aigus résonnent
    const damped = !(this.def.id === 'grand' && voice.pitch > 89);
    const tc = this.sustain ? 0.09 : damped ? (voice.pitch < 48 ? 0.16 : voice.pitch < 72 ? 0.1 : 0.07) : 0.9;
    try {
      voice.g.gain.cancelScheduledValues(when);
      voice.g.gain.setTargetAtTime(0, when, tc);
      voice.src.stop(when + tc * 8);
    } catch { /* */ }
    const rb = this.rel.get(voice.pitch);
    if (rb && damped && dest) {
      const s = ctx.createBufferSource(); s.buffer = rb;
      const rg = ctx.createGain(); rg.gain.value = 0.055 * (0.4 + voice.vel);
      s.connect(rg).connect(dest); s.start(when);
      voice.relSrc = s;
    }
  }

  pedalNoise(ctx, dest, down, when) {
    const b = this.pedal[down ? 'down' : 'up'];
    if (!b) return;
    const s = ctx.createBufferSource(); s.buffer = b;
    const g = ctx.createGain(); g.gain.value = 0.12;
    s.connect(g).connect(dest); s.start(when);
  }

  _drum(ctx, dest, pitch, vel, when) {
    const name = this.drumMap[pitch] || this.drumMap.default;
    const z = this.zones.find((x) => x.name === name);
    if (!z) return null;
    const src = ctx.createBufferSource(); src.buffer = z.buffer;
    if (z.rate) src.playbackRate.value = z.rate;
    const g = ctx.createGain(); g.gain.value = this.gain * (0.15 + 0.85 * vel);
    src.connect(g).connect(dest); src.start(when);
    return { src, g, pitch, vel, inst: this, end: when + z.buffer.duration, drum: true };
  }
}
