// MusiMix — le lecteur : paroles synchronisées, accords, mixage, options.

import { db } from '../db.js';
import { esc, icon, fmtTime, toast, openMenu, drag, debounce, dialog } from '../ui.js';
import { renderSheet, lyricLine, chordDisplay, songKey, uniqueChords } from '../render.js';
import { chordTimeline, sectionsOf, tokenize } from '../sheet.js';
import { diagramSVG, voicings, chordFormula, loadChordDb, setSongShapes } from '../diagrams.js';
import { LyricsEditing } from './chord-edit.js';
import { ensureLevels, isEmptyStem } from '../levels.js';
import { STEM_KINDS, sortStems, exportPack, download } from '../songs.js';
import { lowerBound } from '../engine.js';
import { keyName } from '../theory.js';
import { suggestCapo } from '../capo.js';
import { TakeRecorder } from '../take.js';
import { ScoreView, SCORE_EXT } from '../score.js';
import { pickFiles } from '../ui.js';
import { improLayers, neckSvg, keysSvg, ALL_KEYS, keyLabelFr, SCALES } from '../impro.js';
import { parseKey, pcName } from '../theory.js';
import { encodeOpus, opusSupported } from '../opus.js';
import { encodeWav } from '../wav.js';
import { levelOf } from '../levels.js';
import { uid } from '../db.js';
import { surface, MCU } from '../surface.js';
import { midi, nameChord, matchesChord, noteName } from '../midi-input.js';
import { transposeChord } from '../theory.js';

export class PlayerView {
  constructor(app) {
    this.app = app;
    this.engine = app.engine;
    this.song = null;
    this.el = null;
    this.raf = 0;
    this.userScrollAt = 0;
    this.mode = 'lyrics';
    this.instrument = 'guitar';
    this.voicingIdx = {};
    this.saveSong = debounce(() => this.song && db.putSong(this.song), 600);
    this.editing = new LyricsEditing(this);
    this._onTime = () => this.frame();
    this._onKey = (e) => this.onKey(e);
  }

  async open(song, ctx = {}) {
    this.song = song;
    this.ctx = ctx;
    this._gsAuto = null; this._clock = null;
    const prefs = await this.app.prefs();
    this.prefsCache = prefs || {};
    this.prefsSnap = prefs;
    this.instrument = prefs.instrument || 'guitar';
    this.mode = prefs.viewMode === 'score' && !this.song?.score ? 'lyrics' : (prefs.viewMode || 'lyrics');
    this.fontSize = prefs.fontSize || null;
    this.showChords = prefs.showChords !== false;
    this.showBars = prefs.showBars === true; // désactivé par défaut (demande de Gabriel)
    this.midiOn = !!prefs.midi;
    this.r20On = prefs.r20 === true;
    this.r20Bank = 0;
    this.midiFollow = prefs.midiFollow !== false;
    midi.advanceNote = prefs.midiKey ?? null;
    song.prefs = { transpose: 0, audioPitch: false, rate: 1, offset: 0, capo: 0, ...(song.prefs || {}) };
    await loadChordDb();
    setSongShapes(song.doc?.meta?.shapes, song.doc?.meta?.piano);
    this.build();
    this.applyRail(); this.el.classList.toggle('hud-off', !this.hudOn());
    await this.loadAudio();
    song.playCount = (song.playCount || 0) + 1;
    song.lastPlayedAt = Date.now();
    db.putSong(song);
    document.addEventListener('keydown', this._onKey);
    this.setupMediaSession();
  }

  close() {
    this.cancelDelay?.();
    if (this.take) { this.take.rec.cancel(); this.endTakeUi(); this.take = null; }
    this.midiStop(false);
    this.scoreView?.destroy(); this.scoreView = null;
    this.r20Stop(false);
    this._barRO?.disconnect();
    this.exitFullStage();
    this.editing.on = false;
    document.querySelector('.drop-mark')?.remove();
    document.removeEventListener('keydown', this._onKey);
    this.engine.removeEventListener('time', this._onTime);
    for (const [ev, fn] of Object.entries(this._engineH || {})) this.engine.removeEventListener(ev, fn);
    window.removeEventListener('resize', this._onResize);
    clearTimeout(this.autoNext);
    cancelAnimationFrame(this.raf);
    clearInterval(this.meterTimer);
    this.engine.unload();
    this.releaseWake();
    this.el?.remove();
    this.el = null;
    this.song = null;
    if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
  }

  // ─────────────────────────────────────────────────────── construction ──

  build() {
    const s = this.song;
    const el = document.createElement('section');
    el.className = 'view player';
    el.innerHTML = `
      <header class="topbar">
        <button class="icon-btn" data-act="back" aria-label="Retour à la bibliothèque">${icon('back')}</button>
        <div class="song-title"><b>${esc(s.title || 'Sans titre')}</b><span>${esc(s.artist || '')}${this.ctx.setlist ? ` · ${this.ctx.index + 1}/${this.ctx.setlist.songs.length} · ${esc(this.ctx.setlist.name)}` : ''}</span></div>
        <div class="spacer"></div>
        <div class="top-tools">
          ${this.ctx.setlist ? `<button class="icon-btn" data-act="prev-song" aria-label="Morceau précédent">${icon('prev')}</button><button class="icon-btn" data-act="next-song" aria-label="Morceau suivant">${icon('next')}</button>` : ''}
          <button class="key-chip" data-act="key" aria-label="Tonalité et transposition"></button>
          <div class="seg hide-m" role="tablist" aria-label="Affichage">
            <button data-mode="lyrics" title="Paroles et accords">Paroles</button>
            <button data-mode="stage" title="Mode scène : texte en très grand">Scène</button>
            <button data-mode="grid" title="Grille d’accords par mesure">Grille</button>
            <button data-mode="score" title="Partition / tablature (Guitar Pro, MusicXML)"${this.song.score ? '' : ' hidden'}>Partition</button>
          </div>
          <button class="icon-btn" data-act="impro" aria-label="Impro" title="Impro : notes qui vont avec le morceau (I)">${icon('impro')}</button>
          <button class="icon-btn hide-s" data-act="tuner" aria-label="Accordeur" title="Accordeur (T)">${icon('tuner')}</button>
          <button class="icon-btn hide-s" data-act="fullstage" aria-label="Scène plein écran" title="Scène plein écran (P)">${icon('stage')}</button>
          <button class="icon-btn" data-act="text" aria-label="Taille du texte">${icon('textsize')}</button>
          <button class="icon-btn" data-act="menu" aria-label="Plus d’actions">${icon('more')}</button>
        </div>
      </header>
      <div class="mob-chord" aria-live="off">
        <div class="now-chord" data-r="now"></div>
        <div class="next-chord" data-r="next"></div>
        <div class="mini" data-r="mini"></div>
      </div>
      <div class="stage">
        <div class="lyrics" tabindex="-1"></div>
        <div class="big"></div>
        <div class="grid-view"></div>
        <div class="score-view">
          <div class="score-bar">
            <select data-r="sc-track" aria-label="Piste de la partition"></select>
            <span class="seg"><button data-sc="layout:tab">Tab</button><button data-sc="layout:both">Les deux</button><button data-sc="layout:score">Portée</button></span>
            <span class="stepper" title="Taille"><button data-sc="zoom:-">−</button><output>A</output><button data-sc="zoom:+">+</button></span>
            <span class="sc-sync"><span class="note">Calage</span>
              <span class="stepper" title="Mesure de l’audio où commence la partition"><button data-sc="bar:-1">−</button><output data-r="sc-bar">mes. 1</output><button data-sc="bar:1">+</button></span>
              <span class="stepper" title="Décalage fin"><button data-sc="off:-0.05">−</button><output data-r="sc-off">0,00 s</output><button data-sc="off:0.05">+</button></span>
              <button class="btn small ghost" data-sc="auto:score" title="Écoute l’audio et pose la 1re note de la partition sur le début de la musique">Auto</button></span>
            <button class="btn small sc-hud-btn" data-sc="hud:1" title="Afficher l’accord en cours (et le suivant) au-dessus de la partition et en Scène">Accords</button>
            <button class="btn small sc-lyr-btn" data-sc="lyrics:1" aria-pressed="false" title="Afficher les paroles au-dessus de la partition">Paroles</button>
            <span class="sc-loff" hidden><span class="note">Décalage paroles</span>
              <span class="stepper" title="+ : les paroles s'allument plus tôt"><button data-sc="loff:-0.5" title="−0,5 s">«</button><button data-sc="loff:-0.05">−</button><output data-r="sc-loff">0 s</output><button data-sc="loff:0.05">+</button><button data-sc="loff:0.5" title="+0,5 s">»</button></span>
              <button class="btn small ghost" data-sc="auto:lyr" title="Écoute la voix et cale les paroles dessus">Auto</button>
              <button class="btn small ghost" data-sc="auto:words" title="Chaque mot prend le temps de sa note dans la partition (si elle contient les paroles)">Mot à mot</button></span>
            <span class="note sc-status" data-r="sc-status"></span>
            <button class="btn small ghost sc-hide" data-sc="bar:toggle" title="Masquer / afficher les réglages de la partition"><span class="when-open">Masquer ▴</span><span class="when-min">Réglages de la partition ▾</span></button>
          </div>
          <div class="sc-lyrics" hidden aria-live="off"><div class="hud" data-r="hud"></div><div class="scl-body"></div><div class="sc-grip" title="Glisser vers le bas pour agrandir, vers le haut pour réduire" role="separator" aria-orientation="horizontal" aria-label="Taille du bandeau"></div></div>
          <div class="score-host"></div>
        </div>
        <div class="fs-chords" aria-live="off"><span class="fs-now" data-r="now"></span><span class="fs-dg" data-r="fs-dg"></span><span class="fs-next" data-r="next"></span></div>
        <div class="fs-hint">Toucher l’écran : lecture / pause · Pédale : partie suivante · Double-toucher ou Échap : quitter</div>
        <button class="btn small follow-btn" data-act="follow" hidden>${icon('sync')} Suivre la lecture</button>
        <div class="countdown" hidden></div>
        <div class="stage-hud"><div class="hud" data-r="hud"></div><span class="hud-size"><button data-act="hud-size" data-v="-1" title="Réduire l’accord" aria-label="Réduire l’accord">−</button><button data-act="hud-size" data-v="1" title="Agrandir l’accord" aria-label="Agrandir l’accord">+</button></span></div>
        <button class="rail-open" data-act="rail-toggle" title="Afficher le panneau Accords et mixage" hidden>◂ Accords et mixage</button>
      </div>
      <aside class="rail" aria-label="Accords et mixage">
        <button class="rail-close" data-act="rail-toggle" title="Masquer le panneau (plus de place pour les paroles ou la partition)">Masquer ▸</button>
        <div class="rail-resizer" role="separator" aria-orientation="vertical" aria-label="Largeur du panneau" tabindex="0" title="Glisser pour agrandir · double-clic : taille normale"></div>
        <div class="rail-sec" data-r="chords-sec">
          <h3><span>Accord</span>
            <span class="seg" role="tablist" aria-label="Instrument">
              <button data-inst="guitar">Guitare</button><button data-inst="ukulele">Ukulélé</button><button data-inst="piano">Piano</button>
            </span></h3>
          <div class="now-next">
            <div class="now-chord" data-r="now"></div>
            <div class="next-chord" data-r="next"></div>
            <div class="chord-progress"><i></i></div>
          </div>
          <div class="diagram" data-r="diagram"></div>
          <div class="formula" data-r="formula"></div>
        </div>
        <div class="rail-sec" data-r="mix-sec">
          <h3><span>Mixage</span><button class="btn ghost small" data-act="mix-reset">Tout remettre</button></h3>
          <div class="mixer"></div>
          <div class="presets"></div>
        </div>
        <div class="rail-sec" data-r="opts-sec"></div>
      </aside>
      <section class="impro-panel" hidden aria-label="Impro"></section>
      <footer class="transport">
        <div class="t-left">
          <button class="icon-btn" data-act="back5" aria-label="Reculer de 5 secondes">${icon('back5')}</button>
          <button class="play" data-act="play" aria-label="Lecture">${icon('play')}</button>
          <button class="icon-btn" data-act="fwd5" aria-label="Avancer de 5 secondes">${icon('fwd5')}</button>
        </div>
        <div class="timeline">
          <span class="time" data-r="cur">0:00</span>
          <div class="track" role="slider" tabindex="0" aria-label="Position dans le morceau" aria-valuemin="0">
            <div class="lane-sec"></div>
            <div class="rail-bar"><canvas></canvas></div>
            <div class="done"></div>
            <div class="lane-ch"></div>
            <div class="loop" hidden></div>
            <div class="head"></div>
          </div>
          <span class="time end" data-r="dur">0:00</span>
        </div>
        <div class="t-right">
          <button class="icon-btn rec-btn" data-act="rec" aria-label="Enregistrer ma prise" title="Enregistrer ma prise au micro">${icon('rec')}</button>
          <button class="icon-btn" data-act="loop" aria-label="Boucle A-B" title="Boucle A-B (L)">${icon('loop')}</button>
          <button class="rate-btn" data-act="rate" aria-label="Vitesse de lecture" title="Vitesse">1×</button>
          <button class="icon-btn" data-act="metro" aria-label="Métronome" title="Métronome (M)">${icon('metro')}</button>
          <button class="icon-btn only-m" data-act="sheet-mix" aria-label="Mixage">${icon('mix')}</button>
          <button class="icon-btn only-m" data-act="sheet-opts" aria-label="Réglages du morceau">${icon('settings')}</button>
        </div>
      </footer>
      <div class="scrim"></div>
      <div class="sheet-panel" data-sheet="mix" role="dialog" aria-label="Mixage"><div class="grip"></div><div class="rail-sec" style="border:0;padding:4px 0"><h3><span>Mixage</span><button class="btn ghost small" data-act="mix-reset">Tout remettre</button></h3><div class="mixer"></div><div class="presets"></div></div></div>
      <div class="sheet-panel" data-sheet="opts" role="dialog" aria-label="Réglages"><div class="grip"></div><div data-r="opts-m"></div></div>`;
    this.el = el;
    this.app.mount(el);
    this.$lyrics = el.querySelector('.lyrics');
    this.$big = el.querySelector('.big');
    this.$grid = el.querySelector('.grid-view');
    this.$track = el.querySelector('.track');
    this.renderLyrics();
    this.renderOptions();
    this.renderMixer();
    this.setMode(this.mode, false);
    this.setInstrument(this.instrument, false);
    if (this.midiOn) this.midiStart(false);
    if (this.r20On) this.r20Start(false);
    if (this.fontSize) this.el.style.setProperty('--lyrics-size', this.fontSize + 'px');
    this.railWidth = this.prefsSnap?.railWidth || null;
    if (this.railWidth) this.el.style.setProperty('--rail-w', this.railWidth + 'px');
    this.bind();
    this.bindResizer();
  }

  get display() {
    return this._display || (this._display = chordDisplay(this.song, this.song.prefs.transpose, this.song.prefs.capo));
  }

  refreshChords() {
    this._display = null;
    this.renderLyrics();
    this.renderKeyChip();
    this.renderImpro?.();
    this.lastChordIdx = -2;
    this.frame(true);
  }

  renderKeyChip() {
    const d = this.display;
    const p = this.song.prefs;
    const chip = this.el.querySelector('.key-chip');
    const label = d.keyLabel || '—';
    let extra = '';
    if (p.transpose) extra += ` <small>${p.transpose > 0 ? '+' : ''}${p.transpose}</small>`;
    if (p.capo) extra += ` <small>capo ${p.capo}</small>`;
    chip.innerHTML = `${esc(label)}${extra}`;
  }

  renderLyrics() {
    const s = this.song;
    this._clock = null;
    const off = (s.prefs.offset || 0) / 1000; // temps des paroles = temps audio + décalage
    this.applyWrittenBars(off);
    this.vdoc = this.viewDoc(off);
    this.timeline = chordTimeline(this.vdoc, s.duration || this.engine.duration, s.detectedChords);
    if (this.vdocFromScore) this.timeline.forEach((c) => { c.fixed = true; });
    // un accord écrit au-dessus d'un mot tombe sur le mot, pas forcément sur le changement joué :
    // s'il existe tout près le même accord entendu dans l'audio, on prend le moment entendu
    if (s.detectedChords?.length) {
      const det = s.detectedChords, win = Math.min(1.6, (this.masterClock().gap || 2) * 0.55);
      for (const c of this.timeline) {
        if (c.t == null || c.fixed) continue;
        const a = c.t - off;
        let best = null;
        for (const d of det) {
          if (d.s > a + win) break;
          if (d.s < a - win || !sameChord(d.name, c.name)) continue;
          if (!best || Math.abs(d.s - a) < Math.abs(best.s - a)) best = d;
        }
        if (best) c.t = best.s + off;
      }
      for (let i = 1; i < this.timeline.length; i++) if (this.timeline[i].t != null && this.timeline[i - 1].t != null && this.timeline[i].t <= this.timeline[i - 1].t) this.timeline[i].t = this.timeline[i - 1].t + 0.05;
    }
    // horloge de l'audio : on cherche sur quel temps tombent la plupart des changements d'accords → c'est le 1er temps
    this._autoPhase = 0; this._clock = null;
    {
      const ck = this.masterClock();
      if (ck.src === 'audio' && ck.beats.length > 16 && !s.clock?.phaseOff) {
        const bpb = ck.bpb || 4, cnt = new Array(bpb).fill(0);
        let k = 0, n = 0;
        const evs = (s.score?.chords?.length && s.score.useChords !== false) ? s.score.chords.map((c) => ({ t: c.t + off })) : this.timeline;
        for (const c of evs) {
          if (c.t == null) continue;
          const a = c.t - off;
          while (k + 1 < ck.beats.length && ck.beats[k + 1] <= a) k++;
          const j = ck.beats[k + 1] != null && ck.beats[k + 1] - a < a - ck.beats[k] ? k + 1 : k;
          cnt[j % bpb]++; n++;
        }
        const best = cnt.indexOf(Math.max(...cnt));
        if (n >= 8 && best && cnt[best] >= 1.5 * cnt[0]) { this._autoPhase = best; this._clock = null; }
      }
    }
    { const ck = this.masterClock(); if (ck.beats.length) this.engine.setBeats(ck.beats, ck.bars); }
    // accords du texte : posés sur le temps le plus proche de l'horloge maître
    {
      const bt = this.masterClock().beats;
      if (bt.length > 4) {
        const beatLen = (this.masterClock().gap || 2) / (this.masterClock().bpb || 4);
        let k = 0;
        for (const c of this.timeline) {
          if (c.t == null || c.fixed) continue;
          const a = c.t - off;
          while (k + 1 < bt.length && bt[k + 1] <= a) k++;
          const cand = [bt[k], bt[k + 1]].filter((x) => x != null);
          const near = cand.reduce((m, x) => (Math.abs(x - a) < Math.abs(m - a) ? x : m), cand[0]);
          if (Math.abs(near - a) < beatLen * 0.45) c.t = near + off;
        }
      }
    }
    // accords écrits dans la partition (calée) : prioritaires pour le temps ; on les relie aux accords du texte
    if (!this.vdocFromScore && s.score?.chords?.length && s.score.useChords !== false) {
      const txt = this.timeline.filter((c) => c.t != null && c.li >= 0);
      const used = new Set();
      this.timeline = s.score.chords.map((c0) => {
        const c = { ...c0, t: c0.t + off }; // temps audio → temps des paroles
        let m = null;
        for (const x of txt) if (!used.has(x) && Math.abs(x.t - c.t) < 2.5 && sameChord(x.name, c.name) && (!m || Math.abs(x.t - c.t) < Math.abs(m.t - c.t))) m = x;
        if (m) used.add(m);
        return { name: m ? m.name : c.name, t: c.t, li: m ? m.li : -1, ci: m ? m.ci : -1, fixed: true };
      });
      this.timeline.forEach((c, i) => { c.e = this.timeline[i + 1]?.t ?? (s.duration || c.t + 4); });
    }
    this.timedLines = [];
    const tl0 = [];
    this.vdoc.lines.forEach((l, li) => { if (l.type === 'lyric' && l.s != null) tl0.push({ li, s: l.s, e: l.e }); });
    // une ligne dont le temps est en désordre (reste d'un ancien calage) ferait revenir le rose en arrière : on l'ignore
    this.timedLines = increasing(tl0);
    this.synced = this.timedLines.length > 0;
    this.hasTimedChords = this.timeline.some((c) => c.t != null);
    const hasLines = this.vdoc.lines.some((l) => l.type === 'lyric' || l.type === 'chords');
    if (hasLines) {
      this.$lyrics.innerHTML = renderSheet(this.vdoc, { display: this.display });
    } else if (this.timeline.length) {
      // pas de paroles : on affiche la suite d'accords détectés
      this.$lyrics.innerHTML = `<div class="sheet"><p class="ln section">Accords détectés</p>${chunk(this.timeline, 4).map((g) => `<p class="ln chords-only">${g.map((c) => `<span class="cbar" data-t="${c.t}">${esc(this.display(c.name))}</span>`).join('')}</p>`).join('')}
        <p class="note" style="font-size:15px;margin-top:2em">Ajoute les paroles avec <b>Éditer</b> : colle le texte ou une grille d’accords.</p></div>`;
    } else {
      this.$lyrics.innerHTML = `<div class="sheet"><p class="note" style="font-size:17px">Pas encore de paroles pour ce morceau.</p>
        <p><button class="btn" data-act="edit">${icon('edit')} Ajouter paroles et accords</button></p></div>`;
    }
    this.$lyrics.classList.toggle('no-sync', !this.synced);
    this.$lyrics.classList.toggle('hide-chords', !this.showChords);
    this.lineEls = new Map();
    this.$lyrics.querySelectorAll('.ln[data-li]').forEach((p) => this.lineEls.set(+p.dataset.li, p));
    this.chordEls = new Map();
    this.$lyrics.querySelectorAll('[data-ci]').forEach((c) => this.chordEls.set(`${c.dataset.li}|${c.dataset.ci}`, c));
    this.sections = sectionsOf(this.vdoc, this.timeline);
    this.curLine = -2;
    this.lastChordIdx = -2;
    this.renderLanes();
    this.renderGrid();
    this.renderKeyChip();
    this._bars = null;
    this.renderBarMarks();
    if (!this._barRO && window.ResizeObserver) {
      let w = 0;
      this._barRO = new ResizeObserver(() => { const nw = this.$lyrics.clientWidth; if (nw !== w) { w = nw; clearTimeout(this._barT); this._barT = setTimeout(() => this.renderBarMarks(), 120); } });
      this._barRO.observe(this.$lyrics);
    }
  }

  /** Débuts de mesure (temps audio, secondes). */
  /**
   * Horloge maître : UNE grille de mesures et de temps (temps de l'audio) que tout suit —
   * grille d'accords, traits de mesure, métronome, accords calés sur les temps.
   * Source : la partition calée si elle existe, sinon les mesures détectées dans l'audio (corrigées ×2 / ½ / décalage).
   */
  masterClock() {
    if (this._clock) return this._clock;
    const s = this.song, c = s.clock || {};
    const dur = s.duration || this.engine.duration || 0;
    let bars = null, src = 'audio';
    if (s.score?.bars?.length > 4) { bars = s.score.bars.slice(); src = 'partition'; }
    else {
      let d = s.downbeats?.length ? s.downbeats.slice() : null;
      if (!d && s.beats?.length > 8) d = s.beats.filter((_, i) => i % 4 === 0);
      if (!d && s.bpm && dur) { const per = (60 / s.bpm) * (c.bpb || 4); d = []; for (let t = (c.start || 0); t < dur; t += per) d.push(t); }
      if (d?.length) {
        if (c.scale === 2) d = d.filter((_, i) => i % 2 === 0);
        else if (c.scale === 0.5) { const o = []; d.forEach((x, i) => { o.push(x); if (d[i + 1] != null) o.push((x + d[i + 1]) / 2); }); d = o; }
        bars = d.map((x) => x + (c.offset || 0));
        // phase trouvée d'après les changements d'accords (les mesures détectées sont souvent décalées de 1 ou 2 temps)
        if (this._autoPhase && bars.length > 2 && c.phase == null) {
          const gp = bars.slice(1).map((x, i) => x - bars[i]).sort((a, b) => a - b);
          const step = (gp[gp.length >> 1] / (c.bpb || 4)) * this._autoPhase;
          bars = bars.map((x) => x + step);
          if (bars[0] - gp[gp.length >> 1] > 0) bars.unshift(bars[0] - gp[gp.length >> 1]);
        }
      }
    }
    if (!bars?.length) return (this._clock = { bars: [], beats: [], bpb: 4, src: null });
    // prolonge jusqu'à la fin du morceau
    const gaps = bars.slice(1).map((x, i) => x - bars[i]).sort((a, b) => a - b);
    const g = gaps[gaps.length >> 1] || 2;
    while (dur && bars[bars.length - 1] + g < dur - 0.2 && bars.length < 2000) bars.push(bars[bars.length - 1] + g);
    const bpb = (src === 'partition' ? s.score.bpb : c.bpb) || 4;
    const beats = [];
    bars.forEach((a, i) => { const z = bars[i + 1] ?? a + g; for (let k = 0; k < bpb; k++) beats.push(a + (k * (z - a)) / bpb); });
    return (this._clock = { bars, beats, bpb, src, gap: g });
  }

  barTimes() { return this.masterClock().bars; }

  /** L'horloge a changé : tout se recale dessus. */
  applyClock() {
    this._clock = null; this._bars = null; this._gsAuto = null;
    const ck = this.masterClock();
    this.engine.setBeats(ck.beats.length ? ck.beats : (this.song.beats?.length ? this.song.beats : beatsFromBpm(this.song)), ck.bars.length ? ck.bars : this.song.downbeats);
    this.renderLyrics();
    this.curBar = -2; this.frame(true);
  }

  /** Traits discrets au début de chaque mesure, posés sur les paroles sans décaler le texte. */
  renderBarMarks() {
    const L = this.$lyrics;
    if (!L) return;
    L.querySelectorAll('.bar-mk').forEach((m) => m.remove());
    L.classList.toggle('show-bars', !!this.showBars);
    if (!this.synced) return;
    const bars = this.barTimes();
    if (!bars.length) return;
    const off = (this.song.prefs.offset || 0) / 1000;
    const lt = bars.map((d) => d + off); // temps des paroles
    let bi = 0;
    for (const ln of L.querySelectorAll('.ln.lyric[data-s]')) {
      const ws = [...ln.querySelectorAll('.w[data-s]')];
      if (!ws.length) continue;
      const lr = ln.getBoundingClientRect();
      const t0 = +ws[0].dataset.s - 0.06, t1 = +ws[ws.length - 1].dataset.e + 0.06;
      while (bi > 0 && lt[bi - 1] >= t0) bi--;
      while (bi < lt.length && lt[bi] < t0) bi++;
      const frag = [];
      for (let k = bi; k < lt.length && lt[k] <= t1; k++) {
        const T = lt[k];
        let wi = ws.findIndex((w) => T <= +w.dataset.e);
        if (wi < 0) wi = ws.length - 1;
        const w = ws[wi];
        const txt = w.querySelector('.t') || w;
        const r = txt.getBoundingClientRect();
        const s = +w.dataset.s, e = +w.dataset.e;
        let x, pos;
        const n = (txt.textContent || '').replace(/\s+$/, '').length;
        if (T < s) { // dans le blanc avant le mot
          const prev = ws[wi - 1]?.querySelector('.t') || ws[wi - 1];
          const pr = prev?.getBoundingClientRect();
          x = pr && Math.abs(pr.top - r.top) < 4 ? (pr.right + r.left) / 2 : r.left - 3;
          pos = +w.dataset.a;
        } else {
          const f = e > s ? Math.min(1, (T - s) / (e - s)) : 0;
          const ci = Math.round(f * n);
          pos = +w.dataset.a + ci;
          x = r.left + (n ? (r.width * ci) / Math.max(n, 1) : 0);
          // position exacte du caractère si possible
          const tn = [...txt.childNodes].find((c) => c.nodeType === 3);
          if (tn && ci <= tn.length) { const rg = document.createRange(); rg.setStart(tn, ci); rg.collapse(true); const cr = rg.getClientRects()[0]; if (cr) x = cr.left; }
        }
        const top = w.getBoundingClientRect().top - lr.top;
        frag.push(`<i class="bar-mk" style="left:${(x - lr.left).toFixed(1)}px;top:${top.toFixed(1)}px;height:${w.getBoundingClientRect().height.toFixed(1)}px" data-pos="${pos}" data-t="${T.toFixed(3)}"></i>`);
      }
      if (frag.length) ln.insertAdjacentHTML('beforeend', frag.join(''));
    }
  }

  renderLanes() {
    const dur = this.song.duration || this.engine.duration || 1;
    const secs = this.sections;
    const tw = this.$track.clientWidth || 600;
    this.el.querySelector('.lane-sec').innerHTML = secs.map((sec, i) => {
      const end = secs[i + 1]?.t ?? dur;
      const w = (end - sec.t) / dur;
      const txt = w * tw > 7 * Math.min(sec.label.length, 9) + 8 ? esc(sec.label) : '';
      return `<span class="k-${sec.kind || 'verse'}" style="left:${(sec.t / dur) * 100}%;width:${w * 100}%" title="${esc(sec.label)}">${txt}</span>`;
    }).join('');
    this.el.querySelector('.lane-ch').innerHTML = this.hasTimedChords
      ? this.timeline.filter((c) => c.t != null).map((c) => `<i style="left:${(c.t / dur) * 100}%;width:${Math.max(0.2, ((c.e - c.t) / dur) * 100 - 0.15)}%"></i>`).join('')
      : '';
    this.drawPeaks();
  }

  drawPeaks() {
    const peaks = this.song.peaks;
    const cv = this.el.querySelector('.rail-bar canvas');
    if (!peaks?.length || !cv) return;
    const r = cv.getBoundingClientRect();
    cv.width = Math.max(1, r.width * devicePixelRatio);
    cv.height = Math.max(1, r.height * devicePixelRatio);
    const g = cv.getContext('2d');
    g.fillStyle = getComputedStyle(this.el).getPropertyValue('--line-2');
    const n = peaks.length;
    for (let i = 0; i < cv.width; i++) {
      const v = peaks[Math.floor((i / cv.width) * n)] || 0;
      const h = Math.max(1, v * cv.height);
      g.fillRect(i, (cv.height - h) / 2, 1, h);
    }
  }

  // grille d'accords, posée sur l'horloge maître
  renderGrid() {
    const s = this.song, ck = this.masterClock(), off = (s.prefs.offset || 0) / 1000;
    this.bars = [];
    const G = this.$grid;
    const lyrMode = this.prefsCache?.gridLyrics || 'off';
    const tools = this.gridTools(ck);
    if (!ck.bars.length || !this.hasTimedChords) {
      G.innerHTML = `${tools}<p class="note" style="font-size:16px;max-width:44ch">${this.writtenGrid && !ck.bars.length
        ? 'Ta grille est écrite en mesures, mais le tempo du morceau est inconnu : lance « Tout préparer » (étape Tempo et accords), ou indique le tempo dans <b>Éditer → Infos</b>.'
        : 'La grille par mesure a besoin du tempo et des accords datés. Prépare le morceau avec « Tout préparer », ou indique le tempo dans <b>Éditer → Infos</b>.'}</p>`;
      return;
    }
    const bars = ck.bars, bpb = ck.bpb || 4, n = bars.length;
    const end = (k) => bars[k + 1] ?? bars[k] + (ck.gap || 2);
    const barOf = (ta, tol) => { let lo = 0, hi = n - 1, r = 0; while (lo <= hi) { const m = (lo + hi) >> 1; if (bars[m] <= ta + tol) { r = m; lo = m + 1; } else hi = m - 1; } return r; };
    const cells = Array.from({ length: n }, () => ({ ch: [], sec: null, ly: [] }));
    // accords → mesure + temps (un accord joué un demi-temps en avance appartient à la mesure suivante)
    for (const c of this.timeline) {
      if (c.t == null) continue;
      const ta = c.t - off, k = barOf(ta, (end(barOf(ta, 0)) - bars[barOf(ta, 0)]) / bpb * 0.5);
      const bl = (end(k) - bars[k]) / bpb;
      const slot = Math.max(0, Math.min(bpb - 1, Math.round((ta - bars[k]) / bl)));
      const cell = cells[k].ch;
      const same = cell.findIndex((x) => x.slot === slot);
      if (same >= 0) cell[same] = { name: c.name, slot }; else cell.push({ name: c.name, slot });
    }
    // parties (intro, couplet, refrain…)
    for (const sec of this.sections) {
      if (sec.t == null) continue;
      const ta = sec.t - off, k = barOf(ta, (ck.gap || 2) / bpb);
      if (!cells[k].sec) cells[k].sec = { label: sec.label, kind: sec.kind };
    }
    // paroles de chaque mesure (mot par mot si possible)
    (this.vdoc || s.doc).lines.forEach((l) => {
      if (l.type !== 'lyric' || l.s == null) return;
      const toks = tokenize(l.text);
      if (l.words?.length === toks.length) toks.forEach((tk, i) => cells[barOf(l.words[i].s - off, 0.15)].ly.push(tk.w));
      else cells[barOf(l.s - off, 0.15)].ly.push(l.text);
    });
    const used = cells.map((c) => c.ch.length || c.sec);
    const first = used.findIndex(Boolean);
    let last = n - 1; while (last > 0 && !cells[last].ch.length) last--;
    if (first < 0) { G.innerHTML = tools; return; }
    const perRow = this.prefsCache?.gridPerRow || 4;
    let html = '', row = [], prev = null, sec = null, secOpen = false;
    const flush = () => { if (row.length) html += `<div class="g-row">${row.join('')}</div>`; row = []; };
    for (let k = first; k <= last + 0; k++) {
      const c = cells[k];
      if (c.sec) {
        flush(); if (secOpen) html += '</section>';
        html += `<section class="g-sec k-${esc(c.sec.kind || 'verse')}"><h4 class="g-sec-h">${esc(c.sec.label)}</h4>`;
        secOpen = true; sec = c.sec;
      } else if (row.length >= perRow) flush();
      if (!secOpen) { html += '<section class="g-sec">'; secOpen = true; }
      const ch = c.ch.sort((x, y) => x.slot - y.slot);
      let inner;
      if (!ch.length) inner = prev ? `<b class="cont" title="${esc(this.display(prev))} (continue)">${esc(this.display(prev))}</b>` : '<b class="cont">–</b>';
      else if (ch.length === 1 && ch[0].slot === 0) inner = `<b>${esc(this.display(ch[0].name))}</b>`;
      else if (ch.length === 1 && (!prev || sameName(prev, ch[0].name))) inner = `<b>${esc(this.display(ch[0].name))}</b>`;
      else if (ch.length === 1) inner = `<span class="split"><b class="c1 cont">${esc(this.display(prev))}</b><b class="c2">${esc(this.display(ch[0].name))}</b></span>`;
      else if (ch.length === 2) inner = `<span class="split"><b class="c1">${esc(this.display(ch[0].name))}</b><b class="c2">${esc(this.display(ch[1].name))}</b></span>`;
      else inner = `<span class="many">${ch.map((x) => `<b>${esc(this.display(x.name))}</b>`).join('')}</span>`;
      if (ch.length) prev = ch[ch.length - 1].name;
      const ly = c.ly.join(' ');
      this.bars.push({ a: bars[k] + off, z: end(k) + off, k });
      row.push(`<div class="mbar${ch.length ? '' : ' nochg'}" data-t="${bars[k].toFixed(3)}" data-i="${this.bars.length - 1}">${lyrMode !== 'off' ? `<span class="ly">${esc(ly)}</span>` : ''}<span class="chs">${inner}</span><span class="n">${k + 1}</span></div>`);
    }
    flush(); if (secOpen) html += '</section>';
    G.innerHTML = `${tools}<div class="gridx ly-${lyrMode}">${html}</div>`;
    this.barEls = [...G.querySelectorAll('.mbar')];
    this.curBar = -2;
  }

  /** Barre d'outils de la grille : paroles, horloge maître (mesures, calage), métronome. */
  gridTools(ck) {
    const lyr = this.prefsCache?.gridLyrics || 'off', c = this.song.clock || {};
    const bpm = ck.gap ? Math.round((60 * (ck.bpb || 4)) / ck.gap) : null;
    const seg = (k, v, label) => `<button data-g="${k}:${v}" class="${String((k === 'ly' ? lyr : k === 'scale' ? (c.scale || 1) : k === 'row' ? (this.prefsCache?.gridPerRow || 4) : '')) === String(v) ? 'on' : ''}">${label}</button>`;
    const open = this._gToolsOpen ?? (window.innerWidth > 700);
    return `<details class="g-tools-d"${open ? ' open' : ''}><summary>Réglages de la grille</summary><div class="g-tools">
      <span class="g-grp"><span class="note">Paroles</span><span class="seg">${seg('ly', 'off', 'Non')}${seg('ly', 'cur', 'Ligne en cours')}${seg('ly', 'all', 'Toutes')}</span></span>
      <span class="g-grp"><span class="note">Par ligne</span><span class="seg">${seg('row', 4, '4')}${seg('row', 8, '8')}</span></span>
      <span class="g-grp" title="Horloge maître : la grille, le métronome et les accords se calent dessus"><span class="note">Horloge ${ck.src === 'partition' ? '(partition)' : ck.src ? '(audio)' : ''}${bpm ? ` · ${bpm} bpm` : ''}</span>
        ${ck.src === 'audio' ? `<span class="seg" title="Si une case dure une demi-mesure ou deux mesures">${seg('scale', 0.5, '×2')}${seg('scale', 1, 'normal')}${seg('scale', 2, '÷2')}</span>` : ''}
        <span class="seg" title="Décaler la grille d’un temps"><button data-g="shift:-1">◀ 1 temps</button><button data-g="shift:1">1 temps ▶</button></span>
        <button class="btn small ghost${this.engine.metronome.on ? ' on' : ''}" data-act="metro" title="Entendre l'horloge pour vérifier qu'elle tombe sur la musique">Métronome</button></span>
      ${this.writtenGrid ? `<span class="g-grp"><span class="note">Ta grille démarre à la mesure</span><span class="stepper"><button data-g="start:-1">−</button><output>${(c.gridStart ?? this._gsAuto ?? 0) + 1}</output><button data-g="start:1">+</button></span></span>` : ''}
    </div></details>`;
  }

  gridAction(k, v) {
    const s = this.song, c = (s.clock ||= {}), ck = this.masterClock();
    if (k === 'ly') { this.app.setPref('gridLyrics', v); (this.prefsCache ||= {}).gridLyrics = v; this.renderGrid(); return; }
    if (k === 'row') { this.app.setPref('gridPerRow', +v); (this.prefsCache ||= {}).gridPerRow = +v; this.renderGrid(); return; }
    if (k === 'scale') c.scale = +v === 1 ? undefined : +v;
    if (k === 'start') c.gridStart = Math.max(0, (c.gridStart ?? this._gsAuto ?? 0) + +v);
    if (k === 'shift') {
      const beat = (ck.gap || 2) / (ck.bpb || 4), d = +v * beat;
      if (ck.src === 'partition') {
        s.score.bars = s.score.bars.map((x) => Math.round((x + d) * 1000) / 1000);
        s.score.sync = { ...(s.score.sync || {}), offset: Math.round(((s.score.sync?.offset || 0) + d) * 100) / 100 };
        if (this.scoreView) { this.scoreView.cfg.sync.offset = s.score.sync.offset; this.scoreView.applySync(); }
      } else c.offset = Math.round(((c.offset || 0) + d) * 1000) / 1000;
      toast(`Grille décalée d'un temps ${+v > 0 ? 'plus tard' : 'plus tôt'}`);
    }
    this.saveSong();
    this.applyClock();
  }


  renderOptions() {
    const p = this.song.prefs;
    const audioOk = true;
    const html = `
      <h3><span>Réglages du morceau</span></h3>
      <div class="opt-row"><span>Transposer</span><span class="stepper"><button data-act="tr-">−</button><output data-r="tr">${fmtSemi(p.transpose)}</output><button data-act="tr+">+</button></span></div>
      <div class="opt-row"><span>Transposer aussi l’audio</span><label class="switch"><input type="checkbox" data-act="audio-pitch" ${p.audioPitch ? 'checked' : ''} ${audioOk ? '' : 'disabled'}><i></i></label></div>
      <div class="opt-row"><span>Capo</span><span class="stepper"><button data-act="capo-">−</button><output data-r="capo">${p.capo ? p.capo : 'aucun'}</output><button data-act="capo+">+</button></span></div>
      <div class="capo-sug" data-r="capo-sug" hidden></div>
      <div class="opt-row"><span>Vitesse</span><span class="stepper"><button data-act="rate-">−</button><output data-r="rate">${Math.round(p.rate * 100)} %</output><button data-act="rate+">+</button></span></div>
      <div class="opt-row"><span>Boucle progressive<br><small class="note">à chaque tour de boucle, la vitesse monte de ${Math.round((p.progStep ?? 0.05) * 100)} % jusqu’à 100 %</small></span><label class="switch"><input type="checkbox" data-act="prog" ${p.progressive ? 'checked' : ''}><i></i></label></div>
      <div class="opt-row prog-opts"${p.progressive ? '' : ' hidden'}><span>Départ</span><span class="stepper"><button data-act="prog-">−</button><output data-r="prog">${Math.round((p.progStart ?? 0.7) * 100)} %</output><button data-act="prog+">+</button></span></div>
      <div class="opt-row"><span>Départ différé<br><small class="note">le temps de lancer REC sur la Zoom (tous les morceaux)</small></span><select data-act="start-delay" class="sel-sm">${[0, 3, 5, 10, 15, 20].map((v) => `<option value="${v}" ${+(this.prefsCache?.startDelay || 0) === v ? 'selected' : ''}>${v ? `${v} s` : 'Non'}</option>`).join('')}</select></div>
      <div class="opt-row"><span>Accord en cours en Partition et Scène</span><label class="switch"><input type="checkbox" data-act="hud-switch" ${this.hudOn() ? 'checked' : ''}><i></i></label></div>
      <div class="opt-row"><span>Décompte avant lecture</span><label class="switch"><input type="checkbox" data-act="countin" ${p.countIn ? 'checked' : ''}><i></i></label></div>
      <div class="opt-row"><span>Métronome</span><label class="switch"><input type="checkbox" data-act="metro-switch"><i></i></label></div>
      <div class="opt-row"><span>Clavier MIDI<br><small class="note" data-r="midi-st"></small></span><label class="switch"><input type="checkbox" data-act="midi" ${this.midiOn ? 'checked' : ''}><i></i></label></div>
      <div class="opt-row"><span>Zoom R20 en USB<br><small class="note" data-r="r20-st"></small> <button type="button" class="linklike" data-act="diag">Tester</button></span><label class="switch"><input type="checkbox" data-act="r20" ${this.r20On ? 'checked' : ''}><i></i></label></div>
      <div class="midi-opts"${this.midiOn ? '' : ' hidden'}>
        <div class="opt-row"><span>Suivi d’accords<br><small class="note">à l’arrêt, joue l’accord suivant : la lecture avance d’un accord</small></span><label class="switch"><input type="checkbox" data-act="midi-follow" ${this.midiFollow ? 'checked' : ''}><i></i></label></div>
        <div class="opt-row"><span>Avancer d’un accord<br><small class="note" data-r="midi-key"></small></span><button class="btn small ghost" data-act="midi-learn">Choisir une touche</button></div>
      </div>
      <div class="opt-row"${this.song.score ? '' : ' hidden'}><span>Accords de la partition<br><small class="note">leur moment suit la tablature calée</small></span><label class="switch"><input type="checkbox" data-act="sc-chords" ${this.song.score?.useChords !== false ? 'checked' : ''}><i></i></label></div>
      <div class="opt-row"><span>Afficher les accords</span><label class="switch"><input type="checkbox" data-act="show-chords" ${this.showChords ? 'checked' : ''}><i></i></label></div>
      <div class="opt-row"><span>Afficher les mesures<br><small class="note">petits traits au début de chaque mesure</small></span><label class="switch"><input type="checkbox" data-act="show-bars" ${this.showBars ? 'checked' : ''}><i></i></label></div>
      <div class="opt-row"><span>Décalage paroles<br><small class="note">+ : plus tôt · « Auto » écoute la voix</small></span><span class="row-r"><span class="stepper"><button data-act="off-">−</button><output data-r="off">${fmtOffset(p.offset)}</output><button data-act="off+">+</button></span> <button class="btn small ghost" data-act="off-auto">Auto</button></span></div>
      <div class="opt-row only-m"><span>Affichage</span><span class="seg"><button data-mode="lyrics">Paroles</button><button data-mode="stage">Scène</button><button data-mode="grid">Grille</button><button data-mode="score"${this.song.score ? '' : ' hidden'}>Partition</button></span></div>
      <div class="opt-row only-m"><span>Diagrammes</span><span class="seg"><button data-inst="guitar">Guitare</button><button data-inst="ukulele">Ukulélé</button><button data-inst="piano">Piano</button></span></div>`;
    this.el.querySelector('[data-r="opts-sec"]').innerHTML = html;
    this.el.querySelector('[data-r="opts-m"]').innerHTML = html;
    this.syncModeButtons();
    this.updateMidiUi();
    this.updateR20Ui();
    // interrupteurs : nom lisible par les lecteurs d'écran (texte de la ligne)
    this.el.querySelectorAll('.opt-row .switch input:not([aria-label])').forEach((i) => {
      const t = i.closest('.opt-row')?.querySelector('span')?.firstChild?.textContent?.trim();
      if (t) i.setAttribute('aria-label', t);
    });
  }

  renderCapoSug() {
    const boxes = this.el.querySelectorAll('[data-r="capo-sug"]');
    if (!boxes.length) return;
    const sug = this.instrument === 'piano' ? null : suggestCapo(this.song, { instrument: this.instrument });
    boxes.forEach((b) => {
      b.hidden = !sug;
      if (!sug) return;
      const shapes = sug.shapes.slice(0, 6).map((n) => `<b>${esc(n)}</b>`).join(' ');
      b.innerHTML = `<span>💡 ${sug.capo ? `Capo <b>${sug.capo}</b>` : '<b>Sans capo</b>'} : formes plus faciles<br><small>${shapes}${sug.shapes.length > 6 ? ' …' : ''}</small></span>
        <button class="btn small" data-act="capo-apply" data-capo="${sug.capo}">Appliquer</button>`;
    });
  }

  updateOptionOutputs() {
    const p = this.song.prefs;
    this.el.querySelectorAll('[data-r="tr"]').forEach((o) => { o.textContent = fmtSemi(p.transpose); });
    this.el.querySelectorAll('[data-r="capo"]').forEach((o) => { o.textContent = p.capo ? p.capo : 'aucun'; });
    this.renderCapoSug();
    this.updateMidiUi?.();
    this.updateR20Ui?.();
    this.el.querySelectorAll('[data-r="rate"]').forEach((o) => { o.textContent = Math.round(p.rate * 100) + ' %'; });
    this.el.querySelectorAll('[data-r="off"]').forEach((o) => { o.textContent = fmtOffset(p.offset); });
    this.el.querySelectorAll('[data-act="audio-pitch"]').forEach((i) => { i.checked = !!p.audioPitch; });
    this.el.querySelectorAll('[data-act="countin"]').forEach((i) => { i.checked = !!p.countIn; });
    this.el.querySelectorAll('[data-act="show-chords"]').forEach((i) => { i.checked = this.showChords; });
    const rb = this.el.querySelector('.rate-btn');
    rb.textContent = (Math.round(p.rate * 100) / 100).toString().replace('.', ',') + '×';
    rb.classList.toggle('changed', p.rate !== 1);
  }

  renderMixer() {
    const s = this.song;
    const all = sortStems(s.stems);
    // pistes vides (silence) : pas de bouton dans le mixage, sauf si on demande à les voir
    const hidden = this.showEmpty ? [] : all.filter(isEmptyStem);
    const stems = all.filter((st) => !hidden.includes(st));
    this._mixStems = stems;
    const strips = stems.map((st) => {
      const m = s.mix[st.id] || { vol: 1 };
      const color = STEM_KINDS[st.kind]?.color || 'var(--c-other)';
      return `<div class="strip${m.mute ? ' muted' : ''}" data-id="${st.id}" style="--k:${color}">
        <div class="fader" tabindex="0" role="slider" aria-label="Volume ${esc(st.label)}" aria-valuemin="0" aria-valuemax="150">
          <div class="stem"></div><div class="level"></div><div class="unity"></div><div class="kn"></div>
        </div>
        <span class="pct"></span>
        <div class="ms"><button class="m${m.mute ? ' on' : ''}" data-act="mute" title="Couper">M</button><button class="s${m.solo ? ' on' : ''}" data-act="solo" title="Seul">S</button></div>
        <span class="lbl" title="${esc(st.label)}">${esc(st.label)}</span>
      </div>`;
    }).join('');
    const master = `<div class="strip" data-id="master" style="--k:var(--ink-3)">
        <div class="fader" tabindex="0" role="slider" aria-label="Volume général" aria-valuemin="0" aria-valuemax="150"><div class="stem"></div><div class="unity"></div><div class="kn"></div></div>
        <span class="pct"></span><div class="ms" style="visibility:hidden"><button>M</button></div><span class="lbl">Général</span></div>`;
    const kinds = new Set(stems.map((x) => x.kind));
    const presets = [];
    if (kinds.has('vocals')) presets.push(['karaoke', 'Sans la voix'], ['voice', 'Voix seule']);
    for (const k of ['guitar', 'piano', 'bass', 'drums']) if (kinds.has(k)) presets.push(['no-' + k, 'Sans ' + STEM_KINDS[k].label.toLowerCase()]);
    const presetHtml = presets.map(([k, l]) => `<button class="chip" data-preset="${k}">${esc(l)}</button>`).join('');
    const emptyNote = hidden.length ? `<p class="note empty-note">${hidden.length} piste${hidden.length > 1 ? 's' : ''} vide${hidden.length > 1 ? 's' : ''} masquée${hidden.length > 1 ? 's' : ''} (${hidden.map((x) => esc(x.label)).join(', ')}) · <button class="linklike" data-act="show-empty">afficher</button></p>` : '';
    this.el.querySelectorAll('.mixer').forEach((m) => { m.innerHTML = stems.length ? strips + (stems.length > 1 ? master : '') + emptyNote : '<p class="note">Aucune piste audio.</p>'; });
    this.el.querySelectorAll('.presets').forEach((p) => { p.innerHTML = presetHtml; });
    this.el.querySelectorAll('.strip').forEach((strip) => this.bindStrip(strip));
    this.updateStrips();
  }

  updateStrips() {
    const s = this.song;
    this.el.querySelectorAll('.strip').forEach((strip) => {
      const id = strip.dataset.id;
      const v = id === 'master' ? s.master ?? 1 : s.mix[id]?.vol ?? 1;
      const kn = strip.querySelector('.kn');
      const f = strip.querySelector('.fader');
      const h = f.clientHeight || 150;
      const usable = h - 20;
      kn.style.top = `${10 + usable * (1 - v / 1.5)}px`;
      strip.querySelector('.unity').style.top = `${10 + usable * (1 - 1 / 1.5)}px`;
      strip.querySelector('.pct').textContent = Math.round(v * 100) + ' %';
      f.setAttribute('aria-valuenow', Math.round(v * 100));
      if (id !== 'master') {
        const m = s.mix[id] || {};
        strip.classList.toggle('muted', !!m.mute);
        strip.querySelector('.m').classList.toggle('on', !!m.mute);
        strip.querySelector('.s').classList.toggle('on', !!m.solo);
      }
    });
  }

  bindStrip(strip) {
    const id = strip.dataset.id;
    const fader = strip.querySelector('.fader');
    const set = (v) => {
      v = Math.max(0, Math.min(1.5, v));
      if (Math.abs(v - 1) < 0.04) v = 1; // aimant sur 100 %
      if (id === 'master') { this.song.master = v; this.engine.setMaster(v); }
      else { this.song.mix[id] = { ...(this.song.mix[id] || {}), vol: v }; this.engine.setTrack(id, { vol: v }); }
      this.updateStrips();
      this.saveSong();
    };
    const fromY = (e) => {
      const r = fader.getBoundingClientRect();
      return 1.5 * (1 - (e.clientY - r.top - 10) / (r.height - 20));
    };
    drag(fader, { onStart: (e) => set(fromY(e)), onMove: (e) => set(fromY(e)) });
    fader.addEventListener('dblclick', () => set(1));
    fader.addEventListener('keydown', (e) => {
      const cur = id === 'master' ? this.song.master ?? 1 : this.song.mix[id]?.vol ?? 1;
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); set(cur + 0.05); }
      if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); set(cur - 0.05); }
      if (e.key === 'Home') set(1);
    });
    strip.querySelector('[data-act="mute"]')?.addEventListener('click', () => this.toggleMix(id, 'mute'));
    strip.querySelector('[data-act="solo"]')?.addEventListener('click', () => this.toggleMix(id, 'solo'));
  }

  toggleMix(id, field) {
    const m = { vol: 1, ...(this.song.mix[id] || {}) };
    m[field] = !m[field];
    this.song.mix[id] = m;
    this.engine.setTrack(id, { [field]: m[field] });
    this.updateStrips();
    if (this.r20On) this.r20Leds();
    this.saveSong();
  }

  applyPreset(k) {
    const s = this.song;
    for (const st of s.stems) {
      const m = (s.mix[st.id] = { ...(s.mix[st.id] || {}), vol: 1, mute: st.kind === 'instrumental' && s.stems.length > 2, solo: false });
      if (k === 'karaoke' && (st.kind === 'vocals' || st.kind === 'backing')) m.mute = true;
      if (k === 'voice') m.solo = st.kind === 'vocals';
      if (k.startsWith('no-') && st.kind === k.slice(3)) m.mute = true;
      this.engine.setTrack(st.id, { vol: m.vol, mute: m.mute, solo: m.solo });
    }
    this.updateStrips();
    this.saveSong();
  }

  // ─────────────────────────────────────────────────────────── audio ──

  async loadAudio() {
    const s = this.song;
    const stems = [];
    for (const st of s.stems) {
      const blob = st.url ? null : await db.getBlob(st.blobId);
      if (!blob && !st.url) continue;
      const m = s.mix[st.id] || {};
      stems.push({ id: st.id, kind: st.kind, label: st.label, blob, url: st.url, vol: m.vol ?? 1, mute: !!m.mute, solo: !!m.solo, pan: m.pan || 0 });
    }
    await this.engine.load(stems, { duration: s.duration });
    // mesure des pistes encore inconnues (une fois), puis mixage sans les pistes vides
    ensureLevels(s).then((ch) => { if (ch && this.song === s) { db.putSong(s); this.renderMixer(); } }).catch(() => {});
    if (!s.duration && this.engine.duration) { s.duration = this.engine.duration; this.renderLyrics(); }
    this.engine.setMaster(s.master ?? 1);
    this.engine.setRate(s.prefs.rate || 1);
    this.engine.setSemitones(s.prefs.audioPitch ? s.prefs.transpose : 0);
    { const ck = this.masterClock(); this.engine.setBeats(ck.beats.length ? ck.beats : (s.beats?.length ? s.beats : beatsFromBpm(s)), ck.bars.length ? ck.bars : s.downbeats); }
    this.engine.setMetronome(false);
    this.engine.addEventListener('time', this._onTime);
    this._engineH = {};
    for (const ev of ['play', 'pause', 'seek', 'loop', 'rate', 'ended', 'looped']) {
      this._engineH[ev] = () => this.onEngine(ev);
      this.engine.addEventListener(ev, this._engineH[ev]);
    }
    this._engineH.blocked = () => toast('Touche lecture pour démarrer le son');
    this.engine.addEventListener('blocked', this._engineH.blocked);
    this.el.querySelector('[data-r="dur"]').textContent = fmtTime(s.duration || this.engine.duration);
    this.updateOptionOutputs();
    this.frame(true);
    this.startMeters();
  }

  onEngine(ev) {
    const playBtn = this.el?.querySelector('.play');
    if (!playBtn) return;
    if (ev === 'play' || ev === 'pause' || ev === 'ended') {
      playBtn.innerHTML = icon(this.engine.playing ? 'pause' : 'play');
      playBtn.setAttribute('aria-label', this.engine.playing ? 'Pause' : 'Lecture');
      if (this.engine.playing) this.requestWake(); else this.releaseWake();
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = this.engine.playing ? 'playing' : 'paused';
    }
    if (ev === 'seek') { this.userScrollAt = 0; this.frame(true); }
    if (ev === 'loop') { this.renderLoop(); this.progressStart(); }
    if (ev === 'looped') this.progressStep();
    if (ev === 'ended') this.onEnded();
    if ((ev === 'play' || ev === 'pause') && this.r20On) this.r20Leds();
    if (ev === 'play') this.scoreView?.userPlay();
    if (this.take?.live && (ev === 'pause' || ev === 'ended' || ev === 'seek' || ev === 'loop')) this.stopTake();
  }

  onEnded() {
    if (this.take) return;
    if (this.ctx.setlist && this.ctx.index < this.ctx.setlist.songs.length - 1) {
      toast('Morceau suivant dans 3 secondes…');
      this.autoNext = setTimeout(() => this.app.playFromSetlist(this.ctx.setlist, this.ctx.index + 1), 3000);
    }
  }

  async togglePlay() {
    if (this._delay) { this.cancelDelay(); return; } // 2e appui pendant l'attente : on annule
    if (this.engine.playing) { this.engine.pause(); return; }
    const d = +(this.prefsCache?.startDelay || 0);
    if (d > 0 && !this._delaySkip) { this.startDelay(d); return; }
    this._delaySkip = false;
    const p = this.song.prefs;
    if (p.countIn) {
      const bpm = this.song.bpm || 100;
      this.showCountdown(bpm);
      await this.engine.countIn(bpm * 1, 4);
    } else {
      await this.engine.play();
    }
  }

  /** Départ différé : laisse le temps de lancer l'enregistrement de la Zoom et de se placer. */
  startDelay(sec) {
    const ov = document.createElement('div');
    ov.className = 'delay-ov';
    ov.innerHTML = `<div class="delay-n"></div><p>Départ dans…</p><div class="delay-acts"><button class="btn primary" data-d="now">Démarrer maintenant</button><button class="btn" data-d="stop">Annuler</button></div>`;
    this.el.querySelector('.player-main, main, .lyrics-wrap')?.appendChild(ov) || this.el.appendChild(ov);
    const end = performance.now() + sec * 1000;
    const tick = () => {
      const left = Math.ceil((end - performance.now()) / 1000);
      if (left <= 0) { this.cancelDelay(); this._delaySkip = true; this.togglePlay(); return; }
      ov.querySelector('.delay-n').textContent = left;
      this._delay.raf = setTimeout(tick, 100);
    };
    this._delay = { ov };
    ov.addEventListener('click', (e) => {
      const b = e.target.closest('[data-d]');
      if (!b) return;
      this.cancelDelay();
      if (b.dataset.d === 'now') { this._delaySkip = true; this.togglePlay(); }
    });
    tick();
  }

  cancelDelay() {
    if (!this._delay) return;
    clearTimeout(this._delay.raf);
    this._delay.ov.remove();
    this._delay = null;
  }

  showCountdown(bpm) {
    const el = this.el.querySelector('.countdown');
    const period = 60 / bpm / this.engine.rate;
    el.hidden = false;
    let n = 4;
    el.textContent = n;
    const iv = setInterval(() => {
      n--;
      if (n <= 0) { clearInterval(iv); el.hidden = true; return; }
      el.textContent = n;
    }, period * 1000);
  }

  startMeters() {
    clearInterval(this.meterTimer);
    this.meterTimer = setInterval(() => {
      if (!this.el || !this.engine.playing) return;
      const lv = this.engine.levels();
      this.el.querySelectorAll('.strip[data-id]').forEach((strip) => {
        const l = strip.querySelector('.level');
        if (!l) return;
        const v = lv[strip.dataset.id] || 0;
        l.style.height = `${Math.round(v * ((strip.querySelector('.fader').clientHeight || 150) - 20))}px`;
      });
    }, 60);
  }

  async requestWake() {
    try { if ('wakeLock' in navigator && !this.wake) { this.wake = await navigator.wakeLock.request('screen'); this.wake.addEventListener('release', () => { this.wake = null; }); } } catch { /* */ }
  }

  releaseWake() { try { this.wake?.release(); } catch { /* */ } this.wake = null; }

  setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const s = this.song;
    navigator.mediaSession.metadata = new MediaMetadata({ title: s.title || 'MusiMix', artist: s.artist || '', artwork: [{ src: new URL('assets/icons/icon-512.png', location.href).href, sizes: '512x512', type: 'image/png' }] });
    const h = {
      play: () => this.engine.play(), pause: () => this.engine.pause(),
      seekbackward: () => this.engine.skip(-5), seekforward: () => this.engine.skip(5),
      seekto: (d) => this.engine.seek(d.seekTime),
      previoustrack: this.ctx.setlist ? () => this.app.playFromSetlist(this.ctx.setlist, this.ctx.index - 1) : null,
      nexttrack: this.ctx.setlist ? () => this.app.playFromSetlist(this.ctx.setlist, this.ctx.index + 1) : null,
    };
    for (const [k, fn] of Object.entries(h)) { try { navigator.mediaSession.setActionHandler(k, fn); } catch { /* */ } }
  }

  // ───────────────────────────────────────────────────── synchronisation ──

  get t() { return this.engine.displayTime + (this.song.prefs.offset || 0) / 1000; }

  frame(force = false) {
    if (!this.el) return;
    const t = this.t;
    if (this.mode === 'score') this.scoreView?.update(this.engine.displayTime ?? this.engine.currentTime, force);
    const dur = this.song.duration || this.engine.duration || 0;
    // barre de lecture
    const pct = dur ? Math.min(100, (this.engine.currentTime / dur) * 100) : 0;
    this.$track.querySelector('.done').style.width = pct + '%';
    this.$track.querySelector('.head').style.left = pct + '%';
    this.$track.setAttribute('aria-valuenow', Math.round(this.engine.currentTime));
    this.$track.setAttribute('aria-valuetext', fmtTime(this.engine.currentTime));
    this.el.querySelector('[data-r="cur"]').textContent = fmtTime(this.engine.currentTime);
    if (dur && !this.$track.getAttribute('aria-valuemax')) this.$track.setAttribute('aria-valuemax', Math.round(dur));

    this.syncLines(t, force);
    this.syncChords(t, force);
    if (this.mode === 'grid') this.syncGrid(t, force);
  }

  syncLines(t, force) {
    if (this.synced) {
      const tl = this.timedLines;
      let i = -1;
      let lo = 0, hi = tl.length - 1;
      while (lo <= hi) { const mid = (lo + hi) >> 1; if (tl[mid].s <= t + 0.05) { i = mid; lo = mid + 1; } else hi = mid - 1; }
      const li = i >= 0 ? tl[i].li : -1;
      if (li !== this.curLine || force) {
        const prev = this.lineEls.get(this.curLine);
        prev?.classList.remove('cur');
        prev?.querySelectorAll('.w').forEach((w) => { w.classList.remove('sung', 'singing'); w.style.removeProperty('--p'); });
        this.lineEls.forEach((p, k) => p.classList.toggle('past', k < li && p.classList.contains('lyric')));
        const cur = this.lineEls.get(li);
        cur?.classList.add('cur');
        this.curLine = li;
        this.curWords = cur ? [...cur.querySelectorAll('.w[data-s]')].map((w) => ({ w, s: +w.dataset.s, e: +w.dataset.e })) : [];
        if (this.mode === 'stage') this.renderBig(i);
        if (this.mode === 'score') this.renderScoreLyrics(false, i);
      }
      // karaoké mot à mot
      for (const x of this.curWords || []) {
        if (t >= x.e) { if (!x.done) { x.w.classList.add('sung'); x.w.classList.remove('singing'); x.done = true; } }
        else if (t >= x.s) { x.done = false; x.w.classList.remove('sung'); x.w.classList.add('singing'); x.w.style.setProperty('--p', `${((t - x.s) / Math.max(0.05, x.e - x.s)) * 100}%`); }
        else if (x.done !== null) { x.w.classList.remove('sung', 'singing'); x.done = null; }
      }
      if (this.mode === 'stage') this.syncBigWords(t);
      this.autoScroll(this.lineEls.get(this.curLine), force);
    } else if (this.mode === 'lyrics') {
      // sans synchro : défilement proportionnel à la durée, en pause si on fait défiler à la main
      const dur = this.song.duration || this.engine.duration;
      if (!dur || !this.engine.playing || performance.now() - this.userScrollAt < 4000) return;
      const L = this.$lyrics;
      const max = L.scrollHeight - L.clientHeight;
      const target = (t / dur) * max;
      this.smoothScrollTo(target);
    }
  }

  autoScroll(lineEl, force) {
    if (this.mode !== 'lyrics' || !lineEl || this.editing.on) return;
    if (!force && performance.now() - this.userScrollAt < 4000) return;
    this.el.querySelector('.follow-btn').hidden = true;
    const L = this.$lyrics;
    const target = lineEl.offsetTop - L.clientHeight * 0.32;
    if (force) { this._scrolling = true; L.scrollTop = target; setTimeout(() => { this._scrolling = false; }, 50); }
    else this.smoothScrollTo(target);
  }

  smoothScrollTo(target) {
    const L = this.$lyrics;
    const cur = L.scrollTop;
    const d = target - cur;
    if (Math.abs(d) < 1) return;
    this._scrolling = true;
    L.scrollTop = cur + d * 0.14;
    clearTimeout(this._scrollT);
    this._scrollT = setTimeout(() => { this._scrolling = false; }, 80);
  }

  renderBig(i) {
    const tl = this.timedLines;
    const doc = this.vdoc || this.song.doc;
    const cur = i >= 0 ? doc.lines[tl[i].li] : null;
    const nxt = doc.lines[tl[i + 1]?.li];
    let tag = '';
    if (i >= 0) {
      for (let k = tl[i].li; k >= 0; k--) if (doc.lines[k].type === 'section') { tag = doc.lines[k].label; break; }
    }
    const curHtml = cur ? lyricLine(cur, tl[i].li, this.display, 'cur now-line') : '<p class="ln now-line" style="color:var(--ink-3)">…</p>';
    const nextHtml = nxt ? `<div class="next-line">${esc(nxt.text)}</div>` : '';
    this.$big.innerHTML = `${tag ? `<div class="tag">${esc(tag)}</div>` : ''}${curHtml}${nextHtml}`;
    this.bigWords = [...this.$big.querySelectorAll('.now-line .w[data-s]')].map((w) => ({ w, s: +w.dataset.s, e: +w.dataset.e }));
    this.layoutStageHud();
  }

  /** Accord en Scène : déplaçable partout sur la page, sans jamais recouvrir les paroles. */
  layoutStageHud(drag) {
    const stage = this.el.querySelector('.stage'), hud = stage?.querySelector('.stage-hud');
    if (!hud || this.mode !== 'stage' || !hud.offsetWidth) return;
    if (!hud.dataset.drag) {
      hud.dataset.drag = '1';
      hud.addEventListener('pointerdown', (e) => {
        if (e.target.closest('.hud-size')) return;
        e.preventDefault(); e.stopPropagation(); hud.setPointerCapture(e.pointerId); hud.classList.add('drag');
        const r = hud.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
        const mv = (ev) => { const sr = stage.getBoundingClientRect(); this.layoutStageHud({ x: ev.clientX - sr.left - dx, y: ev.clientY - sr.top - dy, live: true }); };
        const up = (ev) => { hud.classList.remove('drag'); hud.removeEventListener('pointermove', mv); hud.removeEventListener('pointerup', up); hud.removeEventListener('pointercancel', up); const sr = stage.getBoundingClientRect(); this.layoutStageHud({ x: ev.clientX - sr.left - dx, y: ev.clientY - sr.top - dy }); this.app.setPref('stageHudPos', this.prefsCache.stageHudPos); };
        hud.addEventListener('pointermove', mv); hud.addEventListener('pointerup', up); hud.addEventListener('pointercancel', up);
      });
      if (window.ResizeObserver) new ResizeObserver(() => this.layoutStageHud()).observe(stage);
    }
    const z = this.prefsCache?.stageHudZoom || 1;
    hud.style.zoom = z;
    const W = stage.clientWidth, H = stage.clientHeight, w = hud.offsetWidth * z, h = hud.offsetHeight * z, m = 10;
    const P = (this.prefsCache ||= {}).stageHudPos || { fx: 0.5, fy: 0 };
    let x, y;
    if (drag) { x = drag.x; y = drag.y; } else { x = P.fx * (W - w); y = P.fy * (H - h); }
    x = Math.max(m, Math.min(W - w - m, x)); y = Math.max(m, Math.min(H - h - m, y));
    if (!drag?.live) {
      // zone des paroles (agrandie un peu) : on en sort par le côté le plus proche
      const sr = stage.getBoundingClientRect();
      let T = null;
      this.$big.querySelectorAll('.tag, .ln, .next-line, .big-chord').forEach((el) => {
        const r = el.getBoundingClientRect(); if (!r.width) return;
        const q = { l: r.left - sr.left - 14, t: r.top - sr.top - 14, r: r.right - sr.left + 14, b: r.bottom - sr.top + 14 };
        T = T ? { l: Math.min(T.l, q.l), t: Math.min(T.t, q.t), r: Math.max(T.r, q.r), b: Math.max(T.b, q.b) } : q;
      });
      if (T && x < T.r && x + w > T.l && y < T.b && y + h > T.t) {
        const c = [
          { x: T.l - w, y }, { x: T.r, y }, { x, y: T.t - h }, { x, y: T.b },
        ].filter((p) => p.x >= m - 0.5 && p.x <= W - w - m + 0.5 && p.y >= m - 0.5 && p.y <= H - h - m + 0.5);
        if (c.length) { const best = c.reduce((a, b) => (Math.hypot(b.x - x, b.y - y) < Math.hypot(a.x - x, a.y - y) ? b : a)); x = best.x; y = best.y; }
      }
      if (drag) this.prefsCache.stageHudPos = { fx: W > w ? x / (W - w) : 0, fy: H > h ? y / (H - h) : 0 };
    }
    hud.style.left = `${Math.round(x / z)}px`; hud.style.top = `${Math.round(y / z)}px`; hud.style.transform = 'none';
  }

  syncBigWords(t) {
    for (const x of this.bigWords || []) {
      if (t >= x.e) { x.w.classList.add('sung'); x.w.classList.remove('singing'); }
      else if (t >= x.s) { x.w.classList.add('singing'); x.w.style.setProperty('--p', `${((t - x.s) / Math.max(0.05, x.e - x.s)) * 100}%`); }
      else x.w.classList.remove('sung', 'singing');
    }
  }

  syncChords(t, force) {
    const tl = this.timeline;
    if (!tl.length || !this.hasTimedChords) {
      if (force) this.showAllChords();
      return;
    }
    const times = this._chordTimes || (this._chordTimes = tl.map((c) => c.t ?? Infinity));
    if (this._chordTimesFor !== tl) { this._chordTimes = tl.map((c) => c.t ?? Infinity); this._chordTimesFor = tl; }
    const idx = lowerBound(this._chordTimes, t + 0.06) - 1;
    if (idx !== this.lastChordIdx || force) {
      const prevC = tl[this.lastChordIdx];
      if (prevC) this.chordEls.get(`${prevC.li}|${prevC.ci}`)?.classList.remove('now');
      this.lastChordIdx = idx;
      const c = tl[idx];
      if (c) this.chordEls.get(`${c.li}|${c.ci}`)?.classList.add('now');
      if (this.mode === 'score' && this.song.score?.showLyrics) this.markScoreChord(c);
      let n = idx + 1;
      while (tl[n] && c && tl[n].name === c.name) n++;
      this.showChord(c ? c.name : null, tl[n]?.name || null);
    }
    const c = tl[idx];
    if (c) {
      const p = Math.min(1, Math.max(0, (t - c.t) / Math.max(0.1, (c.e - c.t))));
      this.el.querySelector('.chord-progress i').style.width = (p * 100) + '%';
    }
  }

  showChord(name, next) {
    const d = this.display;
    const shown = name ? d(name) : '';
    const nextShown = next ? d(next) : '';
    this.el.querySelectorAll('[data-r="now"]').forEach((e) => { e.textContent = shown || '–'; });
    if (this.improOn && name !== this._improChord) { this._improChord = name; this.renderImpro(); }
    if (this.mode === 'stage' && !this.synced) {
      this.$big.innerHTML = `<div class="tag">Accord</div><div class="now-line big-chord">${esc(shown || '–')}</div>${nextShown ? `<div class="next-line">ensuite ${esc(nextShown)}</div>` : ''}`;
    }
    this.el.querySelectorAll('[data-r="next"]').forEach((e) => { e.innerHTML = nextShown ? `<small>ensuite</small>${esc(nextShown)}` : ''; });
    if (this.hudOn()) {
      const hk = shown + '|' + nextShown + '|' + this.instrument + '|' + (this.voicingIdx[shown] || 0);
      if (hk !== this._hudKey) {
        this._hudKey = hk;
        const dg = shown ? diagramSVG(shown, this.instrument, { index: this.voicingIdx[shown] || 0 }) : '';
        this.el.querySelectorAll('[data-r="hud"]').forEach((e) => { e.innerHTML = shown ? `<div class="hud-txt"><b>${esc(shown)}</b>${nextShown ? `<small>ensuite <i>${esc(nextShown)}</i></small>` : ''}</div><div class="hud-dg">${dg}</div>` : ''; });
        if (this.mode === 'score') this.layoutHud();
        if (this.mode === 'stage') this.layoutStageHud();
      }
    }
    const key = shown + '|' + this.instrument + '|' + (this.voicingIdx[shown] || 0) + '|' + nextShown;
    if (key === this._diagKey) return;
    this._diagKey = key;
    const dg = this.el.querySelector('[data-r="diagram"]');
    const fm = this.el.querySelector('[data-r="formula"]');
    const mini = this.el.querySelector('[data-r="mini"]');
    const fsd = this.el.querySelector('[data-r="fs-dg"]');
    if (!shown) { dg.innerHTML = ''; fm.textContent = ''; mini.innerHTML = ''; if (fsd) fsd.innerHTML = ''; return; }
    const idx = this.voicingIdx[shown] || 0;
    const nv = this.instrument === 'piano' ? 0 : voicings(shown, this.instrument).length;
    const main = diagramSVG(shown, this.instrument, { index: idx });
    const nextD = nextShown && this.instrument !== 'piano' ? diagramSVG(nextShown, this.instrument, { index: this.voicingIdx[nextShown] || 0 }).replace('class="fretboard"', 'class="fretboard next"') : '';
    dg.innerHTML = `<div>${main}${nv > 1 ? `<div class="alt">Doigté ${idx % nv + 1}/${nv} · touche pour changer</div>` : ''}</div>${nextD}`;
    const f = chordFormula(shown);
    fm.textContent = f ? f.notes.join(' · ') + (f.bass ? ` / basse ${f.bass}` : '') : '';
    mini.innerHTML = diagramSVG(shown, this.instrument, { index: idx });
    if (fsd) fsd.innerHTML = main;
  }

  /** Va au début d'un accord : juste après son temps, pour que ce soit bien lui qui s'affiche
   *  (avant, on se plaçait 50 ms plus tôt et c'était l'accord précédent qui apparaissait). */
  // ---------- Partition (Guitar Pro / MusicXML) ----------
  scoreDialog() {
    const has = !!this.song.score;
    const d = dialog(`<form method="dialog">
      <h2>Partition</h2>
      <p>Fichier <b>Guitar Pro</b> (.gp, .gpx, .gp5, .gp4, .gp3) ou <b>MusicXML</b> (.musicxml, .mxl, .xml, export de MuseScore). Elle s’affiche dans la vue « Partition », calée sur l’audio du morceau.</p>
      ${has ? `<p class="note">Actuelle : <b>${esc(this.song.score.name || 'partition')}</b></p>` : ''}
      <label class="field">Ou un lien direct vers le fichier<input type="url" name="url" placeholder="https://…/morceau.gp5"></label>
      <div class="actions">${has ? '<button type="button" class="btn ghost danger" data-v="del">Retirer</button>' : ''}<button class="btn ghost" value="">Annuler</button><button type="button" class="btn" data-v="url">Depuis le lien</button><button type="button" class="btn primary" data-v="file">Ouvrir un fichier</button></div></form>`);
    const form = d.el.querySelector('form');
    d.el.addEventListener('click', (e) => {
      const v = e.target.closest('[data-v]')?.dataset.v;
      if (!v) return;
      // le sélecteur de fichier doit s'ouvrir dans le clic même (sinon le navigateur le bloque)
      const picked = v === 'file' ? pickFiles({ accept: '.gp,.gpx,.gp3,.gp4,.gp5,.musicxml,.mxl,.xml', multiple: false }) : null;
      d.close(v);
      run(v, picked);
    });
    const run = async (v, picked) => {
      try {
        if (v === 'del') { this.scoreView?.destroy(); this.scoreView = null; delete this.song.score; await db.putSong(this.song); this.refreshScoreButtons(); if (this.mode === 'score') this.setMode('lyrics'); toast('Partition retirée'); return; }
        let blob, name;
        if (v === 'file') {
          const [f] = (await picked) || [];
          if (!f) return;
          blob = f; name = f.name;
        } else if (v === 'url') {
          const url = new FormData(form).get('url')?.toString().trim();
          if (!url) { toast('Colle d’abord le lien du fichier'); return; }
          toast('Téléchargement de la partition…');
          const r = await fetch(url);
          if (!r.ok) throw new Error(`le lien répond ${r.status}`);
          blob = await r.blob(); name = decodeURIComponent(url.split('/').pop().split('?')[0]) || 'partition';
        } else return;
        await this.setScoreBlob(blob, name);
      } catch (err) { toast(`Partition impossible : ${err.message || err}`, 6000); }
    };
  }

  async setScoreBlob(blob, name) {
    if (!SCORE_EXT.test(name)) toast('Ce n’est peut-être pas une partition : essai quand même…');
    const blobId = await db.putBlob(blob);
    this.song.score = { blobId, name, mime: blob.type || 'application/octet-stream', track: 0, layout: 'both', sync: { firstBar: 0, offset: 0, auto: true } };
    await db.putSong(this.song);
    this.scoreView?.destroy(); this.scoreView = null;
    this.refreshScoreButtons();
    this.setMode('score');
    toast(`Partition ajoutée : ${name}`);
  }

  refreshScoreButtons() { this.el.querySelectorAll('[data-mode="score"]').forEach((b) => { b.hidden = !this.song.score; }); }

  async mountScore() {
    const sc = this.song.score;
    const view = this.el.querySelector('.score-view');
    const status = (txt) => { const o = view.querySelector('[data-r="sc-status"]'); if (o) o.textContent = txt; };
    if (!sc) { view.querySelector('.score-host').innerHTML = '<p class="note" style="padding:20px">Pas de partition pour ce morceau : menu ⋯ → Ajouter une partition.</p>'; return; }
    this.updateScoreBar();
    if (this.scoreView) return;
    const host = view.querySelector('.score-host');
    host.innerHTML = '<p class="note" style="padding:20px">Chargement de la partition…</p>';
    if (!this._scBound) {
      this._scBound = true;
      view.querySelector('.score-bar').addEventListener('click', (e) => {
        const b = e.target.closest('[data-sc]');
        if (b?.dataset.sc === 'bar:toggle') {
          const min = !this.prefsCache?.scoreBarMin;
          (this.prefsCache ||= {}).scoreBarMin = min; this.app.setPref('scoreBarMin', min);
          this.el.querySelector('.score-bar').classList.toggle('min', min);
          return;
        }
        if (!b || (!this.scoreView && !b.dataset.sc.startsWith('lyrics'))) return;
        const [k, v] = b.dataset.sc.split(':');
        if (k === 'layout') this.scoreView.setLayout(v);
        if (k === 'zoom') this.scoreView.setScale((this.song.score.scale || 1) + (v === '+' ? 0.1 : -0.1));
        if (k === 'bar') this.scoreView.nudge({ firstBar: +v });
        if (k === 'off') this.scoreView.nudge({ offset: +v });
        if (k === 'hud') { const on = !this.hudOn(); (this.prefsCache ||= {}).hud = on; this.app.setPref('hud', on); this.applyHud(); this.renderScoreLyrics(true); this.updateScoreBar(); return; }
        if (k === 'auto') { v === 'lyr' ? this.autoLyrics() : v === 'words' ? this.autoWords() : this.autoScore(); return; }
        if (k === 'loff') {
          const p = this.song.prefs;
          p.offset = Math.round((p.offset || 0) + +v * 1000);
          this.updateOptionOutputs(); this.renderBarMarks(); this.saveSong(); this.curLine = -2; this.frame(true); this.renderScoreLyrics(true);
          toast(`Paroles décalées de ${fmtOffset(p.offset)}`);
        }
        if (k === 'lyrics') { this.song.score.showLyrics = !this.song.score.showLyrics; this.saveSong(); this.renderScoreLyrics(true); }
        this.updateScoreBar();
      });
      view.querySelector('[data-r="sc-track"]').addEventListener('change', (e) => this.scoreView?.setTrack(+e.target.value));
    }
    try {
      const blob = await db.getBlob(sc.blobId);
      if (!blob) throw new Error('fichier absent sur cet appareil (synchro en cours ?)');
      this.scoreView = new ScoreView(host, {
        engine: this.engine,
        song: this.song,
        onStatus: status,
        getDownbeats: () => this.song.downbeats?.length ? this.song.downbeats : (this.barTimes?.() || []),
        save: () => this.saveSong(),
        onSynced: () => this.takeScoreChords(),
        onTracks: (tracks, cur) => {
          const sel = view.querySelector('[data-r="sc-track"]');
          sel.innerHTML = tracks.map((t) => `<option value="${t.i}" ${t.i === cur ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
          sel.hidden = tracks.length < 2;
        },
      });
      await this.scoreView.mount(new Uint8Array(await blob.arrayBuffer()));
    } catch (err) {
      this.scoreView = null;
      host.innerHTML = `<p class="note" style="padding:20px">Partition impossible à afficher : ${esc(err.message || String(err))}</p>`;
    }
  }

  /** Écoute la piste Voix et règle le décalage des paroles. */
  async autoLyrics() {
    if (this._autoBusy) { toast('Un calage est déjà en cours, patiente quelques secondes…'); return; }
    this._autoBusy = true;
    toast('Calage des paroles : écoute de la voix…', 20000);
    try {
      const { alignLyrics, alignFromScore } = await import('../autoalign.js?v=4.28.4');
      // 1) la partition contient les paroles et elle est calée : c'est la référence la plus sûre
      let r = null;
      if (this.song.score) {
        if (!this.scoreView) { const m = this.mode; this.setMode('score', false); await new Promise((ok) => setTimeout(ok, 2500)); if (m !== 'score') this.setMode(m, false); }
        let syl = [];
        try { syl = this.scoreView?.scoreLyrics?.() || []; } catch (e) { console.error(e); }
        const fs = typeof alignFromScore === 'function' && alignFromScore(this.song, syl);
        window.__mmAuto = { syl: syl.slice(0, 40), nSyl: syl.length, fs, downs: this.scoreView?._downs?.length };
        if (fs && fs.n >= 3 && fs.conf >= 0.4) r = { ...fs, src: 'partition' };
        else this._autoWhy = `partition : ${syl.length} syllabes lues, ${fs ? `${fs.n} lignes d'accord sur ${fs.of}` : 'aucune ligne reconnue'}`;
      }
      else this._autoWhy = '';
      // 2) sinon, on écoute la piste Voix
      if (!r) r = await alignLyrics(this.song);
      if (r.src !== 'partition' && r.conf < 0.12) { toast(`Calage automatique pas assez sûr : règle le décalage à l’oreille${this._autoWhy ? ` (${this._autoWhy})` : ''}`, 9000); return; }
      const p = this.song.prefs, before = p.offset || 0;
      p.offset = Math.round(-r.shift * 1000);
      this.updateOptionOutputs(); this.renderBarMarks(); this.saveSong(); this.curLine = -2; this.frame(true); this.renderScoreLyrics(true); this.updateScoreBar?.();
      toast(`Paroles calées sur la ${r.src}${r.n ? ` (${r.n} lignes reconnues)` : ''} : décalage ${fmtOffset(p.offset)}${before && before !== p.offset ? ` (avant : ${fmtOffset(before)})` : ''}${r.conf < 0.3 ? ' · à vérifier' : ''}`, 7000);
    } catch (err) { console.error(err); toast(err.message || 'Calage impossible', 6000); }
    finally { this._autoBusy = false; }
  }

  /** Minutage mot à mot pris dans les paroles écrites sous les notes de la partition. */
  async autoWords() {
    if (this._autoBusy) { toast('Un calage est déjà en cours, patiente quelques secondes…'); return; }
    if (!this.scoreView) { toast('Ouvre la vue Partition d’abord'); return; }
    toast('Mot à mot : lecture des paroles de la partition…', 8000);
    this._autoBusy = true;
    try {
      const syl = this.scoreView.scoreLyrics?.() || [];
      if (!syl.length) { toast('Cette partition ne contient pas de paroles (ni sous les notes, ni en texte au-dessus)', 6000); return; }
      const { wordsFromScore } = await import('../autoalign.js?v=4.28.4');
      const s = this.song, p = s.prefs;
      const backup = JSON.stringify(s.doc.lines), offBefore = p.offset || 0;
      // le décalage actuel est intégré aux temps (les lignes absentes de la partition restent en place)
      const off = offBefore / 1000;
      if (off) for (const l of s.doc.lines) if (l.type === 'lyric' && l.s != null) { l.s -= off; if (l.e != null) l.e -= off; l.words?.forEach((w) => { w.s -= off; if (w.e != null) w.e -= off; }); }
      const r = await wordsFromScore(s, syl);
      if (!r) { s.doc.lines = JSON.parse(backup); toast(`Trop peu de mots retrouvés dans la partition (${syl.length} syllabes lues) : rien n’a été changé`, 7000); return; }
      p.offset = 0;
      await db.putSong(s);
      this._undoWords = { lines: backup, offset: offBefore };
      this.renderLyrics(); this.curLine = -2; this.frame(true); this.updateOptionOutputs(); this.renderScoreLyrics(true);
      toast(`Mot à mot : ${r.lines} lignes calées d’après la partition (${r.words} mots sur ${r.total})`, 7000);
    } catch (err) { console.error(err); toast(err.message || 'Impossible', 6000); }
    finally { this._autoBusy = false; }
  }

  /** Écoute le début du morceau et y pose la 1re note de la partition. */
  async autoScore() {
    if (this._autoBusy) { toast('Un calage est déjà en cours, patiente quelques secondes…'); return; }
    if (!this.scoreView) return;
    this._autoBusy = true;
    toast('Calage de la partition : écoute du début du morceau…', 4000);
    try {
      const { musicStart } = await import('../autoalign.js?v=4.28.4');
      const onset = await musicStart(this.song);
      const r = this.scoreView.autoStart(onset);
      if (!r) toast('Pas de note trouvée dans la partition', 5000);
      else { this.updateScoreBar(); toast(`Partition calée : la musique démarre à ${onset.toFixed(1).replace('.', ',')} s → mes. ${r.firstBar + 1}, ${fmtOffset(r.offset * 1000)}. Ajuste à l’oreille si besoin.`, 8000); }
    } catch (err) { console.error(err); toast(err.message || 'Calage impossible', 6000); }
    finally { this._autoBusy = false; }
  }

  /**
   * Grilles écrites en mesures (« | Am | F G | % | ») sans minutage : chaque mesure écrite prend,
   * dans l'ordre, une mesure de l'horloge maître à partir de la mesure de départ (réglable).
   */
  applyWrittenBars(off) {
    const s = this.song, lines = s.doc.lines.filter((l) => l.bars?.length);
    if (!lines.length) { this.writtenGrid = false; return; }
    const timed = lines.some((l) => l.chords.some((c) => c.t != null && !c.auto));
    this.writtenGrid = !timed;
    if (timed) return;
    const bars = this.masterClock().bars;
    if (!bars.length) return;
    const bpb = this.masterClock().bpb || 4;
    let k = s.clock?.gridStart ?? this.autoGridStart(lines, bars);
    for (const l of lines) {
      let ci = 0;
      l.bars.forEach((names) => {
        const a = bars[k], z = bars[k + 1] ?? (a + (this.masterClock().gap || 2));
        names.forEach((n, j) => {
          const slot = names.length === 1 ? 0 : Math.round((j * bpb) / names.length);
          const c = l.chords[ci++];
          if (c && a != null) { c.t = a + (slot * (z - a)) / bpb + off; c.auto = true; }
        });
        k++;
      });
    }
  }

  /** Mesure de départ d'une grille écrite : celle où ses accords collent le mieux aux accords entendus dans l'audio. */
  autoGridStart(lines, bars) {
    const det = this.song.detectedChords;
    if (this._gsAuto != null) return this._gsAuto;
    if (!det?.length) return (this._gsAuto = 0);
    const seq = lines.flatMap((l) => l.bars.map((b) => b[0])).slice(0, 48);
    const at = (t) => { for (const d of det) if (d.s <= t + 0.05 && t < d.e) return d.name; return null; };
    let best = 0, bestScore = -1;
    for (let st = 0; st < Math.min(40, bars.length - seq.length); st++) {
      let sc = 0;
      seq.forEach((n, i) => { const d = at(bars[st + i] + 0.1); if (d && sameChord(d, n)) sc += /m(?!aj)/.test(d) === /m(?!aj)/.test(n) ? 1 : 0.5; });
      if (sc > bestScore) { bestScore = sc; best = st; }
    }
    return (this._gsAuto = best);
  }

  /**
   * Vue des paroles avec les accords de la PARTITION (si elle en a, qu'elle est calée et que les paroles le sont) :
   * chaque accord est posé sur le mot chanté à ce moment-là ; les accords entre deux phrases forment une ligne d'accords.
   * Rien n'est enregistré : la grille d'origine reste intacte (et revient en mode Modifier).
   */
  viewDoc(off) {
    const s = this.song, sc = s.score;
    this.vdocFromScore = false;
    if (!sc?.chords?.length || sc.useChords === false || this.editing?.on) return s.doc;
    const lines = s.doc.lines.map((l) => ({ ...l, chords: l.type === 'lyric' ? [] : l.chords }));
    const lyr = []; lines.forEach((l, i) => { if (l.type === 'lyric' && l.s != null) lyr.push(i); });
    if (lyr.length < 2) return s.doc;
    // les lignes d'accords seules (intro, solo) sont remplacées par celles de la partition
    for (let i = lines.length - 1; i >= 0; i--) if (lines[i].type === 'chords') lines.splice(i, 1);
    const L = []; lines.forEach((l, i) => { if (l.type === 'lyric' && l.s != null) L.push(i); });
    const endOf = (k) => { const l = lines[L[k]]; const we = l.words?.length ? (l.words[l.words.length - 1].e ?? l.words[l.words.length - 1].s + 0.5) : (l.e ?? l.s + 3); return Math.min(we + 0.6, lines[L[k + 1]]?.s ?? Infinity); };
    const gaps = new Map(); // index de ligne de paroles → accords joués juste avant
    for (const c0 of sc.chords) {
      const t = c0.t + off;
      let k = -1; for (let j = 0; j < L.length; j++) if (lines[L[j]].s - 0.35 <= t) k = j; else break;
      if (k < 0 || t > endOf(k)) { const nk = k + 1; if (!gaps.has(nk)) gaps.set(nk, []); gaps.get(nk).push({ name: c0.name, t, fixed: true }); continue; }
      const l = lines[L[k]], toks = tokenize(l.text);
      let pos = 0;
      if (l.words?.length === toks.length) { let w = 0; for (let i = 0; i < toks.length; i++) if (l.words[i].s - 0.12 <= t) w = i; pos = toks[w].start; }
      else { const f = Math.max(0, Math.min(1, (t - l.s) / Math.max(0.5, (l.e ?? l.s + 3) - l.s))); pos = Math.round(f * l.text.length); }
      const ch = l.chords, last = ch[ch.length - 1];
      if (last && last.pos >= pos) { if (last.t + 0.25 > t) { last.name = c0.name; continue; } pos = Math.min(l.text.length, last.pos + 1); }
      ch.push({ pos, name: c0.name, t, fixed: true });
    }
    // lignes d'accords entre les phrases (après le titre de partie s'il y en a un)
    [...gaps.keys()].sort((a, b) => b - a).forEach((k) => {
      const cs = gaps.get(k);
      let at = k < L.length ? L[k] : lines.length;
      // partie restée vide (ex. « Intro » dont on a retiré les accords écrits) juste avant : les accords y vont
      let j = at - 1; while (j >= 0 && lines[j].type === 'blank') j--;
      if (j >= 0 && lines[j].type === 'section') {
        let h = j - 1; while (h >= 0 && lines[h].type === 'blank') h--;
        if (h >= 0 && lines[h].type === 'section') at = h + 1;
      }
      lines.splice(at, 0, { type: 'chords', text: '', chords: cs.map((c, i) => ({ ...c, pos: i })) });
    });
    this.vdocFromScore = true;
    return { ...s.doc, lines };
  }

  /** Relève les accords de la partition (après chaque calage) et les garde avec le morceau. */
  takeScoreChords() {
    const sc = this.song.score;
    if (!sc || !this.scoreView) return;
    const ch = this.scoreView.scoreChords?.() || [];
    const bars = (this.scoreView._downs || []).map((d) => Math.round((d + (this.scoreView._off || 0)) * 1000) / 1000);
    const bpb = this.scoreView.score?.masterBars?.[0]?.timeSignatureNumerator || 4;
    const sig = JSON.stringify([ch, bars, bpb]);
    if (sig === JSON.stringify([sc.chords || [], sc.bars || [], sc.bpb || 4])) return;
    sc.chords = ch; sc.bars = bars; sc.bpb = bpb;
    this.applyClock();
    this.saveSong();
    if (sc.useChords !== false) { this.renderLyrics(); this.lastChordIdx = -2; this.frame(true); }
    if (ch.length && !this._scChordToast) { this._scChordToast = true; toast(`Accords pris dans la partition (${ch.length} changements) : leur moment suit la tablature`, 5000); }
  }

  /** Bandeau de paroles (ligne en cours + suivante, avec accords) au-dessus de la partition. */
  renderScoreLyrics(force = false, idx) {
    const wrap = this.el.querySelector('.sc-lyrics');
    if (!wrap) return;
    this.initBandGrip();
    const on = !!this.song.score?.showLyrics, hud = this.hudOn();
    wrap.hidden = !on && !hud;
    const box = wrap.querySelector('.scl-body');
    box.hidden = !on;
    if (!on) return;
    if (!this.synced) { box.innerHTML = '<p class="note">Paroles non calées sur l’audio : lance « Tout préparer » ou importe un .lrc pour les voir défiler ici.</p>'; return; }
    const tl = this.timedLines || [];
    let i = idx;
    if (i == null || force) {
      const t = this.t; i = -1;
      for (let k = 0; k < tl.length; k++) { if (tl[k].s <= t + 0.05) i = k; else break; }
    }
    const pick = (k) => { const ln = tl[k] && this.lineEls.get(tl[k].li); return ln ? ln.outerHTML : ''; };
    const cur = i >= 0 ? pick(i) : '';
    const next = pick(i + 1);
    box.innerHTML = `<div class="scl-cur">${cur || '<p class="ln note">…</p>'}</div><div class="scl-next">${next}</div>`;
    box.querySelectorAll('.cur,.past,.sung,.singing,.now').forEach((e) => e.classList.remove('cur', 'past', 'sung', 'singing', 'now'));
    this.markScoreChord(this.timeline?.[this.lastChordIdx]);
    this.layoutHud();
  }

  /** Poignée du bas du bandeau : glisser vers le bas / le haut agrandit / réduit accord et paroles. */
  initBandGrip() {
    const band = this.el.querySelector('.sc-lyrics');
    if (!band) return;
    const grip = band.querySelector('.sc-grip');
    if (grip && !grip.dataset.on) {
      grip.dataset.on = '1';
      band.style.setProperty('--bz', this.prefsCache?.scBandZoom || 1);
      grip.addEventListener('pointerdown', (e) => {
        e.preventDefault(); e.stopPropagation(); grip.setPointerCapture(e.pointerId); grip.classList.add('on'); document.body.classList.add('noselect');
        const y0 = e.clientY, z0 = this.prefsCache?.scBandZoom || 1;
        const mv = (ev) => {
          const z = Math.max(0.6, Math.min(3, Math.round(z0 * (1 + (ev.clientY - y0) / 160) * 100) / 100));
          (this.prefsCache ||= {}).scBandZoom = z; band.style.setProperty('--bz', z); this.layoutHud();
        };
        const up = () => { grip.classList.remove('on'); document.body.classList.remove('noselect'); grip.removeEventListener('pointermove', mv); grip.removeEventListener('pointerup', up); grip.removeEventListener('pointercancel', up); this.app.setPref('scBandZoom', this.prefsCache.scBandZoom); };
        grip.addEventListener('pointermove', mv); grip.addEventListener('pointerup', up); grip.addEventListener('pointercancel', up);
      });
      grip.addEventListener('dblclick', () => { (this.prefsCache ||= {}).scBandZoom = 1; band.style.setProperty('--bz', 1); this.app.setPref('scBandZoom', 1); this.layoutHud(); });
    }
  }

  /** Accord du bandeau : déplaçable à gauche ou à droite des paroles, sans jamais les recouvrir. */
  layoutHud(dragX) {
    const band = this.el.querySelector('.sc-lyrics'), hud = band?.querySelector('.hud');
    if (!hud || band.hidden || !hud.offsetWidth) return;
    if (!hud.dataset.drag) {
      hud.dataset.drag = '1';
      hud.addEventListener('pointerdown', (e) => {
        e.preventDefault(); hud.setPointerCapture(e.pointerId); hud.classList.add('drag');
        const dx = e.clientX - hud.getBoundingClientRect().left;
        const mv = (ev) => this.layoutHud(ev.clientX - band.getBoundingClientRect().left - dx);
        const up = () => { hud.classList.remove('drag'); hud.removeEventListener('pointermove', mv); hud.removeEventListener('pointerup', up); hud.removeEventListener('pointercancel', up); this.app.setPref('hudPos', this.prefsCache.hudPos); };
        hud.addEventListener('pointermove', mv); hud.addEventListener('pointerup', up); hud.addEventListener('pointercancel', up);
      });
      if (window.ResizeObserver) new ResizeObserver(() => this.layoutHud()).observe(band);
    }
    const W = band.clientWidth, w = hud.offsetWidth, br = band.getBoundingClientRect();
    let L = W / 2, R = W / 2;
    band.querySelectorAll('.scl-body .ln').forEach((ln) => { const r = ln.getBoundingClientRect(); if (r.width) { L = Math.min(L, r.left - br.left); R = Math.max(R, r.right - br.left); } });
    const zones = { left: [8, L - w - 16], right: [R + 16, W - w - 8] };
    const pos = (this.prefsCache ||= {}).hudPos || { side: 'left', f: 0 };
    if (dragX != null) {
      const side = dragX + w / 2 < W / 2 ? 'left' : 'right', [a, b] = zones[side];
      pos.side = side; pos.f = b > a ? Math.max(0, Math.min(1, (dragX - a) / (b - a))) : side === 'left' ? 0 : 1;
      this.prefsCache.hudPos = pos;
    }
    const [a, b] = zones[pos.side] || zones.left;
    const x = b >= a ? a + pos.f * (b - a) : (pos.side === 'right' ? W - w - 8 : 8);
    hud.style.left = `${Math.round(x)}px`;
  }

  applyHud() {
    this._hudKey = null;
    this.el.classList.toggle('hud-off', !this.hudOn());
    const c = this.timeline?.[this.lastChordIdx];
    this.lastChordIdx = -2; this.frame(true);
  }

  applyRail() {
    const off = !!this.prefsCache?.railOff;
    this.el.classList.toggle('rail-off', off);
    this.el.querySelector('.rail-open').hidden = !off;
  }

  hudOn() { return this.prefsCache?.hud !== false; }

  markScoreChord(c) {
    const box = this.el.querySelector('.sc-lyrics');
    if (!box || box.hidden) return;
    box.querySelectorAll('.now').forEach((e) => e.classList.remove('now'));
    if (!c) return;
    const src = this.chordEls.get(`${c.li}|${c.ci}`);
    const line = src?.closest('.ln[data-li]');
    if (!line) return;
    const all = [...line.querySelectorAll('.c')], k = all.indexOf(src);
    const copy = box.querySelector(`.scl-cur .ln[data-li="${line.dataset.li}"]`);
    copy?.querySelectorAll('.c')[k]?.classList.add('now');
  }

  updateScoreBar() {
    const sc = this.song.score;
    if (!sc) return;
    const v = this.el.querySelector('.score-view');
    v.querySelectorAll('[data-sc^="layout:"]').forEach((b) => b.classList.toggle('on', b.dataset.sc === `layout:${sc.layout || 'both'}`));
    const s = sc.sync || {};
    v.querySelector('.score-bar').classList.toggle('min', !!this.prefsCache?.scoreBarMin);
    const hb = v.querySelector('.sc-hud-btn'); hb.classList.toggle('on', this.hudOn()); hb.setAttribute('aria-pressed', String(this.hudOn()));
    const lb = v.querySelector('.sc-lyr-btn');
    lb.classList.toggle('on', !!sc.showLyrics); lb.setAttribute('aria-pressed', String(!!sc.showLyrics));
    v.querySelector('.sc-loff').hidden = !sc.showLyrics;
    v.querySelector('[data-r="sc-loff"]').textContent = fmtOffset(this.song.prefs.offset);
    v.querySelector('[data-r="sc-bar"]').textContent = `mes. ${(s.firstBar || 0) + 1}`;
    v.querySelector('[data-r="sc-off"]').textContent = `${(s.offset || 0) >= 0 ? '+' : '−'}${Math.abs(s.offset || 0).toFixed(2).replace('.', ',')} s`;
  }

  // ---------- Impro : notes qui vont avec le morceau ----------
  improKey() {
    const p = this.song.prefs;
    const own = parseKey(p.improKey);
    if (own) return own;
    return this.display.soundingKey || songKey(this.song) || { pc: 0, minor: false };
  }

  toggleImpro(force) {
    this.improOn = force ?? !this.improOn;
    const panel = this.el.querySelector('.impro-panel');
    panel.hidden = !this.improOn;
    this.el.classList.toggle('has-impro', this.improOn);
    this.el.querySelectorAll('[data-act="impro"]').forEach((b) => b.classList.toggle('on', this.improOn));
    if (this.improOn) {
      if (!this._improBound) {
        this._improBound = true;
        panel.addEventListener('click', (e) => {
          const t = e.target.closest('[data-im]');
          if (!t) return;
          const k = t.dataset.im;
          const o = this.improOpts;
          if (k === 'close') { this.toggleImpro(false); return; }
          if (k in o && typeof o[k] === 'boolean') o[k] = !o[k];
          if (k === 'names') o.names = o.names === 'notes' ? 'degrees' : 'notes';
          if (k.startsWith('inst:')) { this.setInstrument(k.slice(5)); }
          this.app.setPref('impro', o);
          this.renderImpro();
        });
        panel.addEventListener('change', (e) => {
          if (e.target.matches('[data-im-key]')) {
            this.song.prefs.improKey = e.target.value || null;
            this.saveSong();
            this.renderImpro();
          }
        });
      }
      this._improChord = this.timeline?.[this.lastChordIdx]?.name ?? null;
      this.renderImpro();
    }
  }

  get improOpts() {
    if (!this._improOpts) this._improOpts = { penta: true, scale: true, current: true, blues: false, names: 'notes', ...(this.prefsSnap?.impro || {}) };
    return this._improOpts;
  }

  renderImpro() {
    const panel = this.el?.querySelector('.impro-panel');
    if (!panel || panel.hidden) return;
    const o = this.improOpts;
    const key = this.improKey();
    const p = this.song.prefs;
    const chord = this._improChord ? this.soundingName(this._improChord) : null;
    const L = improLayers(key, chord, o);
    const inst = this.instrument;
    const S = SCALES[key.minor ? 'minor' : 'major'];
    const auto = !parseKey(p.improKey);
    const keyOpts = ALL_KEYS.map((k) => { const v = pcName(k.pc, k) + (k.minor ? 'm' : ''); return `<option value="${v}" ${!auto && k.pc === key.pc && k.minor === key.minor ? 'selected' : ''}>${keyLabelFr(k)}</option>`; }).join('');
    const chip = (k, label, on, cls = '') => `<button type="button" class="im-chip ${cls} ${on ? 'on' : ''}" data-im="${k}">${label}</button>`;
    const board = inst === 'piano' ? keysSvg(L, key, { names: o.names }) : neckSvg(L, key, { instrument: inst, capo: p.capo || 0, names: o.names });
    panel.innerHTML = `
      <div class="im-head">
        <b>Impro</b>
        <label class="im-key">Tonalité <select data-im-key><option value="" ${auto ? 'selected' : ''}>${esc(keyLabelFr(this.display.soundingKey || songKey(this.song) || key))} (auto)</option>${keyOpts}</select></label>
        <span class="im-now">${chord ? `Accord : <b>${esc(this.display(this._improChord))}</b>` : ''}</span>
        <span class="im-sp"></span>
        <span class="seg im-inst">${['guitar', 'ukulele', 'piano'].map((i) => `<button type="button" data-im="inst:${i}" class="${inst === i ? 'on' : ''}">${{ guitar: 'Guitare', ukulele: 'Ukulélé', piano: 'Piano' }[i]}</button>`).join('')}</span>
        <button type="button" class="icon-btn im-x" data-im="close" aria-label="Fermer l’impro">✕</button>
      </div>
      <div class="im-legend">
        ${chip('current', '<i class="sw chord"></i>Accord en cours', o.current)}
        ${chip('penta', '<i class="sw penta"></i>Toujours bonnes <small>(pentatonique)</small>', o.penta)}
        ${chip('scale', `<i class="sw scale"></i>Reste de la gamme ${S.label}`, o.scale)}
        ${chip('blues', '<i class="sw blues"></i>Note blues', o.blues)}
        ${chip('names', o.names === 'notes' ? 'Noms : notes' : 'Noms : degrés', true, 'plain')}
      </div>
      <div class="im-board">${board}</div>`;
  }

  // ---------- Enregistrer sa prise ----------
  takeDialog() {
    if (!this.engine.tracks?.length) { toast('Ajoute d’abord l’audio du morceau'); return; }
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === 'undefined') { toast('Enregistrement impossible dans ce navigateur', 5000); return; }
    const s = this.song;
    const hasVoice = s.stems.some((st) => st.kind === 'vocals' || st.kind === 'backing');
    const pos = this.engine.currentTime;
    const takes = s.stems.filter((st) => st.kind === 'take');
    const d = dialog(`<form method="dialog" class="take-dlg">
      <h2>Enregistrer ma prise</h2>
      <p>Chante ou joue par-dessus le morceau : ta prise devient une piste du mixage, calée sur la chanson.</p>
      <p class="take-tip">🎧 Mets un <b>casque</b> : sans casque, le micro reprend aussi le morceau.</p>
      ${hasVoice ? `<label class="check"><input type="checkbox" name="novoice" checked> Couper la voix d’origine pendant la prise</label>` : ''}
      ${takes.length ? `<label class="check"><input type="checkbox" name="mutetakes" checked> Couper mes prises précédentes</label>` : ''}
      <div class="take-from"><label><input type="radio" name="from" value="start" ${pos < 2 ? 'checked' : ''}> Depuis le début</label><label><input type="radio" name="from" value="here" ${pos >= 2 ? 'checked' : ''}> Depuis ${fmtTime(pos)}</label></div>
      <p class="note">Pause, ou le bouton ● rouge, pour arrêter.</p>
      <div class="actions"><button class="btn ghost" data-close="">Annuler</button><button class="btn primary rec-go" data-close="go">● Enregistrer</button></div></form>`);
    const form = d.el.querySelector('form');
    d.done.then((v) => {
      if (v !== 'go') return;
      const fd = new FormData(form);
      this.startTake({ noVoice: !!fd.get('novoice'), muteTakes: !!fd.get('mutetakes'), from: fd.get('from') || 'here' });
    });
  }

  async startTake(opts) {
    const rec = new TakeRecorder(this.engine, { micId: (await this.app.prefs())?.micId || null });
    try { await rec.open(); } catch (err) {
      rec.cancel();
      toast(err.name === 'NotAllowedError' ? 'Micro refusé : autorise-le pour MusiMix (icône à gauche de l’adresse)' : `Micro inaccessible : ${err.message}`, 6000);
      return;
    }
    const s = this.song;
    const restore = { rate: s.prefs.rate || 1 };
    for (const st of s.stems) {
      if ((opts.noVoice && (st.kind === 'vocals' || st.kind === 'backing')) || (opts.muteTakes && st.kind === 'take')) this.engine.setTrack(st.id, { mute: true });
    }
    if (this.engine.loop) { this.engine.setLoop(null, null); this.loopA = null; this.renderLoop?.(); }
    if (restore.rate !== 1) { this.engine.setRate(1); toast('Vitesse remise à 100 % pour la prise'); }
    if (opts.from === 'start') this.engine.seek(0);
    this.take = { rec, restore, live: false };
    this.el.classList.add('recording');
    const badge = document.createElement('div');
    badge.className = 'rec-badge';
    badge.innerHTML = '<i></i><b>REC</b><span data-r="rec-t">0:00</span><span class="rec-meter"><span></span></span>';
    this.el.appendChild(badge);
    this.take.timer = setInterval(() => {
      badge.querySelector('[data-r="rec-t"]').textContent = fmtTime(rec.elapsed);
      badge.querySelector('.rec-meter span').style.width = `${Math.min(100, rec.level * 140)}%`;
    }, 80);
    rec.start();
    await this.engine.play();
    if (this.take) this.take.live = true;
  }

  endTakeUi() {
    clearInterval(this.take?.timer);
    this.el?.classList.remove('recording');
    this.el?.querySelector('.rec-badge')?.remove();
  }

  async stopTake() {
    const t = this.take;
    if (!t || t.stopping) return;
    t.stopping = true;
    t.live = false;
    if (this.engine.playing) this.engine.pause();
    this.endTakeUi();
    const s = this.song;
    const res = await t.rec.stop(s.duration || this.engine.duration);
    // remet le mixage et la vitesse
    for (const st of s.stems) { const m = s.mix[st.id] || {}; this.engine.setTrack(st.id, { mute: !!m.mute, solo: !!m.solo, vol: m.vol ?? 1 }); }
    if (t.restore.rate !== 1) this.engine.setRate(t.restore.rate);
    this.take = null;
    if (!res || res.end - res.start < 1) { toast('Prise trop courte : rien n’a été gardé'); return; }
    const lv = levelOf([res.channel]);
    const quiet = lv.peak < 0.02;
    const d = dialog(`<div class="dlg"><h2>Prise enregistrée</h2>
      <p>De ${fmtTime(res.start)} à ${fmtTime(res.end)}.${quiet ? ' <b>Le niveau est très faible</b> : vérifie le micro choisi par le navigateur ou rapproche-toi.' : ''}</p>
      <div class="actions"><button class="btn ghost" data-close="">Jeter</button><button class="btn primary" data-close="keep">Garder dans le mixage</button></div></div>`);
    if ((await d.done) !== 'keep') { toast('Prise jetée'); return; }
    toast('Enregistrement de la piste…');
    try { await this.saveTake(res, lv); } catch (err) { toast(`Échec : ${err.message}`, 6000); }
  }

  async saveTake(res, level) {
    const s = this.song;
    let blob, name;
    if (opusSupported()) { blob = await encodeOpus([res.channel], res.sampleRate, { bitrate: 96000 }); name = 'ma-prise.ogg'; }
    else { blob = encodeWav([res.channel], res.sampleRate, 16); blob = blob instanceof Blob ? blob : new Blob([blob], { type: 'audio/wav' }); name = 'ma-prise.wav'; }
    const blobId = await db.putBlob(blob);
    const n = s.stems.filter((st) => st.kind === 'take').length;
    const id = uid();
    s.stems.push({ id, kind: 'take', label: n ? `Ma prise ${n + 1}` : 'Ma prise', blobId, name, mime: blob.type, size: blob.size, level, take: { at: Date.now(), from: res.start, to: res.end } });
    s.stems = sortStems(s.stems);
    s.mix[id] = { vol: 1, mute: false, solo: false, pan: 0 };
    // les prises précédentes laissent la place à la nouvelle
    for (const st of s.stems) if (st.kind === 'take' && st.id !== id) s.mix[st.id] = { ...(s.mix[st.id] || {}), mute: true };
    await db.putSong(s);
    const pos = this.engine.currentTime;
    await this.loadAudio();
    this.engine.seek(pos);
    this.renderMixer();
    toast('Ta prise est dans le mixage. « Sans la voix » pour l’écouter à la place du chant d’origine.', 6000);
  }

  // ---------- Zoom R20 (surface Mackie Control) ----------
  async r20Start(user = false) {
    surface.port = (await this.app.prefs())?.r20Port || null;
    try { await surface.enable(); } catch (err) {
      if (user) toast(err.message || 'Accès MIDI refusé', 6000);
      this.r20On = false; if (user) this.app.setPref('r20', false); this.updateR20Ui(); return;
    }
    midi.skipSurface = true;
    midi.surfacePort = surface.port;
    if (midi.access) midi._bind();
    if (!this._r20H) {
      this._r20H = {
        fader: (e) => this.r20Fader(e.detail.ch, e.detail.v),
        button: (e) => this.r20Button(e.detail.note),
        devices: () => { this.updateR20Ui(); this.r20Leds(); },
      };
      for (const [k, f] of Object.entries(this._r20H)) surface.addEventListener(k, f);
    }
    this.updateR20Ui();
    this.r20Leds();
    if (user) toast(surface.devices.length ? `Zoom R20 relié : faders 1 à 8 = pistes du mixage, dernier = Général` : 'R20 non détecté : branche-le en USB, mode interface audio + Control Surface (Mackie)', 6000);
  }

  r20Stop(ui = true) {
    if (this._r20H) for (const [k, f] of Object.entries(this._r20H)) surface.removeEventListener(k, f);
    this._r20H = null;
    surface.disable();
    midi.skipSurface = false;
    if (midi.access) midi._bind();
    if (ui) this.updateR20Ui();
  }

  updateR20Ui() {
    if (!this.el) return;
    const st = !surface.supported ? 'pas disponible sur ce navigateur (Chrome ou Edge sur le PC)'
      : !this.r20On ? 'lecture, arrêt et volumes des pistes depuis le R20'
      : surface.devices.length ? `🎚️ ${surface.devices.join(', ')}` : 'R20 non détecté : USB + mode Control Surface';
    this.el.querySelectorAll('[data-r="r20-st"]').forEach((x) => { x.textContent = st; });
    this.el.querySelectorAll('[data-act="r20"]').forEach((x) => { x.checked = this.r20On; });
  }

  /** Pistes pilotées par les faders 1–8 (pistes visibles du mixage, par banque de 8). */
  r20Strips() { return (this._mixStems || this.song.stems).slice(this.r20Bank * 8, this.r20Bank * 8 + 8); }

  r20Fader(ch, x) {
    let v = Math.max(0, Math.min(1.5, x * 1.5));
    if (Math.abs(v - 1) < 0.04) v = 1;
    if (ch === 8) { this.song.master = v; this.engine.setMaster(v); }
    else {
      const st = this.r20Strips()[ch];
      if (!st) return;
      this.song.mix[st.id] = { ...(this.song.mix[st.id] || {}), vol: v };
      this.engine.setTrack(st.id, { vol: v });
    }
    if (!this._r20Raf) this._r20Raf = requestAnimationFrame(() => { this._r20Raf = 0; this.updateStrips(); });
    this.saveSong();
  }

  r20Button(n) {
    const e = this.engine;
    if (n === MCU.PLAY) { if (!e.playing) e.play(); }
    else if (n === MCU.STOP) { if (e.playing) e.pause(); else e.seek(0); }
    else if (n === MCU.REW) e.seek(Math.max(0, e.currentTime - 5));
    else if (n === MCU.FF) e.seek(Math.min(e.duration || 1e9, e.currentTime + 5));
    else if (n === MCU.REC) { if (this.take) this.stopTake(); else this.startTake({ noVoice: true, muteTakes: true, from: 'here' }); }
    else if (n === MCU.BANK_L || n === MCU.BANK_R) {
      const max = Math.max(0, Math.ceil((this._mixStems || []).length / 8) - 1);
      this.r20Bank = Math.max(0, Math.min(max, this.r20Bank + (n === MCU.BANK_R ? 1 : -1)));
      toast(`R20 : pistes ${this.r20Bank * 8 + 1} à ${this.r20Bank * 8 + 8}`);
    } else if (n >= MCU.MUTE && n < MCU.MUTE + 8) { const st = this.r20Strips()[n - MCU.MUTE]; if (st) this.toggleMix(st.id, 'mute'); }
    else if (n >= MCU.SOLO && n < MCU.SOLO + 8) { const st = this.r20Strips()[n - MCU.SOLO]; if (st) this.toggleMix(st.id, 'solo'); }
    this.r20Leds();
  }

  r20Leds() {
    if (!this.r20On || !surface.outs.length) return;
    surface.led(MCU.PLAY, this.engine.playing);
    surface.led(MCU.STOP, !this.engine.playing);
    surface.led(MCU.REC, !!this.take);
    this.r20Strips().forEach((st, i) => { const m = this.song.mix[st.id] || {}; surface.led(MCU.MUTE + i, !!m.mute); surface.led(MCU.SOLO + i, !!m.solo); });
  }

  // ---------- Clavier MIDI ----------
  async midiStart(user = false) {
    try { await midi.enable(); } catch (err) {
      if (user) toast(err.message || 'Accès MIDI refusé', 6000);
      this.midiOn = false; if (user) this.app.setPref('midi', false); this.updateMidiUi(); return;
    }
    if (!this._midiH) {
      this._midiH = {
        notes: (e) => this.onMidiNotes(e.detail.notes),
        advance: () => this.midiAdvance(),
        devices: () => this.updateMidiUi(),
        learned: (e) => { this.app.setPref('midiKey', e.detail); toast(`Touche ${noteName(e.detail)} : avance d’un accord`); this.updateMidiUi(); },
      };
      for (const [k, f] of Object.entries(this._midiH)) midi.addEventListener(k, f);
    }
    this.updateMidiUi();
    if (user) toast(midi.devices.length ? `Clavier détecté : ${midi.devices.join(', ')}` : 'Branche ton clavier en USB : il sera détecté tout seul', 4000);
  }

  midiStop(ui = true) {
    if (this._midiH) for (const [k, f] of Object.entries(this._midiH)) midi.removeEventListener(k, f);
    this._midiH = null;
    midi.disable();
    this.el?.querySelector('.midi-chip')?.remove();
    if (ui) this.updateMidiUi();
  }

  updateMidiUi() {
    if (!this.el) return;
    const st = !midi.supported ? 'pas disponible sur ce navigateur (Chrome ou Edge requis)'
      : !this.midiOn ? 'suivre les accords et avancer à la pédale'
      : midi.devices.length ? `🎹 ${midi.devices.join(', ')}` : 'aucun clavier détecté : branche-le en USB';
    this.el.querySelectorAll('[data-r="midi-st"]').forEach((x) => { x.textContent = st; });
    const key = midi.advanceNote != null ? ` ou la touche ${noteName(midi.advanceNote)}` : '';
    this.el.querySelectorAll('[data-r="midi-key"]').forEach((x) => { x.textContent = `pédale de sustain${key}`; });
    this.el.querySelectorAll('[data-act="midi-learn"]').forEach((x) => {
      x.textContent = midi.advanceNote != null ? 'Retirer la touche' : 'Choisir une touche';
      if (midi.advanceNote != null) x.dataset.clear = '1'; else delete x.dataset.clear;
    });
    this.el.querySelectorAll('[data-act="midi"]').forEach((x) => { x.checked = this.midiOn; });
    this.el.querySelectorAll('.midi-opts').forEach((x) => { x.hidden = !this.midiOn; });
  }

  /** Accord suivant (ayant un temps) après l'accord courant. */
  nextTimedChord() {
    const tl = this.timeline || [];
    for (let j = Math.max(0, this.lastChordIdx + 1); j < tl.length; j++) if (tl[j].t != null && tl[j].t > this.engine.currentTime + 0.05) return tl[j];
    return null;
  }

  soundingName(name) {
    const tr = this.song.prefs.transpose || 0;
    return tr ? transposeChord(name, tr) : name;
  }

  onMidiNotes(notes) {
    let chip = this.el.querySelector('.midi-chip');
    if (!notes.length) { chip?.classList.add('fade'); return; }
    if (!chip) { chip = document.createElement('div'); chip.className = 'midi-chip'; this.el.appendChild(chip); }
    chip.classList.remove('fade', 'ok');
    const name = nameChord(notes);
    chip.innerHTML = `<span>🎹</span><b>${esc(name || notes.map(noteName).join(' '))}</b>`;
    if (!this.midiFollow || notes.length < 2 || !this.hasTimedChords) return;
    const tl = this.timeline;
    if (this.engine.playing) {
      const cur = tl[this.lastChordIdx];
      if (cur && matchesChord(notes, this.soundingName(cur.name))) chip.classList.add('ok');
      return;
    }
    const cur = tl[this.lastChordIdx];
    if (cur && matchesChord(notes, this.soundingName(cur.name))) { chip.classList.add('ok'); return; }
    const nx = this.nextTimedChord();
    if (nx && matchesChord(notes, this.soundingName(nx.name))) {
      chip.classList.add('ok');
      this.seekChord(nx.t);
    }
  }

  midiAdvance() {
    if (!this.hasTimedChords) { toast('Synchronise d’abord les accords (Tout préparer ou Studio)'); return; }
    const nx = this.nextTimedChord();
    if (nx) this.seekChord(nx.t);
  }

  seekChord(t) {
    this.engine.seek(Math.max(0, t + 0.02));
    this.lastChordIdx = -2;
    this.frame(true);
  }

  isNarrow() {
    return window.matchMedia('(max-width: 860px)').matches;
  }

  /** Fiche d'un accord : diagramme guitare / ukulélé / piano, positions, notes, tous les accords du morceau. */
  openChordSheet(name, t = null, at = null) {
    if (!name) return;
    const all = uniqueChords(this.vdoc || this.song.doc, this.display, this.song.detectedChords);
    let cur = name;
    const d = dialog(`<div class="dlg chord-sheet">
      <div class="cs-head"><b class="cs-name"></b>
        <span class="seg" role="tablist" aria-label="Instrument"><button data-i="guitar">Guitare</button><button data-i="ukulele">Ukulélé</button><button data-i="piano">Piano</button></span></div>
      <div class="cs-diag" role="button" tabindex="0"></div>
      <div class="cs-alt"></div>
      <div class="cs-notes"></div>
      ${all.length > 1 ? `<div class="cs-all" aria-label="Accords du morceau">${all.map((n) => `<button data-n="${esc(n)}">${esc(n)}</button>`).join('')}</div>` : ''}
      <div class="actions">${at ? `<button class="btn ghost" data-edit>${icon('edit')} Modifier</button>` : ''}${t != null ? `<button class="btn" data-go>${icon('play')} Jouer d’ici</button>` : ''}<button class="btn primary" data-close="">Fermer</button></div></div>`);
    const el = d.el;
    const draw = () => {
      const inst = this.instrument;
      const nv = inst === 'piano' ? 0 : voicings(cur, inst).length;
      const idx = this.voicingIdx[cur] || 0;
      el.querySelector('.cs-name').textContent = cur;
      el.querySelectorAll('[data-i]').forEach((b) => b.classList.toggle('on', b.dataset.i === inst));
      el.querySelector('.cs-diag').innerHTML = diagramSVG(cur, inst, { index: idx }) || '<p class="note">Pas de diagramme pour cet accord.</p>';
      el.querySelector('.cs-alt').textContent = nv > 1 ? `Position ${idx % nv + 1}/${nv} · touche le diagramme pour changer` : '';
      const f = chordFormula(cur);
      el.querySelector('.cs-notes').textContent = f ? 'Notes : ' + f.notes.join(' · ') + (f.bass ? ` · basse ${f.bass}` : '') : '';
      el.querySelectorAll('[data-n]').forEach((b) => b.classList.toggle('on', b.dataset.n === cur));
    };
    el.addEventListener('click', (e) => {
      const ib = e.target.closest('[data-i]');
      if (ib) { this.setInstrument(ib.dataset.i); draw(); return; }
      const nb = e.target.closest('[data-n]');
      if (nb) { cur = nb.dataset.n; draw(); return; }
      if (e.target.closest('.cs-diag')) { this.voicingIdx[cur] = (this.voicingIdx[cur] || 0) + 1; this._diagKey = null; draw(); return; }
      if (e.target.closest('[data-go]')) { this.seekChord(t); d.close(); }
      if (e.target.closest('[data-edit]')) { d.close(); this.editing.chordDialog(at.li, at.ci); }
    });
    loadChordDb().then(draw, draw);
    draw();
  }

  /** Sans accords datés : tous les accords du morceau, en diagrammes. */
  showAllChords() {
    const names = uniqueChords(this.vdoc || this.song.doc, this.display, this.song.detectedChords);
    const sec = this.el.querySelector('[data-r="chords-sec"]');
    sec.querySelector('.now-next').hidden = true;
    this.el.querySelector('[data-r="formula"]').textContent = names.length ? 'Les accords se suivront en direct une fois le morceau synchronisé (Studio ou Éditer → Synchro).' : '';
    const dg = this.el.querySelector('[data-r="diagram"]');
    dg.style.flexWrap = 'wrap';
    dg.innerHTML = names.map((n) => `<figure style="margin:0;display:grid;justify-items:center;gap:2px"><figcaption style="font-weight:800;color:var(--chord)">${esc(n)}</figcaption>${diagramSVG(n, this.instrument).replace('class="fretboard"', 'class="fretboard" style="width:78px"').replace('class="piano"', 'class="piano" style="width:130px"')}</figure>`).join('');
    this.el.querySelector('.mob-chord').hidden = true;
  }

  syncGrid(t) {
    if (!this.bars?.length) return;
    let lo = 0, hi = this.bars.length - 1, i = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (this.bars[m].a <= t + 0.03) { i = m; lo = m + 1; } else hi = m - 1; }
    if (i >= 0 && t > this.bars[i].z + 0.05) i = -1; // trou (mesures vides non affichées)
    if (i === this.curBar) return;
    const old = this.barEls?.[this.curBar];
    old?.classList.remove('cur'); old?.parentElement?.classList.remove('cur');
    this.curBar = i;
    const b = this.barEls?.[i];
    if (b) {
      b.classList.add('cur'); b.parentElement.classList.add('cur');
      const G = this.$grid;
      const target = b.offsetTop - G.clientHeight * 0.3;
      if (Math.abs(G.scrollTop - target) > 40) G.scrollTo({ top: target, behavior: 'smooth' });
    }
  }

  renderLoop() {
    const L = this.engine.loop;
    const el = this.$track.querySelector('.loop');
    const btn = this.el.querySelector('[data-act="loop"]');
    const dur = this.song.duration || this.engine.duration || 1;
    if (L) {
      el.hidden = false;
      el.style.left = (L.a / dur) * 100 + '%';
      el.style.width = ((L.b - L.a) / dur) * 100 + '%';
      btn.classList.add('changed');
      btn.title = `Boucle ${fmtTime(L.a)} → ${fmtTime(L.b)} (L pour arrêter)`;
    } else if (this.loopA != null) {
      el.hidden = false;
      el.style.left = (this.loopA / dur) * 100 + '%';
      el.style.width = '2px';
      btn.classList.add('changed');
    } else {
      el.hidden = true;
      btn.classList.remove('changed');
      btn.title = 'Boucle A-B (L)';
    }
  }

  toggleLoop() {
    const t = this.engine.currentTime;
    if (this.engine.loop) { this.engine.setLoop(null, null); this.loopA = null; toast('Boucle arrêtée'); }
    else if (this.loopA == null) { this.loopA = t; this.renderLoop(); toast('Début de boucle posé. Appuie encore pour la fin.'); }
    else {
      const a = Math.min(this.loopA, t), b = Math.max(this.loopA, t);
      this.loopA = null;
      if (b - a < 0.5) { toast('Boucle trop courte'); this.renderLoop(); return; }
      this.engine.setLoop(a, b);
      toast(`Boucle ${fmtTime(a)} → ${fmtTime(b)}`);
      if (!this.engine.playing) this.engine.seek(a);
    }
    this.renderLoop();
  }

  loopSection(sec) {
    const i = this.sections.indexOf(sec);
    const end = this.sections[i + 1]?.t ?? (this.song.duration || this.engine.duration);
    this.loopA = null;
    this.engine.setLoop(sec.t, end);
    this.engine.seek(sec.t);
    toast(`Boucle : ${sec.label}`);
  }

  // ─────────────────────────────────────────────────────────── actions ──

  setMode(mode, save = true) {
    this.mode = mode;
    const stage = this.el.querySelector('.stage');
    stage.classList.toggle('stage-mode', mode === 'stage');
    if (mode === 'stage') requestAnimationFrame(() => this.layoutStageHud());
    stage.classList.toggle('grid-mode', mode === 'grid');
    stage.classList.toggle('score-mode', mode === 'score');
    if (mode === 'score') { this.mountScore(); this.renderScoreLyrics(true); }
    this.syncModeButtons();
    this.curLine = -2;
    this.curBar = -2;
    this.lastChordIdx = -2;
    this.frame(true);
    if (mode === 'stage' && !this.synced && !this.hasTimedChords) this.$big.innerHTML = '<div class="next-line">Le mode scène suit les paroles synchronisées ou les accords datés. Prépare le morceau avec le Studio, ou synchronise-le dans Éditer.</div>';
    if (save) this.app.setPref('viewMode', mode);
  }

  syncModeButtons() {
    this.el.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === this.mode));
    this.el.querySelectorAll('[data-inst]').forEach((b) => b.classList.toggle('on', b.dataset.inst === this.instrument));
  }

  setInstrument(inst, save = true) {
    this.instrument = inst;
    this.renderCapoSug?.();
    this.renderImpro?.();
    this._diagKey = null;
    this.syncModeButtons();
    this.lastChordIdx = -2;
    this.frame(true);
    if (!this.hasTimedChords) this.showAllChords();
    if (save) this.app.setPref('instrument', inst);
  }

  async setTranspose(n) {
    const p = this.song.prefs;
    p.transpose = Math.max(-11, Math.min(11, n));
    if (p.audioPitch) await this.engine.setSemitones(p.transpose);
    this.updateOptionOutputs();
    this.refreshChords();
    this.saveSong();
  }

  bind() {
    const el = this.el;
    el.addEventListener('click', (e) => {
      if (this.fullStage && e.target.closest('.stage') && !e.target.closest('.stage-hud')) {
        // plein écran : un toucher = lecture / pause (un double-toucher quitte)
        clearTimeout(this._fsTap);
        if (this._fsLast && performance.now() - this._fsLast < 320) { this._fsLast = 0; this.exitFullStage(); return; }
        this._fsLast = performance.now();
        this._fsTap = setTimeout(() => { if (this.fullStage) this.togglePlay(); }, 330);
        return;
      }
      if (this.editing.onClick(e)) return;
      const modeB = e.target.closest('[data-mode]');
      if (modeB) { this.setMode(modeB.dataset.mode); return; }
      const instB = e.target.closest('[data-inst]');
      if (instB) { this.setInstrument(instB.dataset.inst); return; }
      const pre = e.target.closest('[data-preset]');
      if (pre) { this.applyPreset(pre.dataset.preset); return; }
      const chordEl = e.target.closest('.c:not(.e), .cbar');
      if (chordEl && chordEl.closest('.lyrics')) {
        const li = +chordEl.dataset.li, ci = +chordEl.dataset.ci;
        const lineS = chordEl.closest('.ln')?.dataset.s;
        const c = this.timeline.find((x) => x.li === li && x.ci === ci && x.t != null) || (chordEl.dataset.t ? { t: +chordEl.dataset.t } : lineS ? { t: +lineS } : null);
        // petit écran (pas de panneau de droite) ou accord sans temps : on montre le diagramme
        if (this.isNarrow() || c?.t == null) { this.openChordSheet(chordEl.textContent.trim(), c?.t ?? null, Number.isFinite(li) && Number.isFinite(ci) ? { li, ci } : null); return; }
        this.seekChord(c.t); return;
      }
      const mobNow = e.target.closest('.mob-chord .now-chord, .mob-chord .next-chord');
      if (mobNow && mobNow.textContent.trim()) {
        const n = mobNow.classList.contains('next-chord') ? this.display(this.timeline[this.lastChordIdx + 1]?.name || '') : mobNow.textContent.trim();
        if (n) { this.openChordSheet(n, null); return; }
      }
      const line = e.target.closest('.lyrics .ln.lyric');
      if (line && line.dataset.s) { this.engine.seek(Math.max(0, +line.dataset.s - 0.25)); this.userScrollAt = 0; return; }
      if (e.target.closest('.g-tools-d > summary')) { setTimeout(() => { this._gToolsOpen = this.$grid.querySelector('.g-tools-d')?.open; }, 0); return; }
      const gb = e.target.closest('[data-g]');
      if (gb) { const [k, v] = gb.dataset.g.split(':'); this.gridAction(k, v); return; }
      const bar = e.target.closest('.mbar[data-t]');
      if (bar) { this.engine.seek(+bar.dataset.t); return; }
      const dg = e.target.closest('[data-r="diagram"], [data-r="mini"]');
      if (dg) {
        const name = this.el.querySelector('[data-r="now"]').textContent;
        this.voicingIdx[name] = (this.voicingIdx[name] || 0) + 1;
        this._diagKey = null;
        this.showChord(this.timeline[this.lastChordIdx]?.name, this.timeline[this.lastChordIdx + 1]?.name);
        return;
      }
      const secSpan = e.target.closest('.lane-sec span');
      if (secSpan) {
        const i = [...secSpan.parentNode.children].indexOf(secSpan);
        const sec = this.sections[i];
        if (sec) openMenu(secSpan, [
          { icon: 'play', label: `Aller à « ${sec.label} »`, action: () => this.engine.seek(sec.t) },
          { icon: 'loop', label: 'Boucler cette partie', action: () => this.loopSection(sec) },
        ]);
        return;
      }
      const b = e.target.closest('[data-act]');
      if (!b) return;
      this.action(b.dataset.act, b, e);
    });
    el.addEventListener('change', (e) => {
      const a = e.target.dataset.act;
      if (a === 'audio-pitch') {
        this.song.prefs.audioPitch = e.target.checked;
        this.engine.setSemitones(e.target.checked ? this.song.prefs.transpose : 0);
        if (e.target.checked && !this.engine.pitchAvailable) toast('Transposition audio indisponible sur ce navigateur');
        this.updateOptionOutputs();
        this.saveSong();
      }
      if (a === 'metro-switch') { this.el.querySelector('.t-right [data-act="metro"]').click(); }
      if (a === 'prog') {
        this.song.prefs.progressive = e.target.checked; this.saveSong();
        this.el.querySelectorAll('.prog-opts').forEach((x) => { x.hidden = !e.target.checked; });
        this.el.querySelectorAll('[data-act="prog"]').forEach((x) => { x.checked = e.target.checked; });
        if (e.target.checked) { if (this.engine.loop) this.progressStart(true); else toast('Pose une boucle sur le passage à travailler : bouton boucle (ou L), ou touche une partie sur la barre de lecture', 6000); }
        else this.progressStop();
      }
      if (a === 'midi') { this.midiOn = e.target.checked; this.app.setPref('midi', this.midiOn); if (this.midiOn) this.midiStart(true); else this.midiStop(); }
      if (a === 'r20') { this.r20On = e.target.checked; this.app.setPref('r20', this.r20On); if (this.r20On) this.r20Start(true); else this.r20Stop(); }
      if (a === 'midi-follow') { this.midiFollow = e.target.checked; this.app.setPref('midiFollow', this.midiFollow); this.updateMidiUi(); }
      if (a === 'hud-switch') { (this.prefsCache ||= {}).hud = e.target.checked; this.app.setPref('hud', e.target.checked); this.applyHud(); this.renderScoreLyrics(true); this.updateScoreBar?.(); }
      if (a === 'start-delay') { this.app.setPref('startDelay', +e.target.value); (this.prefsCache ||= {}).startDelay = +e.target.value; this.el.querySelectorAll('[data-act="start-delay"]').forEach((x) => { x.value = e.target.value; }); toast(+e.target.value ? `Play attendra ${e.target.value} s avant de démarrer` : 'Départ immédiat'); }
      if (a === 'countin') { this.song.prefs.countIn = e.target.checked; this.updateOptionOutputs(); this.saveSong(); }
      if (a === 'show-bars') {
        this.showBars = e.target.checked;
        this.app.setPref('showBars', this.showBars);
        this.el.querySelectorAll('[data-act="show-bars"]').forEach((x) => { x.checked = this.showBars; });
        this.renderBarMarks();
        if (this.showBars && !this.barTimes().length) toast('Pas de tempo pour ce morceau : lance « Tout préparer » (étape Tempo et accords)', 6000);
      }
      if (a === 'sc-chords' && this.song.score) {
        this.song.score.useChords = e.target.checked;
        this.saveSong(); this.renderLyrics(); this.lastChordIdx = -2; this.frame(true);
        if (e.target.checked && !this.song.score.chords?.length) toast('Ouvre la vue Partition une fois pour relever ses accords', 5000);
      }
      if (a === 'show-chords') {
        this.showChords = e.target.checked;
        this.$lyrics.classList.toggle('hide-chords', !this.showChords);
        this.app.setPref('showChords', this.showChords);
        this.updateOptionOutputs();
      }
    });
    // défilement manuel → on arrête de suivre quelques secondes
    const markUser = () => { if (!this._scrolling) { this.userScrollAt = performance.now(); if (this.engine.playing && this.mode === 'lyrics') el.querySelector('.follow-btn').hidden = false; } };
    this.$lyrics.addEventListener('wheel', markUser, { passive: true });
    this.$lyrics.addEventListener('touchmove', markUser, { passive: true });
    this.$lyrics.addEventListener('keydown', (e) => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown'].includes(e.key)) markUser(); });
    // barre de progression
    const tr = this.$track;
    const posT = (e) => {
      const r = tr.getBoundingClientRect();
      return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (this.song.duration || this.engine.duration || 0);
    };
    let wasPlaying = false;
    drag(tr, {
      onStart: (e) => { if (e.target.closest('.lane-sec span')) return; wasPlaying = this.engine.playing; this.scrubT = posT(e); this.showScrub(this.scrubT); },
      onMove: (e) => { if (this.scrubT == null) return; this.scrubT = posT(e); this.showScrub(this.scrubT); },
      onEnd: () => { if (this.scrubT == null) return; this.engine.seek(this.scrubT); this.scrubT = null; this.showScrub(null); if (wasPlaying && !this.engine.playing) this.engine.play(); },
    });
    tr.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); this.engine.skip(-5); }
      if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); this.engine.skip(5); }
    });
    el.querySelector('.scrim').addEventListener('click', () => this.closeSheets());
    window.addEventListener('resize', this._onResize = debounce(() => { this.updateStrips(); this.renderLanes(); }, 150));
  }

  /** Poignée pour élargir / réduire le panneau de droite (accords + mixage). */
  bindResizer() {
    const h = this.el.querySelector('.rail-resizer');
    if (!h) return;
    const apply = (px, save) => {
      if (px == null) { this.el.style.removeProperty('--rail-w'); this.railWidth = null; }
      else {
        px = Math.round(Math.max(280, Math.min(px, Math.min(760, window.innerWidth * 0.62))));
        this.el.style.setProperty('--rail-w', px + 'px');
        this.railWidth = px;
      }
      this.updateStrips();
      if (save) { this.app.setPref('railWidth', this.railWidth); this.renderLanes(); this._diagKey = null; this.frame(true); }
    };
    drag(h, {
      onStart: () => h.classList.add('on'),
      onMove: (e) => apply(window.innerWidth - e.clientX, false),
      onEnd: () => { h.classList.remove('on'); apply(this.railWidth, true); },
    });
    h.addEventListener('dblclick', () => apply(null, true));
    h.addEventListener('keydown', (e) => {
      const cur = this.el.querySelector('.rail').getBoundingClientRect().width;
      if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); apply(cur + 30, true); }
      if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); apply(cur - 30, true); }
    });
  }

  showScrub(t) {
    let tip = this.$track.querySelector('.hover-t');
    if (t == null) { tip?.remove(); return; }
    if (!tip) { tip = document.createElement('div'); tip.className = 'hover-t'; this.$track.appendChild(tip); }
    const dur = this.song.duration || this.engine.duration || 1;
    tip.style.left = (t / dur) * 100 + '%';
    tip.textContent = fmtTime(t);
    this.$track.querySelector('.head').style.left = (t / dur) * 100 + '%';
  }

  openSheet(name) {
    this.el.querySelectorAll('.sheet-panel').forEach((p) => p.classList.toggle('open', p.dataset.sheet === name));
    this.el.querySelector('.scrim').classList.add('on');
    setTimeout(() => this.updateStrips(), 30);
  }

  closeSheets() {
    this.el.querySelectorAll('.sheet-panel').forEach((p) => p.classList.remove('open'));
    this.el.querySelector('.scrim').classList.remove('on');
  }

  async action(a, b) {
    const p = this.song.prefs;
    switch (a) {
      case 'back': this.app.go('#/'); break;
      case 'play': this.togglePlay(); break;
      case 'back5': this.engine.skip(-5); break;
      case 'fwd5': this.engine.skip(5); break;
      case 'loop': this.toggleLoop(); break;
      case 'follow': this.userScrollAt = 0; b.hidden = true; this.frame(true); break;
      case 'edit': this.app.go(`#/edit/${this.song.id}`); break;
      case 'tr-': this.setTranspose(p.transpose - 1); break;
      case 'tr+': this.setTranspose(p.transpose + 1); break;
      case 'capo-': p.capo = Math.max(0, (p.capo || 0) - 1); this.updateOptionOutputs(); this.refreshChords(); this.saveSong(); break;
      case 'capo-apply': p.capo = +b.dataset.capo; this.updateOptionOutputs(); this.refreshChords(); this.saveSong(); toast(p.capo ? `Capo ${p.capo} : le son ne change pas, seules les formes changent` : 'Capo retiré'); break;
      case 'midi-learn':
        if (!this.midiOn) { toast('Active d’abord « Clavier MIDI »'); break; }
        if (midi.advanceNote != null && b.dataset.clear) { midi.advanceNote = null; this.app.setPref('midiKey', null); this.updateMidiUi(); break; }
        midi.learn(); b.textContent = 'Appuie sur une touche…'; toast('Appuie sur la touche du clavier qui servira à avancer', 5000); break;
      case 'impro': this.toggleImpro(); break;
      case 'diag': import('../diag.js').then((m) => m.diagDialog(this.app)); break;
      case 'rec': if (this.take) this.stopTake(); else this.takeDialog(); break;
      case 'capo+': p.capo = Math.min(11, (p.capo || 0) + 1); this.updateOptionOutputs(); this.refreshChords(); this.saveSong(); break;
      case 'rate-': case 'rate+': {
        p.rate = Math.round(Math.max(0.5, Math.min(1.5, p.rate + (a === 'rate+' ? 0.05 : -0.05))) * 100) / 100;
        this.engine.setRate(p.rate); this.updateOptionOutputs(); this.saveSong(); break;
      }
      case 'off-auto': this.autoLyrics(); break;
      case 'hud-size': {
        const z0 = this.prefsCache?.stageHudZoom || 1, z = Math.max(0.5, Math.min(2.5, Math.round((z0 + (+b.dataset.v) * 0.15) * 100) / 100));
        (this.prefsCache ||= {}).stageHudZoom = z; this.app.setPref('stageHudZoom', z); this.layoutStageHud();
        break;
      }
      case 'rail-toggle': { const off = !this.prefsCache?.railOff; (this.prefsCache ||= {}).railOff = off; this.app.setPref('railOff', off); this.applyRail(); break; }
      case 'hud-toggle': { const on = !this.hudOn(); (this.prefsCache ||= {}).hud = on; this.app.setPref('hud', on); this.applyHud(); this.renderScoreLyrics(true); this.updateScoreBar?.(); break; }
      case 'off-': case 'off+': p.offset = (p.offset || 0) + (a === 'off+' ? 50 : -50); this.updateOptionOutputs(); this.frame(true); this.renderBarMarks(); this.saveSong(); break;
      case 'rate':
        openMenu(b, [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 1, 1.1, 1.25].map((r) => ({
          label: `${Math.round(r * 100)} %${r === 1 ? ' (normal)' : ''}${Math.abs(r - p.rate) < 0.001 ? '  ✓' : ''}`,
          action: () => { p.rate = r; this.engine.setRate(r); this.updateOptionOutputs(); this.saveSong(); },
        })));
        break;
      case 'metro': {
        const on = !this.engine.metronome.on;
        if (on && !this.engine.metronome.beats.length) { toast('Pas de tempo connu pour ce morceau (Éditer → Infos)'); return; }
        await this.engine.ensureContext();
        this.engine.setMetronome(on);
        this.el.querySelector('.t-right [data-act="metro"]').classList.toggle('changed', on);
        this.$grid?.querySelector('[data-act="metro"]')?.classList.toggle('on', on);
        this.el.querySelectorAll('[data-act="metro-switch"]').forEach((i) => { i.checked = on; });
        toast(on ? 'Métronome activé' : 'Métronome coupé');
        break;
      }
      case 'key':
        openMenu(b, [
          { label: 'Monter d’un demi-ton', icon: 'plus', action: () => this.setTranspose(p.transpose + 1) },
          { label: 'Descendre d’un demi-ton', icon: 'back', action: () => this.setTranspose(p.transpose - 1) },
          { label: p.audioPitch ? 'Ne transposer que les accords' : 'Transposer aussi l’audio', icon: 'sync', action: () => { p.audioPitch = !p.audioPitch; this.engine.setSemitones(p.audioPitch ? p.transpose : 0); this.updateOptionOutputs(); this.saveSong(); toast(p.audioPitch ? 'L’audio suit la transposition' : 'Seuls les accords sont transposés'); } },
          '-',
          { label: 'Tonalité d’origine', icon: 'undo', action: () => this.setTranspose(0) },
        ]);
        break;
      case 'text': {
        const cur = parseFloat(getComputedStyle(this.el).getPropertyValue('--lyrics-size')) || 26;
        openMenu(b, [
          { label: 'Plus grand', icon: 'plus', action: () => this.setFont(cur + 2) },
          { label: 'Plus petit', icon: 'textsize', action: () => this.setFont(cur - 2) },
          { label: 'Taille normale', icon: 'undo', action: () => this.setFont(null) },
        ]);
        break;
      }
      case 'menu':
        openMenu(b, [
          { icon: 'stage', label: 'Scène plein écran', action: () => this.enterFullStage() },
          { icon: 'piano', label: 'Jouer au piano (notes qui tombent)', action: () => { location.href = `piano.html#song-${encodeURIComponent(this.song.id)}`; } },
          { icon: 'tuner', label: 'Accordeur', action: () => import('../tuner.js').then((m) => m.tunerDialog(this.app)) },
          { icon: 'edit', label: 'Modifier ici (accords, doigtés, texte)', action: () => { if (this.mode !== 'lyrics') this.setMode('lyrics'); this.editing.toggle(true); } },
          { icon: 'edit', label: 'Paroles et accords (éditeur)', action: () => this.app.go(`#/edit/${this.song.id}`) },
          { icon: 'upload', label: this.song.score ? 'Partition : changer ou retirer' : 'Ajouter une partition (Guitar Pro, MusicXML)', action: () => this.scoreDialog() },
          { icon: 'tap', label: 'Synchroniser les paroles', action: () => this.app.go(`#/edit/${this.song.id}/sync`) },
          { icon: 'info', label: 'Infos et pistes', action: () => this.app.go(`#/edit/${this.song.id}/info`) },
          '-',
          { icon: 'pdf', label: 'Exporter en PDF', action: () => this.app.printSong(this.song, { transpose: p.transpose - p.capo, instrument: this.instrument }) },
          { icon: 'download', label: 'Télécharger le pack (ZIP)', action: async () => { toast('Préparation du pack…'); const { blob, name } = await exportPack(this.song); download(blob, name); } },
          { icon: 'mix', label: 'Tout préparer (pistes, paroles, accords)', action: () => this.app.separateDialog(this.song) },
          { icon: 'mix', label: 'Exporter pour Zoom R20', action: () => this.app.zoomExport(this.song) },
          { icon: 'list', label: 'Ajouter à une setlist', action: () => this.app.addToSetlist(this.song) },
          { icon: 'upload', label: this.song.shared ? 'Ne plus partager' : 'Partager par lien', action: () => this.app.toggleShare(this.song) },
        ]);
        break;
      case 'sheet-mix': this.openSheet('mix'); break;
      case 'sheet-opts': this.openSheet('opts'); break;
      case 'mix-reset': this.applyPreset('all'); break;
      case 'fullstage': this.enterFullStage(); break;
      case 'tuner': import('../tuner.js').then((m) => m.tunerDialog(this.app)); break;
      case 'prog-': case 'prog+': {
        p.progStart = Math.min(0.95, Math.max(0.5, Math.round(((p.progStart ?? 0.7) + (a === 'prog+' ? 0.05 : -0.05)) * 100) / 100));
        this.el.querySelectorAll('[data-r="prog"]').forEach((o) => { o.textContent = Math.round(p.progStart * 100) + ' %'; });
        this.saveSong();
        if (this.prog) this.progressStart(true);
        break;
      }
      case 'show-empty': this.showEmpty = true; this.renderMixer(); break;
      case 'prev-song': if (this.ctx.index > 0) this.app.playFromSetlist(this.ctx.setlist, this.ctx.index - 1); break;
      case 'next-song': if (this.ctx.index < this.ctx.setlist.songs.length - 1) this.app.playFromSetlist(this.ctx.setlist, this.ctx.index + 1); break;
      default: break;
    }
  }

  setFont(px) {
    if (px) px = Math.max(14, Math.min(48, px));
    if (px) this.el.style.setProperty('--lyrics-size', px + 'px'); else this.el.style.removeProperty('--lyrics-size');
    this.app.setPref('fontSize', px);
    clearTimeout(this._barT); this._barT = setTimeout(() => this.renderBarMarks(), 60);
    this.curLine = -2;
    this.frame(true);
  }

  onKey(e) {
    if (e.target.closest('input, textarea, select, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (document.querySelector('dialog[open], .menu')) return;
    const k = e.key;
    if (k === ' ' || k === 'k') { e.preventDefault(); this.togglePlay(); }
    else if (k === 'ArrowLeft') { e.preventDefault(); this.engine.skip(-5); }
    else if (k === 'ArrowRight') { e.preventDefault(); this.engine.skip(5); }
    else if (k === 'l' || k === 'L') this.toggleLoop();
    else if (k === 'm' || k === 'M') this.el.querySelector('[data-act="metro"]').click();
    else if (k === '+' || k === '=') this.setTranspose(this.song.prefs.transpose + 1);
    else if (k === '-' || k === '_') this.setTranspose(this.song.prefs.transpose - 1);
    else if (k === '[') this.action('rate-');
    else if (k === ']') this.action('rate+');
    else if (k === 'f' || k === 'F') this.setMode(this.mode === 'stage' ? 'lyrics' : 'stage');
    else if (k === 'g' || k === 'G') this.setMode(this.mode === 'grid' ? 'lyrics' : 'grid');
    else if (k === 'p' || k === 'P') { if (this.fullStage) this.exitFullStage(); else this.enterFullStage(); }
    else if ((k === 'i' || k === 'I') && !document.querySelector('dialog[open]')) this.toggleImpro();
    else if ((k === 't' || k === 'T') && !document.querySelector('dialog[open]')) import('../tuner.js').then((m) => m.tunerDialog(this.app));
    else if (k === 'Escape') { if (this.fullStage) { this.exitFullStage(); return; } this.closeSheets(); if (this.mode === 'stage') this.setMode('lyrics'); }
    else if (k === 'PageDown' || k === 'ArrowDown' && this.mode === 'stage') { e.preventDefault(); this.pedal(1); }
    else if (k === 'PageUp' || k === 'ArrowUp' && this.mode === 'stage') { e.preventDefault(); this.pedal(-1); }
  }

  /** Pédale Bluetooth (PageDown / PageUp) : morceau suivant en setlist, sinon partie suivante. */
  // ── boucle progressive : la vitesse monte à chaque tour jusqu'à 100 %
  progressStart(force = false) {
    const p = this.song.prefs;
    if (!p.progressive || !this.engine.loop) { if (!this.engine.loop) this.progressStop(); return; }
    const key = `${this.engine.loop.a}|${this.engine.loop.b}`;
    if (this.prog && this.prog.key === key && !force) return;
    if (!this.prog) this.prog = { before: p.rate || 1 };
    this.prog.key = key; this.prog.lap = 1;
    this.setRateLive(p.progStart ?? 0.7);
    toast(`Boucle progressive : départ à ${Math.round((p.progStart ?? 0.7) * 100)} %`);
  }

  progressStep() {
    const p = this.song.prefs;
    if (!this.prog || !p.progressive) return;
    this.prog.lap++;
    const target = 1, step = p.progStep ?? 0.05;
    const r = Math.min(target, Math.round(((p.rate || 1) + step) * 100) / 100);
    if (r !== p.rate) { this.setRateLive(r); toast(r >= target ? `Tour ${this.prog.lap} · 100 % : à toi de jouer !` : `Tour ${this.prog.lap} · ${Math.round(r * 100)} %`, 2200); }
  }

  progressStop() {
    if (!this.prog) return;
    this.setRateLive(this.prog.before || 1);
    this.prog = null;
  }

  setRateLive(r) {
    this.song.prefs.rate = r;
    this.engine.setRate(r);
    this.updateOptionOutputs();
    this.saveSong();
  }

  /** Scène plein écran : paroles et accords en très grand, sans aucun bouton. */
  enterFullStage() {
    if (this.editing.on) this.editing.toggle(false);
    this._modeBeforeFs = this.mode;
    this.setMode('stage', false);
    this.fullStage = true;
    this.el.classList.add('fullstage');
    this.el.requestFullscreen?.().catch(() => {});
    this.requestWake();
    this._onFs = () => { if (!document.fullscreenElement && this.fullStage) this.exitFullStage(); };
    document.addEventListener('fullscreenchange', this._onFs);
    this.lastChordIdx = -2;
    this.frame(true);
  }

  exitFullStage() {
    if (!this.fullStage) return;
    this.fullStage = false;
    this.el?.classList.remove('fullstage');
    document.removeEventListener('fullscreenchange', this._onFs);
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    if (this._modeBeforeFs && this._modeBeforeFs !== 'stage') this.setMode(this._modeBeforeFs, false);
    if (!this.engine.playing) this.releaseWake();
  }

  pedal(dir) {
    if (this.ctx.setlist) {
      const i = this.ctx.index + dir;
      if (i >= 0 && i < this.ctx.setlist.songs.length) this.app.playFromSetlist(this.ctx.setlist, i);
      return;
    }
    const t = this.engine.currentTime;
    const secs = this.sections;
    if (!secs.length) { this.engine.skip(dir * 10); return; }
    if (dir > 0) { const s = secs.find((x) => x.t > t + 0.5); if (s) this.engine.seek(s.t); }
    else { const s = [...secs].reverse().find((x) => x.t < t - 2); this.engine.seek(s ? s.t : 0); }
  }
}

function chunk(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }
function fmtSemi(n) { return n ? (n > 0 ? '+' : '−') + Math.abs(n) : '0'; }
/** Plus longue suite de lignes aux temps croissants (dans l'ordre du texte). */
function increasing(a) {
  const n = a.length, len = new Array(n).fill(1), prev = new Array(n).fill(-1);
  let best = -1;
  for (let i = 0; i < n; i++) {
    for (let j = Math.max(0, i - 200); j < i; j++) if (a[j].s < a[i].s && len[j] + 1 > len[i]) { len[i] = len[j] + 1; prev[i] = j; }
    if (best < 0 || len[i] >= len[best]) best = i;
  }
  const out = [];
  for (let i = best; i >= 0; i = prev[i]) out.push(a[i]);
  return out.reverse();
}

function sameName(a, b) { return String(a).replace(/\*$/, '') === String(b).replace(/\*$/, ''); }

function sameChord(a, b) {
  const r = (x) => (x || '').replace(/^([A-G][#b]?).*$/, '$1').replace('Db', 'C#').replace('Eb', 'D#').replace('Gb', 'F#').replace('Ab', 'G#').replace('Bb', 'A#');
  return r(a) === r(b);
}

function fmtOffset(ms) { return ms ? `${ms > 0 ? '+' : '−'}${Math.abs(ms / 1000).toFixed(2).replace('.', ',')} s` : '0 s'; }

function beatsFromBpm(song) {
  if (!song.bpm || !song.duration) return [];
  const p = 60 / song.bpm;
  const out = [];
  const t0 = song.downbeats?.[0] ?? 0;
  for (let t = t0 % p; t < song.duration; t += p) out.push(t);
  return out;
}

export { keyName, songKey };
