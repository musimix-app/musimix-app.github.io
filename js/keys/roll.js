// MusiMix Piano — rendu « notes qui tombent » sur Canvas 2D :
// fond nocturne animé, notes lumineuses (halo par flou additif), faisceaux et étincelles
// sur la ligne de frappe, clavier en relief qui s'illumine, accords et mesures dans la cascade.

const BLACK = new Set([1, 3, 6, 8, 10]);
const isBlack = (p) => BLACK.has(((p % 12) + 12) % 12);
const BLACK_SHIFT = { 1: -0.12, 3: 0.12, 6: -0.14, 8: 0, 10: 0.14 };
const NAMES_FR = ['Do', 'Do♯', 'Ré', 'Ré♯', 'Mi', 'Fa', 'Fa♯', 'Sol', 'Sol♯', 'La', 'La♯', 'Si'];
const NAMES_EN = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
export const noteLabel = (p, lang = 'fr') => (lang === 'fr' ? NAMES_FR : NAMES_EN)[p % 12] + (Math.floor(p / 12) - (lang === 'fr' ? 2 : 1));

export const PALETTE = {
  R: { a: '#7ff3f7', b: '#14a9c6', glow: '#3fe0ec', dark: '#0c6f86' },   // main droite : turquoise
  L: { a: '#ffa1d6', b: '#d9348f', glow: '#ff5fb5', dark: '#8c1f5e' },   // main gauche : rose MusiMix
  B: { a: '#a7b0cf', b: '#59607d', glow: '#8d96bb', dark: '#3a3f55' },   // accompagnement
  ok: '#5df0a0', bad: '#ff5468', chord: '#ffb52e',
};

export class KeysRoll {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.glow = document.createElement('canvas');
    this.gctx = this.glow.getContext('2d');
    this.lo = 21; this.hi = 108;
    this.look = 3.2;            // secondes visibles au-dessus du clavier
    this.labels = 'c';          // 'none' | 'c' (les Do) | 'all'
    this.lang = 'fr';
    this.particles = [];
    this.rings = [];
    this.flashes = new Map();   // pitch → { color, t0 }
    this.notes = []; this.maxDur = 1;
    this.chords = []; this.downbeats = []; this.bookmarks = [];
    this.filterOK = 'filter' in this.ctx;
    this._t0 = performance.now();
    this.resize();
  }

  setSong(notes, { chords = [], downbeats = [], bookmarks = [] } = {}) {
    this.notes = notes;
    this.maxDur = Math.max(0.5, ...notes.map((n) => n.d).slice(0, 20000));
    this.chords = chords; this.downbeats = downbeats; this.bookmarks = bookmarks;
  }

  /** Plage du clavier : 'auto' (d'après les notes) ou nombre de touches (61, 76, 88). */
  setRange(mode, notes = this.notes) {
    this._rangeMode = mode; this._rangeNotes = notes;
    notes = notes || this._rangeNotes || [];
    let lo = 21, hi = 108;
    if (mode === '61') { lo = 36; hi = 96; } else if (mode === '76') { lo = 28; hi = 103; } else if (mode === 'auto' && notes.length) {
      let a = 127, b = 0;
      for (const n of notes) { if (n.hand === 'X') continue; if (n.pitch < a) a = n.pitch; if (n.pitch > b) b = n.pitch; }
      // écran étroit (téléphone en portrait) : juste la plage du morceau, au moins deux octaves
      const narrow = this.W < 700;
      if (!narrow) { a = Math.min(a, 48); b = Math.max(b, 84); }
      lo = Math.max(21, a - (a % 12)); hi = Math.min(108, b + (11 - (b % 12)) + 1);
      const minSpan = narrow ? 24 : 36;
      if (hi - lo < minSpan) { const extra = minSpan - (hi - lo); lo = Math.max(21, lo - 12 * Math.ceil(extra / 24)); hi = Math.min(108, Math.max(hi, lo + minSpan)); }
    }
    if (isBlack(lo)) lo--;
    if (isBlack(hi)) hi++;
    this.lo = lo; this.hi = hi;
    this._layout();
  }

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const r = this.cv.getBoundingClientRect();
    this.W = Math.max(200, r.width); this.H = Math.max(200, r.height);
    this.dpr = dpr;
    this.cv.width = Math.round(this.W * dpr); this.cv.height = Math.round(this.H * dpr);
    this.glow.width = Math.round(this.W / 2); this.glow.height = Math.round(this.H / 2);
    if (this._rangeMode) this.setRange(this._rangeMode, this._rangeNotes); else this._layout();
    this._bg = null;
  }

  _layout() {
    const W = this.W, H = this.H;
    this.kbH = Math.round(Math.min(160, Math.max(78, H * 0.2, W / 52 * 4.6)));
    this.kbH = Math.min(this.kbH, Math.round(H * 0.3));
    this.hitY = H - this.kbH - 6;
    const whites = [];
    for (let p = this.lo; p <= this.hi; p++) if (!isBlack(p)) whites.push(p);
    this.kw = W / whites.length;
    this.keyX = new Map();
    whites.forEach((p, i) => this.keyX.set(p, { x: i * this.kw, w: this.kw, black: false }));
    const bw = this.kw * 0.6;
    for (let p = this.lo; p <= this.hi; p++) {
      if (!isBlack(p)) continue;
      const left = this.keyX.get(p - 1);
      if (!left) continue;
      const cx = left.x + left.w + BLACK_SHIFT[p % 12] * bw;
      this.keyX.set(p, { x: cx - bw / 2, w: bw, black: true });
    }
  }

  pitchAt(x, y) {
    if (y < this.hitY) return null;
    const blackH = this.kbH * 0.63;
    if (y < this.hitY + 6 + blackH) {
      for (const [p, k] of this.keyX) if (k.black && x >= k.x && x <= k.x + k.w) return p;
    }
    for (const [p, k] of this.keyX) if (!k.black && x >= k.x && x <= k.x + k.w) return p;
    return null;
  }

  // ───────────────────────────────────────────────────────────── effets ──

  burst(pitch, kind = 'R', strength = 1) {
    const k = this.keyX.get(pitch);
    if (!k) return;
    const col = kind === 'bad' ? PALETTE.bad : kind === 'ok' ? PALETTE.ok : (PALETTE[kind] || PALETTE.R).glow;
    const cx = k.x + k.w / 2;
    const n = Math.round((kind === 'bad' ? 10 : 18) * strength);
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * (kind === 'bad' ? 2.4 : 1.6);
      const sp = 80 + Math.random() * 260 * strength;
      this.particles.push({ x: cx + (Math.random() - 0.5) * k.w * 0.6, y: this.hitY, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0, max: 0.5 + Math.random() * 0.7, r: 1 + Math.random() * 2.4, col });
    }
    this.rings.push({ x: cx, y: this.hitY, t: 0, col, w: k.w });
    this.flashes.set(pitch, { col, t0: performance.now() });
    if (this.particles.length > 900) this.particles.splice(0, this.particles.length - 900);
  }

  // ───────────────────────────────────────────────────────────── dessin ──

  /**
   * T = temps du morceau ; st = { keys: Map pitch → { col, kind }, sounding: Map pitch → hand,
   * hint: Set pitch (à jouer maintenant), playing, rate }
   */
  draw(T, st) {
    const { ctx, W, H, dpr } = this;
    const now = performance.now();
    const dt = Math.min(0.05, (now - (this._last || now)) / 1000);
    this._last = now;
    const wall = (now - this._t0) / 1000;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.filter = 'none';
    this._background(wall);
    const pps = this.hitY / this.look;
    const yOf = (t) => this.hitY - (t - T) * pps;

    this._lanes();
    this._measures(T, yOf);
    this._chordLines(T, yOf);

    // notes visibles
    const g = this.gctx;
    g.setTransform(0.5, 0, 0, 0.5, 0, 0);
    g.clearRect(0, 0, W, H);
    const tEnd = T + this.look + 0.1, tStart = T - this.maxDur - 0.2;
    const notes = this.notes;
    let i = lowerBound(notes, tStart);
    const fingerFont = `700 ${Math.max(9, Math.min(13, this.kw * 0.42))}px 'Atkinson Hyperlegible Next', system-ui, sans-serif`;
    const fingers = [], names = [];
    for (; i < notes.length; i++) {
      const n = notes[i];
      if (n.t > tEnd) break;
      if (n.hand === 'X' || n.hidden) continue;
      const k = this.keyX.get(n.pitch);
      if (!k) continue;
      const y1 = yOf(n.t), y0 = yOf(n.t + n.d);
      if (y1 < -4 || y0 > this.hitY + 2) continue;
      const pal = PALETTE[n.hand] || PALETTE.B;
      const bg = n.hand === 'B';
      const pad = k.black ? 0.5 : Math.max(1.5, k.w * 0.1);
      const x = k.x + pad, w = k.w - pad * 2;
      const top = Math.max(y0, -10), bot = Math.min(y1, this.hitY);
      const h = Math.max(3, bot - top);
      const active = n.t <= T && n.t + n.d > T;
      const state = n.state; // 'hit' | 'miss' | undefined
      let alpha = bg ? 0.42 : n.dim ? 0.62 : 1;
      if (state === 'miss') alpha = 0.32;
      const r = Math.min(7, w * 0.35, h / 2);
      // corps
      ctx.globalAlpha = alpha;
      const grd = ctx.createLinearGradient(0, top, 0, bot);
      if (state === 'hit' || (active && !bg && n.play === false)) {
        grd.addColorStop(0, '#ffffff'); grd.addColorStop(0.25, pal.a); grd.addColorStop(1, pal.b);
      } else if (k.black) {
        grd.addColorStop(0, shade(pal.a, -0.18)); grd.addColorStop(1, pal.dark);
      } else {
        grd.addColorStop(0, pal.a); grd.addColorStop(1, pal.b);
      }
      ctx.fillStyle = grd;
      roundRect(ctx, x, top, w, h, r); ctx.fill();
      if (!bg) {
        // reflet sur le bord gauche + liseré
        ctx.globalAlpha = alpha * 0.55;
        ctx.fillStyle = 'rgba(255,255,255,.55)';
        roundRect(ctx, x + 1.2, top + 1.5, Math.max(1, w * 0.16), Math.max(1, h - 3), r); ctx.fill();
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = state === 'miss' ? 'rgba(255,84,104,.75)' : 'rgba(255,255,255,.22)';
        ctx.lineWidth = 1;
        roundRect(ctx, x + 0.5, top + 0.5, w - 1, h - 1, r); ctx.stroke();
        // halo (dessiné en petit, flouté plus tard)
        g.globalAlpha = state === 'miss' ? 0.15 : active || state === 'hit' ? 1 : 0.55;
        g.fillStyle = pal.glow;
        g.fillRect(x, top, w, h);
        if (n.finger && h > 16 && w > 9) fingers.push([x + w / 2, bot - Math.min(12, h / 2), n.finger]);
        else if (this.noteNames && h > 18 && w > 12) names.push([x + w / 2, bot - 9, noteLabel(n.pitch, this.lang).replace(/-?\d+$/, '')]);
      }
    }
    ctx.globalAlpha = 1;
    // doigtés
    if (fingers.length) {
      ctx.font = fingerFont; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (const [fx, fy, f] of fingers) {
        ctx.fillStyle = 'rgba(10,12,20,.55)';
        ctx.beginPath(); ctx.arc(fx, fy, Math.min(9, this.kw * 0.36), 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.fillText(String(f), fx, fy + 0.5);
      }
    }

    if (names.length) {
      ctx.font = `700 ${Math.max(8, Math.min(11, this.kw * 0.34))}px 'Atkinson Hyperlegible Next', system-ui, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(8,10,18,.78)';
      for (const [fx, fy, lab] of names) ctx.fillText(lab, fx, fy);
    }
    // faisceaux des notes qui sonnent
    for (const [p, hand] of st.sounding) {
      const k = this.keyX.get(p);
      if (!k) continue;
      const pal = PALETTE[hand] || PALETTE.B;
      const bh = Math.min(this.hitY, 220);
      g.globalAlpha = hand === 'B' ? 0.35 : 0.9;
      g.fillStyle = pal.glow;
      g.fillRect(k.x, this.hitY - 8, k.w, 16);
      const beam = ctx.createLinearGradient(0, this.hitY, 0, this.hitY - bh);
      beam.addColorStop(0, hexA(pal.glow, hand === 'B' ? 0.18 : 0.42)); beam.addColorStop(1, hexA(pal.glow, 0));
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = beam;
      ctx.fillRect(k.x - k.w * 0.15, this.hitY - bh, k.w * 1.3, bh);
      ctx.globalCompositeOperation = 'source-over';
      // étincelles continues
      if (hand !== 'B' && Math.random() < 0.45) {
        this.particles.push({ x: k.x + Math.random() * k.w, y: this.hitY, vx: (Math.random() - 0.5) * 30, vy: -60 - Math.random() * 120, life: 0, max: 0.4 + Math.random() * 0.5, r: 0.8 + Math.random() * 1.6, col: pal.a });
      }
    }

    // halo : copie floutée, ajoutée en lumière
    if (this.filterOK) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.filter = 'blur(9px)';
      ctx.globalAlpha = 0.75;
      ctx.drawImage(this.glow, 0, 0, W, H);
      ctx.filter = 'blur(26px)';
      ctx.globalAlpha = 0.5;
      ctx.drawImage(this.glow, 0, 0, W, H);
      ctx.filter = 'none';
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }

    this._particles(dt);
    this._hitLine(wall, st);
    this._keyboard(st, now);
  }

  _background(wall) {
    const { ctx, W, H } = this;
    if (!this._bg) {
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, '#07080e'); g.addColorStop(0.55, '#0d0f1a'); g.addColorStop(1, '#151226');
      this._bg = g;
    }
    ctx.fillStyle = this._bg;
    ctx.fillRect(0, 0, W, H);
    // aurores lentes (rose et turquoise, couleurs MusiMix)
    ctx.globalCompositeOperation = 'lighter';
    const blob = (cx, cy, r, col, a) => {
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, hexA(col, a)); g.addColorStop(1, hexA(col, 0));
      ctx.fillStyle = g; ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    };
    const R = Math.max(W, H) * 0.55;
    blob(W * (0.25 + 0.12 * Math.sin(wall * 0.07)), H * (0.3 + 0.08 * Math.cos(wall * 0.05)), R, '#1cc0ca', 0.07);
    blob(W * (0.78 + 0.1 * Math.cos(wall * 0.06)), H * (0.42 + 0.1 * Math.sin(wall * 0.045)), R * 0.9, '#fe50ad', 0.06);
    blob(W * 0.5, this.hitY + 40, R * 0.7, '#ffaf1b', 0.035);
    ctx.globalCompositeOperation = 'source-over';
  }

  _lanes() {
    const { ctx } = this;
    // couloirs des touches noires, un peu plus sombres ; séparation des octaves
    ctx.fillStyle = 'rgba(0,0,0,.22)';
    for (const [p, k] of this.keyX) if (k.black) ctx.fillRect(k.x, 0, k.w, this.hitY);
    for (const [p, k] of this.keyX) {
      if (k.black) continue;
      const pc = p % 12;
      if (pc !== 0 && pc !== 5) continue;
      ctx.fillStyle = pc === 0 ? 'rgba(255,255,255,.075)' : 'rgba(255,255,255,.03)';
      ctx.fillRect(Math.round(k.x), 0, 1, this.hitY);
    }
  }

  _measures(T, yOf) {
    const { ctx, W } = this;
    const db = this.downbeats;
    if (!db?.length) return;
    let i = lowerBound(db, T - 0.1, (x) => x);
    ctx.font = "600 10px 'Atkinson Hyperlegible Next', system-ui, sans-serif";
    ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
    for (; i < db.length && db[i] < T + this.look; i++) {
      const y = Math.round(yOf(db[i])) + 0.5;
      if (y > this.hitY) continue;
      ctx.fillStyle = 'rgba(255,255,255,.07)';
      ctx.fillRect(0, y, W, 1);
      ctx.fillStyle = 'rgba(255,255,255,.22)';
      ctx.fillText(String(i + 1), W - 6, y - 2);
    }
  }

  _chordLines(T, yOf) {
    const { ctx, W } = this;
    const list = this.chords;
    if (!list?.length) return;
    let i = lowerBound(list, T - 8, (c) => c.s);
    ctx.font = "700 15px 'Atkinson Hyperlegible Next', system-ui, sans-serif";
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    for (; i < list.length && list[i].s < T + this.look; i++) {
      const c = list[i];
      const y = yOf(c.s);
      if (y > this.hitY + 2 || y < -20) continue;
      const near = Math.max(0, 1 - Math.abs(c.s - T) / this.look);
      ctx.globalAlpha = Math.max(0, Math.min(1, (y - 70) / 70));
      if (ctx.globalAlpha <= 0) continue;
      const lg = ctx.createLinearGradient(0, 0, W, 0);
      lg.addColorStop(0, hexA(PALETTE.chord, 0.5 * (0.4 + near))); lg.addColorStop(0.35, hexA(PALETTE.chord, 0.12)); lg.addColorStop(1, hexA(PALETTE.chord, 0));
      ctx.fillStyle = lg;
      ctx.fillRect(0, Math.round(y), W, 1.5);
      const label = c.name;
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(12,10,20,.78)';
      roundRect(ctx, 8, y - 13, tw + 18, 26, 13); ctx.fill();
      ctx.strokeStyle = hexA(PALETTE.chord, 0.65); ctx.lineWidth = 1;
      roundRect(ctx, 8.5, y - 12.5, tw + 17, 25, 12.5); ctx.stroke();
      ctx.fillStyle = PALETTE.chord;
      ctx.fillText(label, 17, y + 0.5);
    }
    ctx.globalAlpha = 1;
    // repères (sections, signets .synthesia)
    ctx.font = "italic 600 13px 'Fraunces', Georgia, serif";
    ctx.textAlign = 'right';
    for (const b of this.bookmarks) {
      if (b.t < T - 0.2 || b.t > T + this.look) continue;
      const y = yOf(b.t);
      ctx.fillStyle = 'rgba(255,255,255,.5)';
      ctx.fillText(b.label, W - 26, y - 12);
    }
  }

  _particles(dt) {
    const { ctx } = this;
    ctx.globalCompositeOperation = 'lighter';
    const ps = this.particles;
    let j = 0;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      p.life += dt;
      if (p.life > p.max) continue;
      p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 140 * dt; p.vx *= 0.985;
      const a = 1 - p.life / p.max;
      ctx.globalAlpha = a;
      ctx.fillStyle = p.col;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (0.6 + a * 0.6), 0, Math.PI * 2); ctx.fill();
      ps[j++] = p;
    }
    ps.length = j;
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.t += dt;
      if (r.t > 0.45) { this.rings.splice(i, 1); continue; }
      const k = r.t / 0.45;
      ctx.globalAlpha = (1 - k) * 0.85;
      ctx.strokeStyle = r.col; ctx.lineWidth = 2 * (1 - k) + 0.5;
      ctx.beginPath(); ctx.ellipse(r.x, r.y, r.w * (0.5 + k * 1.6), 6 + k * 22, 0, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  _hitLine(wall, st) {
    const { ctx, W } = this;
    const y = this.hitY;
    // feutre (comme la bande rouge au-dessus des touches d'un vrai piano)
    const felt = ctx.createLinearGradient(0, y, 0, y + 6);
    felt.addColorStop(0, '#5a1428'); felt.addColorStop(1, '#2a0812');
    ctx.fillStyle = felt; ctx.fillRect(0, y, W, 6);
    // ligne de frappe lumineuse, qui « respire » pendant la lecture
    const pulse = st.playing ? 0.75 + 0.25 * Math.sin(wall * 6) : 0.6;
    const lg = ctx.createLinearGradient(0, 0, W, 0);
    lg.addColorStop(0, hexA('#fe50ad', 0.9 * pulse)); lg.addColorStop(0.5, hexA('#ffcf6b', pulse)); lg.addColorStop(1, hexA('#1cc0ca', 0.9 * pulse));
    ctx.fillStyle = lg; ctx.fillRect(0, y - 1, W, 2);
    ctx.globalCompositeOperation = 'lighter';
    const halo = ctx.createLinearGradient(0, y - 18, 0, y + 2);
    halo.addColorStop(0, 'rgba(255,190,110,0)'); halo.addColorStop(1, hexA('#ffb86b', 0.16 * pulse));
    ctx.fillStyle = halo; ctx.fillRect(0, y - 18, W, 20);
    ctx.globalCompositeOperation = 'source-over';
  }

  _keyboard(st, now) {
    const { ctx, W, H } = this;
    const top = this.hitY + 6, kh = H - top;
    const bh = kh * 0.63;
    // fond (ombre sous les touches)
    ctx.fillStyle = '#05060a'; ctx.fillRect(0, top, W, kh);
    const keyState = (p) => {
      const k = st.keys.get(p);
      if (k) return k;
      const fl = this.flashes.get(p);
      if (fl) { const a = 1 - (now - fl.t0) / 350; if (a > 0) return { col: fl.col, a: a * 0.6 }; this.flashes.delete(p); }
      const s = st.sounding.get(p);
      if (s) return { col: (PALETTE[s] || PALETTE.B).glow, a: s === 'B' ? 0.28 : 0.5 };
      if (st.hint?.has(p)) { const pal = PALETTE[st.hint.get(p)] || PALETTE.R; return { col: pal.glow, a: 0.22 + 0.16 * (0.5 + 0.5 * Math.sin(now / 160)), hint: true }; }
      return null;
    };
    // blanches
    for (const [p, k] of this.keyX) {
      if (k.black) continue;
      const s = keyState(p);
      const down = s && !s.hint ? 2 : 0;
      const x = k.x + 0.6, w = k.w - 1.2;
      const g = ctx.createLinearGradient(0, top, 0, top + kh);
      g.addColorStop(0, '#d8d2c8'); g.addColorStop(0.06, '#f6f2ec'); g.addColorStop(0.92, '#ece6dd'); g.addColorStop(1, '#bdb5a9');
      ctx.fillStyle = g;
      roundRect(ctx, x, top + down, w, kh - 2 - down, [0, 0, 5, 5]); ctx.fill();
      if (s) {
        ctx.globalAlpha = s.a ?? 0.85;
        const cg = ctx.createLinearGradient(0, top, 0, top + kh);
        cg.addColorStop(0, s.col); cg.addColorStop(1, shade(s.col, -0.25));
        ctx.fillStyle = cg;
        roundRect(ctx, x, top + down, w, kh - 2 - down, [0, 0, 5, 5]); ctx.fill();
        ctx.globalAlpha = 1;
      }
      // tranche avant
      ctx.fillStyle = 'rgba(0,0,0,.12)'; ctx.fillRect(x, top + kh - 6, w, 4);
      if (this.labels === 'all' || (this.labels === 'c' && p % 12 === 0)) {
        ctx.font = `600 ${Math.max(8, Math.min(12, k.w * 0.36))}px 'Atkinson Hyperlegible Next', system-ui, sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        ctx.fillStyle = s ? 'rgba(10,10,20,.75)' : 'rgba(40,40,55,.55)';
        const lab = this.labels === 'all' && p % 12 !== 0 ? noteLabel(p, this.lang).replace(/-?\d+$/, '') : noteLabel(p, this.lang);
        ctx.fillText(lab, k.x + k.w / 2, top + kh - 9);
      }
    }
    // ombre portée sous le feutre
    const sh = ctx.createLinearGradient(0, top, 0, top + 10);
    sh.addColorStop(0, 'rgba(0,0,0,.45)'); sh.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = sh; ctx.fillRect(0, top, W, 10);
    // noires
    for (const [p, k] of this.keyX) {
      if (!k.black) continue;
      const s = keyState(p);
      const down = s && !s.hint ? 1.5 : 0;
      ctx.fillStyle = 'rgba(0,0,0,.4)';
      roundRect(ctx, k.x + 1, top, k.w, bh + 3, [0, 0, 3, 3]); ctx.fill();
      const g = ctx.createLinearGradient(0, top, 0, top + bh);
      g.addColorStop(0, '#16171c'); g.addColorStop(0.85, '#2c2e36'); g.addColorStop(1, '#0d0e12');
      ctx.fillStyle = g;
      roundRect(ctx, k.x, top + down, k.w, bh - down, [0, 0, 3, 3]); ctx.fill();
      if (s) {
        ctx.globalAlpha = s.hint ? s.a + 0.15 : Math.min(1, (s.a ?? 0.85) + 0.15);
        const cg = ctx.createLinearGradient(0, top, 0, top + bh);
        cg.addColorStop(0, shade(s.col, -0.35)); cg.addColorStop(1, s.col);
        ctx.fillStyle = cg;
        roundRect(ctx, k.x + 1, top + down, k.w - 2, bh - down - 2, [0, 0, 3, 3]); ctx.fill();
        ctx.globalAlpha = 1;
      }
      // reflet
      ctx.fillStyle = 'rgba(255,255,255,.13)';
      ctx.fillRect(k.x + k.w * 0.18, top + 3 + down, Math.max(1, k.w * 0.14), bh * 0.7);
    }
    // lueur au-dessus des touches enfoncées
    ctx.globalCompositeOperation = 'lighter';
    for (const [p, s] of st.keys) {
      const k = this.keyX.get(p);
      if (!k) continue;
      const g = ctx.createRadialGradient(k.x + k.w / 2, top, 0, k.x + k.w / 2, top, k.w * 2.2);
      g.addColorStop(0, hexA(s.col, 0.55)); g.addColorStop(1, hexA(s.col, 0));
      ctx.fillStyle = g; ctx.fillRect(k.x - k.w * 2, top - k.w * 2.2, k.w * 5, k.w * 4.4);
    }
    ctx.globalCompositeOperation = 'source-over';
  }
}

// ─────────────────────────────────────────────────────────── utilitaires ──

export function lowerBound(arr, t, key = (n) => n.t) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (key(arr[m]) < t) lo = m + 1; else hi = m; }
  return lo;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
  const rr = Array.isArray(r) ? r[0] : r;
  ctx.moveTo(x + rr, y); ctx.arcTo(x + w, y, x + w, y + h, rr); ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr); ctx.arcTo(x, y, x + w, y, rr); ctx.closePath();
}

const _hex = new Map();
function rgb(hex) {
  let v = _hex.get(hex);
  if (!v) { const h = hex.replace('#', ''); v = [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; _hex.set(hex, v); }
  return v;
}
export function hexA(hex, a) { const [r, g, b] = rgb(hex); return `rgba(${r},${g},${b},${a})`; }
function shade(hex, k) {
  const [r, g, b] = rgb(hex);
  const f = (c) => Math.round(k < 0 ? c * (1 + k) : c + (255 - c) * k);
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}
