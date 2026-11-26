// MusiMix — vue « Partition » : Guitar Pro (.gp, .gpx, .gp5, .gp4, .gp3) et MusicXML (.musicxml, .xml, .mxl)
// affichés par alphaTab (MPL-2.0, https://alphatab.net), calés sur l'audio du morceau.
// alphaTab tourne en « média externe » : c'est le moteur de MusiMix qui joue, alphaTab suit (curseur,
// défilement), et un clic sur une note fait sauter la lecture. Le calage partition ↔ audio passe par des
// « sync points » : chaque mesure de la partition (dans l'ordre joué, reprises comprises) est posée sur un
// début de mesure détecté dans l'audio (Tout préparer), avec un décalage et une mesure de départ réglables.

export const AT_VERSION = '1.9.0';
export const AT_BASE = `https://cdn.jsdelivr.net/npm/@coderline/alphatab@${AT_VERSION}/dist/`;
export const SCORE_EXT = /\.(gp|gpx|gp3|gp4|gp5|musicxml|mxl|xml)$/i;

let loading = null;
export function loadAlphaTab() {
  if (window.alphaTab) return Promise.resolve(window.alphaTab);
  loading ||= new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = AT_BASE + 'alphaTab.min.js';
    s.crossOrigin = 'anonymous';
    s.onload = () => (window.alphaTab ? res(window.alphaTab) : rej(new Error('alphaTab introuvable')));
    s.onerror = () => { loading = null; rej(new Error('Lecteur de partitions non chargé : vérifie la connexion (première fois seulement).')); };
    document.head.appendChild(s);
  });
  return loading;
}

const PROFILES = { both: 'Default', tab: 'Tab', score: 'Score' };

export class ScoreView {
  /**
   * @param {HTMLElement} host  conteneur qui défile
   * @param {object} opts { engine, song, onStatus(text), getDownbeats(), save() }
   */
  constructor(host, opts) {
    this.host = host;
    this.o = opts;
    this.api = null;
    this.ready = false;
  }

  get cfg() {
    const s = this.o.song;
    s.score.sync ||= { firstBar: 0, offset: 0, auto: true };
    return s.score;
  }

  async mount(bytes) {
    const AT = await loadAlphaTab();
    this.host.innerHTML = '<div class="score-sheet"></div>';
    const el = this.host.firstElementChild;
    const c = this.cfg;
    const api = new AT.AlphaTabApi(el, {
      core: { fontDirectory: AT_BASE + 'font/', useWorkers: false, includeNoteBounds: false },
      display: { staveProfile: AT.StaveProfile[PROFILES[c.layout] || 'Default'], scale: c.scale || (innerWidth < 700 ? 0.8 : 1), layoutMode: AT.LayoutMode.Page },
      player: { playerMode: AT.PlayerMode.EnabledExternalMedia, enableCursor: true, enableAnimatedBeatCursor: true, enableUserInteraction: true, scrollElement: this.host, scrollMode: AT.ScrollMode?.Off ?? 0 },
    });
    this.api = api;
    this.AT = AT;
    window.__mmScore = this; // diagnostic
    api.error.on((e) => this.o.onStatus?.(`Partition illisible : ${e?.message || e}`));
    api.scoreLoaded.on((score) => {
      this.score = score;
      this.o.onTracks?.(score.tracks.map((t, i) => ({ i, name: t.name || `Piste ${i + 1}` })), c.track || 0);
    });
    api.playerReady.on(() => this.attach());
    api.midiLoaded?.on?.(() => this.applySync());
    api.load(bytes, [c.track || 0]);
  }

  /** Branche le moteur de MusiMix comme « média externe » d'alphaTab. */
  attach() {
    const out = this.api.player?.output;
    if (!out) return;
    const eng = this.o.engine;
    out.handler = {
      get backingTrackDuration() { return (eng.duration || 0) * 1000; },
      get playbackRate() { return eng.rate || 1; },
      set playbackRate(v) { /* la vitesse se règle dans MusiMix */ },
      get masterVolume() { return 1; },
      set masterVolume(v) { /* idem */ },
      // alphaTab renvoie parfois la position qu'on vient de lui donner : on n'obéit qu'à un vrai saut (clic sur une note)
      seekTo: (ms) => { this.log('seekTo', ms); const t = Math.max(0, ms / 1000); if (Math.abs(t - eng.currentTime) > 0.3) eng.seek(t); },
      play: () => { this.log('play'); if (!eng.playing) eng.play(); },
      pause: () => { this.log('pause'); if (eng.playing && performance.now() - (this._userPlay || 0) > 800) eng.pause(); },
    };
    this.out = out;
    this.ready = true;
    this.applySync();
    this.update(eng.currentTime, true);
  }

  /** Pose les sync points : mesure k jouée → k-ième début de mesure détecté (+ décalage). */
  applySync() {
    const AT = this.AT, api = this.api, score = this.score;
    const tl = api?.tickCache?.masterBars;
    if (!AT || !score || !tl?.length) return;
    const { firstBar = 0, offset = 0 } = this.cfg.sync;
    for (const mb of score.masterBars) mb.syncPoints = undefined;
    const raw = this.cfg.sync.auto === false ? [] : (this.o.getDownbeats?.() || []).slice(firstBar);
    const downs = this.fitBars(raw, tl);
    const seen = new Map();
    const add = (mb, occ, ms) => {
      const a = new AT.model.Automation();
      a.type = AT.model.AutomationType.SyncPoint;
      a.ratioPosition = 0;
      const d = new AT.model.SyncPointData();
      d.barOccurence = occ;
      d.millisecondOffset = Math.max(0, ms);
      a.syncPointValue = d;
      mb.addSyncPoint(a);
    };
    let placed = 0;
    tl.forEach((lk, k) => {
      const mb = lk.masterBar;
      const occ = seen.get(mb.index) || 0;
      seen.set(mb.index, occ + 1);
      const t = downs[k];
      if (t == null) return;
      add(mb, occ, (t + offset) * 1000);
      placed++;
    });
    if (!placed) add(tl[0].masterBar, 0, Math.max(0, ((raw[0] ?? 0) + offset) * 1000)); // seul le départ : la partition suit son propre tempo
    api.updateSyncPoints?.();
    this.placed = placed;
    const fix = this.ratio > 1.5 ? ' (tempo détecté doublé : corrigé)' : this.ratio < 0.67 ? ' (tempo détecté réduit de moitié : corrigé)' : '';
    this.o.onStatus?.(placed ? `Calage : ${placed} mesures posées sur l’audio${fix}. Si le curseur est en avance ou en retard d’une demi-mesure, touche « mes. » + ou −.` : 'Calage sur le tempo de la partition (prépare le morceau pour un calage mesure par mesure)');
  }

  log(...a) { (window.__mmScoreLog ||= []).push([Math.round(performance.now()), ...a]); if (window.__mmScoreLog.length > 60) window.__mmScoreLog.shift(); }

  /** Lecture lancée par MusiMix : alphaTab ne doit pas la couper dans la foulée. */
  userPlay() { this._userPlay = performance.now(); }

  /**
   * Met les mesures détectées à l'échelle de la partition : l'analyse trouve souvent le tempo double
   * (ou moitié). On compare la durée d'une mesure de la partition (son tempo) à l'écart entre deux
   * débuts de mesure détectés, puis on en garde une sur deux (ou on en ajoute au milieu).
   */
  fitBars(raw, tl) {
    if (raw.length < 4) return raw;
    const gaps = raw.slice(1).map((t, i) => t - raw[i]).sort((a, b) => a - b);
    const audioBar = gaps[gaps.length >> 1];
    const msOf = (lk) => {
      const tempo = lk.tempoChanges?.[0]?.tempo || lk.tempo || this.score.tempo || 120;
      return ((lk.end - lk.start) / 960) * (60 / tempo);
    };
    const durs = tl.slice(0, Math.min(8, tl.length)).map(msOf).sort((a, b) => a - b);
    const scoreBar = durs[durs.length >> 1];
    if (!audioBar || !scoreBar) return raw;
    const r = scoreBar / audioBar;
    this.ratio = r;
    if (r > 1.5) { const step = Math.round(r); return raw.filter((_, i) => i % step === 0); }
    if (r < 0.67) {
      const n = Math.round(1 / r), out = [];
      raw.forEach((t, i) => { const nx = raw[i + 1]; for (let k = 0; k < n; k++) out.push(nx == null ? t + k * audioBar / n : t + (k * (nx - t)) / n); });
      return out;
    }
    return raw;
  }

  update(t, force = false) {
    if (!this.ready || !this.out) return;
    const ms = Math.max(0, t * 1000);
    if (!force && Math.abs(ms - (this._last || -1e9)) < 15) return;
    this._last = ms;
    try { this.out.updatePosition(ms); } catch { /* */ }
    this.follow();
  }

  /** Défilement automatique : garde la ligne en cours dans le premier tiers de la vue. */
  follow() {
    const h = this.host;
    if (!this._userHook) {
      this._userHook = true;
      const hold = () => { this._userScroll = performance.now(); };
      ['wheel', 'touchstart', 'pointerdown', 'keydown'].forEach((e) => h.addEventListener(e, hold, { passive: true }));
    }
    if (performance.now() - (this._userScroll || 0) < 4000) return;
    const cur = h.querySelector('.at-cursor-bar');
    if (!cur || !cur.offsetHeight) return;
    const hr = h.getBoundingClientRect(), cr = cur.getBoundingClientRect();
    const top = cr.top - hr.top, bottom = cr.bottom - hr.top, H = h.clientHeight;
    if (top >= 8 && bottom <= H - 24) return; // déjà bien visible
    const target = Math.max(0, h.scrollTop + top - Math.min(H * 0.2, 120));
    if (Math.abs(target - (this._scrollTo ?? -1)) < 4) return;
    this._scrollTo = target;
    h.scrollTo({ top: target, behavior: 'smooth' });
  }

  setTrack(i) { this.cfg.track = i; if (this.score) this.api.renderTracks([this.score.tracks[i]]); this.o.save?.(); }

  setLayout(k) {
    this.cfg.layout = k;
    this.api.settings.display.staveProfile = this.AT.StaveProfile[PROFILES[k] || 'Default'];
    this.api.updateSettings(); this.api.render(); this.o.save?.();
  }

  setScale(f) {
    this.cfg.scale = Math.max(0.5, Math.min(1.8, f));
    this.api.settings.display.scale = this.cfg.scale;
    this.api.updateSettings(); this.api.render(); this.o.save?.();
  }

  nudge({ firstBar = 0, offset = 0 } = {}) {
    const s = this.cfg.sync;
    s.firstBar = Math.max(0, (s.firstBar || 0) + firstBar);
    s.offset = Math.round(((s.offset || 0) + offset) * 100) / 100;
    this.applySync(); this.update(this.o.engine.currentTime, true); this.o.save?.();
  }

  destroy() { try { this.api?.destroy(); } catch { /* */ } this.api = null; this.ready = false; this.host.innerHTML = ''; }
}
