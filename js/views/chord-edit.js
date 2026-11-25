// MusiMix — mode « Modifier » du lecteur : accords et paroles directement sur la partition.
//   Accords : glisser pour déplacer (dans la ligne ou vers une autre), toucher pour renommer,
//   changer le doigté (manche guitare ou clavier piano) ou supprimer ; toucher un mot pour en ajouter.
//   Paroles : modifier le texte d'une ligne, couper la ligne à un mot, joindre à la suivante,
//   supprimer, ajouter une section. Le minutage suit : un accord prend le temps du mot sous lequel
//   il est posé ; couper / joindre partage ou réunit les temps des mots ; un texte retouché garde
//   le début et la fin de sa ligne (les mots sont répartis dedans s'ils ne correspondent plus).

import { db } from '../db.js';
import { esc, icon, toast, dialog, openMenu, confirmBox } from '../ui.js';
import { tokenize, fillLineEnds, sectionKind, sectionLabelFr } from '../sheet.js';
import { isChord, transposeChord, parseChord, chordPcs } from '../theory.js';
import { diagramSVG, setSongShapes, songShape, songPiano, voicings, pianoNotes, chordFormula } from '../diagrams.js';

const GUITAR = [40, 45, 50, 55, 59, 64]; // Mi grave → Mi aigu
const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const clone = (x) => JSON.parse(JSON.stringify(x));

export class LyricsEditing {
  constructor(player) {
    this.p = player;
    this.on = false;
    this.undo = [];
    this.drag = null;
    this.skipClick = false;
  }

  get song() { return this.p.song; }
  get lines() { return this.p.song.doc.lines; }
  get shift() { return (this.song.prefs.transpose || 0) - (this.song.prefs.capo || 0); }
  /** nom affiché (transposé) → nom enregistré */
  stored(display) { return this.shift ? transposeChord(display, -this.shift, this.p.display.key) : display; }

  toggle(on = !this.on) {
    this.on = on;
    const lyr = this.p.$lyrics;
    lyr.classList.toggle('editing', on);
    let bar = this.p.el.querySelector('.edit-bar');
    if (on && !bar) {
      bar = document.createElement('div');
      bar.className = 'edit-bar';
      bar.innerHTML = `<span><b>Modifier</b> · glisse un accord pour le déplacer · touche un accord pour le changer · touche un mot pour ajouter un accord, couper la ligne ou changer le texte</span>
        <span class="edit-acts"><button class="btn small" data-ed="undo" disabled>${icon('undo') || '↶'} Annuler</button><button class="btn small primary" data-ed="done">Terminé</button></span>`;
      lyr.parentElement.insertBefore(bar, lyr);
      bar.addEventListener('click', (e) => {
        const b = e.target.closest('[data-ed]');
        if (!b) return;
        if (b.dataset.ed === 'done') this.toggle(false);
        else if (b.dataset.ed === 'undo') this.undoLast();
      });
      if (!this._bound) this.bindDrag();
      toast('Mode modification : la lecture continue, tes changements sont enregistrés au fur et à mesure', 5000);
    } else if (!on && bar) bar.remove();
    this.updateUndo();
  }

  updateUndo() {
    const b = this.p.el.querySelector('[data-ed="undo"]');
    if (b) b.disabled = !this.undo.length;
  }

  snapshot() {
    this.undo.push(JSON.stringify({ lines: this.lines, shapes: this.song.doc.meta?.shapes || null, piano: this.song.doc.meta?.piano || null }));
    if (this.undo.length > 50) this.undo.shift();
    this.updateUndo();
  }

  undoLast() {
    const s = this.undo.pop();
    if (!s) return;
    const st = JSON.parse(s);
    this.song.doc.lines = st.lines;
    this.song.doc.meta = { ...(this.song.doc.meta || {}), shapes: st.shapes || undefined, piano: st.piano || undefined };
    this.commit(false);
    toast('Annulé');
  }

  commit(snap = true) {
    if (snap) { /* la photo a déjà été prise avant la modification */ }
    fillLineEnds(this.lines);
    const m = this.song.doc.meta || {};
    setSongShapes(m.shapes, m.piano);
    db.putSong(this.song);
    const top = this.p.$lyrics.scrollTop;
    this.p.refreshChords();
    this.p.$lyrics.scrollTop = top;
    if (this.on) this.p.$lyrics.classList.add('editing');
    this.updateUndo();
  }

  // ───────────────────────────────────────────── clics

  /** Appelé par le lecteur avant son propre traitement ; true = géré ici. */
  onClick(e) {
    if (!this.on) return false;
    if (this.skipClick) { this.skipClick = false; return true; }
    if (!e.target.closest('.lyrics')) return false;
    const ch = e.target.closest('.c:not(.e), .cbar[data-ci]');
    if (ch) { this.chordDialog(+ch.dataset.li, +ch.dataset.ci); return true; }
    const sec = e.target.closest('.ln.section');
    if (sec) { this.sectionMenu(sec, +sec.dataset.li); return true; }
    const ln = e.target.closest('.ln[data-li]');
    if (!ln) return true;
    const li = +ln.dataset.li;
    const line = this.lines[li];
    if (line?.type === 'lyric') {
      const hit = this.posFromPoint(e.clientX, e.clientY);
      this.snapT = hit?.li === li && hit.t != null ? { li, pos: hit.pos, t: hit.t } : null;
      this.wordMenu(e.target.closest('.w') || ln, li, hit?.li === li ? hit.pos : line.text.length);
    } else if (line?.type === 'chords') {
      this.addChordDialog(li, line.chords.length);
    }
    return true;
  }

  // ───────────────────────────────────────────── position sous le doigt

  posFromPoint(x, y) {
    const ghost = this.drag?.ghost;
    if (ghost) ghost.style.display = 'none';
    const el = document.elementFromPoint(x, y);
    if (ghost) ghost.style.display = '';
    const ln = el?.closest?.('.lyrics .ln[data-li]');
    if (!ln) return null;
    const li = +ln.dataset.li;
    const line = this.lines[li];
    if (!line) return null;
    if (line.type === 'chords') {
      const chips = [...ln.querySelectorAll('.cbar')];
      const idx = chips.filter((c) => { const r = c.getBoundingClientRect(); return r.left + r.width / 2 < x; }).length;
      return { li, index: idx, el: ln };
    }
    if (line.type !== 'lyric') return null;
    // on vise la rangée du texte (sous les accords) à la hauteur du mot le plus proche
    const ws = [...ln.querySelectorAll('.w[data-a]')];
    if (!ws.length) return { li, pos: 0, el: ln };
    let best = ws[0], bd = Infinity;
    for (const w of ws) {
      const r = w.getBoundingClientRect();
      const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
      const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
      const d = dy * 3 + dx;
      if (d < bd) { bd = d; best = w; }
    }
    const br = best.getBoundingClientRect();
    const ty = br.bottom - Math.min(10, br.height / 4);
    let pos = null;
    const caret = document.caretRangeFromPoint ? document.caretRangeFromPoint(x, ty) : null;
    let node = caret?.startContainer, off = caret?.startOffset ?? 0;
    if (!caret && document.caretPositionFromPoint) { const c = document.caretPositionFromPoint(x, ty); node = c?.offsetNode; off = c?.offset ?? 0; }
    const host = node && (node.nodeType === 3 ? node.parentElement : node);
    const w = host?.closest?.('.w[data-a]');
    if (w && w.closest('.ln') === ln && !host.closest('.c')) pos = +w.dataset.a + off;
    if (pos == null) {
      // à gauche / à droite d'un mot
      const r = best.getBoundingClientRect();
      const txt = best.querySelector('.t')?.textContent ?? best.textContent;
      pos = +best.dataset.a + (x > r.left + r.width / 2 ? txt.replace(/ /g, '').length : 0);
    }
    pos = Math.max(0, Math.min(line.text.length, pos));
    // aimant : près d'un trait de mesure, l'accord se cale exactement sur le début de la mesure
    let snap = null, sd = 18;
    for (const mk of ln.querySelectorAll('.bar-mk')) {
      const r = mk.getBoundingClientRect();
      if (y < r.top - 26 || y > r.bottom + 14) continue;
      const dx = Math.abs(x - r.left);
      if (dx < sd) { sd = dx; snap = mk; }
    }
    if (snap) return { li, pos: Math.max(0, Math.min(line.text.length, +snap.dataset.pos)), t: +snap.dataset.t, snap, el: ln };
    return { li, pos, el: ln };
  }

  markerAt(hit, x) {
    let mk = document.querySelector('.drop-mark');
    if (!hit) { mk?.remove(); return; }
    if (!mk) { mk = document.createElement('div'); mk.className = 'drop-mark'; document.body.appendChild(mk); }
    const lr = hit.el.getBoundingClientRect();
    let left = x;
    const line = this.lines[hit.li];
    mk.classList.toggle('snap', !!hit.snap);
    if (hit.snap) left = hit.snap.getBoundingClientRect().left + 1;
    else if (line.type === 'lyric') {
      const w = [...hit.el.querySelectorAll('.w[data-a]')].reverse().find((el) => +el.dataset.a <= hit.pos);
      if (w) {
        const t = w.querySelector('.t') || w;
        const tn = [...t.childNodes].find((n) => n.nodeType === 3);
        const k = hit.pos - +w.dataset.a;
        if (tn && k >= 0 && k <= tn.length) { const r = document.createRange(); r.setStart(tn, Math.min(k, tn.length)); r.collapse(true); const rr = r.getClientRects()[0] || r.getBoundingClientRect(); if (rr && rr.left) left = rr.left; }
      }
    }
    Object.assign(mk.style, { left: left - 1 + 'px', top: lr.top + 'px', height: lr.height + 'px' });
  }

  // ───────────────────────────────────────────── glisser un accord

  bindDrag() {
    this._bound = true;
    const lyr = this.p.$lyrics;
    lyr.addEventListener('pointerdown', (e) => {
      if (!this.on) return;
      const ch = e.target.closest('.c:not(.e), .cbar[data-ci]');
      if (!ch) return;
      e.preventDefault();
      this.drag = { li: +ch.dataset.li, ci: +ch.dataset.ci, x0: e.clientX, y0: e.clientY, moved: false, src: ch, id: e.pointerId };
      ch.setPointerCapture?.(e.pointerId);
    });
    const move = (e) => {
      const d = this.drag;
      if (!d || e.pointerId !== d.id) return;
      if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 7) return;
      if (!d.moved) {
        d.moved = true;
        d.ghost = document.createElement('div');
        d.ghost.className = 'chord-ghost';
        d.ghost.textContent = d.src.textContent;
        document.body.appendChild(d.ghost);
        d.src.classList.add('dragging');
      }
      d.ghost.style.left = e.clientX + 'px';
      d.ghost.style.top = e.clientY - 34 + 'px';
      d.hit = this.posFromPoint(e.clientX, e.clientY);
      this.markerAt(d.hit, e.clientX);
      // défilement près des bords
      const r = lyr.getBoundingClientRect();
      if (e.clientY < r.top + 50) lyr.scrollTop -= 12; else if (e.clientY > r.bottom - 50) lyr.scrollTop += 12;
    };
    const up = (e) => {
      const d = this.drag;
      if (!d || e.pointerId !== d.id) return;
      this.drag = null;
      d.ghost?.remove();
      d.src.classList.remove('dragging');
      this.markerAt(null);
      if (!d.moved) return; // simple toucher : le clic suit (onClick)
      this.skipClick = true;
      setTimeout(() => { this.skipClick = false; }, 400);
      if (d.hit) this.moveChord(d.li, d.ci, d.hit);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  chordTime(li, ci) {
    return this.p.timeline.find((x) => x.li === li && x.ci === ci)?.t ?? this.lines[li]?.chords?.[ci]?.t;
  }

  moveChord(li, ci, hit) {
    const from = this.lines[li];
    const c = from?.chords?.[ci];
    if (!c) return;
    const to = this.lines[hit.li];
    if (hit.li === li && to.type === 'lyric' && c.pos === hit.pos && (hit.t == null || Math.abs((c.t ?? -1) - hit.t) < 0.01)) return;
    this.snapshot();
    const t = this.chordTime(li, ci);
    from.chords.splice(ci, 1);
    if (to.type === 'lyric') {
      to.chords = (to.chords || []).filter((x) => x.pos !== hit.pos);
      to.chords.push(hit.t != null ? { pos: hit.pos, name: c.name, t: hit.t } : { pos: hit.pos, name: c.name });
      to.chords.sort((a, b) => a.pos - b.pos);
    } else {
      let idx = hit.index;
      if (hit.li === li && idx > ci) idx--;
      to.chords.splice(Math.max(0, Math.min(idx, to.chords.length)), 0, { pos: 0, name: c.name, t: from.type === 'chords' ? c.t : t });
      to.chords.forEach((x, k) => { x.pos = k; });
    }
    if (from.type === 'chords') {
      if (!from.chords.length) this.lines.splice(li, 1);
      else from.chords.forEach((x, k) => { x.pos = k; });
    }
    this.commit();
  }

  // ───────────────────────────────────────────── menus

  wordMenu(anchor, li, pos) {
    const line = this.lines[li];
    const toks = tokenize(line.text);
    const k = toks.findIndex((t) => t.end > pos);
    const word = toks[k < 0 ? toks.length - 1 : k];
    const canSplit = k > 0;
    openMenu(anchor, [
      { icon: 'plus', label: this.snapT?.pos === pos ? 'Ajouter un accord au début de la mesure' : `Ajouter un accord ici${word ? ` (« ${word.w.slice(0, 18)} »)` : ''}`, action: () => this.addChordDialog(li, this.snapT?.pos === pos || !word || pos > word.start + 1 ? pos : word.start) },
      { icon: 'edit', label: 'Modifier le texte de la ligne', action: () => this.textDialog(li) },
      ...(canSplit ? [{ icon: 'list', label: `Aller à la ligne avant « ${word.w.slice(0, 18)} »`, action: () => this.splitLine(li, word.start) }] : []),
      ...(this.nextLyric(li) != null ? [{ icon: 'list', label: 'Joindre la ligne suivante', action: () => this.joinNext(li) }] : []),
      { icon: 'list', label: 'Ajouter une section avant', action: () => this.sectionDialog(null, li) },
      '-',
      { icon: 'trash', label: 'Supprimer la ligne', danger: true, action: () => this.deleteLine(li) },
    ]);
  }

  sectionMenu(anchor, li) {
    openMenu(anchor, [
      { icon: 'edit', label: 'Renommer la section', action: () => this.sectionDialog(li) },
      { icon: 'trash', label: 'Supprimer la section', danger: true, action: () => { this.snapshot(); this.lines.splice(li, 1); this.commit(); } },
    ]);
  }

  nextLyric(li) {
    const n = li + 1;
    return this.lines[n]?.type === 'lyric' ? n : null;
  }

  // ───────────────────────────────────────────── paroles

  async textDialog(li) {
    const line = this.lines[li];
    const d = dialog(`<form method="dialog"><h2>Texte de la ligne</h2>
      <label class="field"><textarea name="t" rows="3">${esc(line.text)}</textarea></label>
      <p class="note">Le début et la fin de la ligne restent calés sur l’audio. Pour couper la ligne, va à la ligne dans le texte (Entrée) : les temps sont partagés entre les deux lignes.</p>
      <div class="actions"><button class="btn ghost" data-close="">Annuler</button><button class="btn primary" data-ok>Enregistrer</button></div></form>`);
    const ta = d.el.querySelector('textarea');
    setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 50);
    d.el.querySelector('[data-ok]').addEventListener('click', (e) => {
      e.preventDefault();
      const parts = ta.value.split('\n').map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
      d.close();
      if (!parts.length) { this.deleteLine(li); return; }
      if (parts.length === 1 && parts[0] === line.text) return;
      this.snapshot();
      this.setText(li, parts.join(' '));
      // retours à la ligne : on coupe aux mêmes endroits
      let at = li, offset = 0;
      for (let k = 0; k < parts.length - 1; k++) {
        offset = parts[k].length + 1;
        this.splitLine(at, offset, false);
        at++;
      }
      this.commit();
    });
  }

  /** Nouveau texte pour une ligne : accords gardés sur le même mot, temps gardés si possible. */
  setText(li, text) {
    const line = this.lines[li];
    const oldT = tokenize(line.text), newT = tokenize(text);
    line.chords = (line.chords || []).map((c) => {
      let k = oldT.findIndex((t) => t.end > c.pos);
      if (k < 0) return { ...c, pos: text.length };
      const into = Math.max(0, c.pos - oldT[k].start);
      k = Math.min(k, newT.length - 1);
      if (k < 0) return { ...c, pos: 0 };
      return { ...c, pos: newT[k].start + Math.min(into, newT[k].end - newT[k].start - 1) };
    });
    const sameCount = oldT.length === newT.length;
    if (line.words?.length && sameCount) { /* mêmes mots en nombre : on garde leurs temps */ }
    else line.words = null; // répartis à nouveau entre le début et la fin de la ligne
    line.text = text;
  }

  splitLine(li, pos, commit = true) {
    const line = this.lines[li];
    const toks = tokenize(line.text);
    const k = toks.findIndex((t) => t.start >= pos);
    if (k <= 0) return;
    if (commit) this.snapshot();
    const cut = toks[k].start;
    const a = { ...clone(line), text: line.text.slice(0, cut).trimEnd(), chords: [], words: null };
    const b = { ...clone(line), text: line.text.slice(cut), chords: [], words: null };
    for (const c of line.chords || []) (c.pos < cut ? a.chords : b.chords).push(c.pos < cut ? { ...c } : { ...c, pos: c.pos - cut });
    const w = line.words || [];
    if (w.length === toks.length && line.s != null) {
      a.words = w.slice(0, k); b.words = w.slice(k);
      a.s = line.s; a.e = a.words[a.words.length - 1].e;
      b.s = b.words[0].s; b.e = line.e;
    } else if (line.s != null) {
      const frac = cut / Math.max(1, line.text.length);
      const e = line.e ?? line.s + 4;
      a.s = line.s; a.e = line.s + (e - line.s) * frac;
      b.s = a.e; b.e = e;
    }
    this.lines.splice(li, 1, a, b);
    if (commit) this.commit();
  }

  joinNext(li) {
    const a = this.lines[li], n = this.nextLyric(li);
    if (n == null) return;
    const b = this.lines[n];
    this.snapshot();
    const off = a.text.length + 1;
    const ta = tokenize(a.text), tb = tokenize(b.text);
    const okWords = a.words?.length === ta.length && b.words?.length === tb.length;
    const j = {
      ...a,
      text: a.text + ' ' + b.text,
      chords: [...(a.chords || []), ...(b.chords || []).map((c) => ({ ...c, pos: c.pos + off }))],
      words: okWords ? [...a.words, ...b.words] : null,
      s: a.s ?? b.s, e: b.e ?? a.e,
    };
    this.lines.splice(li, 2, j);
    this.commit();
  }

  async deleteLine(li) {
    const line = this.lines[li];
    if (line.chords?.length && !(await confirmBox('Supprimer la ligne ?', 'Ses accords seront supprimés aussi.', { ok: 'Supprimer', danger: true }))) return;
    this.snapshot();
    this.lines.splice(li, 1);
    this.commit();
  }

  sectionDialog(li, beforeLi = null) {
    const cur = li != null ? this.lines[li] : null;
    const d = dialog(`<form method="dialog"><h2>${cur ? 'Renommer la section' : 'Nouvelle section'}</h2>
      <label class="field">Nom<input type="text" name="n" value="${esc(cur?.label || '')}" placeholder="Couplet 2, Refrain, Pont…" list="sec-names"></label>
      <datalist id="sec-names">${['Intro', 'Couplet', 'Pré-refrain', 'Refrain', 'Pont', 'Solo', 'Instrumental', 'Fin'].map((x) => `<option value="${x}">`).join('')}</datalist>
      <div class="actions"><button class="btn ghost" data-close="">Annuler</button><button class="btn primary" data-ok>Enregistrer</button></div></form>`);
    const inp = d.el.querySelector('input');
    setTimeout(() => inp.focus(), 50);
    d.el.querySelector('[data-ok]').addEventListener('click', (e) => {
      e.preventDefault();
      const label = inp.value.trim();
      d.close();
      if (!label) return;
      this.snapshot();
      if (cur) { cur.label = label; cur.kind = sectionKind(label); }
      else this.lines.splice(beforeLi, 0, { type: 'section', label, kind: sectionKind(label), chords: [] });
      this.commit();
    });
  }

  // ───────────────────────────────────────────── accords

  songChordNames() {
    const set = new Set();
    for (const l of this.lines) for (const c of l.chords || []) set.add(this.p.display(c.name));
    return [...set];
  }

  addChordDialog(li, pos) {
    this.chordDialog(li, null, pos);
  }

  /** Accord existant (li, ci) ou nouveau (ci null, à la position pos). */
  chordDialog(li, ci, pos = 0) {
    const line = this.lines[li];
    const c = ci != null ? line?.chords?.[ci] : null;
    const shown = c ? this.p.display(c.name) : '';
    const count = c ? this.lines.reduce((n, l) => n + (l.chords || []).filter((x) => x.name === c.name).length, 0) : 0;
    let inst = this.p.instrument === 'piano' ? 'piano' : 'guitar';
    let name = shown;
    const names = this.songChordNames();
    const d = dialog(`<form method="dialog" class="chord-editor">
      <h2>${c ? 'Accord' : 'Ajouter un accord'}</h2>
      <label class="field">Nom<input type="text" name="n" value="${esc(shown)}" placeholder="Am, G7, F#m*, D/F#…" autocomplete="off" spellcheck="false"></label>
      <div class="ce-names">${names.map((n) => `<button type="button" data-pick="${esc(n)}">${esc(n)}</button>`).join('')}</div>
      ${c && count > 1 ? `<div class="opt-row"><span>Changer le nom partout<br><small class="note">${count} fois dans le morceau</small></span><label class="switch"><input type="checkbox" name="all"><i></i></label></div>` : ''}
      <div class="ce-head"><b>Doigté</b><span class="seg"><button type="button" data-i="guitar">Guitare</button><button type="button" data-i="piano">Piano</button></span></div>
      <div class="ce-pad"></div>
      <p class="note ce-help"></p>
      <p class="note ce-notes"></p>
      <div class="actions">${c ? `<button class="btn ghost danger" type="button" data-del>${icon('trash')} Supprimer</button>` : ''}<button class="btn ghost" data-close="">Annuler</button><button class="btn primary" data-ok>${c ? 'Enregistrer' : 'Ajouter'}</button></div>
    </form>`);
    const el = d.el;
    const inp = el.querySelector('input[name="n"]');
    const meta = this.song.doc.meta || (this.song.doc.meta = {});
    let frets = null, keys = null, touched = false;
    const loadShape = () => {
      touched = false;
      const v = name && isChord(name) ? (songShape(name) ? { frets: songShape(name) } : voicings(name, 'guitar')[0]) : null;
      frets = v ? [...v.frets] : [-1, -1, -1, -1, -1, -1];
      const pn = name && isChord(name) ? pianoNotes(name) : null;
      keys = new Set(pn ? (pn.exact ? [pn.left, ...pn.right] : [pn.left - (pn.left >= 60 ? 12 : 0), ...pn.right.map((m) => { while (m < 60) m += 12; while (m > 83) m -= 12; return m; })]) : []);
    };
    const draw = () => {
      el.querySelectorAll('[data-i]').forEach((b) => b.classList.toggle('on', b.dataset.i === inst));
      const pad = el.querySelector('.ce-pad');
      const ok = name && isChord(name);
      inp.classList.toggle('bad', !!name && !ok);
      if (inst === 'guitar') pad.innerHTML = fretEditor(frets);
      else pad.innerHTML = pianoEditor(keys);
      el.querySelector('.ce-help').textContent = inst === 'guitar'
        ? 'Corde de gauche = Mi grave. Touche une case pour y poser un doigt (encore = corde à vide) ; au-dessus du manche : ○ à vide ou × étouffée.'
        : 'Touche les touches pour les ajouter ou les enlever.';
      const f = ok ? chordFormula(name) : null;
      // orthographe des notes comme dans le nom de l'accord (Eb plutôt que D#)
      const spell = {};
      const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
      for (const n of f?.notes || []) { const pc = (PC[n[0]] + (n.includes('#') ? 1 : 0) - (/b/.test(n.slice(1)) ? 1 : 0) + 12) % 12; spell[pc] = n; }
      const nm = (pc) => spell[pc] || NOTE[pc];
      const notes = inst === 'guitar'
        ? frets.map((fr, i) => (fr >= 0 ? nm((GUITAR[i] + fr) % 12) : null)).filter(Boolean)
        : [...keys].sort((a, b) => a - b).map((m) => nm(m % 12));
      const custom = inst === 'guitar' ? !!songShape(name) : !!songPiano(name);
      el.querySelector('.ce-notes').innerHTML = `${notes.length ? 'Tu joues : <b>' + esc([...new Set(notes)].join(' · ')) + '</b>' : 'Touche le manche ou le clavier pour choisir les notes.'}${f ? ` · ${esc(name)} = ${esc(f.notes.join(' · '))}` : ''}${custom && !touched ? ' · <i>doigté personnalisé</i> <button type="button" class="btn small ghost" data-reset>Remettre le doigté standard</button>' : ''}`;
    };
    loadShape(); draw();
    inp.addEventListener('input', () => { name = inp.value.trim(); if (!touched) loadShape(); draw(); });
    el.addEventListener('click', (e) => {
      const pk = e.target.closest('[data-pick]');
      if (pk) { name = pk.dataset.pick; inp.value = name; loadShape(); draw(); return; }
      const ib = e.target.closest('[data-i]');
      if (ib) { inst = ib.dataset.i; draw(); return; }
      const cell = e.target.closest('[data-s]');
      if (cell) {
        const s = +cell.dataset.s, f = +cell.dataset.f;
        if (f === -2) frets[s] = frets[s] === 0 ? -1 : 0; // au-dessus du sillet : à vide / étouffée
        else frets[s] = frets[s] === f ? 0 : f;
        touched = true; draw(); return;
      }
      const sh = e.target.closest('[data-shift]');
      if (sh) {
        const dlt = +sh.dataset.shift;
        const fr = frets.filter((x) => x > 0);
        if (fr.length && (Math.min(...fr) + dlt >= 1) && Math.max(...fr) + dlt <= 20) { frets = frets.map((x) => (x > 0 ? x + dlt : x)); touched = true; draw(); }
        return;
      }
      const key = e.target.closest('[data-m]');
      if (key && inst === 'piano') { const m = +key.dataset.m; if (keys.has(m)) keys.delete(m); else keys.add(m); touched = true; draw(); return; }
      if (e.target.closest('[data-reset]')) {
        this.snapshot();
        if (inst === 'guitar' && meta.shapes) delete meta.shapes[name];
        if (inst === 'piano' && meta.piano) delete meta.piano[name];
        setSongShapes(meta.shapes, meta.piano);
        loadShape(); draw(); this.commit(); return;
      }
      if (e.target.closest('[data-del]')) {
        d.close(); this.snapshot();
        line.chords.splice(ci, 1);
        if (line.type === 'chords') { if (!line.chords.length) this.lines.splice(li, 1); else line.chords.forEach((x, k) => { x.pos = k; }); }
        this.commit(); return;
      }
      if (e.target.closest('[data-ok]')) {
        e.preventDefault();
        if (!name || !isChord(name)) { inp.focus(); toast('Nom d’accord non reconnu (exemples : Am, G7, F#m*, D/F#)'); return; }
        d.close();
        this.snapshot();
        const st = this.stored(name);
        if (c) {
          if (el.querySelector('input[name="all"]')?.checked) { const old = c.name; for (const l of this.lines) for (const x of l.chords || []) if (x.name === old) x.name = st; }
          else c.name = st;
        } else if (line.type === 'lyric') {
          line.chords = (line.chords || []).filter((x) => x.pos !== pos);
          const sn = this.snapT && this.snapT.li === li && this.snapT.pos === pos ? this.snapT.t : null;
          line.chords.push(sn != null ? { pos, name: st, t: sn } : { pos, name: st });
          line.chords.sort((a, b) => a.pos - b.pos);
        } else {
          line.chords.splice(pos, 0, { pos, name: st, t: line.chords[pos - 1]?.t });
          line.chords.forEach((x, k) => { x.pos = k; });
        }
        if (touched) {
          if (inst === 'guitar' && frets.some((f) => f >= 0)) meta.shapes = { ...(meta.shapes || {}), [name]: [...frets] };
          if (inst === 'piano' && keys.size) meta.piano = { ...(meta.piano || {}), [name]: [...keys].sort((a, b) => a - b) };
        }
        this.commit();
      }
    });
    setTimeout(() => { if (!c) inp.focus(); }, 60);
  }
}

/** Manche modifiable : 6 cordes × 5 cases à partir de la position du doigté. */
function fretEditor(frets) {
  const fr = frets.filter((f) => f > 0);
  const lo = fr.length ? Math.min(...fr) : 1;
  const hi = fr.length ? Math.max(...fr) : 1;
  const base = hi <= 5 ? 1 : lo;
  const rows = 5, W = 196, H = 180, x0 = 36, y0 = 34, sw = 30, rh = 28;
  let s = `<div class="ce-fret"><svg viewBox="0 0 ${W} ${H}" class="fret-edit" role="img" aria-label="Manche de guitare modifiable">`;
  s += base === 1 ? `<rect x="${x0 - 2}" y="${y0 - 4}" width="${sw * 5 + 4}" height="5" fill="currentColor"/>` : `<text x="${x0 - 14}" y="${y0 + rh / 2 + 4}" text-anchor="end" font-size="13" fill="currentColor">${base}</text>`;
  for (let r = 0; r <= rows; r++) s += `<line x1="${x0}" x2="${x0 + sw * 5}" y1="${y0 + r * rh}" y2="${y0 + r * rh}" stroke="currentColor" stroke-opacity=".45"/>`;
  for (let i = 0; i < 6; i++) s += `<line x1="${x0 + i * sw}" x2="${x0 + i * sw}" y1="${y0}" y2="${y0 + rows * rh}" stroke="currentColor" stroke-opacity=".7"/>`;
  for (let i = 0; i < 6; i++) {
    const x = x0 + i * sw;
    const f = frets[i];
    s += `<g data-s="${i}" data-f="-2" class="ce-top"><rect x="${x - 13}" y="2" width="26" height="26" fill="transparent"/>${f === 0 ? `<circle cx="${x}" cy="17" r="7" fill="none" stroke="currentColor" stroke-width="2"/>` : f < 0 ? `<text x="${x}" y="22" text-anchor="middle" font-size="15" fill="currentColor">×</text>` : ''}</g>`;
    for (let r = 0; r < rows; r++) {
      const fret = base + r;
      const on = f === fret;
      s += `<g data-s="${i}" data-f="${fret}" class="ce-cell"><rect x="${x - 14}" y="${y0 + r * rh}" width="28" height="${rh}" fill="transparent"/>${on ? `<circle cx="${x}" cy="${y0 + r * rh + rh / 2}" r="10" class="ce-dot"/>` : ''}</g>`;
    }
  }
  s += `</svg>
    <div class="ce-shift"><button type="button" class="btn small" data-shift="-1" aria-label="Descendre d'une case">▲ case</button><button type="button" class="btn small" data-shift="1" aria-label="Monter d'une case">▼ case</button></div></div>`;
  return s;
}

/** Clavier modifiable (deux octaves, Do3 → Si4). */
function pianoEditor(keys) {
  const whites = [0, 2, 4, 5, 7, 9, 11], blackX = { 1: 1, 3: 2, 6: 4, 8: 5, 10: 6 };
  const ww = 22, wh = 100, bw = 14, bh = 62, W = 14 * ww + 2;
  let s = `<svg viewBox="0 0 ${W} ${wh + 4}" class="piano-edit" role="img" aria-label="Clavier modifiable">`;
  for (let o = 0; o < 2; o++) whites.forEach((pc, k) => { const m = 48 + o * 12 + pc; s += `<rect data-m="${m}" class="pk w${keys.has(m) ? ' on' : ''}" x="${1 + (o * 7 + k) * ww}" y="1" width="${ww}" height="${wh}" rx="3"/>`; });
  for (let o = 0; o < 2; o++) [1, 3, 6, 8, 10].forEach((pc) => { const m = 48 + o * 12 + pc; s += `<rect data-m="${m}" class="pk b${keys.has(m) ? ' on' : ''}" x="${1 + (o * 7 + blackX[pc]) * ww - bw / 2}" y="1" width="${bw}" height="${bh}" rx="2"/>`; });
  return s + '</svg>';
}
