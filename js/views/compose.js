// MusiMix — atelier de composition : grille vierge par parties, suggestions (suite, transitions,
// variantes, doigtés enchaînés), écoute des accords et de la grille dans le style choisi.
import { db, uid } from '../db.js';
import { esc, icon, toast, confirmBox, openMenu, debounce } from '../ui.js';
import { parseChord, FLAT, SHARP } from '../theory.js';
import { diagramSVG, allVoicings, voicings as vList } from '../diagrams.js';
import { STYLES, nextChords, transitions, variations, chainVoicings, voicingOptions, voicingOf, playChord, GridPlayer, guessKey, roman, degree, pianoOptions, nameChord, chordMidi, PATTERNS, DRUM_STYLES, SOUNDS, setSounds, prepareSounds, setVolume, getVolume } from '../compose.js';
import { newSong } from '../songs.js';
import { autofill, slotAlternatives } from '../autofill.js';
import { improLayers, neckSvg, keysSvg, SCALES } from '../impro.js';
import { midi } from '../midi-input.js';
import { ChordListener, recognize, judge, CHROMA_NAMES } from '../chordlisten.js';
import { parseChord as pc2 } from '../theory.js';
import { parseSheet } from '../sheet.js';

const KINDS = [['intro', 'Intro'], ['verse', 'Couplet'], ['prechorus', 'Pré-refrain'], ['chorus', 'Refrain'], ['bridge', 'Pont'], ['solo', 'Solo'], ['outro', 'Final']];
const QUAL = [['', 'maj'], ['m', 'm'], ['7', '7'], ['maj7', 'maj7'], ['m7', 'm7'], ['sus2', 'sus2'], ['sus4', 'sus4'], ['add9', 'add9'], ['6', '6'], ['9', '9'], ['m9', 'm9'], ['dim', 'dim'], ['m7b5', 'ø'], ['aug', 'aug'], ['5', '5']];
const KEYS = [];
for (let pc = 0; pc < 12; pc++) { KEYS.push({ pc, minor: false }); KEYS.push({ pc, minor: true }); }
const keyLabel = (k) => (k ? (k.minor ? (k.pc === 3 || k.pc === 10 ? FLAT : SHARP)[k.pc] + 'm' : ([1, 3, 8, 10].includes(k.pc) ? FLAT : SHARP)[k.pc]) : 'Auto');

// presse-papiers de mesures (partagé entre compositions, gardé pendant la session)
let CLIP = null;
try { CLIP = JSON.parse(sessionStorage.getItem('mm-compo-clip') || 'null'); } catch { /* */ }
const setClip = (bars) => { CLIP = bars; try { sessionStorage.setItem('mm-compo-clip', JSON.stringify(bars)); } catch { /* */ } };

const FR_ROOT = { C: 'Do', D: 'Ré', E: 'Mi', F: 'Fa', G: 'Sol', A: 'La', B: 'Si' };
const FR_QUAL = { '': 'majeur', m: 'mineur', 7: 'septième', maj7: 'majeur 7', m7: 'mineur 7', 6: 'sixte', m6: 'mineur 6', 9: 'neuvième', m9: 'mineur 9', maj9: 'majeur 9', add9: 'add 9', madd9: 'mineur add 9', sus2: 'sus 2', sus4: 'sus 4', '7sus4': '7 sus 4', dim: 'diminué', dim7: 'diminué 7', aug: 'augmenté', m7b5: 'demi-diminué', 5: 'power chord', 11: 'onzième', m11: 'mineur 11', 13: 'treizième', '7b9': '7 ♭9', '7#9': '7 ♯9', 69: '6/9' };
function frNote(n) { return (FR_ROOT[n[0]] || n[0]) + (n.slice(1) === '#' ? ' dièse' : n.slice(1) === 'b' ? ' bémol' : ''); }
/** « F#m7/A » → « Fa dièse mineur 7, basse La » */
function frChord(name) {
  const ch = parseChord(name);
  if (!ch) return '';
  return `${frNote(ch.rootName)} ${FR_QUAL[ch.suffix] ?? ch.suffix}${ch.bassName ? `, basse ${frNote(ch.bassName)}` : ''}`;
}
const fmtT = (sec) => `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

function blank(name = 'Ma composition') {
  return {
    id: uid(), name, style: 'pop', key: null, bpm: 100, instrument: 'guitar', zone: null, drums: true,
    sections: [
      { id: uid(), kind: 'intro', label: 'Intro', repeat: 1, bars: Array.from({ length: 4 }, () => ({ c: [] })) },
      { id: uid(), kind: 'verse', label: 'Couplet', repeat: 1, bars: Array.from({ length: 8 }, () => ({ c: [] })) },
      { id: uid(), kind: 'chorus', label: 'Refrain', repeat: 1, bars: Array.from({ length: 8 }, () => ({ c: [] })) },
    ],
    createdAt: Date.now(), updatedAt: Date.now(),
  };
}

export class ComposeView {
  constructor(app) { this.app = app; this.player = new GridPlayer(); this.undo = []; this.tab = 'next'; }

  async open(id) {
    this.list = (await db.get('compos', [])) || [];
    this.c = id ? this.list.find((x) => x.id === id) : null;
    const el = document.createElement('section');
    el.className = 'view compose';
    this.el = el;
    this.app.mount(el);
    el.addEventListener('click', (e) => this.onClick(e));
    el.addEventListener('change', (e) => this.onChange(e));
    el.addEventListener('input', (e) => this.onInput(e));
    this.keyH = (e) => this.onKey(e);
    document.addEventListener('keydown', this.keyH);
    const deb = debounce(() => this.persist(), 400);
    this.save = () => { this.setSaved(false); deb(); };
    this.redo = [];
    this.view2 = this.c?.impro?.on ? 'impro' : 'compose';
    try { const vv = localStorage.getItem('mm-compo-vol'); if (vv != null) setVolume(+vv); } catch { /* */ }
    this.render();
    this.bindDrag();

  }

  close() { cancelAnimationFrame(this._raf); this.player.stop(); document.removeEventListener('keydown', this.keyH); this.midiOff(true); this.listener?.stop(); this.el?.remove(); }

  async persist() {
    if (this.c) { this.c.updatedAt = Date.now(); const i = this.list.findIndex((x) => x.id === this.c.id); if (i >= 0) this.list[i] = this.c; else this.list.unshift(this.c); }
    await db.set('compos', this.list);
    this.setSaved(true);
  }

  setSaved(ok) {
    this._saved = ok;
    const el = this.el?.querySelector('.cp-saved');
    if (el) { el.classList.toggle('busy', !ok); el.innerHTML = ok ? `${icon('check')}<span>Enregistré</span>` : '<span>Enregistrement…</span>'; }
  }

  snap() { this.undo.push(JSON.stringify(this.c)); if (this.undo.length > 80) this.undo.shift(); this.redo = []; }
  changed({ snap = true } = {}) { if (snap) this.snap(); this.save(); this.render(); }

  // ───────────────────────────────────────────────── données dérivées ──
  key() {
    if (this.c.key) return this.c.key;
    const own = this.flat().filter((x) => !this.c.sections[x.si].bars[x.bi].s?.[x.h]).map((x) => x.name);
    return own.length ? guessKey(own) : { pc: 0, minor: false };
  }

  sugCount() { let n = 0; for (const s of this.c.sections) for (const b of s.bars) b.c.forEach((nm, h) => { if (nm && b.s?.[h]) n++; }); return n; }

  /** Suite des accords, dans l'ordre : [{ si, bi, h, name }] (h = moitié 0/1). */
  flat() {
    const out = [];
    this.c.sections.forEach((s, si) => s.bars.forEach((b, bi) => b.c.forEach((nm, h) => { if (nm) out.push({ si, bi, h, name: nm }); })));
    return out;
  }

  voicingsAuto() {
    const f = this.flat(), locked = {}, custom = {};
    f.forEach((x, i) => { const b = this.c.sections[x.si].bars[x.bi]; const v = b.v?.[x.h]; if (v != null) locked[i] = v; if (b.g?.[x.h]) custom[i] = b.g[x.h]; });
    const idx = chainVoicings(f.map((x) => x.name), this.c.instrument === 'piano' ? 'guitar' : this.c.instrument, { locked, zone: this.c.zone, custom });
    const map = new Map();
    f.forEach((x, i) => map.set(`${x.si}.${x.bi}.${x.h}`, idx[i]));
    this._vmap = map; this._flat = f;
    return map;
  }

  // ───────────────────────────────────────── sélection de plusieurs mesures ──
  order(x) { let n = 0; for (let i = 0; i < x.si; i++) n += this.c.sections[i].bars.length; return n + x.bi; }

  rangeBars() {
    if (!this.range) return [];
    let [a, b] = [this.range.a, this.range.b];
    if (this.order(a) > this.order(b)) [a, b] = [b, a];
    const out = [];
    this.c.sections.forEach((s, si) => s.bars.forEach((_, bi) => { const o = this.order({ si, bi }); if (o >= this.order(a) && o <= this.order(b)) out.push({ si, bi }); }));
    return out;
  }

  inRange(si, bi) {
    if (!this.range) return false;
    const o = this.order({ si, bi }), x = this.order(this.range.a), y = this.order(this.range.b);
    return o >= Math.min(x, y) && o <= Math.max(x, y);
  }

  copyRange(cut = false) {
    const rb = this.rangeBars().length ? this.rangeBars() : this.sel ? [{ si: this.sel.si, bi: this.sel.bi }] : [];
    if (!rb.length) return;
    setClip(rb.map(({ si, bi }) => JSON.parse(JSON.stringify(this.c.sections[si].bars[bi]))));
    if (cut) { this.snap(); rb.forEach(({ si, bi }) => { this.c.sections[si].bars[bi] = { c: [] }; }); this.save(); }
    toast(`${rb.length} mesure${rb.length > 1 ? 's' : ''} ${cut ? 'coupée' : 'copiée'}${rb.length > 1 ? 's' : ''}`);
    this.render();
  }

  paste(insert = false) {
    if (!CLIP?.length || !this.sel) { toast('Rien à coller : sélectionne des mesures puis « Copier »'); return; }
    const s = this.c.sections[this.sel.si], at = this.sel.bi, bars = CLIP.map((b) => JSON.parse(JSON.stringify(b)));
    this.snap();
    if (insert) s.bars.splice(at, 0, ...bars);
    else bars.forEach((b, i) => { if (at + i < s.bars.length) s.bars[at + i] = b; else s.bars.push(b); });
    this.range = bars.length > 1 ? { a: { si: this.sel.si, bi: at }, b: { si: this.sel.si, bi: at + bars.length - 1 } } : null;
    this.save(); this.render();
    toast(`${bars.length} mesure${bars.length > 1 ? 's' : ''} ${insert ? 'insérée' : 'collée'}${bars.length > 1 ? 's' : ''}`);
  }

  /** Glisser sur plusieurs cases (souris) pour les sélectionner. */
  bindDrag() {
    if (this._dragBound) return;
    this._dragBound = true;
    this.el.addEventListener('pointerdown', (e) => {
      const bar = e.target.closest('.cp-bar');
      if (!bar || e.pointerType !== 'mouse' || e.button !== 0 || e.shiftKey) return;
      this._dragFrom = { si: +bar.dataset.si, bi: +bar.dataset.bi };
    });
    this.el.addEventListener('pointerover', (e) => {
      if (!this._dragFrom || !(e.buttons & 1)) return;
      const bar = e.target.closest('.cp-bar');
      if (!bar) return;
      const to = { si: +bar.dataset.si, bi: +bar.dataset.bi };
      if (to.si === this._dragFrom.si && to.bi === this._dragFrom.bi) return;
      this.sel = { ...this._dragFrom, h: 0 };
      this.range = { a: this._dragFrom, b: to };
      this._dragged = true;
      document.getSelection()?.removeAllRanges();
      this.el.querySelectorAll('.cp-bar').forEach((x) => x.classList.toggle('cp-rng', this.inRange(+x.dataset.si, +x.dataset.bi)));
    });
    document.addEventListener('pointerup', () => { if (this._dragFrom && this._dragged) { this._noClickUntil = performance.now() + 120; this.render(); } this._dragFrom = null; this._dragged = false; });
  }

  /** Forme imposée pour une case (dessinée ou position choisie) : { frets } guitare, { notes } piano. */
  own(si, bi, h) {
    const b = this.c.sections[si]?.bars[bi];
    return { frets: b?.g?.[h] || null, notes: b?.p?.[h] || null };
  }

  hearSlot(si, bi, h, extra = {}) {
    const b = this.c.sections[si].bars[bi], nm = b.c[h];
    if (nm) playChord(nm, this.c.instrument, this.vAt(si, bi, h), { ...this.own(si, bi, h), ...extra });
  }

  vAt(si, bi, h) { return this._vmap?.get(`${si}.${bi}.${h}`) ?? 0; }

  neighbors(si, bi, h) {
    const f = this._flat || this.flat();
    const i = f.findIndex((x) => x.si === si && x.bi === bi && x.h === h);
    // place dans la suite même si la case est vide
    let prev = null, next = null;
    if (i >= 0) { prev = f[i - 1] || null; next = f[i + 1] || null; } else {
      const ord = (x) => x.si * 1e4 + x.bi * 10 + x.h, me = si * 1e4 + bi * 10 + h;
      prev = [...f].reverse().find((x) => ord(x) < me) || null; next = f.find((x) => ord(x) > me) || null;
    }
    return { prev, next };
  }

  // ─────────────────────────────────────────────────────────── rendu ──
  applySound() {
    const c = this.c, inst = c.instrument === 'piano' ? 'piano' : 'guitar';
    const ok = SOUNDS[inst].some(([k]) => k === c.sound);
    setSounds({ real: c.sound !== 'synth', [inst]: ok ? c.sound : SOUNDS[inst][0][0] });
  }

  render() {
    if (!this.c) return this.renderList();
    this.applySound();
    const c = this.c, key = this.key();
    this.voicingsAuto();
    const sel = this.sel;
    const inst = c.instrument === 'piano' ? 'piano' : 'guitar';
    const head = `<header class="topbar cp-top">
      <button class="icon-btn" data-a="back" aria-label="Retour à mes compositions" title="Mes compositions">${icon('back')}</button>
      <a class="brand cp-brand" href="#/" aria-label="MusiMix, accueil"><img src="assets/icons/icon-192.png" alt=""><b>MusiMix</b></a>
      <span class="cp-hsep"></span>
      <span class="cp-title">${icon('folder')}<input class="cp-name" data-f="name" value="${esc(c.name)}" aria-label="Nom de la composition"></span>
      <div class="spacer"></div>
      <span class="cp-saved${this._saved === false ? ' busy' : ''}">${this._saved === false ? '<span>Enregistrement…</span>' : `${icon('check')}<span>Enregistré</span>`}</span>
      <span class="cp-hsep"></span>
      <button class="icon-btn" data-a="undo" aria-label="Annuler" title="Annuler (Ctrl+Z)" ${this.undo.length ? '' : 'disabled'}>${icon('undo')}</button>
      <button class="icon-btn cp-redo" data-a="redo" aria-label="Rétablir" title="Rétablir (Ctrl+Y)" ${this.redo?.length ? '' : 'disabled'}>${icon('undo')}</button>
      <button class="icon-btn" data-a="more" aria-label="Plus">${icon('more')}</button>
    </header>`;
    // réglages : cartes (icône, étiquette, valeur ▾) — le menu natif couvre toute la carte
    const card = (ic, label, value, ctrl, cls = '') => `<label class="cp-card ${cls}">${icon(ic)}<span class="cp-card-t"><small>${label}</small><b>${value}</b></span><i class="cp-chev">▾</i>${ctrl}</label>`;
    const optSel = (f, list, cur) => `<select data-f="${f}" aria-label="${f}">${list.map(([k, l]) => `<option value="${k}" ${String(cur) === String(k) ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
    const soundList = [['synth', 'Synthé (léger)'], ...SOUNDS[inst]];
    const curSound = c.sound === 'synth' ? 'synth' : SOUNDS[inst].some(([k]) => k === c.sound) ? c.sound : SOUNDS[inst][0][0];
    const keyList = [['', `Auto (${keyLabel(key)})`], ...KEYS.map((k) => [`${k.pc}${k.minor ? 'm' : ''}`, keyLabel(k)])];
    const keyCur = c.key ? `${c.key.pc}${c.key.minor ? 'm' : ''}` : '';
    const drumCur = c.drumStyle ?? (c.drums === false ? 'off' : '');
    const lbl = (list, cur) => (list.find(([k]) => String(k) === String(cur)) || list[0])[1];
    const opts = `<div class="cp-cards">
      ${card('stage', 'Style', esc(STYLES[c.style].label), optSel('style', Object.entries(STYLES).map(([k, v]) => [k, v.label]), c.style))}
      ${card('tuner', 'Tonalité', esc(c.key ? keyLabel(c.key) : `Auto · ${keyLabel(key)}`), optSel('key', keyList, keyCur))}
      <label class="cp-card cp-card-tempo">${icon('metro')}<span class="cp-card-t"><small>Tempo</small><b><input type="number" min="40" max="240" data-f="bpm" value="${c.bpm}" aria-label="Tempo"> BPM</b></span></label>
      ${card(inst === 'piano' ? 'piano' : 'guitar', 'Instrument', esc(lbl(soundList, curSound).replace(/\s*\(.*\)$/, '')), `<select data-f="instsound" aria-label="Instrument et son"><optgroup label="Guitare">${[['synth', 'Synthé (léger)'], ...SOUNDS.guitar].map(([k, l]) => `<option value="guitar|${k}" ${inst === 'guitar' && curSound === k ? 'selected' : ''}>${l}</option>`).join('')}</optgroup><optgroup label="Piano">${[['synth', 'Synthé (léger)'], ...SOUNDS.piano].map(([k, l]) => `<option value="piano|${k}" ${inst === 'piano' && curSound === k ? 'selected' : ''}>${l}</option>`).join('')}</optgroup></select>`)}
      ${card('grid', 'Jeu', esc(lbl(PATTERNS, c.pattern || '')), optSel('pattern', PATTERNS, c.pattern || ''))}
      ${card('tap', 'Batterie', esc(lbl(DRUM_STYLES, drumCur)), optSel('drumStyle', DRUM_STYLES, drumCur))}
      ${inst === 'guitar' ? card('guitar', 'Manche', esc({ '': 'Libre', low: 'En bas', mid: 'Au milieu', high: 'En haut' }[c.zone || '']), optSel('zone', [['', 'Libre'], ['low', 'En bas (cordes à vide)'], ['mid', 'Au milieu'], ['high', 'En haut']], c.zone || ''), 'sm') : ''}
      ${card('list', 'Grille', `${c.cols || 4} col.`, optSel('cols', [2, 3, 4, 5, 6, 8].map((n) => [n, `${n} colonnes`]), c.cols || 4), 'sm')}
    </div>`;
    // onglets de travail
    const v2 = this.view2 || 'compose';
    const tab = (k, ic, l) => `<button class="${v2 === k ? 'on' : ''}" data-a="view" data-v="${k}">${icon(ic)}<span>${l}</span></button>`;
    const tabs = `<div class="cp-tabsbar"><div class="cp-vtabs">${tab('compose', 'grid', 'Composition')}${tab('impro', 'impro', 'Improvisation')}${tab('midi', 'piano', 'Clavier MIDI')}${tab('mic', 'rec', 'Micro')}</div>
      <button class="cp-fill-btn" data-a="fill" title="Compléter les cases vides selon tes accords, la tonalité et le style">${icon('sparkle')}<span>Remplir<em> les cases vides</em></span></button></div>`;
    const toolPanel = v2 === 'impro' ? this.improPanel() : v2 === 'midi' ? this.midiPanel() : v2 === 'mic' ? this.micPanel() : '';
    const narrow = (c.cols || 4) >= 5;
    const secs = c.sections.map((s, si) => {
      const bars = s.collapsed ? '' : s.bars.map((b, bi) => {
        const isSel = sel && sel.si === si && sel.bi === bi;
        const cs = b.c.filter(Boolean);
        let inner;
        const sg = (h) => (b.s?.[h] && b.c[h] ? ' sug' : '');
        if (!b.c.length || !cs.length) inner = '<span class="cp-empty">+</span>';
        else if (b.c.length === 1) inner = `<b class="cp-ch${sg(0)}">${esc(b.c[0])}</b>`;
        else inner = `<span class="cp-split"><b class="c1${sg(0)}${sel && isSel && sel.h === 0 ? ' hsel' : ''}">${esc(b.c[0] || '·')}</b><b class="c2${sg(1)}${sel && isSel && sel.h === 1 ? ' hsel' : ''}">${esc(b.c[1] || '·')}</b></span>`;
        const hasSug = b.c.some((nm, h) => nm && b.s?.[h]);
        if (hasSug) inner += `<button class="cp-ok" data-a="ok" data-si="${si}" data-bi="${bi}" title="Valider ${b.c.length > 1 ? 'ces accords' : 'cet accord'}" aria-label="Valider">${icon('check')}</button>`;
        const dg = cs.length ? `<span class="cp-dg">${b.c.map((nm, h) => (nm ? diagramSVG(nm, inst, { index: this.vAt(si, bi, h), ...this.own(si, bi, h) }) : '')).join('')}</span>` : '';
        const rm = cs.length && b.c.length === 1 ? `<i class="cp-rn">${esc(roman(b.c[0], key))}</i>` : '';
        return `<div class="cp-bar${cs.length ? '' : ' cp-void'}${hasSug ? ' has-sug' : ''}${isSel ? ' cp-sel' : ''}${this.inRange(si, bi) ? ' cp-rng' : ''}${this.playing === `${si}.${bi}` ? ' cp-now' : ''}" data-si="${si}" data-bi="${bi}">${inner}${rm}${dg}<span class="n">${bi + 1}</span></div>`;
      }).join('');
      return `<section class="cp-sec k-${s.kind}${s.collapsed ? ' closed' : ''}" data-si="${si}">
        <div class="cp-sec-h">
          <button class="cp-fold" data-a="fold" data-si="${si}" aria-label="${s.collapsed ? 'Déplier' : 'Replier'}">▾</button>
          <i class="cp-kbar"></i>
          <input class="cp-sec-name" data-f="label" data-si="${si}" value="${esc(s.label)}" aria-label="Nom de la partie" size="${Math.max(4, s.label.length + 1)}">
          <label class="cp-pill" title="Nombre de fois que la partie est jouée">×${s.repeat}<i class="cp-chev">▾</i><select data-f="rep" data-si="${si}">${[1, 2, 3, 4, 5, 6, 8].map((n) => `<option value="${n}" ${s.repeat === n ? 'selected' : ''}>× ${n}</option>`).join('')}</select></label>
          <span class="cp-sec-acc" title="Jeu et batterie de cette partie">
            <select data-f="sec-pattern" data-si="${si}" class="${s.pattern ? 'set' : ''}"><option value="">Jeu général</option>${PATTERNS.slice(1).map(([k, l]) => `<option value="${k}" ${s.pattern === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
            <select data-f="sec-drums" data-si="${si}" class="${s.drumStyle ? 'set' : ''}"><option value="">Batterie générale</option>${DRUM_STYLES.slice(1).map(([k, l]) => `<option value="${k}" ${s.drumStyle === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
          </span>
          <span class="cp-sec-tools">
            <button data-a="sec-play" data-si="${si}" title="Écouter cette partie" aria-label="Écouter cette partie">${icon('play')}</button>
            <span class="cp-nb">${s.bars.length} mesure${s.bars.length > 1 ? 's' : ''}</span>
            <button class="cp-plus" data-a="bars" data-si="${si}" data-v="1" title="Ajouter une mesure" aria-label="Ajouter une mesure">+</button>
            <button data-a="sec-menu" data-si="${si}" aria-label="Plus d’options">${icon('more')}</button>
          </span>
        </div>
        ${s.collapsed ? '' : `<div class="cp-bars${narrow ? ' narrow' : ''}" style="--cols:${c.cols || 4}">${bars}</div>`}
      </section>`;
    }).join('');
    const addSec = `<div class="cp-add"><span class="note">Ajouter une partie</span>${KINDS.map(([k, l]) => `<button class="cp-addk k-${k}" data-a="add-sec" data-v="${k}"><i class="cp-dot"></i>${l}</button>`).join('')}</div>`;
    this.el.innerHTML = `${head}<div class="cp-wrap${this.panelHidden ? ' no-panel' : ''}"><main class="cp-main">${opts}${tabs}${this.fillBar()}${toolPanel}<div class="cp-grid">${secs}</div>${addSec}
      <p class="note cp-help">Touche une case pour y mettre un accord · Maj+clic ou glisser pour sélectionner plusieurs mesures · Espace : écouter · sons réalistes : FluidR3 GM (Frank Wen, CC BY 3.0).</p></main>
      ${this.panelHidden ? '<button class="cp-panel-open" data-a="panel" title="Afficher le panneau de l’accord">«</button>' : this.panel(key)}</div>
      ${this.transport()}`;
    this.tickTransport();
    if (sel && this._scrollSel !== `${sel.si}.${sel.bi}`) {
      this._scrollSel = `${sel.si}.${sel.bi}`;
      requestAnimationFrame(() => {
        const bar = this.el.querySelector('.cp-bar.cp-sel'), pnl = this.el.querySelector('.cp-panel');
        if (!bar || !pnl || getComputedStyle(pnl).position !== 'fixed') return;
        const r = bar.getBoundingClientRect(), limit = innerHeight - pnl.offsetHeight - 12;
        if (r.bottom > limit || r.top < 60) bar.scrollIntoView({ block: 'start', behavior: 'smooth' });
      });
    }
  }

  // ──────────────────────────────────────────────── écoute au micro ──
  async micStart() {
    try {
      const prefs = (await this.app.prefs?.()) || {};
      this.listener ||= new ChordListener();
      await this.listener.start(prefs.micId);
      this.listener.onFrame = () => { const now = performance.now(); if (now - (this._micT || 0) > 140) { this._micT = now; this.updateMic(); } };
      this.micActive = true; this.view2 = 'mic';
      toast('Micro ouvert : joue l’accord demandé' + (this.player.on ? ' (mets un casque pour que le micro n’entende pas MusiMix)' : ''), 4000);
    } catch (err) {
      this.micActive = false; this.view2 = 'compose';
      toast(err?.name === 'NotAllowedError' ? 'Accès au micro refusé : autorise-le dans le navigateur' : err?.name === 'NotFoundError' ? 'Aucun micro trouvé' : 'Micro indisponible', 6000);
    }
    this.render();
  }

  micStop() { this.listener?.stop(); this.micActive = false; }

  micPanel() {
    if (!this.micActive) return '';
    const L = this.listener, target = this.improChord();
    const chroma = L?.chroma || new Array(12).fill(0), active = L?.active && Math.max(...chroma) > 0.05;
    const j = judge(chroma, target);
    const rec = active ? recognize(chroma) : null;
    const lvl = !active ? 'idle' : j.level;
    const fr = (p) => CHROMA_NAMES[p];
    let st;
    if (!active) st = target ? `<span class="mk-target">Accord demandé : <b>${esc(target)}</b></span> <span class="note">· joue-le, j’écoute…</span>` : '<span class="note">Choisis une case (ou lance l’écoute) puis joue l’accord. J’écoute…</span>';
    else if (!target) st = `J’entends <b>${esc(rec?.name || '…')}</b> <span class="note">· choisis une case pour comparer</span>`;
    else st = `<span class="mk-target">Accord demandé : <b>${esc(target)}</b></span> · J’entends <b>${esc(rec?.name || '…')}</b> · ${{
      ok: '<b class="mk-ok">✓ Juste !</b>',
      partial: `<b class="mk-warn">Il manque ${j.missing.map(fr).join(', ')}</b>`,
      bad: j.wrong.length ? `<b class="mk-bad">${j.wrong.map(fr).join(', ')} ${j.wrong.length > 1 ? 'ne sont pas' : 'n’est pas'} dans l’accord</b>` : '<b class="mk-bad">Ce n’est pas cet accord</b>',
    }[j.level] || ''}`;
    const bars = CHROMA_NAMES.map((n, p) => {
      const v = active ? j.heard[p] : 0, inT = j.set?.has(p);
      const cls = v > 0.35 ? (j.set ? (inT ? 'ok' : 'bad') : 'on') : inT ? 'tgt' : '';
      return `<div class="ch-col ${cls}"><div class="ch-bar"><i style="height:${Math.round(Math.min(1, v) * 100)}%"></i></div><span>${n}</span></div>`;
    }).join('');
    const meter = Math.min(100, Math.round((L?.rms || 0) * 900));
    return `<div class="cp-tool cp-midi cp-mic lv-${lvl}">
      <div class="im-head"><b>Micro</b><span class="mk-st">${st}</span><span class="im-sp"></span>
        <span class="mic-meter" title="Niveau du micro"><i style="width:${meter}%"></i></span>
        ${rec && active && this.sel && !this.player.on && rec.score > 0.82 ? `<button class="btn small" data-a="mic-put" data-v="${esc(rec.name)}">Mettre ${esc(rec.name)} dans la case</button>` : ''}
        <button type="button" class="icon-btn im-x" data-a="view" data-v="compose" aria-label="Fermer">✕</button></div>
      <div class="ch-cols">${bars}</div>
      <div class="mk-leg"><span><i class="sw tgt"></i>notes de l’accord demandé</span><span><i class="sw ok"></i>entendue, juste</span><span><i class="sw bad"></i>entendue, hors accord</span><span class="note">· le micro entend les notes, pas l’octave</span></div></div>`;
  }

  updateMic() {
    const el = this.el?.querySelector('.cp-mic');
    if (!el) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = this.micPanel();
    el.replaceWith(tmp.firstElementChild);
  }

  // ─────────────────────────────────────────────────── clavier MIDI ──
  async midiOnStart(user) {
    try {
      await midi.enable();
      midi.skipSurface = true; midi._bind?.();
      if (!this._midiH) {
        this._midiH = (e) => { this.midiNotes = e.detail.notes; this.updateMidi(); };
        this._midiD = () => this.updateMidi(true);
        midi.addEventListener('notes', this._midiH);
        midi.addEventListener('devices', this._midiD);
      }
      this.midiActive = true; this.midiNotes = [...midi.held]; this.view2 = 'midi';
      localStorage.setItem('mm-compo-midi', '1');
      if (user) toast(midi.devices.length ? `Clavier connecté : ${midi.devices[0]}` : 'Aucun clavier MIDI détecté : branche-le (USB), il apparaîtra tout seul');
    } catch (err) { if (user) toast(err.message || 'MIDI indisponible', 6000); this.midiActive = false; this.view2 = 'compose'; }
    this.render();
  }

  midiOff(keepPref = false) {
    if (this._midiH) { midi.removeEventListener('notes', this._midiH); midi.removeEventListener('devices', this._midiD); this._midiH = null; }
    this.midiActive = false;
    if (!keepPref) localStorage.setItem('mm-compo-midi', '0');
  }

  /** Compare les notes jouées à l'accord demandé. */
  midiCheck(notes, target) {
    const ch = target ? pc2(target) : null;
    if (!ch) return { want: new Set(), level: notes.length ? 'free' : 'idle' };
    const want = new Set(ch.intervals.map((i) => (ch.root + i) % 12));
    if (ch.bass != null) want.add(ch.bass);
    const fifth = (ch.root + 7) % 12;
    const have = new Set(notes.map((n) => n % 12));
    const missing = [...want].filter((p) => !have.has(p) && !(p === fifth && want.size >= 3));
    const wrong = notes.filter((n) => !want.has(n % 12));
    const bassOk = ch.bass == null || !notes.length || Math.min(...notes) % 12 === ch.bass;
    const level = !notes.length ? 'idle' : wrong.length ? 'bad' : missing.length ? 'partial' : bassOk ? 'ok' : 'bass';
    return { want, missing, wrong, level, ch };
  }

  midiKeys(notes, want) {
    const held = new Set(notes);
    const lo = 36, hi = 84, wW = 20, wH = 84, bW = 13, bH = 52;
    let whites = '', blacks = '', x = 0;
    const cls = (m) => (held.has(m) ? (want.size ? (want.has(m % 12) ? ' ok' : ' bad') : ' on') : want.has(m % 12) ? ' tgt' : '');
    for (let m = lo; m <= hi; m++) {
      const pc = m % 12;
      if ([1, 3, 6, 8, 10].includes(pc)) continue;
      whites += `<rect class="mk-w${cls(m)}" x="${x}" y="0" width="${wW}" height="${wH}" rx="3"/>${pc === 0 ? `<text x="${x + wW / 2}" y="${wH - 6}" class="mk-t">Do${Math.floor(m / 12) - 1}</text>` : ''}`;
      if ([0, 2, 5, 7, 9].includes(pc) && m + 1 <= hi) blacks += `<rect class="mk-b${cls(m + 1)}" x="${x + wW - bW / 2}" y="0" width="${bW}" height="${bH}" rx="2"/>`;
      x += wW;
    }
    return `<svg class="mk" viewBox="-1 -1 ${x + 2} ${wH + 2}">${whites}${blacks}</svg>`;
  }

  midiStatus(notes, target, chk) {
    const nm = (p) => ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'][p % 12];
    const played = notes.length >= 2 ? nameChord(notes) : notes.length ? nm(notes[0]) : '';
    if (!midi.devices.length) return '<span class="note">Aucun clavier détecté : branche-le en USB (Chrome ou Edge).</span>';
    if (!target) return notes.length ? `Tu joues <b>${esc(played || notes.map(nm).join(' '))}</b> <span class="note">· choisis une case pour comparer</span>` : '<span class="note">Choisis une case (ou lance l’écoute) puis joue l’accord.</span>';
    const t = `<span class="mk-target">Accord demandé : <b>${esc(target)}</b></span>`;
    if (chk.level === 'idle') return `${t} <span class="note">· joue-le !</span>`;
    const msg = {
      ok: `<b class="mk-ok">✓ Juste !${(() => { const f = (chk.ch.root + 7) % 12; return chk.want.has(f) && !notes.some((n) => n % 12 === f) ? ` <small>(sans la quinte ${nm(f)})</small>` : ''; })()}</b>`,
      bass: `<b class="mk-warn">Presque : mets ${nm(chk.ch.bass)} à la basse</b>`,
      partial: `<b class="mk-warn">Il manque ${chk.missing.map(nm).join(', ')}</b>`,
      bad: `<b class="mk-bad">${[...new Set(chk.wrong.map((n) => nm(n)))].join(', ')} ${chk.wrong.length > 1 ? 'ne sont pas' : 'n’est pas'} dans l’accord</b>`,
    }[chk.level];
    return `${t} · Tu joues <b>${esc(played || '…')}</b> · ${msg}`;
  }

  midiPanel() {
    if (!this.midiActive) return '';
    const target = this.improChord(), notes = this.midiNotes || [];
    const chk = this.midiCheck(notes, target);
    const sel = this.sel, b = sel && this.c.sections[sel.si].bars[sel.bi];
    const canPut = notes.length >= 2 && nameChord(notes) && sel && !this.player.on;
    return `<div class="cp-tool cp-midi lv-${chk.level}">
      <div class="im-head"><b>Clavier MIDI</b><span class="mk-st">${this.midiStatus(notes, target, chk)}</span><span class="im-sp"></span>
        ${canPut ? `<button class="btn small" data-a="midi-put" title="Mettre l’accord joué dans la case choisie">Mettre ${esc(nameChord(notes))} dans la case</button>` : ''}
        <button type="button" class="icon-btn im-x" data-a="view" data-v="compose" aria-label="Fermer">✕</button></div>
      <div class="mk-wrap">${this.midiKeys(notes, chk.want)}</div>
      <div class="mk-leg"><span><i class="sw tgt"></i>notes de l’accord demandé</span><span><i class="sw ok"></i>juste</span><span><i class="sw bad"></i>hors accord</span></div></div>`;
  }

  updateMidi(full = false) {
    const el = this.el?.querySelector('.cp-midi');
    if (!el || full) { if (this.c) this.render(); return; }
    const tmp = document.createElement('div');
    tmp.innerHTML = this.midiPanel();
    el.replaceWith(tmp.firstElementChild);
  }

  // ─────────────────────────────────────────────── notes justes (impro) ──
  improChord() {
    if (this.player.on && this._playChord) return this._playChord;
    const sel = this.sel;
    return sel ? this.c.sections[sel.si]?.bars[sel.bi]?.c[sel.h] || null : null;
  }

  improBoard() {
    const o = this.c.impro, key = this.key(), chord = o.mode === 'chord' ? this.improChord() : null;
    const L = improLayers(key, chord, { current: o.mode === 'chord', penta: o.penta !== false, scale: o.scale !== false, blues: !!o.blues });
    const board = this.c.instrument === 'piano' ? keysSvg(L, key, { names: o.names || 'notes' }) : neckSvg(L, key, { instrument: 'guitar', names: o.names || 'notes', frets: 15 });
    const now = o.mode === 'chord' ? (chord ? `Accord : <b>${esc(chord)}</b>${this.player.on ? ' <small>(suit la lecture)</small>' : ''}` : '<span class="note">Touche une case (ou lance l’écoute) pour voir ses notes</span>') : `Tonalité : <b>${esc(keyLabel(key))}</b>`;
    return { board, now };
  }

  improPanel() {
    const o = this.c.impro;
    if (!o?.on) return '';
    const key = this.key(), S = SCALES[key.minor ? 'minor' : 'major'];
    const { board, now } = this.improBoard();
    const chip = (k, label, on) => `<button type="button" class="im-chip ${on ? 'on' : ''}" data-a="im" data-v="${k}">${label}</button>`;
    return `<div class="cp-tool cp-impro">
      <div class="im-head"><b>Impro</b>
        <span class="seg"><button data-a="im-mode" data-v="song" class="${o.mode !== 'chord' ? 'on' : ''}">Tout le morceau</button><button data-a="im-mode" data-v="chord" class="${o.mode === 'chord' ? 'on' : ''}">Accord choisi</button></span>
        <span class="im-now">${now}</span><span class="im-sp"></span>
        <button type="button" class="icon-btn im-x" data-a="view" data-v="compose" aria-label="Fermer">✕</button></div>
      <div class="im-legend">
        ${o.mode === 'chord' ? '<span class="im-chip on plain"><i class="sw chord"></i>Notes de l’accord</span>' : ''}
        ${chip('penta', '<i class="sw penta"></i>Toujours bonnes <small>(pentatonique)</small>', o.penta !== false)}
        ${chip('scale', `<i class="sw scale"></i>Reste de la gamme ${S.label}`, o.scale !== false)}
        ${chip('blues', '<i class="sw blues"></i>Note blues', !!o.blues)}
        ${chip('names', o.names === 'degrees' ? 'Noms : degrés' : 'Noms : notes', true)}
      </div>
      <div class="im-board">${board}</div></div>`;
  }

  updateImpro() {
    const el = this.el.querySelector('.cp-impro');
    if (!el || this.c.impro?.mode !== 'chord') return;
    const { board, now } = this.improBoard();
    el.querySelector('.im-board').innerHTML = board;
    el.querySelector('.im-now').innerHTML = now;
  }

  // ───────────────────────────────────────────── remplissage intelligent ──
  fillBar() {
    const n = this.sugCount();
    if (!n) { this.fill = null; return ''; }
    const f = this.fill;
    return `<div class="cp-fillbar"><span class="cp-fb-t">${icon('sparkle')} <b>${n} accord${n > 1 ? 's' : ''} proposé${n > 1 ? 's' : ''}</b> <span class="note">en violet</span></span>
      ${f?.sets.length > 1 ? `<span class="seg cp-fb-nav"><button data-a="fill-prev" aria-label="Proposition précédente">◀</button><output>Proposition ${f.idx + 1} / ${f.sets.length}</output><button data-a="fill-next" aria-label="Proposition suivante">▶</button></span>` : ''}
      <button class="btn small" data-a="fill-again" title="Tirer de nouvelles propositions">Autres idées</button>
      <button class="btn small primary" data-a="fill-ok">${icon('check')} Tout valider</button>
      <button class="btn small ghost" data-a="fill-no">Tout retirer</button></div>`;
  }

  /** Lance le remplissage sur la portée choisie : 'all', 'section' ou 'range'. */
  runFill(scope, seed = Date.now()) {
    const c = this.c, key = this.key();
    const rk = scope === 'range' ? new Set(this.rangeBars().map(({ si, bi }) => `${si}.${bi}`)) : null;
    const sec = scope === 'section' ? this.sel?.si : null;
    const inScope = (si, bi) => (scope === 'all' ? true : scope === 'section' ? si === sec : rk.has(`${si}.${bi}`));
    const res = autofill(c, key, { inScope, count: 3, seed });
    if (!res.sets.length) { toast('Aucune case vide à remplir ici'); return; }
    if (!this.fill || this.fill.scope !== scope) this.snap();
    this.fill = { scope, sets: res.sets, idx: 0, seed };
    this.applyFillSet();
    const n = res.sets[0].length;
    toast(`${n} accord${n > 1 ? 's' : ''} proposé${n > 1 ? 's' : ''} en ${keyLabel(key)} · ${res.sets.length} proposition${res.sets.length > 1 ? 's' : ''}`);
  }

  applyFillSet() {
    const f = this.fill;
    if (!f) return;
    for (const x of f.sets[f.idx]) {
      const b = this.c.sections[x.si]?.bars[x.bi];
      if (!b) continue;
      const cur = b.c[x.h] || '';
      if (cur && (!b.s?.[x.h] || b.s[x.h] === 2)) continue; // case remplie ou choisie à la main entre-temps
      if (!b.c.length) b.c = [''];
      b.c[x.h] = x.name;
      (b.s ||= [])[x.h] = true;
      if (b.v) b.v[x.h] = null; if (b.g) b.g[x.h] = null; if (b.p) b.p[x.h] = null;
    }
    this.save(); this.render();
    if (this.player.on) this.restartIfPlaying();
  }

  validate(pred) {
    this.snap();
    for (const [si, s] of this.c.sections.entries()) s.bars.forEach((b, bi) => b.c.forEach((nm, h) => { if (nm && b.s?.[h] && pred(si, bi, h)) b.s[h] = false; }));
    this.save(); this.render();
  }

  panel(key) {
    const sel = this.sel, c = this.c;
    if (!sel) return `<aside class="cp-panel empty-p"><div class="cp-p-head"><button class="cp-pbtn" data-a="panel" title="Masquer le panneau" aria-label="Masquer le panneau">»</button><b>Accord</b></div><h3>Composer</h3><p class="note">Touche une case de la grille pour choisir un accord. MusiMix te proposera :</p>
      <ul class="note"><li><b>Suite</b> : les accords qui vont bien après le précédent</li><li><b>Transitions</b> : des accords de passage vers le suivant</li><li><b>Variantes</b> : couleurs, renversements, substitutions</li><li><b>Doigtés</b> : les formes les plus proches sur le manche</li></ul>
      <p class="note">Le style (${esc(STYLES[c.style].label)}) oriente les propositions et le rythme d’écoute.</p></aside>`;
    const s = c.sections[sel.si], b = s.bars[sel.bi], cur = b.c[sel.h] || '';
    const rb = this.rangeBars();
    if (rb.length > 1) {
      const names = rb.map(({ si, bi }) => c.sections[si].bars[bi].c.filter(Boolean).join(' ') || '–');
      return `<aside class="cp-panel"><div class="cp-p-head"><b>${rb.length} mesures sélectionnées</b><button class="icon-btn sm" data-a="unsel" aria-label="Fermer">${icon('close')}</button></div>
        <p class="cp-rng-list">${names.map((x) => `<span>${esc(x)}</span>`).join('')}</p>
        <div class="cp-row"><button class="btn primary small" data-a="copy">Copier</button><button class="btn small" data-a="cut">Couper</button><button class="btn small" data-a="clear-rng">Effacer</button><button class="btn small" data-a="dup-rng">Dupliquer à la suite</button><button class="btn small ghost" data-a="hear-rng">${icon('play')} Écouter</button></div>
        <p class="note">Ensuite, touche la case où coller, puis « Coller ». Raccourcis : Ctrl+C, Ctrl+X, Ctrl+V. Maj+clic ou glisser pour sélectionner.</p></aside>`;
    }
    const { prev, next } = this.neighbors(sel.si, sel.bi, sel.h);
    const inst = c.instrument === 'piano' ? 'piano' : 'guitar';
    const chip = (nm, why, extra = '') => `<span class="cp-chip"><button class="cp-use" data-a="use" data-v="${esc(nm)}" ${extra} title="${esc(why || '')}"><b>${esc(nm)}</b>${why ? `<small>${esc(why)}</small>` : ''}</button><button class="cp-hear" data-a="hear" data-v="${esc(nm)}" aria-label="Écouter ${esc(nm)}">${icon('play')}</button></span>`;
    const od = (this.openD ||= new Set(['acts']));
    const det = (k, title, body, ic = '') => `<details class="cp-det" data-d="${k}"${od.has(k) ? ' open' : ''}><summary>${ic ? icon(ic) : ''}<span>${title}</span><i class="cp-chev">▾</i></summary><div class="cp-det-b">${body}</div></details>`;
    // contenus
    const sugg = nextChords(prev?.name || '', key, c.style).slice(0, 6);
    const transBody = (() => {
      const a = cur || prev?.name, nb = next?.name;
      if (!a || !nb) return '<p class="note">Il faut un accord ici et un accord après pour proposer des transitions.</p>';
      return `<p class="note">De <b>${esc(a)}</b> vers <b>${esc(nb)}</b>, joués sur la 2<sup>e</sup> moitié de la mesure :</p><div class="cp-chips">${transitions(a, nb, key, c.style).map((x) => `<span class="cp-chip"><button class="cp-use" data-a="trans" data-v="${esc(x.names.join(' '))}" title="${esc(x.why)}"><b>${esc(x.names.join(' → '))}</b><small>${esc(x.why)}</small></button><button class="cp-hear" data-a="hear-seq" data-v="${esc([a, ...x.names, nb].join(' '))}" aria-label="Écouter">${icon('play')}</button></span>`).join('')}</div>`;
    })();
    const varBody = cur ? `<div class="cp-chips">${variations(cur, key, c.style).map((x) => chip(x.name, x.why)).join('')}</div>` : '<p class="note">Choisis d’abord un accord.</p>';
    let voBody;
    if (!cur) voBody = '<p class="note">Choisis d’abord un accord.</p>';
    else if (inst === 'piano') {
      const own = b.p?.[sel.h];
      voBody = `<div class="cp-vos piano">${pianoOptions(cur).map((o) => `<button class="cp-vo${own && own.join() === o.notes.join() ? ' on' : ''}" data-a="pno" data-v="${o.notes.join(',')}">${diagramSVG(cur, 'piano', { notes: o.notes })}<small>${esc(o.label)}</small></button>`).join('')}</div>${own ? '<button class="btn small" data-a="vo-auto">Position normale</button>' : ''}`;
    } else {
      const pv = prev ? this.vObj(prev) : null, nv = next ? this.vObj(next) : null;
      const all = allVoicings(cur, 'guitar'), curF = this.vObj({ si: sel.si, bi: sel.bi, h: sel.h, name: cur })?.frets?.join();
      const close = voicingOptions(cur, pv, nv, 'guitar')[0];
      const closeF = close ? vList(cur, 'guitar')[close.index]?.frets.join() : null;
      const lockd = b.v?.[sel.h] != null || b.g?.[sel.h];
      voBody = `<p class="note">${prev || next ? '★ = la plus proche des accords voisins' : 'De la tête vers le corps du manche'}</p>
        <div class="cp-vos">${all.map((v) => `<button class="cp-vo${v.frets.join() === curF ? ' on' : ''}" data-a="vof" data-v="${v.frets.join(',')}">${diagramSVG(cur, 'guitar', { frets: v.frets })}<small>${v.frets.join() === closeF ? '★ ' : ''}${v.pos ? `case ${v.pos}` : 'cordes à vide'}</small></button>`).join('')}</div>
        ${lockd ? '<button class="btn small" data-a="vo-auto">Revenir au choix automatique</button>' : ''}`;
    }
    const keyBody = `<div class="cp-chips small">${[0, 1, 2, 3, 4, 5, 6].map((d) => { const nm = degree(key, d, c.style); return chip(nm, roman(nm, key)); }).join('')}</div>`;
    const actsBody = `<div class="cp-btns">
        <button data-a="split" title="${b.c.length > 1 ? 'Un seul accord dans la mesure' : 'Deux accords dans la mesure'}">${b.c.length > 1 ? '1 accord' : '2 accords'}</button>
        ${b.c.length > 1 ? `<button data-a="half" data-v="0" class="${sel.h === 0 ? 'on' : ''}">1re moitié</button><button data-a="half" data-v="1" class="${sel.h === 1 ? 'on' : ''}">2e moitié</button>` : ''}
        <button data-a="copy-prev" title="Reprendre l’accord d’avant">= précédent</button>
        <button data-a="clear">Effacer</button></div>
      <div class="cp-btns" style="margin-top:6px">
        <button data-a="multi" class="${this.multi ? 'on' : ''}" title="Puis touche la dernière case à prendre">Sélectionner plusieurs</button>
        <button data-a="copy">Copier</button>
        ${CLIP?.length ? `<button data-a="paste" title="Coller ${CLIP.length} mesure(s) ici">Coller</button><button data-a="paste-ins" title="Insérer ici sans rien écraser">Insérer</button>` : ''}</div>`;
    const rn = cur ? roman(cur, key) : '';
    return `<aside class="cp-panel">
      <div class="cp-p-head">
        <button class="cp-pbtn" data-a="panel" title="Masquer le panneau" aria-label="Masquer le panneau">»</button>
        <button class="cp-pbtn" data-a="nav" data-v="-1" aria-label="Case précédente">‹</button>
        <b>${esc(s.label)} · mesure ${sel.bi + 1}${b.c.length > 1 ? ` · ${sel.h ? '2e' : '1re'} moitié` : ''}</b>
        <button class="cp-pbtn" data-a="nav" data-v="1" aria-label="Case suivante">›</button>
        <button class="cp-pbtn" data-a="unsel" aria-label="Fermer">${icon('close')}</button>
      </div>
      ${cur && b.s?.[sel.h] ? `<div class="cp-sugbox"><div class="cp-sug-h">${icon('sparkle')} <b>Proposé par MusiMix</b>
          <button class="btn small primary" data-a="ok-slot">${icon('check')} Valider</button><button class="btn small ghost" data-a="ok-sec" title="Valider tous les accords proposés de cette partie">Toute la partie</button></div>
          <div class="cp-sug-alts"><span class="note">Ou plutôt :</span>${slotAlternatives(c, key, sel.si, sel.bi, sel.h, cur).map((nm) => `<button class="cp-alt" data-a="alt" data-v="${esc(nm)}" title="Essayer ${esc(nm)} (reste proposé)">${esc(nm)}</button>`).join('')}</div></div>` : ''}
      <div class="cp-entry">
        <input class="cp-in${b.s?.[sel.h] ? ' sug' : ''}" data-f="chord" value="${esc(cur)}" placeholder="Accord (ex. Am7, F/A, G)" autocomplete="off" spellcheck="false">
        <button class="cp-in-play" data-a="${cur ? 'hear-slot' : 'noop'}" aria-label="Écouter" ${cur ? '' : 'disabled'}>${icon('play')}</button>
      </div>
      <div class="cp-dcard">
        ${inst === 'piano' ? this.drawPiano(cur, b) : this.drawNeck(cur, b)}
        ${cur ? `<div class="cp-dname"><span><b>${esc(cur)}</b><small>${esc(frChord(cur))}</small></span>${rn ? `<i class="cp-rnb">${esc(rn)}</i>` : ''}</div>` : ''}
      </div>
      <div class="cp-lbl">Construire un accord</div>
      <div class="cp-roots">${(([1, 3, 5, 8, 10].includes(key.pc) && !key.minor) || [0, 2, 5, 7, 10].includes(key.pc) && key.minor ? FLAT : ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']).map((n) => `<button data-a="root" data-v="${n}" class="${(this.root || parseChord(cur)?.rootName) === n ? 'on' : ''}">${n}</button>`).join('')}</div>
      <div class="cp-quals">${QUAL.map(([q, l]) => `<button data-a="qual" data-v="${q}" class="${cur && parseChord(cur)?.suffix === q && !parseChord(cur)?.bassName ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div class="cp-lbl">Accords suggérés ${prev ? `<span>après ${esc(prev.name)}</span>` : `<span>(${esc(keyLabel(key))})</span>`}</div>
      <div class="cp-sugg">${sugg.map((x) => `<button data-a="use" data-v="${esc(x.name)}" title="${esc(x.why)}">${esc(x.name)}</button>`).join('')}</div>
      ${det('acts', 'Mesure et copier-coller', actsBody, 'grid')}
      ${det('trans', 'Transitions vers l’accord suivant', transBody, 'next')}
      ${det('var', 'Variantes et substitutions', varBody, 'sparkle')}
      ${det('vo', inst === 'piano' ? 'Positions au clavier' : 'Doigtés alternatifs', voBody, inst === 'piano' ? 'piano' : 'guitar')}
      ${det('key', `Accords de la tonalité (${esc(keyLabel(key))})`, keyBody, 'tuner')}
    </aside>`;
  }

  /** Doigté effectivement affiché pour une case de la suite. */
  vObj(x) {
    const b = this.c.sections[x.si].bars[x.bi];
    if (b.g?.[x.h]) return { frets: b.g[x.h] };
    return voicingOf(x.name, this.vAt(x.si, x.bi, x.h));
  }

  slotKey() { const s = this.sel; return s ? `${s.si}.${s.bi}.${s.h}` : ''; }

  shownFrets(cur, b) {
    if (this.draft?.kind === 'g' && this.draft.key === this.slotKey()) return this.draft.frets;
    return (b.g?.[this.sel.h] || (cur && this.vObj({ ...this.sel, name: cur })?.frets) || [-1, -1, -1, -1, -1, -1]).slice();
  }

  shownNotes(cur, b) {
    if (this.draft?.kind === 'p' && this.draft.key === this.slotKey()) return this.draft.notes;
    return (b.p?.[this.sel.h] || (cur ? chordMidi(cur, 'piano') : [])).slice();
  }

  /** Forme modifiée au manche / au clavier : si c'est un accord reconnu, il va directement dans la case. */
  applyShape(kind, shape) {
    const midi = kind === 'g' ? chordMidi('', 'guitar', 0, { frets: shape }) : [...shape].sort((x, y) => x - y);
    const nm = midi.length >= 2 ? nameChord(midi) : null;
    if (nm) { this.draft = null; this.setChord(nm, { play: false, keep: kind === 'g' ? { frets: shape.slice() } : { notes: midi } }); }
    else { this.draft = { kind, key: this.slotKey(), [kind === 'g' ? 'frets' : 'notes']: shape }; this.render(); }
  }

  drawNeck(cur, b) {
    const sel = this.sel;
    const fr = this.shownFrets(cur, b), names = ['Mi', 'La', 'Ré', 'Sol', 'Si', 'Mi'];
    const midi = chordMidi('', 'guitar', 0, { frets: fr });
    const nm = midi.length >= 2 ? nameChord(midi) : null;
    let rows = '';
    for (let st = 5; st >= 0; st--) {
      let cells = `<button class="nk-open ${fr[st] === 0 ? 'on' : fr[st] < 0 ? 'mute' : ''}" data-a="nk" data-s="${st}" data-f="0" title="Corde à vide / étouffée">${fr[st] === 0 ? 'o' : fr[st] < 0 ? '×' : ''}</button>`;
      for (let f = 1; f <= 12; f++) cells += `<button class="nk-c${fr[st] === f ? ' on' : ''}" data-a="nk" data-s="${st}" data-f="${f}" aria-label="${names[st]} case ${f}"></button>`;
      rows += `<div class="nk-row"><span class="nk-l">${names[st]}</span>${cells}</div>`;
    }
    const marks = Array.from({ length: 13 }, (_, f) => `<span>${[3, 5, 7, 9, 12].includes(f) ? f : ''}</span>`).join('');
    const pending = this.draft?.key === this.slotKey();
    return `<div class="cp-draw">
      <div class="nk"><div class="nk-rows">${rows}<div class="nk-row nk-m"><span class="nk-l"></span>${marks}</div></div></div>
      <div class="cp-draw-res"><span class="note" title="Touche une case par corde · o / × : corde à vide / étouffée">${pending ? (midi.length >= 2 ? 'Non reconnu : ajoute ou enlève une note' : 'Pose au moins deux notes') : cur ? 'Touche le manche pour modifier' : 'Pose tes doigts pour créer un accord'}</span>
        <button class="btn small ghost" data-a="nk-hear" ${midi.length ? '' : 'disabled'} aria-label="Écouter">${icon('play')}</button>
        <button class="btn small ghost" data-a="nk-clear">Vider</button></div></div>`;
  }

  drawPiano(cur, b) {
    const set = new Set(this.shownNotes(cur, b));
    const nm = set.size >= 2 ? nameChord([...set]) : null;
    const lo = 36, hi = 72, wW = 22, wH = 92, bW = 14, bH = 58;
    let whites = '', blacks = '', x = 0;
    for (let m = lo; m < hi; m++) {
      const pc = m % 12;
      if ([1, 3, 6, 8, 10].includes(pc)) continue;
      whites += `<rect class="pk-w${set.has(m) ? ' on' : ''}" data-a="pk" data-m="${m}" x="${x}" y="0" width="${wW}" height="${wH}" rx="3"/>${pc === 0 ? `<text x="${x + wW / 2}" y="${wH - 6}" text-anchor="middle" class="pk-t">Do${Math.floor(m / 12) - 1}</text>` : ''}`;
      if ([0, 2, 5, 7, 9].includes(pc) && m + 1 < hi) blacks += `<rect class="pk-b${set.has(m + 1) ? ' on' : ''}" data-a="pk" data-m="${m + 1}" x="${x + wW - bW / 2}" y="0" width="${bW}" height="${bH}" rx="2"/>`;
      x += wW;
    }
    const pending = this.draft?.key === this.slotKey();
    return `<div class="cp-draw">
      <div class="pk"><svg viewBox="-1 -1 ${x + 2} ${wH + 2}">${whites}${blacks}</svg></div>
      <div class="cp-draw-res"><span class="note" title="La note la plus grave est la basse">${pending ? (set.size >= 2 ? 'Non reconnu : ajoute ou enlève une note' : 'Choisis au moins deux notes') : cur ? 'Touche le clavier pour modifier' : 'Touche les notes pour créer un accord'}</span>
        <button class="btn small ghost" data-a="pk-hear" ${set.size ? '' : 'disabled'} aria-label="Écouter">${icon('play')}</button>
        <button class="btn small ghost" data-a="nk-clear">Vider</button></div></div>`;
  }

  renderList() {
    const items = [...this.list].sort((a, b) => b.updatedAt - a.updatedAt);
    this.el.innerHTML = `<header class="topbar"><button class="icon-btn" data-a="home" aria-label="Retour">${icon('back')}</button>
      <div class="song-title"><b>Composer</b><span>Grilles d’accords avec suggestions et écoute</span></div><div class="spacer"></div></header>
      <main class="library"><div class="lib-head"><div><h1>Mes compositions</h1></div><div class="spacer"></div><button class="btn primary" data-a="new">${icon('plus')} Nouvelle composition</button></div>
      ${items.length ? `<ul class="songs">${items.map((x) => { const n = x.sections.reduce((a, s) => a + s.bars.filter((b) => b.c.some(Boolean)).length, 0); return `<li class="song-row" data-open="${x.id}"><div class="t"><b>${esc(x.name)}</b><span>${esc(STYLES[x.style]?.label || '')} · ${esc(x.sections.map((s) => s.label).join(', '))}</span></div><div class="meta">${n} mesure${n > 1 ? 's' : ''}</div><button class="icon-btn" data-a="del" data-v="${x.id}" aria-label="Supprimer">${icon('trash')}</button></li>`; }).join('')}</ul>`
        : `<div class="empty"><h2>Aucune composition</h2><p>Pars d’une grille vierge (intro, couplet, refrain…), mets quelques accords, et laisse MusiMix te proposer la suite, des transitions, des variantes et les doigtés les plus pratiques.</p><div class="row"><button class="btn primary" data-a="new">Commencer</button></div></div>`}
      </main>`;
  }

  // ───────────────────────────────────────────────────────── actions ──
  setChord(nm, { play = true, keep = null } = {}) {
    const sel = this.sel;
    this.draft = null;
    if (!sel) return;
    const b = this.c.sections[sel.si].bars[sel.bi];
    this.snap();
    if (!b.c.length) b.c = [''];
    b.c[sel.h] = nm;
    if (b.v) b.v[sel.h] = null;
    if (b.g) b.g[sel.h] = null;
    if (b.p) b.p[sel.h] = null;
    if (b.s || keep?.suggested) (b.s ||= [])[sel.h] = keep?.suggested ? 2 : false; // 2 = proposition choisie à la main (pas remplacée)
    if (keep?.frets) { (b.g ||= [])[sel.h] = keep.frets; }
    if (keep?.notes) { (b.p ||= [])[sel.h] = keep.notes; }
    if (play && nm) { this.voicingsAuto(); this.hearSlot(sel.si, sel.bi, sel.h); }
    this.save(); this.render();
  }

  advance() {
    const sel = this.sel, s = this.c.sections[sel.si], b = s.bars[sel.bi];
    if (b.c.length > 1 && sel.h === 0) { this.sel = { ...sel, h: 1 }; return; }
    if (sel.bi + 1 < s.bars.length) this.sel = { si: sel.si, bi: sel.bi + 1, h: 0 };
    else if (sel.si + 1 < this.c.sections.length) this.sel = { si: sel.si + 1, bi: 0, h: 0 };
  }

  events(onlySi = null) {
    // événements pour le lecteur (en noires), parties répétées
    const ev = [];
    let beat = 0;
    this.c.sections.forEach((s, si) => {
      if (onlySi != null && si !== onlySi) return;
      for (let r = 0; r < (onlySi != null ? 1 : s.repeat); r++) {
        s.bars.forEach((b, bi) => {
          const cs = b.c.length ? b.c : [''];
          let last = null;
          cs.forEach((nm, h) => {
            const dur = 4 / cs.length;
            let name = nm;
            if (!name) { const prev = ev[ev.length - 1]; name = prev ? prev.name : ''; }
            if (name) ev.push({ name, v: this.vAt(si, bi, h), ...(nm ? this.own(si, bi, h) : {}), pattern: s.pattern || '', drumStyle: s.drumStyle || '', beat0: beat + h * dur, dur, barBeat0: beat, firstOfBar: h === 0, key: `${si}.${bi}` });
            last = name;
          });
          if (!cs.some(Boolean) && !ev.length) ev.push({ name: '', v: 0, beat0: beat, dur: 4, barBeat0: beat, firstOfBar: true, key: `${si}.${bi}`, rest: true });
          beat += 4;
        });
      }
    });
    return ev.filter((e) => e.name || e.rest).map((e) => (e.rest ? { ...e, name: 'C', silent: true } : e)).filter((e) => !e.silent);
  }

  async play(onlySi = null, from = 0) {
    if (this.player.on) { this.player.stop(); this.playing = null; this._posBeat = 0; this.render(); return; }
    this._only = onlySi;
    if (this.c.sound !== 'synth' && !this._soundReady) {
      const btn = this.el.querySelector('.cp-tplay'); if (btn) btn.classList.add('loading');
      this._soundReady = await Promise.race([prepareSounds(this.c.instrument), new Promise((r) => setTimeout(() => r(false), 8000))]);
      if (!this._soundReady) toast('Sons réalistes indisponibles pour l’instant : synthé utilisé');
    }
    const ev = this.events(onlySi);
    if (!ev.length) { toast('Mets au moins un accord dans la grille'); this.render(); return; }
    this._evs = ev;
    from = Math.max(0, Math.min(ev.length - 1, from));
    this._posBeat = ev[from].beat0; this._posAt = performance.now();
    this.player.start(ev, {
      bpm: this.c.bpm, style: this.c.style, instrument: this.c.instrument, drums: true, pattern: this.c.pattern || '', drumStyle: this.c.drumStyle ?? (this.c.drums === false ? 'off' : ''), loop: this.c.loop !== false, from,
      onPos: (i) => {
        if (i < 0) { this.playing = null; this._playChord = null; if (!this.player.on) { this._posBeat = 0; this.render(); } return; }
        this.playing = ev[i].key;
        this._posBeat = ev[i].beat0; this._posAt = performance.now();
        const pc = ev[i].name;
        if (pc !== this._playChord) { this._playChord = pc; this.updateImpro(); if (this.midiActive) this.updateMidi(); }
        this.el.querySelectorAll('.cp-bar.cp-now').forEach((x) => x.classList.remove('cp-now'));
        const [si, bi] = this.playing.split('.'); this.el.querySelector(`.cp-bar[data-si="${si}"][data-bi="${bi}"]`)?.classList.add('cp-now');
      },
    });
    this.render();
  }

  /** Barre de lecture (en bas). */
  transport() {
    const c = this.c, ev = this.events(this.scopeSi ?? null);
    const total = ev.length ? Math.max(...ev.map((e) => e.beat0 + e.dur)) * 60 / c.bpm : 0;
    this._total = total;
    const on = this.player.on, loop = c.loop !== false;
    const spk = '<svg class="i" viewBox="0 0 24 24"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/></svg>';
    return `<div class="cp-transport">
      <span class="cp-time"><b data-r="tcur">${fmtT(on ? 0 : 0)}</b><span> / ${fmtT(total)}</span></span>
      <span class="cp-tsep"></span>
      <button class="cp-tbtn" data-a="t-start" title="Revenir au début" aria-label="Revenir au début">${icon('prev')}</button>
      <button class="cp-tplay${on ? ' on' : ''}" data-a="play" title="${on ? 'Pause' : 'Écouter (Espace)'}" aria-label="${on ? 'Pause' : 'Écouter'}">${icon(on ? 'pause' : 'play')}</button>
      <button class="cp-tbtn" data-a="t-stop" title="Arrêter" aria-label="Arrêter"><i class="cp-sq"></i></button>
      <button class="cp-tbtn${loop ? ' on' : ''}" data-a="t-loop" title="Boucle ${loop ? 'activée' : 'désactivée'}" aria-label="Boucle">${icon('loop')}</button>
      <label class="cp-tscope" title="Ce qui est joué"><select data-f="scope"><option value="">Tout le morceau</option>${c.sections.map((x, i) => `<option value="${i}" ${this.scopeSi === i ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</select></label>
      <div class="cp-prog" data-a="seek" title="Aller à…"><i data-r="tbar"></i><b data-r="tknob"></b></div>
      <span class="cp-tsep"></span>
      <label class="cp-tbpm" title="Tempo">♩<input type="number" min="40" max="240" data-f="bpm" value="${c.bpm}"></label>
      <span class="cp-tsep"></span>
      <label class="cp-tvol" title="Volume">${spk}<input type="range" min="0" max="1" step="0.01" value="${getVolume()}" data-f="vol"></label>
    </div>`;
  }

  tickTransport() {
    cancelAnimationFrame(this._raf);
    const upd = () => {
      const el = this.el?.querySelector('.cp-transport');
      if (!el) return;
      let beat = this._posBeat || 0;
      if (this.player.on) beat += ((performance.now() - (this._posAt || 0)) / 1000) * (this.c.bpm / 60);
      const tot = this._total || 0, t = Math.min(tot, (beat * 60) / this.c.bpm), f = tot ? t / tot : 0;
      el.querySelector('[data-r="tcur"]').textContent = fmtT(t);
      el.querySelector('[data-r="tbar"]').style.width = `${f * 100}%`;
      el.querySelector('[data-r="tknob"]').style.left = `${f * 100}%`;
      if (this.player.on) this._raf = requestAnimationFrame(upd);
    };
    upd();
  }

  seekTo(frac) {
    const ev = this.events(this.scopeSi ?? null);
    if (!ev.length) return;
    const tot = Math.max(...ev.map((e) => e.beat0 + e.dur)), target = frac * tot;
    let i = 0; ev.forEach((e, k) => { if (e.beat0 <= target + 1e-6) i = k; });
    if (this.player.on) this.player.stop();
    this.play(this.scopeSi ?? null, i);
  }

  restartIfPlaying() {
    if (!this.player.on) return;
    const only = this._only ?? null;
    this.player.stop(); this.play(only);
  }

  /** Change d'onglet de travail : Composition, Improvisation, Clavier MIDI, Micro. */
  setView(v) {
    const c = this.c;
    if (v !== 'midi' && this.midiActive) this.midiOff(true);
    if (v !== 'mic' && this.micActive) this.micStop();
    c.impro = { mode: 'chord', ...(c.impro || {}), on: v === 'impro' };
    this.view2 = v;
    if (v === 'midi' && !this.midiActive) { this.midiOnStart(true); return; }
    if (v === 'mic' && !this.micActive) { this.micStart(); return; }
    this.save(); this.render();
  }

  exportText() {
    const c = this.c;
    const lines = [`{title: ${c.name}}`, `{tempo: ${c.bpm}}`, ''];
    for (const s of c.sections) {
      lines.push(`[${s.label}${s.repeat > 1 ? ` x${s.repeat}` : ''}]`);
      for (let i = 0; i < s.bars.length; i += 4) {
        const row = s.bars.slice(i, i + 4).map((b) => (b.c.filter(Boolean).length ? b.c.map((x) => x || '%').join(' ') : '%'));
        lines.push(`| ${row.join(' | ')} |`);
      }
      lines.push('');
    }
    return lines.join('\n');
  }

  async onClick(e) {
    const dsum = e.target.closest('.cp-det > summary');
    if (dsum) { const d = dsum.parentElement; setTimeout(() => { (this.openD ||= new Set())[d.open ? 'add' : 'delete'](d.dataset.d); }, 0); return; }
    if (e.target.closest('.cp-setd > summary')) { setTimeout(() => { this._setOpen = this.el.querySelector('.cp-setd')?.open; }, 0); return; }
    const t = e.target.closest('[data-a], [data-open], .cp-bar');
    if (!t) return;
    if (t.dataset.open && !e.target.closest('[data-a]')) { this.app.go(`#/compo/${t.dataset.open}`); return; }
    if (t.classList.contains('cp-bar') && !t.dataset.a) {
      const si = +t.dataset.si, bi = +t.dataset.bi, b = this.c.sections[si].bars[bi];
      if (performance.now() < (this._noClickUntil || 0)) return;
      if ((e.shiftKey || this.multi) && this.sel) {
        this.range = { a: { si: this.sel.si, bi: this.sel.bi }, b: { si, bi } };
        if (this.rangeBars().length < 2) this.range = null;
        this.render(); return;
      }
      this.range = null;
      let h = 0;
      if (b.c.length > 1) { const r = t.getBoundingClientRect(); h = (e.clientX - r.left) / r.width + (e.clientY - r.top) / r.height > 1 ? 1 : 0; }
      this.sel = { si, bi, h };
      if (b.c[h]) this.hearSlot(si, bi, h);
      this.draft = null;
      this.render();
      setTimeout(() => { const inp = this.el.querySelector('.cp-in'); if (inp && matchMedia('(pointer: fine)').matches) inp.focus(); }, 0);
      return;
    }
    const a = t.dataset.a, v = t.dataset.v;
    const c = this.c;
    switch (a) {
      case 'home': this.app.go('#/'); break;
      case 'back': this.player.stop(); this.app.go('#/compo'); break;
      case 'new': {
        const x = blank(`Composition ${this.list.length + 1}`);
        this.list.unshift(x); await db.set('compos', this.list);
        this.app.go(`#/compo/${x.id}`); break;
      }
      case 'del': {
        e.stopPropagation();
        const x = this.list.find((y) => y.id === v);
        if (x && await confirmBox('Supprimer la composition ?', `« ${x.name} » sera supprimée.`, { ok: 'Supprimer', danger: true })) { this.list = this.list.filter((y) => y.id !== v); await db.set('compos', this.list); this.render(); }
        break;
      }
      case 'undo': if (this.undo.length) { const id = c.id; this.redo.push(JSON.stringify(c)); this.c = JSON.parse(this.undo.pop()); this.c.id = id; this.save(); this.render(); } break;
      case 'redo': if (this.redo.length) { const id = c.id; this.undo.push(JSON.stringify(c)); this.c = JSON.parse(this.redo.pop()); this.c.id = id; this.save(); this.render(); } break;
      case 'more': openMenu(t, [
        { icon: 'list', label: 'Copier la grille (texte)', action: async () => { try { await navigator.clipboard.writeText(this.exportText()); toast('Grille copiée : colle-la dans l’éditeur d’un morceau'); } catch { toast('Copie impossible'); } } },
        { icon: 'plus', label: 'Créer un morceau avec cette grille', action: () => this.toSong() },
        { icon: 'edit', label: 'Dupliquer la composition', action: async () => { const x = JSON.parse(JSON.stringify(c)); x.id = uid(); x.name += ' (copie)'; this.list.unshift(x); await db.set('compos', this.list); this.app.go(`#/compo/${x.id}`); } },
      ]); break;
      case 'inst': this._soundReady = false; c.instrument = v; if (c.sound !== 'synth') c.sound = undefined; this.changed(); break;
      case 'play': this.play(this.player.on ? null : (this.scopeSi ?? null)); break;
      case 't-start': if (this.player.on) { this.player.stop(); this.play(this.scopeSi ?? null, 0); } else { this._posBeat = 0; this.tickTransport(); } break;
      case 't-stop': this.player.stop(); this.playing = null; this._posBeat = 0; this.render(); break;
      case 't-loop': c.loop = c.loop === false; this.save(); this.render(); this.restartIfPlaying(); break;
      case 'seek': { const r = t.getBoundingClientRect(); this.seekTo(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))); break; }
      case 'view': this.setView(v); break;
      case 'fold': { const sct = c.sections[+t.dataset.si]; sct.collapsed = !sct.collapsed; this.save(); this.render(); break; }
      case 'panel': this.panelHidden = !this.panelHidden; this.render(); break;
      case 'nav': { if (!this.sel) break; if (+v > 0) this.advance(); else { const s0 = this.sel; if (s0.h === 1) s0.h = 0; else if (s0.bi > 0) { s0.bi--; s0.h = c.sections[s0.si].bars[s0.bi].c.length > 1 ? 1 : 0; } else if (s0.si > 0) { s0.si--; s0.bi = c.sections[s0.si].bars.length - 1; s0.h = 0; } } this.draft = null; this.render(); this.hearSlot(this.sel.si, this.sel.bi, this.sel.h); break; }
      case 'sec-less': { const sct = c.sections[+t.dataset.si]; if (sct.bars.length > 1) { this.snap(); sct.bars.pop(); this.save(); this.render(); } break; }
      case 'play-sec': case 'sec-play': this.player.stop(); this.play(a === 'sec-play' ? +t.dataset.si : this.sel.si); break;
      case 'rep': { const s = c.sections[+t.dataset.si]; s.repeat = Math.max(1, Math.min(8, s.repeat + +v)); this.changed(); break; }
      case 'bars': {
        const s = c.sections[+t.dataset.si];
        this.snap();
        if (+v > 0) s.bars.push({ c: [] }); else if (s.bars.length > 1) { s.bars.pop(); if (this.sel?.si === +t.dataset.si && this.sel.bi >= s.bars.length) this.sel = null; }
        this.changed({ snap: false }); break;
      }
      case 'sec-menu': {
        const si = +t.dataset.si;
        openMenu(t, [
          { label: 'Retirer la dernière mesure', action: () => { const sct = c.sections[si]; if (sct.bars.length > 1) { this.snap(); sct.bars.pop(); this.save(); this.render(); } } },
          { label: 'Monter', action: () => { if (si > 0) { this.snap(); const [x] = c.sections.splice(si, 1); c.sections.splice(si - 1, 0, x); this.sel = null; this.changed({ snap: false }); } } },
          { label: 'Descendre', action: () => { if (si < c.sections.length - 1) { this.snap(); const [x] = c.sections.splice(si, 1); c.sections.splice(si + 1, 0, x); this.sel = null; this.changed({ snap: false }); } } },
          { label: 'Dupliquer la partie', action: () => { this.snap(); const x = JSON.parse(JSON.stringify(c.sections[si])); x.id = uid(); c.sections.splice(si + 1, 0, x); this.changed({ snap: false }); } },
          { icon: 'trash', label: 'Supprimer la partie', action: () => { this.snap(); c.sections.splice(si, 1); this.sel = null; this.changed({ snap: false }); } },
        ]);
        break;
      }
      case 'add-sec': { const [k, l] = KINDS.find((x) => x[0] === v); this.snap(); c.sections.push({ id: uid(), kind: k, label: l, repeat: 1, bars: Array.from({ length: k === 'intro' || k === 'outro' ? 4 : 8 }, () => ({ c: [] })) }); this.changed({ snap: false }); break; }
      case 'mic': this.setView(this.view2 === 'mic' ? 'compose' : 'mic'); break;
      case 'mic-put': this.setChord(v, { play: false }); toast(`${v} mis dans la case`); break;
      case 'midi': if (this.view2 === 'midi') { this.midiOff(); this.setView('compose'); } else this.setView('midi'); break;
      case 'midi-put': { const notes = [...(this.midiNotes || [])].sort((x, y) => x - y), nm = nameChord(notes); if (nm) { this.setChord(nm, { play: false, keep: { notes } }); toast(`${nm} mis dans la case`); } break; }
      case 'impro': this.setView(this.view2 === 'impro' ? 'compose' : 'impro'); break;
      case 'im-mode': c.impro.mode = v; this.save(); this.render(); break;
      case 'im': { const o = c.impro; if (v === 'names') o.names = o.names === 'degrees' ? 'notes' : 'degrees'; else o[v] = v === 'blues' ? !o.blues : o[v] === false; this.save(); this.render(); break; }
      case 'fill': {
        const items = [{ icon: 'sparkle', label: 'Toute la grille', action: () => this.runFill('all') }];
        if (this.sel) items.push({ label: `Seulement « ${c.sections[this.sel.si].label} »`, action: () => this.runFill('section') });
        if (this.rangeBars().length > 1) items.push({ label: `Seulement la sélection (${this.rangeBars().length} mesures)`, action: () => this.runFill('range') });
        if (items.length === 1) this.runFill('all'); else openMenu(t, items);
        break;
      }
      case 'fill-next': case 'fill-prev': { const f = this.fill; if (!f) break; f.idx = (f.idx + (a === 'fill-next' ? 1 : f.sets.length - 1)) % f.sets.length; this.applyFillSet(); break; }
      case 'fill-again': {
        // retire les propositions puis en tire de nouvelles sur la même portée
        const scope = this.fill?.scope || 'all';
        for (const sct of c.sections) for (const b of sct.bars) b.c.forEach((nm, h) => { if (b.s?.[h]) { b.c[h] = ''; b.s[h] = false; } });
        for (const sct of c.sections) for (const b of sct.bars) if (b.c.length && !b.c.some(Boolean)) b.c = [];
        this.fill = { scope, sets: [], idx: 0 };
        this.runFill(scope, Date.now());
        break;
      }
      case 'fill-ok': this.validate(() => true); this.fill = null; toast('Accords validés'); break;
      case 'fill-no': {
        this.snap();
        for (const sct of c.sections) for (const b of sct.bars) { b.c.forEach((nm, h) => { if (b.s?.[h]) { b.c[h] = ''; b.s[h] = false; } }); if (b.c.length && !b.c.some(Boolean)) b.c = []; }
        this.fill = null; this.save(); this.render(); break;
      }
      case 'ok': { e.stopPropagation(); const si = +t.dataset.si, bi = +t.dataset.bi; this.validate((x, y) => x === si && y === bi); break; }
      case 'ok-slot': { const { si, bi, h } = this.sel; this.validate((x, y, z) => x === si && y === bi && z === h); break; }
      case 'ok-sec': { const si = this.sel.si; this.validate((x) => x === si); break; }
      case 'alt': this.setChord(v, { keep: { suggested: true } }); break;
      case 'unsel': this.sel = null; this.range = null; this.multi = false; this.render(); break;
      case 'multi': this.multi = !this.multi; if (this.multi) toast('Touche la dernière case à sélectionner'); this.render(); break;
      case 'copy': this.copyRange(false); this.multi = false; break;
      case 'cut': this.copyRange(true); this.multi = false; break;
      case 'paste': this.paste(false); break;
      case 'paste-ins': this.paste(true); break;
      case 'clear-rng': this.snap(); this.rangeBars().forEach(({ si, bi }) => { c.sections[si].bars[bi] = { c: [] }; }); this.save(); this.render(); break;
      case 'dup-rng': {
        const rb = this.rangeBars(), last = rb[rb.length - 1];
        this.snap();
        const copy = rb.map(({ si, bi }) => JSON.parse(JSON.stringify(c.sections[si].bars[bi])));
        c.sections[last.si].bars.splice(last.bi + 1, 0, ...copy);
        this.range = { a: { si: last.si, bi: last.bi + 1 }, b: { si: last.si, bi: last.bi + copy.length } };
        this.sel = { si: last.si, bi: last.bi + 1, h: 0 };
        this.save(); this.render(); break;
      }
      case 'hear-rng': {
        if (this.player.on) this.player.stop();
        const keys = new Set(this.rangeBars().map(({ si, bi }) => `${si}.${bi}`));
        const ev = this.events().filter((x) => keys.has(x.key));
        if (!ev.length) break;
        const off = ev[0].barBeat0;
        const evs = ev.map((x) => ({ ...x, beat0: x.beat0 - off, barBeat0: x.barBeat0 - off }));
        this.player.start(evs, { bpm: c.bpm, style: c.style, instrument: c.instrument, drums: true, pattern: c.pattern || '', drumStyle: c.drumStyle ?? '', loop: false, onPos: (i) => { this.el.querySelectorAll('.cp-bar.cp-now').forEach((x) => x.classList.remove('cp-now')); if (i >= 0) { const [si, bi] = evs[i].key.split('.'); this.el.querySelector(`.cp-bar[data-si="${si}"][data-bi="${bi}"]`)?.classList.add('cp-now'); } } });
        break;
      }
      case 'root': this.root = v; this.render(); break;
      case 'qual': { const r = this.root || parseChord(this.c.sections[this.sel.si].bars[this.sel.bi].c[this.sel.h])?.rootName || 'C'; this.setChord(r + v); break; }
      case 'use': this.setChord(v); break;
      case 'hear': playChord(v, c.instrument); break;
      case 'hear-slot': this.hearSlot(this.sel.si, this.sel.bi, this.sel.h); break;
      case 'noop': break;
      case 'hear-seq': { const ns = v.split(' '); ns.forEach((nm, i) => setTimeout(() => playChord(nm, c.instrument, 0, { dur: 0.9 }), i * 700)); break; }
      case 'trans': {
        const ns = v.split(' '), sel = this.sel, s = c.sections[sel.si], b = s.bars[sel.bi];
        this.snap();
        const a0 = b.c[sel.h] || this.neighbors(sel.si, sel.bi, sel.h).prev?.name || '';
        if (ns.length === 1) { b.c = [a0, ns[0]]; b.v = []; this.sel = { ...sel, h: 1 }; }
        else { b.c = [a0, ns[0]]; b.v = []; s.bars.splice(sel.bi + 1, 0, { c: [ns[1]] }); }
        this.save(); this.render();
        const seq = [a0, ...ns, this.neighbors(sel.si, sel.bi, 1).next?.name].filter(Boolean);
        seq.forEach((nm, i) => setTimeout(() => playChord(nm, c.instrument, 0, { dur: 0.9 }), i * 650));
        break;
      }
      case 'split': {
        const b = c.sections[this.sel.si].bars[this.sel.bi];
        this.snap();
        if (b.c.length > 1) { const k = b.c[0] ? 0 : 1; b.c = [b.c[k]]; b.s = [!!b.s?.[k]]; b.v = []; b.g = []; b.p = []; this.sel.h = 0; } else { b.c = [b.c[0] || '', '']; b.s = [!!b.s?.[0], false]; this.sel.h = 1; }
        this.save(); this.render(); break;
      }
      case 'half': this.sel.h = +v; this.draft = null; this.render(); break;
      case 'clear': { const b = c.sections[this.sel.si].bars[this.sel.bi]; this.snap(); b.c = []; b.v = []; b.s = []; b.g = []; b.p = []; this.sel.h = 0; this.save(); this.render(); break; }
      case 'copy-prev': { const p = this.neighbors(this.sel.si, this.sel.bi, this.sel.h).prev; if (p) this.setChord(p.name); break; }
      case 'tab': this.tab = v; this.draft = null; this.render(); break;
      case 'vof': { const b = c.sections[this.sel.si].bars[this.sel.bi], fr = v.split(',').map(Number); this.snap(); (b.g ||= [])[this.sel.h] = fr; if (b.v) b.v[this.sel.h] = null; this.save(); this.render(); this.hearSlot(this.sel.si, this.sel.bi, this.sel.h); break; }
      case 'pno': { const b = c.sections[this.sel.si].bars[this.sel.bi], ns = v.split(',').map(Number); this.snap(); (b.p ||= [])[this.sel.h] = ns; this.save(); this.render(); this.hearSlot(this.sel.si, this.sel.bi, this.sel.h); break; }
      case 'nk': {
        const b = c.sections[this.sel.si].bars[this.sel.bi], cur = b.c[this.sel.h] || '';
        const st = +t.dataset.s, f = +t.dataset.f, fr = this.shownFrets(cur, b).slice();
        fr[st] = f === 0 ? (fr[st] === 0 ? -1 : 0) : (fr[st] === f ? -1 : f);
        if (fr[st] >= 0) playChord('', 'guitar', 0, { frets: fr.map((x, i) => (i === st ? x : -1)), dur: 1.2 });
        this.applyShape('g', fr);
        break;
      }
      case 'nk-hear': { const b = c.sections[this.sel.si].bars[this.sel.bi]; playChord('', 'guitar', 0, { frets: this.shownFrets(b.c[this.sel.h] || '', b) }); break; }
      case 'pk': {
        const b = c.sections[this.sel.si].bars[this.sel.bi], m = +t.dataset.m, ns = this.shownNotes(b.c[this.sel.h] || '', b).slice(), i = ns.indexOf(m);
        if (i >= 0) ns.splice(i, 1); else { ns.push(m); playChord('', 'piano', 0, { notes: [m], dur: 1.2 }); }
        this.applyShape('p', ns);
        break;
      }
      case 'pk-hear': { const b = c.sections[this.sel.si].bars[this.sel.bi]; playChord('', 'piano', 0, { notes: this.shownNotes(b.c[this.sel.h] || '', b) }); break; }
      case 'nk-clear': { const b = c.sections[this.sel.si].bars[this.sel.bi]; this.snap(); b.c[this.sel.h] = ''; if (b.g) b.g[this.sel.h] = null; if (b.p) b.p[this.sel.h] = null; if (!b.c.some(Boolean)) b.c = []; this.draft = null; this.save(); this.render(); break; }
      case 'vo': { const b = c.sections[this.sel.si].bars[this.sel.bi]; this.snap(); b.v = b.v || []; b.v[this.sel.h] = +v; this.save(); this.render(); playChord(b.c[this.sel.h], c.instrument, +v); break; }
      case 'vo-auto': { const b = c.sections[this.sel.si].bars[this.sel.bi]; this.snap(); if (b.v) b.v[this.sel.h] = null; if (b.g) b.g[this.sel.h] = null; if (b.p) b.p[this.sel.h] = null; this.changed({ snap: false }); break; }
      default:
    }
  }

  onChange(e) {
    const f = e.target.dataset.f, c = this.c;
    if (!f || !c) return;
    if (f === 'style') { c.style = e.target.value; if (!this._bpmTouched) c.bpm = STYLES[c.style].bpm; this.changed(); this.restartIfPlaying(); }
    else if (f === 'key') { const v = e.target.value; c.key = v ? { pc: parseInt(v, 10), minor: v.endsWith('m') } : null; this.changed(); }
    else if (f === 'bpm') { c.bpm = Math.max(40, Math.min(240, +e.target.value || 100)); this._bpmTouched = true; this.save(); this.el.querySelectorAll('[data-f="bpm"]').forEach((x) => { if (x !== e.target) x.value = c.bpm; }); this.restartIfPlaying(); }
    else if (f === 'zone') { c.zone = e.target.value || null; this.changed(); }
    else if (f === 'sound') { this._soundReady = false; c.sound = e.target.value; this.applySound(); this.save(); if (c.sound !== 'synth') { toast('Chargement du son…'); prepareSounds(c.instrument).then((ok) => { if (!ok) toast('Son réaliste indisponible (pas de connexion ?) : synthé utilisé'); else playChord('C', c.instrument); this.restartIfPlaying(); }); } else this.restartIfPlaying(); }
    else if (f === 'instsound') { const [ins, snd] = e.target.value.split('|'); this._soundReady = false; c.instrument = ins; c.sound = snd; this.applySound(); this.save(); this.render(); if (snd !== 'synth') prepareSounds(ins).then((ok) => { if (ok) playChord('C', ins); this.restartIfPlaying(); }); else this.restartIfPlaying(); }
    else if (f === 'rep') { const sct = c.sections[+e.target.dataset.si]; this.snap(); sct.repeat = +e.target.value; this.save(); this.render(); }
    else if (f === 'scope') { this.scopeSi = e.target.value === '' ? null : +e.target.value; this.render(); if (this.player.on) { this.player.stop(); this.play(this.scopeSi); } }
    else if (f === 'vol') { setVolume(+e.target.value); try { localStorage.setItem('mm-compo-vol', e.target.value); } catch { /* */ } }
    else if (f === 'cols') { c.cols = +e.target.value; this.save(); this.render(); }
    else if (f === 'pattern' || f === 'drumStyle') { c[f] = e.target.value; this.save(); this.restartIfPlaying(); }
    else if (f === 'sec-pattern' || f === 'sec-drums') { const sct = c.sections[+e.target.dataset.si]; sct[f === 'sec-pattern' ? 'pattern' : 'drumStyle'] = e.target.value || undefined; this.save(); this.restartIfPlaying(); }
    else if (f === 'label') { const s = c.sections[+e.target.dataset.si]; s.label = e.target.value.trim() || s.label; this.save(); }
    else if (f === 'name') { c.name = e.target.value.trim() || c.name; this.save(); }
    else if (f === 'chord') this.commitInput(e.target);
  }

  onInput(e) {
    if (e.target.dataset.f === 'vol') { setVolume(+e.target.value); return; }
    if (e.target.dataset.f === 'chord') e.target.classList.toggle('bad', !!e.target.value.trim() && !e.target.value.trim().split(/\s+/).every((x) => parseChord(x)));
  }

  commitInput(inp, adv = false) {
    const raw = inp.value.trim();
    if (!this.sel) return;
    const parts = raw ? raw.split(/\s+/) : [];
    if (parts.some((x) => !parseChord(x))) { toast('Accord non reconnu'); return; }
    const b = this.c.sections[this.sel.si].bars[this.sel.bi];
    if (parts.length >= 2) { this.snap(); b.c = parts.slice(0, 2); b.v = []; this.save(); if (adv) { this.sel.h = 1; this.advance(); } this.render(); playChord(parts[0], this.c.instrument); return; }
    if ((b.c[this.sel.h] || '') === (parts[0] || '')) { if (adv) { this.advance(); this.render(); } return; }
    this.setChord(parts[0] || '', { play: true });
    if (adv) { this.advance(); this.render(); }
  }

  onKey(e) {
    if (!this.c) return;
    const inInput = e.target.matches?.('input, select, textarea');
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { e.preventDefault(); this.el.querySelector('[data-a="redo"]')?.click(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); this.el.querySelector('[data-a="undo"]')?.click(); return; }
    if (e.target.classList?.contains('cp-in')) {
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); this.commitInput(e.target, true); setTimeout(() => this.el.querySelector('.cp-in')?.focus(), 0); }
      if (e.key === 'Escape') { this.sel = null; this.render(); }
      return;
    }
    if (inInput) return;
    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === 'c') { e.preventDefault(); this.copyRange(false); return; }
      if (k === 'x') { e.preventDefault(); this.copyRange(true); return; }
      if (k === 'v') { e.preventDefault(); this.paste(e.shiftKey); return; }
    }
    if (e.key === 'Escape' && this.range) { this.range = null; this.render(); return; }
    if (e.key === ' ') { e.preventDefault(); this.play(); }
    if (!this.sel) return;
    if (e.key === 'ArrowRight') { this.advance(); this.render(); }
    if (e.key === 'ArrowLeft') { const s = this.sel; if (s.h === 1) s.h = 0; else if (s.bi > 0) { s.bi--; s.h = 0; } else if (s.si > 0) { s.si--; s.bi = this.c.sections[s.si].bars.length - 1; s.h = 0; } this.render(); }
    if (e.key === 'Delete' || e.key === 'Backspace') this.el.querySelector(this.range ? '[data-a="clear-rng"]' : '[data-a="clear"]')?.click();
    if (e.shiftKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) return;
  }

  async toSong() {
    const text = this.exportText().replace(/\[([^\]]+?) x\d+\]/g, '[$1]');
    const song = newSong({ title: this.c.name, artist: '', bpm: this.c.bpm, source: 'composition' });
    song.doc = parseSheet(text);
    const k = this.key();
    song.key = keyLabel(k);
    await db.putSong(song);
    toast('Morceau créé : ajoute ton enregistrement pour l’écouter avec la grille');
    this.app.go(`#/edit/${song.id}`);
  }
}
