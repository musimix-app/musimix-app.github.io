// MusiMix — application : navigation, import, Studio, réglages.

import { db, persistStorage, storageEstimate } from './db.js';
import { Engine } from './engine.js';
import { Studio } from './studio.js';
import { Sync, DEFAULT_CLIENT_ID } from './sync.js';
import { QUALITIES, modelInfo } from './separate.js';
import { prepareSong } from './prepare.js';
import { esc, icon, toast, dialog, pickFiles, confirmBox } from './ui.js';
import { importFiles, importPack, importSingleAudio, guessTitleArtist, newSong, STEM_KINDS } from './songs.js';
import { parseSheet, docFromSongJson, fillLineEnds } from './sheet.js';
import { LibraryView, SetlistsView, askName } from './views/library.js';
import { PlayerView } from './views/player.js';
import { EditorView } from './views/editor.js';
import { printDialog } from './print.js';
import { zoomDialog } from './zoom.js';

class App extends EventTarget {
  constructor() {
    super();
    this.root = document.getElementById('app');
    this.engine = new Engine();
    this.studio = new Studio();
    this.sync = new Sync(this);
    this.view = null;
    this.jobs = new Map();
    this._prefs = null;
  }

  async start() {
    await this.applyTheme();
    this.engine.userLatency = ((await this.prefs()).latency || 0) / 1000;
    if (await this.sync.boot()) return;  // part chez Google renouveler la connexion, revient aussitôt
    await this.studio.init();
    persistStorage();
    window.addEventListener('hashchange', () => this.route());
    this.setupDrop();
    this.route();
    this.resumeJobs();
    this.registerSW();
    // l'appli peut recevoir des fichiers partagés (PWA installée, Android)
    if ('launchQueue' in window) window.launchQueue.setConsumer(async (p) => { if (p.files?.length) this.handleFiles(await Promise.all(p.files.map((h) => h.getFile()))); });
  }

  // ─────────────────────────────────────────────────────── réglages ──

  async prefs() {
    if (!this._prefs) this._prefs = await db.get('prefs', {});
    return this._prefs;
  }

  async setPref(k, v) {
    const p = await this.prefs();
    p[k] = v;
    await db.set('prefs', p);
  }

  async applyTheme(theme) {
    theme = theme ?? (await this.prefs()).theme ?? 'auto';
    try { localStorage.setItem('musimix-theme', JSON.stringify(theme)); } catch { /* */ }
    if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.dataset.theme = theme;
    const dark = theme === 'dark' || (theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#14161b' : '#f9f3ed');
  }

  // ─────────────────────────────────────────────────────── navigation ──

  go(hash) { if (location.hash === hash) this.route(); else location.hash = hash; }

  mount(el) { this.root.innerHTML = ''; this.root.appendChild(el); window.scrollTo(0, 0); }

  async route() {
    const h = location.hash.replace(/^#\/?/, '');
    const [name, id, extra] = h.split('/');
    if (this.view instanceof EditorView && this.view.dirty) {
      if (!(await this.view.leave())) { history.replaceState(null, '', this._lastHash); return; }
    }
    this._lastHash = location.hash || '#/';
    this.view?.close?.();
    this.view = null;
    document.title = 'MusiMix';
    if (name === 'play' && id) {
      const song = await db.getSong(id);
      if (!song) { this.go('#/'); return; }
      const params = new URLSearchParams(location.hash.split('?')[1] || '');
      let ctx = {};
      if (params.get('set')) {
        const sl = (await db.allSetlists()).find((x) => x.id === params.get('set'));
        if (sl) ctx = { setlist: sl, index: +params.get('i') || 0 };
      }
      this.view = new PlayerView(this);
      document.title = `${song.title} · MusiMix`;
      await this.view.open(song, ctx);
    } else if (name === 'edit' && id) {
      const song = await db.getSong(id);
      if (!song) { this.go('#/'); return; }
      this.view = new EditorView(this);
      await this.view.open(song, extra || 'text');
    } else if (name === 'setlists') {
      this.view = new SetlistsView(this);
      await this.view.open(id);
    } else if (name === 'settings') {
      this.view = { close: () => this.settingsEl?.remove() };
      await this.renderSettings();
    } else {
      this.view = new LibraryView(this);
      await this.view.open();
    }
  }

  playFromSetlist(sl, i) {
    if (i < 0 || i >= sl.songs.length) return;
    this.go(`#/play/${sl.songs[i]}?set=${sl.id}&i=${i}`);
  }

  // ─────────────────────────────────────────────────────── import ──

  setupDrop() {
    let depth = 0;
    window.addEventListener('dragenter', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { depth++; document.body.classList.add('dropping'); } });
    window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) document.body.classList.remove('dropping'); });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', async (e) => {
      e.preventDefault();
      depth = 0;
      document.body.classList.remove('dropping');
      const files = await filesFromDrop(e.dataTransfer);
      if (files.length) this.handleFiles(files);
    });
  }

  async importDialog() {
    const files = await pickFiles({ accept: 'audio/*,.mp3,.wav,.flac,.m4a,.ogg,.opus,.zip,.cho,.chopro,.txt,.lrc,.json,.mid,.midi,.kar', multiple: true });
    if (files.length) this.handleFiles(files);
  }

  async handleFiles(files) {
    try {
      let lastMsg = 0;
      const { songs, audioOnly, extras } = await importFiles(files, (m) => { if (Date.now() - lastMsg > 400) { lastMsg = Date.now(); toast(m, 4000); } });
      if (songs.length) {
        toast(songs.length === 1 ? `Ajouté : ${songs[0].title}` : `${songs.length} morceaux ajoutés`);
        if (songs.length === 1 && !audioOnly.length) { this.go(`#/play/${songs[0].id}`); return; }
        if (this.view instanceof LibraryView) this.route();
      }
      for (const f of audioOnly) await this.prepareDialog(f, extras);
    } catch (e) {
      console.error(e);
      toast(e.message || 'Import impossible');
    }
  }

  /** Un fichier audio : on propose la préparation automatique par le Studio. */
  async prepareDialog(file, extras = []) {
    const guess = guessTitleArtist(file.name);
    let sheetText = '';
    const sheetFile = extras?.find((f) => /\.(cho|chopro|txt|crd)$/i.test(f.name));
    if (sheetFile) sheetText = await sheetFile.text();
    await this.studio.check();
    const st = this.studio;
    const online = st.state === 'online' || st.mode === 'bridge';
    const d = dialog(`<form method="dialog">
      <h2>Préparer « ${esc(guess.title || file.name)} »</h2>
      ${online
        ? `<p>Le Studio va séparer la voix et les instruments, synchroniser les paroles mot à mot et trouver les accords. Compte 3 à 7 minutes ; tu peux continuer à utiliser l’appli pendant ce temps.</p>`
        : `<div class="callout"><b>Le Studio ne répond pas.</b> Il fait la séparation et la synchro sur ton PC. Lance « MusiMix Studio » sur le PC, ou vérifie son adresse dans les réglages. Tu peux aussi ajouter le morceau tel quel.</div>`}
      <div class="two">
        <label class="field">Titre<input type="text" name="title" value="${esc(guess.title)}"></label>
        <label class="field">Artiste<input type="text" name="artist" value="${esc(guess.artist)}"></label>
      </div>
      <label class="field">Paroles ou grille d’accords <span class="hint">facultatif : copiée d’un site, c’est encore plus précis</span>
        <textarea name="sheet" rows="5" placeholder="Laisse vide : les paroles sont cherchées en ligne, sinon transcrites.">${esc(sheetText)}</textarea></label>
      <div class="two">
        <label class="field">Langue<select name="lang"><option value="">Détection auto</option><option value="fr">Français</option><option value="en">Anglais</option><option value="pt">Portugais</option><option value="es">Espagnol</option><option value="it">Italien</option><option value="de">Allemand</option></select></label>
        <label class="field">Séparation<select name="quality"><option value="best">6 pistes, qualité max</option><option value="fast">4 pistes, plus rapide</option><option value="voice">Voix + instrumental</option></select></label>
      </div>
      <div class="actions">
        <button class="btn ghost" value="raw" data-raw>Ajouter sans préparer</button>
        <button class="btn${online ? '' : ' primary'}" value="browser" data-browser>${icon('mix')} Tout préparer ici</button>
        ${online ? '<button class="btn primary" value="studio" data-studio>Préparer avec le Studio</button>' : '<button class="btn" type="button" data-retry>Réessayer</button>'}
      </div></form>`, {
      onOpen: (dlg, close) => {
        const f = dlg.querySelector('form');
        const vals = () => Object.fromEntries(new FormData(f).entries());
        f.addEventListener('submit', (e) => e.preventDefault());
        dlg.querySelector('[data-raw]').addEventListener('click', async (e) => {
          e.preventDefault();
          const v = vals();
          close();
          const song = await importSingleAudio(file, { sheetText: v.sheet, title: v.title, artist: v.artist });
          this.go(`#/play/${song.id}`);
        });
        dlg.querySelector('[data-browser]').addEventListener('click', async (e) => {
          e.preventDefault();
          const v = vals();
          close();
          const song = await importSingleAudio(file, { sheetText: v.sheet, title: v.title, artist: v.artist });
          this.separateDialog(song);
        });
        dlg.querySelector('[data-studio]')?.addEventListener('click', (e) => {
          e.preventDefault();
          const v = vals();
          if (st.mode === 'bridge') st.openBridge().catch((err) => toast(err.message, 6000)); // pendant le clic
          close();
          this.runJob(file, v);
        });
        dlg.querySelector('[data-retry]')?.addEventListener('click', async () => {
          close();
          await this.studio.check();
          this.prepareDialog(file, extras);
        });
      },
    });
    return d.done;
  }

  async runJob(file, fields) {
    const key = 'local-' + Date.now();
    const job = { title: fields.title || file.name, progress: 0, message: 'Envoi au Studio…' };
    this.jobs.set(key, job);
    this.dispatchEvent(new Event('jobs'));
    if (!(this.view instanceof LibraryView)) this.go('#/');
    try {
      const zip = await this.studio.prepare(file, fields, (s) => {
        job.progress = s.progress ?? job.progress;
        job.message = s.message || stepLabel(s.step) || job.message;
        this.dispatchEvent(new Event('jobs'));
      });
      job.message = 'Import dans la bibliothèque…';
      this.dispatchEvent(new Event('jobs'));
      const song = await importPack(zip);
      song.source = 'studio';
      await db.putSong(song);
      this.jobs.delete(key);
      this.dispatchEvent(new Event('jobs'));
      toast(`Prêt : ${song.title}`, 4000);
      if (this.view instanceof LibraryView) this.route();
    } catch (e) {
      console.error(e);
      job.error = e.message;
      job.message = e.message;
      this.dispatchEvent(new Event('jobs'));
      setTimeout(() => { this.jobs.delete(key); this.dispatchEvent(new Event('jobs')); }, 15000);
    }
  }

  /** « Tout préparer » dans le navigateur (sans le Studio) : pistes, paroles synchronisées, accords. */
  async separateDialog(song) {
    if ([...this.jobs.values()].some((j) => j.songId === song.id)) { toast('Préparation déjà en cours pour ce morceau'); return; }
    let quality = 'best';
    const already = !!song.separation;
    const hasChords = song.doc?.lines?.some((l) => l.chords?.length);
    const d = dialog(`<form method="dialog">
      <h2>Tout préparer</h2>
      <p>Directement dans ce navigateur, sans le Studio. Le morceau d’origine reste disponible dans le mixage.</p>
      <div class="two">
        <label class="field">Titre<input type="text" name="title" value="${esc(song.title || '')}"></label>
        <label class="field">Artiste<input type="text" name="artist" value="${esc(song.artist || '')}"></label>
      </div>
      <p class="note">Titre et artiste exacts = paroles trouvées plus sûrement.</p>
      <div class="opt-row"><span>Séparer les pistes<br><small class="note">voix, batterie, basse, guitare, piano, autres${already ? ' · déjà fait : refaire ?' : ''}</small></span><label class="switch"><input type="checkbox" name="separate" ${already ? '' : 'checked'}><i></i></label></div>
      <div class="opt-row" data-r="qrow"><span>Qualité</span><span class="seg"><button type="button" data-q="best">Max</button><button type="button" data-q="fast">Rapide</button></span></div>
      <div class="callout" data-r="info">Vérification de la carte graphique…</div>
      <div class="opt-row"><span>Paroles synchronisées<br><small class="note">trouvées sur LRCLIB${song.doc?.lines?.some((l) => l.type === 'lyric') ? ' · tes paroles sont gardées, seul le minutage est ajouté' : ''}</small></span><label class="switch"><input type="checkbox" name="lyrics" checked><i></i></label></div>
      <div class="opt-row"><span>Tempo et accords<br><small class="note">${hasChords ? 'ta grille est gardée ; tempo et mesures ajoutés' : 'détectés à l’écoute : une bonne base, à vérifier'}</small></span><label class="switch"><input type="checkbox" name="chords" checked><i></i></label></div>
      <p class="note">La séparation est longue : de quelques minutes à une demi-heure selon l’ordinateur. Laisse MusiMix ouvert (tu peux l’utiliser). Fais-le plutôt sur le PC : le résultat arrive ensuite sur le téléphone par la synchro.</p>
      <div class="actions"><button class="btn ghost" data-close="">Annuler</button><button class="btn primary" data-go>Préparer</button></div></form>`);
    const el = d.el;
    const f = el.querySelector('form');
    const info = async () => {
      el.querySelectorAll('[data-q]').forEach((b) => b.classList.toggle('on', b.dataset.q === quality));
      const on = f.separate.checked;
      el.querySelector('[data-r="qrow"]').hidden = !on;
      const box = el.querySelector('[data-r="info"]');
      box.hidden = !on;
      if (!on) return;
      try {
        const m = await modelInfo(quality);
        if (!m.usable) { box.innerHTML = '<b>Qualité max indisponible ici :</b> ce navigateur n’a pas accès à la carte graphique (WebGPU). Utilise Chrome sur le PC, ou le mode Rapide.'; return; }
        box.innerHTML = `${QUALITIES[quality].label}. ${m.webgpu ? 'Carte graphique : <b>oui</b>' : 'Carte graphique : <b>non</b> (calcul sur le processeur, plus lent)'}. ${m.cached ? 'Modèle <b>déjà téléchargé</b>.' : `Premier usage : téléchargement du modèle, <b>${m.mb} Mo</b>, une seule fois.`}`;
      } catch (e) { box.textContent = 'Moteur de séparation indisponible : ' + e.message; }
    };
    f.separate.addEventListener('change', info);
    el.addEventListener('click', (e) => {
      const q = e.target.closest('[data-q]');
      if (q) { quality = q.dataset.q; info(); return; }
      if (e.target.closest('[data-go]')) {
        e.preventDefault();
        const opts = { quality, separate: f.separate.checked, lyrics: f.lyrics.checked, chords: f.chords.checked, title: f.title.value.trim(), artist: f.artist.value.trim() };
        if (!opts.separate && !opts.lyrics && !opts.chords) { toast('Coche au moins une étape'); return; }
        d.close();
        this.runSeparation(song, opts);
      }
    });
    info();
  }

  async runSeparation(song, opts) {
    const key = 'sep-' + song.id;
    const ctrl = new AbortController();
    const job = { title: opts.title || song.title || 'Morceau', songId: song.id, progress: 0, message: 'Démarrage…', abort: () => ctrl.abort() };
    this.jobs.set(key, job);
    this.dispatchEvent(new Event('jobs'));
    if (!(this.view instanceof LibraryView)) this.go('#/');
    let lock = null;
    try { lock = await navigator.wakeLock?.request('screen'); } catch { /* */ }
    try {
      const { report } = await prepareSong(song.id, {
        ...opts, signal: ctrl.signal,
        onProgress: (s) => { job.progress = s.progress ?? job.progress; job.message = s.message || job.message; this.dispatchEvent(new Event('jobs')); },
      });
      this.jobs.delete(key);
      this.dispatchEvent(new Event('jobs'));
      const bits = [];
      if (report.separated) bits.push('pistes séparées');
      if (opts.lyrics) bits.push(report.lyrics ? 'paroles synchronisées' : 'paroles introuvables sur LRCLIB');
      if (opts.chords) bits.push(report.keptChords ? `tempo ${report.bpm}` : `${report.chords} accords · ${report.key} · ${report.bpm} BPM`);
      toast(`Prêt : ${job.title} — ${bits.join(', ')}`, 7000);
      if (this.view instanceof LibraryView) this.route();
    } catch (e) {
      console.error(e);
      job.error = e.name === 'AbortError' ? 'Annulé' : (e.message || 'Échec');
      job.message = job.error;
      this.dispatchEvent(new Event('jobs'));
      setTimeout(() => { this.jobs.delete(key); this.dispatchEvent(new Event('jobs')); }, 15000);
    } finally {
      lock?.release?.().catch(() => {});
    }
  }

  async resumeJobs() {
    const pending = await db.get('jobs', []);
    if (!pending.length || this.studio.mode === 'bridge') return;
    for (const j of pending) {
      if (j.url !== this.studio.url) continue;
      const key = j.id;
      const job = { title: j.title, progress: 0, message: 'Reprise…' };
      this.jobs.set(key, job);
      this.dispatchEvent(new Event('jobs'));
      this.studio.follow(j.id, (s) => { job.progress = s.progress ?? 0; job.message = s.message || stepLabel(s.step); this.dispatchEvent(new Event('jobs')); })
        .then(async (zip) => { const song = await importPack(zip); song.source = 'studio'; await db.putSong(song); toast(`Prêt : ${song.title}`); })
        .catch(() => {})
        .finally(() => { this.jobs.delete(key); this.dispatchEvent(new Event('jobs')); if (this.view instanceof LibraryView) this.route(); });
    }
  }

  async loadDemo() {
    toast('Chargement de la démo…');
    try {
      const base = new URL('./', location.href);
      const [voc, inst] = await Promise.all(['vocals.mp3', 'instrumental.mp3'].map(async (n) => {
        const r = await fetch(new URL(n, base));
        if (!r.ok) throw new Error('Fichiers de démo introuvables');
        return new File([await r.blob()], n, { type: 'audio/mpeg' });
      }));
      let json = null;
      try { const r = await fetch(new URL('demo/eu.json', base)); if (r.ok) json = await r.json(); } catch { /* */ }
      const cho = await (await fetch(new URL('demo/eu.cho', base))).text();
      const files = [voc, inst, new File([cho], 'eu.cho')];
      if (json) files.push(new File([JSON.stringify(json)], 'song.json'));
      const { songs } = await importFiles(files);
      if (songs[0]) this.go(`#/play/${songs[0].id}`);
    } catch (e) { toast(e.message); }
  }

  // ─────────────────────────────────────────────────────── divers ──

  async printSong(song, opts) { printDialog(this, [song], opts); }

  zoomExport(song) { zoomDialog(this, song); }

  async printSetlist(sl) {
    const songs = (await Promise.all(sl.songs.map((id) => db.getSong(id)))).filter(Boolean);
    printDialog(this, songs);
  }

  async addToSetlist(song) {
    const lists = await db.allSetlists();
    const d = dialog(`<div class="dlg"><h2>Ajouter à une setlist</h2>
      <div class="lrclib-results">${lists.map((l) => `<button data-id="${l.id}"><b>${esc(l.name)}</b><small>${l.songs.length} titre${l.songs.length > 1 ? 's' : ''}${l.songs.includes(song.id) ? ' · déjà dedans' : ''}</small></button>`).join('')}</div>
      <div class="actions"><button class="btn" data-new>${icon('plus')} Nouvelle setlist</button><button class="btn ghost" data-close="">Fermer</button></div></div>`);
    d.el.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-id]');
      if (b) {
        const l = lists.find((x) => x.id === b.dataset.id);
        if (!l.songs.includes(song.id)) l.songs.push(song.id);
        await db.putSetlist(l);
        d.close();
        toast(`Ajouté à « ${l.name} »`);
      }
      if (e.target.closest('[data-new]')) {
        d.close();
        const name = await askName('Nouvelle setlist', '');
        if (!name) return;
        const { uid } = await import('./db.js');
        await db.putSetlist({ id: uid(), name, songs: [song.id], createdAt: Date.now() });
        toast(`Ajouté à « ${name} »`);
      }
    });
  }

  studioDialog() {
    const st = this.studio;
    const onHttps = location.protocol === 'https:';
    const d = dialog(`<div class="dlg">
      <h2>MusiMix Studio</h2>
      <p>Le Studio est un petit programme pour ton PC. Il prépare chaque morceau tout seul : séparation voix et instruments (moteur d’Ultimate Vocal Remover + Demucs), paroles synchronisées mot à mot, accords, tempo.</p>
      <div class="callout" data-r="state"></div>
      <label class="field">Adresse du Studio <span class="hint">sur le PC : localhost ; sur téléphone ou tablette : l’adresse affichée par le Studio</span>
        <input type="url" data-r="url" value="${esc(st.url)}" placeholder="192.168.1.20"></label>
      <div class="actions" style="justify-content:flex-start"><button class="btn small" data-test>Tester la connexion</button></div>
      <details><summary><b>Installer le Studio sur le PC (une seule fois)</b></summary>
        <p style="margin-top:10px"><a class="btn small" href="musimix-studio.zip" download>${icon('download')} Télécharger MusiMix Studio (Windows)</a></p>
        <ol style="padding-left:1.2em;color:var(--ink-2);display:grid;gap:6px;margin-top:10px">
          <li>Décompresse <b>musimix-studio.zip</b> sur ton PC (par exemple dans Documents).</li>
          <li>Double-clic sur <b>Installer.bat</b> (10 à 20 minutes : Python, modèles d’IA).</li>
          <li>Ensuite, double-clic sur <b>MusiMix Studio.bat</b> pour le lancer. Il affiche l’adresse à utiliser sur ton téléphone.</li>
        </ol>
        ${onHttps ? '<p class="note">Sur téléphone, une petite fenêtre du Studio s’ouvre pendant la préparation : laisse-la ouverte.</p>' : ''}
      </details>
      <div class="actions"><button class="btn primary" data-close="">Fermer</button></div></div>`);
    const show = () => {
      const s = d.el.querySelector('[data-r="state"]');
      if (st.mode === 'bridge') s.innerHTML = '<b>Connexion par fenêtre.</b> Depuis ce téléphone, le Studio s’ouvrira dans une petite fenêtre au moment de préparer un morceau.';
      else if (st.state === 'online') s.innerHTML = `<b>Connecté.</b> ${esc(st.info?.device || '')} ${st.info?.gpu ? '· carte graphique : ' + esc(st.info.gpu) : ''}`;
      else s.innerHTML = '<b>Pas de réponse.</b> Le Studio n’est pas lancé, ou l’adresse est différente.';
    };
    show();
    d.el.querySelector('[data-test]').addEventListener('click', async () => {
      await st.setUrl(d.el.querySelector('[data-r="url"]').value);
      if (st.mode === 'bridge') { try { await st.openBridge(); toast('Studio joignable'); } catch (e) { toast(e.message, 6000); } }
      show();
    });
  }

  async renderSettings() {
    const p = await this.prefs();
    const est = await storageEstimate();
    const el = document.createElement('section');
    el.className = 'view';
    el.innerHTML = `
      <header class="topbar"><button class="icon-btn" data-act="back" aria-label="Retour">${icon('back')}</button><div class="song-title"><b>Réglages</b></div></header>
      <main class="settings">
        <div class="group"><h2>Apparence</h2>
          <div class="opt-row"><span>Thème</span><span class="seg" data-g="theme"><button data-v="auto">Auto</button><button data-v="light">Clair</button><button data-v="dark">Sombre</button></span></div>
          <div class="opt-row"><span>Diagrammes par défaut</span><span class="seg" data-g="instrument"><button data-v="guitar">Guitare</button><button data-v="ukulele">Ukulélé</button><button data-v="piano">Piano</button></span></div>
        </div>
        <div class="group"><h2>Son</h2>
          <div class="opt-row"><span>Compensation de latence<br><small class="note">utile avec un casque ou une enceinte Bluetooth : avance les paroles</small></span>
            <span class="stepper"><button data-lat="-20">−</button><output data-r="lat">${p.latency || 0} ms</output><button data-lat="20">+</button></span></div>
        </div>
        <div class="group"><h2>Studio</h2>
          <p class="note">Adresse : ${esc(this.studio.url)} · ${this.studio.state === 'online' ? 'connecté' : this.studio.mode === 'bridge' ? 'connexion par fenêtre' : 'pas de réponse'}</p>
          <div><button class="btn" data-act="studio">Configurer le Studio</button></div>
        </div>
        <div class="group"><h2>Synchronisation Google Drive</h2>
          <p class="note">Tes morceaux (audio compris), setlists et réglages de mixage passent tout seuls d’un appareil à l’autre, par un dossier « MusiMix » dans ton Google Drive. Connecte le même compte Google sur chaque appareil.</p>
          <div class="callout" data-r="sync"></div>
          <div class="row" data-r="sync-btns" style="display:flex;gap:8px;flex-wrap:wrap"></div>
          <details data-r="gid"><summary><b>Identifiant Google</b> <span class="note">(réglage technique, une seule fois)</span></summary>
            <label class="field" style="margin-top:10px">Identifiant client OAuth
              <input type="text" data-r="clientid" value="${esc(p.gdriveClientId || '')}" placeholder="${esc(DEFAULT_CLIENT_ID || '123456-abc.apps.googleusercontent.com')}" autocomplete="off" spellcheck="false"></label>
            <p class="note">Adresse à autoriser chez Google (origine et redirection) : <b>${esc(location.origin)}</b> et <b>${esc(location.origin + location.pathname)}</b></p>
          </details>
        </div>
        <div class="group"><h2>Stockage</h2>
          <p class="note">${est ? `${fmtBytes(est.usage)} utilisés sur cet appareil.` : ''} Les morceaux restent sur l’appareil, même hors ligne. Sans synchronisation : menu d’un morceau → Télécharger le pack, puis l’ouvrir dans MusiMix sur l’autre appareil.</p>
        </div>
        <div class="group"><h2>Raccourcis clavier</h2>
          <p class="note">Espace : lecture · ← → : 5 s · L : boucle · [ ] : vitesse · + − : transposer · M : métronome · F : mode scène · G : grille · Page suivante / précédente : pédale (partie ou morceau suivant)</p>
        </div>
      </main>`;
    this.settingsEl = el;
    this.mount(el);
    const sync = () => {
      el.querySelectorAll('[data-g]').forEach((g) => g.querySelectorAll('[data-v]').forEach((b) => b.classList.toggle('on', b.dataset.v === (p[g.dataset.g] || (g.dataset.g === 'theme' ? 'auto' : 'guitar')))));
      el.querySelector('[data-r="lat"]').textContent = `${p.latency || 0} ms`;
    };
    sync();
    const sy = this.sync;
    const showSync = () => {
      const box = el.querySelector('[data-r="sync"]');
      if (!box) return;
      const last = sy.lastSync ? new Date(sy.lastSync).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '';
      const txt = {
        off: 'Désactivée.',
        noconfig: 'Il manque l’identifiant Google (ci-dessous).',
        idle: `<b>Activée</b>${sy.email ? ' · ' + esc(sy.email) : ''}${last ? ' · dernière synchro : ' + last : ''}${sy.message ? '<br>' + esc(sy.message) : ''}`,
        syncing: `<b>${esc(sy.message || 'Synchronisation…')}</b>`,
        error: `<b>Problème :</b> ${esc(sy.message)}`,
        reconnect: sy.conf.noscope ? `<b>Accès au Drive manquant.</b> ${esc(sy.message)}` : `<b>En pause</b>${sy.email ? ' · ' + esc(sy.email) : ''} : la connexion Google a expiré.`,
      }[sy.state] || '';
      box.innerHTML = txt;
      el.querySelector('[data-r="sync-btns"]').innerHTML = !sy.enabled
        ? `<button class="btn primary" data-act="gconnect">${icon('sync')} Connecter Google Drive</button>`
        : `${sy.state === 'reconnect' ? `<button class="btn primary" data-act="gconnect">Reconnecter</button>` : `<button class="btn" data-act="gsync">${icon('sync')} Synchroniser maintenant</button>`}<button class="btn" data-act="gdisconnect">Déconnecter</button>`;
    };
    showSync();
    sy.addEventListener('change', showSync);
    const prevClose = this.view?.close;
    if (this.view) this.view.close = () => { sy.removeEventListener('change', showSync); prevClose?.(); };
    el.querySelector('[data-r="clientid"]').addEventListener('change', async (e) => { await this.setPref('gdriveClientId', e.target.value.trim()); if (sy.state === 'noconfig') sy.set('off'); toast('Identifiant enregistré'); });
    el.addEventListener('click', async (e) => {
      const v = e.target.closest('[data-v]');
      if (v) {
        const g = v.closest('[data-g]').dataset.g;
        await this.setPref(g, v.dataset.v);
        if (g === 'theme') this.applyTheme(v.dataset.v);
        sync();
      }
      const lat = e.target.closest('[data-lat]');
      if (lat) {
        p.latency = Math.max(0, Math.min(400, (p.latency || 0) + +lat.dataset.lat));
        await this.setPref('latency', p.latency);
        this.engine.userLatency = p.latency / 1000;
        sync();
      }
      const a = e.target.closest('[data-act]')?.dataset.act;
      if (a === 'back') this.go('#/');
      if (a === 'gconnect') { try { await sy.connect(); } catch (err) { toast(err.message, 6000); el.querySelector('[data-r="gid"]').open = true; } }
      if (a === 'gsync') sy.run();
      if (a === 'gdisconnect' && (await confirmBox('Déconnecter Google Drive ?', 'Les morceaux restent sur cet appareil et dans ton Drive ; ils ne se synchroniseront plus ici.', { ok: 'Déconnecter' }))) sy.disconnect();
      if (a === 'studio') this.studioDialog();
    });
  }

  registerSW() {
    if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
    navigator.serviceWorker.register('sw.js').then((reg) => {
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w?.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) toast('Nouvelle version installée : elle sera active au prochain lancement.', 5000);
        });
      });
    }).catch(() => {});
  }
}

function stepLabel(step) {
  return {
    queued: 'En attente…', convert: 'Lecture du fichier…', vocals: 'Séparation de la voix…', instruments: 'Séparation des instruments…',
    lyrics: 'Synchronisation des paroles…', transcribe: 'Transcription des paroles…', chords: 'Recherche des accords…', beats: 'Tempo et mesures…', pack: 'Finalisation…',
  }[step] || '';
}

function fmtBytes(n) {
  if (!n) return '0 Mo';
  return n > 1e9 ? (n / 1e9).toFixed(1).replace('.', ',') + ' Go' : Math.round(n / 1e6) + ' Mo';
}

async function filesFromDrop(dt) {
  const items = [...(dt.items || [])];
  const entries = items.map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...(dt.files || [])];
  const out = [];
  const walk = async (entry) => {
    if (entry.isFile) out.push(await new Promise((res, rej) => entry.file(res, rej)));
    else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch;
      do { batch = await new Promise((res) => reader.readEntries(res, () => res([]))); for (const e of batch) await walk(e); } while (batch.length);
    }
  };
  for (const e of entries) await walk(e);
  return out;
}

const app = new App();
window.musimix = app;
app.start();

export { newSong, STEM_KINDS, parseSheet, docFromSongJson, fillLineEnds };
