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
      player: { playerMode: AT.PlayerMode.EnabledExternalMedia, enableCursor: true, enableAnimatedBeatCursor: true, enableUserInteraction: true, scrollElement: this.host, scrollOffsetY: -40 },
    });
    this.api = api;
    this.AT = AT;
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
      seekTo: (ms) => { eng.seek(Math.max(0, ms / 1000)); },
      play: () => { if (!eng.playing) eng.play(); },
      pause: () => { if (eng.playing) eng.pause(); },
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
    const downs = this.cfg.sync.auto === false ? [] : (this.o.getDownbeats?.() || []);
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
      const t = downs[firstBar + k];
      if (t == null) return;
      add(mb, occ, (t + offset) * 1000);
      placed++;
    });
    if (!placed) add(tl[0].masterBar, 0, Math.max(0, ((downs[firstBar] ?? 0) + offset) * 1000)); // seul le départ : la partition suit son propre tempo
    api.updateSyncPoints?.();
    this.placed = placed;
    this.o.onStatus?.(placed ? `Calage : ${placed} mesures posées sur l’audio` : 'Calage sur le tempo de la partition (prépare le morceau pour un calage mesure par mesure)');
  }

  update(t, force = false) {
    if (!this.ready || !this.out) return;
    const ms = Math.max(0, t * 1000);
    if (!force && Math.abs(ms - (this._last || -1e9)) < 15) return;
    this._last = ms;
    try { this.out.updatePosition(ms); } catch { /* */ }
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
