// MusiMix Piano — horloge (audio MusiMix ou horloge interne) et entraînement :
// notes justes / fausses / manquées, précision, série, mode « attendre » façon Synthesia.

/** Horloge du morceau : suit le moteur audio MusiMix s'il a des pistes, sinon une horloge interne. */
export class Transport extends EventTarget {
  constructor(engine, ctx) {
    super();
    this.engine = engine; this.ctx = ctx;
    this.rate = 1; this.duration = 0;
    this._t = 0; this._at = 0; this._run = false;
    this.offset = 0; // décalage audio ↔ notes (s)
  }
  get hasAudio() { return this.engine.tracks.length > 0; }
  get playing() { return this.hasAudio ? this.engine.playing : this._run; }
  get time() {
    if (this.hasAudio) return this.engine.currentTime - this.offset;
    return this._run ? this._t + (this.ctx.currentTime - this._at) * this.rate : this._t;
  }
  /** Temps du morceau → temps du contexte audio (pour programmer les notes). */
  ctxTimeOf(t) { return this.ctx.currentTime + (t - this.time) / this.rate; }
  async play() {
    if (this.playing) return;
    if (this.hasAudio) { await this.engine.play(); }
    else { this._at = this.ctx.currentTime; this._run = true; }
    this.dispatchEvent(new Event('play'));
  }
  pause() {
    if (!this.playing) return;
    if (this.hasAudio) this.engine.pause();
    else { this._t = this.time; this._run = false; }
    this.dispatchEvent(new Event('pause'));
  }
  async seek(t) {
    t = Math.max(-2, Math.min(t, this.duration));
    if (this.hasAudio) await this.engine.seek(Math.max(0, t + this.offset));
    this._t = t; this._at = this.ctx.currentTime;
    this.dispatchEvent(new CustomEvent('seek', { detail: t }));
  }
  setRate(r) {
    const t = this.time;
    this.rate = r;
    if (this.hasAudio) this.engine.setRate(r);
    this._t = t; this._at = this.ctx.currentTime;
  }
}

export const TOLERANCE = { easy: 0.3, normal: 0.2, strict: 0.12 };

/** Entraînement sur les notes « à jouer » (n.play === true). */
export class Practice extends EventTarget {
  constructor() {
    super();
    this.notes = [];
    this.wait = false;
    this.tol = TOLERANCE.normal;
    this.reset();
  }
  setNotes(notes) { this.notes = notes.filter((n) => n.play); this.reset(); }
  reset() {
    this.stats = { hit: 0, wrong: 0, miss: 0, perfect: 0, streak: 0, best: 0 };
    this._ptr = 0;
    for (const n of this.notes) { n.state = undefined; n.hitDelta = undefined; }
    this.waitingFor = null;
  }
  /** Après un saut : les notes passées ne comptent plus. */
  rewindTo(t) {
    for (const n of this.notes) if (n.t >= t - 0.05) { n.state = undefined; }
    this._ptr = lower(this.notes, t - 1);
    this.waitingFor = null;
  }
  get accuracy() {
    const s = this.stats, tot = s.hit + s.miss + s.wrong * 0.5;
    return tot ? Math.round((100 * s.hit) / tot) : 100;
  }

  /** Une touche jouée au temps T du morceau (rate = vitesse, pour la tolérance). Retourne 'ok' | 'bad'. */
  press(pitch, T, rate = 1) {
    const tol = this.tol * rate;
    let best = null, bd = Infinity;
    const from = lower(this.notes, T - tol - 0.01);
    for (let i = from; i < this.notes.length; i++) {
      const n = this.notes[i];
      if (n.t > T + tol + (this.wait ? 0.35 * rate : 0)) break;
      if (n.pitch !== pitch || n.state) continue;
      const d = Math.abs(n.t - T);
      if (d < bd) { bd = d; best = n; }
    }
    // en mode attente, la note attendue compte même si l'horloge est arrêtée un peu avant
    if (!best && this.waitingFor) best = this.waitingFor.find((n) => n.pitch === pitch && !n.state) || null;
    if (best) {
      best.state = 'hit';
      best.hitDelta = best.t - T;
      const s = this.stats;
      s.hit++; s.streak++; s.best = Math.max(s.best, s.streak);
      if (bd < 0.07 * rate) s.perfect++;
      this.dispatchEvent(new CustomEvent('hit', { detail: { note: best, perfect: bd < 0.07 * rate } }));
      return 'ok';
    }
    this.stats.wrong++; this.stats.streak = 0;
    this.dispatchEvent(new CustomEvent('wrong', { detail: { pitch } }));
    return 'bad';
  }

  /** À chaque image : notes manquées ; en mode attente, renvoie le temps où il faut s'arrêter. */
  update(T, rate = 1) {
    const tol = this.tol * rate;
    if (this.wait) {
      // groupe de notes (accord) qui arrive : on s'arrête dessus tant qu'il n'est pas joué
      let i = this._ptr;
      while (i < this.notes.length && this.notes[i].state) i++;
      this._ptr = i;
      const n = this.notes[i];
      if (!n) { this.waitingFor = null; return null; }
      const group = [];
      for (let k = i; k < this.notes.length && this.notes[k].t < n.t + 0.06; k++) if (!this.notes[k].state) group.push(this.notes[k]);
      this.waitingFor = T >= n.t - 0.02 ? group : null;
      return n.t;
    }
    while (this._ptr < this.notes.length && this.notes[this._ptr].t < T - tol) {
      const n = this.notes[this._ptr++];
      if (!n.state) {
        n.state = 'miss';
        this.stats.miss++; this.stats.streak = 0;
        this.dispatchEvent(new CustomEvent('miss', { detail: { note: n } }));
      }
    }
    return null;
  }
}

function lower(arr, t) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].t < t) lo = m + 1; else hi = m; }
  return lo;
}
