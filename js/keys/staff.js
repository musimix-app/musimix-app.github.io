// MusiMix Piano — partition défilante : grande portée (clé de sol pour la main droite, clé de fa pour la gauche),
// armure d'après la tonalité, notes placées selon le temps (écriture proportionnelle), lignes supplémentaires,
// altérations, barres de mesure, accords, curseur de lecture. Les notes jouées s'allument en vert, les manquées en rouge.

import { PALETTE, lowerBound } from './roll.js';
import { inkBox } from './drills.js';

const MUSIC_FONT = "'Noto Music', 'Bravura Text', 'Segoe UI Symbol', 'Apple Symbols', serif";
const LETTERS = 'CDEFGAB';
const PC_STEP = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6]; // classe de hauteur → lettre (orthographe dièse)
const PC_STEP_FLAT = [0, 1, 1, 2, 2, 3, 4, 4, 5, 5, 6, 6];
const LETTER_PC = [0, 2, 4, 5, 7, 9, 11];
const SHARP_ORDER = [3, 0, 4, 1, 5, 2, 6]; // Fa Do Sol Ré La Mi Si
const FLAT_ORDER = [6, 2, 5, 1, 4, 0, 3];  // Si Mi La Ré Sol Do Fa
// positions (degrés depuis Do0) des altérations de l'armure, clé de sol et clé de fa
const SHARP_POS = { t: [38, 35, 39, 36, 33, 37, 34], b: [24, 21, 25, 22, 19, 23, 20] };
const FLAT_POS = { t: [34, 37, 33, 36, 32, 35, 31], b: [20, 23, 19, 22, 18, 21, 17] };
const MAJ = { C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, 'F#': 6, 'C#': 7, F: -1, Bb: -2, Eb: -3, Ab: -4, Db: -5, Gb: -6, Cb: -7 };

/** « Db », « F#m », « Am » → nombre d'altérations (+ dièses, − bémols). */
export function keyAccidentals(key) {
  const m = /^([A-G])([#b♯♭]?)(m)?/.exec(String(key || '').trim());
  if (!m) return 0;
  const tonic = m[1] + (m[2] === '♯' ? '#' : m[2] === '♭' ? 'b' : m[2]);
  if (!m[3]) return MAJ[tonic] ?? 0;
  const pc = (LETTER_PC['CDEFGAB'.indexOf(m[1])] + (m[2] === '#' || m[2] === '♯' ? 1 : m[2] ? -1 : 0) + 12) % 12;
  const rel = (pc + 3) % 12; // relatif majeur
  const name = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'][rel];
  return MAJ[name] ?? 0;
}

/** Orthographe d'une note dans la tonalité : { step (degré diatonique depuis Do0), acc (-1, 0, 1) }. */
export function spell(pitch, ks) {
  const pc = ((pitch % 12) + 12) % 12, oct = Math.floor(pitch / 12) - 1;
  const st = ks < 0 ? PC_STEP_FLAT : PC_STEP;
  let letter = st[pc];
  let acc = pc - LETTER_PC[letter];
  if (acc > 6) acc -= 12; if (acc < -6) acc += 12;
  // Mi♯ / Si♯ / Do♭ / Fa♭ seulement dans les tonalités très altérées
  if (ks >= 6 && pc === 5) { letter = 2; acc = 1; }
  if (ks >= 7 && pc === 0) { letter = 6; acc = 1; }
  if (ks <= -6 && pc === 11) { letter = 0; acc = -1; }
  let o = oct;
  if (letter === 6 && acc === 1 && pc === 0) o -= 1;
  if (letter === 0 && acc === -1 && pc === 11) o += 1;
  return { step: o * 7 + letter, acc, letter };
}

export class StaffView {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.look = 5;     // secondes visibles à droite du curseur
    this.ks = 0;
    this.notes = []; this.downbeats = []; this.chords = [];
  }
  setSong(notes, { key = '', downbeats = [], chords = [] } = {}) {
    this.notes = notes.filter((n) => !n.hidden && (n.hand === 'R' || n.hand === 'L'));
    this.ks = keyAccidentals(key);
    this.downbeats = downbeats; this.chords = chords;
  }
  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const r = this.cv.getBoundingClientRect();
    this.W = Math.max(200, r.width); this.H = Math.max(80, r.height); this.dpr = dpr;
    this.cv.width = Math.round(this.W * dpr); this.cv.height = Math.round(this.H * dpr);
    // grande portée : 4 interlignes par portée, ~7 interlignes entre les deux, de la place pour les lignes supplémentaires
    this.g = Math.max(6, Math.min(12, this.H / 24));
    const g = this.g;
    this.trebleBottom = this.H / 2 - g * 2.4;   // ligne du Mi4
    this.bassTop = this.H / 2 + g * 2.4;        // ligne du La3
    this.bassBottom = this.bassTop + 4 * g;     // ligne du Sol2
    const nAcc = Math.abs(this.ks);
    this.x0 = 14 + g * 3.4 + nAcc * g * 1.05 + g * 1.2; // après clé + armure
    this.playX = this.x0 + Math.max(g * 4, (this.W - this.x0) * 0.14);
  }
  /** y d'un degré (Do0 = 0) sur la portée de sol ('t') ou de fa ('b'). */
  yOf(step, staff) {
    const g = this.g;
    return staff === 't' ? this.trebleBottom - (step - 30) * (g / 2) : this.bassBottom - (step - 18) * (g / 2);
  }

  draw(T, { hint } = {}) {
    const { ctx, W, H, g, dpr } = this;
    if (!W) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // fond papier sombre
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#11121c'); bg.addColorStop(1, '#0c0d15');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    const pps = (W - this.playX) / this.look;
    const xOf = (t) => this.playX + (t - T) * pps;
    const tMin = T - (this.playX - this.x0) / pps, tMax = T + this.look + 0.2;

    // lignes des portées
    ctx.strokeStyle = 'rgba(255,255,255,.28)'; ctx.lineWidth = 1;
    for (let k = 0; k < 5; k++) {
      for (const y of [this.trebleBottom - k * g, this.bassBottom - k * g]) { ctx.beginPath(); ctx.moveTo(10, Math.round(y) + 0.5); ctx.lineTo(W - 6, Math.round(y) + 0.5); ctx.stroke(); }
    }
    // accolade + barre initiale
    ctx.fillStyle = 'rgba(255,255,255,.45)';
    ctx.fillRect(10, this.trebleBottom - 4 * g, 1.5, this.bassBottom - (this.trebleBottom - 4 * g));
    // mesures
    let i = lowerBound(this.downbeats, tMin, (x) => x);
    ctx.font = `600 ${Math.round(g * 0.95)}px 'Atkinson Hyperlegible Next', system-ui, sans-serif`;
    ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    for (; i < this.downbeats.length && this.downbeats[i] < tMax; i++) {
      const x = Math.round(xOf(this.downbeats[i])) + 0.5;
      if (x < this.x0 - 2) continue;
      ctx.fillStyle = 'rgba(255,255,255,.22)';
      ctx.fillRect(x, this.trebleBottom - 4 * g, 1, this.bassBottom - (this.trebleBottom - 4 * g));
      ctx.fillStyle = 'rgba(255,255,255,.35)';
      ctx.fillText(String(i + 1), x + 3, this.trebleBottom - 4 * g - 2);
    }
    // accords au-dessus de la portée
    if (this.chords?.length) {
      ctx.font = `700 ${Math.round(g * 1.35)}px 'Atkinson Hyperlegible Next', system-ui, sans-serif`;
      ctx.textBaseline = 'alphabetic'; ctx.fillStyle = PALETTE.chord;
      let last = -1e9;
      for (let k = lowerBound(this.chords, tMin, (c) => c.s); k < this.chords.length && this.chords[k].s < tMax; k++) {
        const x = xOf(this.chords[k].s);
        if (x < this.x0 || x - last < g * 3) continue;
        ctx.fillText(this.chords[k].name, x, this.trebleBottom - 4 * g - g * 2.2); last = x;
      }
    }
    // notes
    const head = (x, y, col, ring) => {
      ctx.save(); ctx.translate(x, y); ctx.rotate(-0.33);
      ctx.beginPath(); ctx.ellipse(0, 0, g * 0.66, g * 0.46, 0, 0, Math.PI * 2);
      ctx.fillStyle = col; ctx.fill();
      if (ring) { ctx.lineWidth = 2; ctx.strokeStyle = ring; ctx.stroke(); }
      ctx.restore();
    };
    const ledger = (x, step, staff) => {
      ctx.strokeStyle = 'rgba(255,255,255,.4)'; ctx.lineWidth = 1;
      const lo = staff === 't' ? 30 : 18, hi = lo + 8;
      if (step < lo - 1) for (let s = lo - 2; s >= step; s -= 2) { const y = Math.round(this.yOf(s, staff)) + 0.5; ctx.beginPath(); ctx.moveTo(x - g * 1.05, y); ctx.lineTo(x + g * 1.05, y); ctx.stroke(); }
      if (step > hi + 1) for (let s = hi + 2; s <= step; s += 2) { const y = Math.round(this.yOf(s, staff)) + 0.5; ctx.beginPath(); ctx.moveTo(x - g * 1.05, y); ctx.lineTo(x + g * 1.05, y); ctx.stroke(); }
    };
    const keyAcc = (letter) => {
      if (this.ks > 0) return SHARP_ORDER.slice(0, this.ks).includes(letter) ? 1 : 0;
      if (this.ks < 0) return FLAT_ORDER.slice(0, -this.ks).includes(letter) ? -1 : 0;
      return 0;
    };
    const from = lowerBound(this.notes, tMin - 8);
    const heads = [];
    for (let k = from; k < this.notes.length; k++) {
      const n = this.notes[k];
      if (n.t > tMax) break;
      if (n.t + n.d < tMin) continue;
      // main droite en clé de sol, main gauche en clé de fa, sauf notes très loin de leur portée (comme sur une vraie partition)
      const staff = n.hand === 'R' ? (n.pitch < 55 ? 'b' : 't') : (n.pitch > 64 ? 't' : 'b');
      const sp = spell(n.pitch, this.ks);
      const y = this.yOf(sp.step, staff);
      const x = xOf(n.t), x2 = xOf(n.t + n.d);
      const P = PALETTE[n.hand];
      const past = n.t < T - 0.02;
      const state = n.state;
      const col = state === 'hit' ? PALETTE.ok : state === 'miss' ? PALETTE.bad : n.dim ? 'rgba(160,166,190,.55)' : P.a;
      // durée : trait fin derrière la tête
      if (x2 > this.x0 && x2 - x > g) {
        ctx.fillStyle = state === 'hit' ? 'rgba(93,240,160,.28)' : state === 'miss' ? 'rgba(255,84,104,.25)' : n.dim ? 'rgba(160,166,190,.16)' : `${P.glow}44`;
        const xa = Math.max(this.x0, x), w = x2 - xa;
        if (w > 0) { ctx.beginPath(); ctx.roundRect ? ctx.roundRect(xa, y - g * 0.22, w, g * 0.44, g * 0.22) : ctx.rect(xa, y - g * 0.22, w, g * 0.44); ctx.fill(); }
      }
      if (x < this.x0 - g * 0.5) continue;
      heads.push({ x, y, col, staff, sp, ring: !past && hint?.has?.(n.pitch) && Math.abs(n.t - T) < 0.15 ? '#fff' : null, accDiff: sp.acc !== keyAcc(sp.letter) ? sp.acc : null, fade: past && state !== 'hit' && state !== 'miss' });
    }
    for (const h of heads) {
      ledger(h.x, h.sp.step, h.staff);
      ctx.globalAlpha = h.fade ? 0.55 : 1;
      if (h.accDiff != null) this._acc(h.accDiff > 0 ? '♯' : h.accDiff < 0 ? '♭' : '♮', h.x - g * 1.5, h.y, h.col);
      head(h.x, h.y, h.col, h.ring);
      ctx.globalAlpha = 1;
    }
    // zone de gauche opaque : clés et armure par-dessus les notes qui sortent
    ctx.fillStyle = '#0f1019';
    ctx.fillRect(0, 0, this.x0 - g * 0.6, H);
    const fade = ctx.createLinearGradient(this.x0 - g * 0.6, 0, this.x0 + g * 2, 0);
    fade.addColorStop(0, '#0f1019'); fade.addColorStop(1, 'rgba(15,16,25,0)');
    ctx.fillStyle = fade; ctx.fillRect(this.x0 - g * 0.6, 0, g * 2.6, H);
    ctx.strokeStyle = 'rgba(255,255,255,.28)'; ctx.lineWidth = 1;
    for (let k = 0; k < 5; k++) for (const y of [this.trebleBottom - k * g, this.bassBottom - k * g]) { ctx.beginPath(); ctx.moveTo(10, Math.round(y) + 0.5); ctx.lineTo(this.x0 - g * 0.6, Math.round(y) + 0.5); ctx.stroke(); }
    ctx.fillStyle = 'rgba(255,255,255,.45)';
    ctx.fillRect(10, this.trebleBottom - 4 * g, 1.5, this.bassBottom - (this.trebleBottom - 4 * g));
    this._clef('𝄞', 18, this.trebleBottom - 5.6 * g, 7.4 * g);
    this._clef('𝄢', 18, this.bassBottom - 4.05 * g, 3.2 * g);
    // armure
    const n = Math.abs(this.ks), pos = this.ks > 0 ? SHARP_POS : FLAT_POS, glyph = this.ks > 0 ? '♯' : '♭';
    for (let k = 0; k < n; k++) {
      const x = 18 + g * 3.9 + k * g * 1.05;
      this._acc(glyph, x, this.yOf(pos.t[k], 't'), 'rgba(255,255,255,.85)');
      this._acc(glyph, x, this.yOf(pos.b[k], 'b'), 'rgba(255,255,255,.85)');
    }
    // curseur de lecture
    const top = this.trebleBottom - 5 * g, bot = this.bassBottom + g;
    const glow = ctx.createLinearGradient(this.playX - 10, 0, this.playX + 10, 0);
    glow.addColorStop(0, 'rgba(255,181,46,0)'); glow.addColorStop(0.5, 'rgba(255,181,46,.18)'); glow.addColorStop(1, 'rgba(255,181,46,0)');
    ctx.fillStyle = glow; ctx.fillRect(this.playX - 10, top, 20, bot - top);
    ctx.fillStyle = '#ffb52e'; ctx.fillRect(Math.round(this.playX) - 1, top, 2, bot - top);
    // séparation avec la cascade
    ctx.fillStyle = 'rgba(255,255,255,.08)'; ctx.fillRect(0, H - 1, W, 1);
  }

  /** Altération centrée sur sa ligne (le rond du bémol sur la ligne, le centre du dièse et du bécarre). */
  _acc(glyph, cx, cy, col) {
    const { ctx, g } = this;
    const ink = inkBox(glyph, MUSIC_FONT);
    ctx.fillStyle = col; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    if (!ink || !ink.h) { ctx.font = `${g * 2}px ${MUSIC_FONT}`; ctx.fillText(glyph, cx - g * 0.4, cy + g * 0.6); return; }
    const flat = glyph === '♭';
    const h = flat ? g * 2.3 : g * 2.7, k = h / ink.h;
    const top = cy - h * (flat ? 0.7 : 0.5);
    ctx.font = `${200 * k}px ${MUSIC_FONT}`;
    ctx.fillText(glyph, cx - (ink.w * k) / 2 - ink.left * k, top - ink.top * k);
  }

  /** Clé dessinée d'après son encre réelle : même place et même taille quelle que soit la police. */
  _clef(glyph, x, top, h) {
    const ink = inkBox(glyph, MUSIC_FONT);
    const { ctx } = this;
    ctx.fillStyle = 'rgba(255,255,255,.88)'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    if (!ink || !ink.h) { ctx.font = `${h}px ${MUSIC_FONT}`; ctx.fillText(glyph, x, top + h * 0.8); return; }
    const k = h / ink.h;
    ctx.font = `${200 * k}px ${MUSIC_FONT}`;
    ctx.fillText(glyph, x - ink.left * k, top - ink.top * k);
  }
}
