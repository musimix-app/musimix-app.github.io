// MusiMix — synchronisation automatique par Google Drive.
//
// Dans le Drive : un dossier « MusiMix » créé par l'appli (droit drive.file : l'appli ne voit
// que ce qu'elle a créé elle-même), avec :
//   morceau-<id>.json   la fiche d'un morceau (paroles, accords, mixage…), appProperties {sid, upd, del}
//   audio-<blobId>      une piste audio (jamais modifiée : téléversée une seule fois), appProperties {bid}
//   setlists.json       toutes les setlists + les setlists supprimées
// Règle : pour chaque morceau, la version la plus récente gagne (updatedAt, ou date de suppression).
//
// Connexion : OAuth Google « implicite » par redirection (pas de serveur). Le jeton dure 1 h ;
// à l'ouverture de l'appli, s'il a expiré, un aller-retour éclair chez Google le renouvelle.

import { db, dbEvents } from './db.js';

// Identifiant client OAuth (Google Cloud → Identifiants). Peut aussi être collé dans Réglages.
export const DEFAULT_CLIENT_ID = '408370398326-3l1jrt7rhtd1sp3isfe55br0t1shp6am.apps.googleusercontent.com';

const SCOPE = 'https://www.googleapis.com/auth/drive.file email';
const API = 'https://www.googleapis.com/drive/v3';
const UP = 'https://www.googleapis.com/upload/drive/v3';
const LS = 'musimix-gdrive';

const lsGet = () => { try { return JSON.parse(localStorage.getItem(LS) || '{}'); } catch { return {}; } };
const lsSet = (o) => { try { localStorage.setItem(LS, JSON.stringify(o)); } catch { /* */ } };

export class Sync extends EventTarget {
  constructor(app) {
    super();
    this.app = app;
    this.state = 'off';        // off | idle | syncing | error | reconnect | noconfig
    this.message = '';
    this.running = null;
    this.again = false;
    this.timer = null;
  }

  get conf() { return lsGet(); }
  get enabled() { return !!this.conf.enabled; }
  get email() { return this.conf.email || ''; }
  get lastSync() { return this.conf.last || 0; }

  async clientId() { return ((await this.app.prefs()).gdriveClientId || DEFAULT_CLIENT_ID || '').trim(); }

  set(state, message = '') { this.state = state; this.message = message; this.dispatchEvent(new Event('change')); }

  tokenValid() { const c = this.conf; return !!c.token && c.exp > Date.now() + 60_000; }

  /**
   * À appeler au tout début du démarrage, avant la navigation : récupère le jeton renvoyé par
   * Google dans l'adresse (#access_token=…) et remet l'adresse de départ. Renvoie true si
   * l'appli part chez Google pour renouveler le jeton (ne rien afficher dans ce cas).
   */
  async boot() {
    const h = location.hash;
    if (/[#&](access_token|error)=/.test(h) && /state=/.test(h)) {
      const p = new URLSearchParams(h.slice(1));
      let st = {};
      try { st = JSON.parse(p.get('state') || '{}'); } catch { /* */ }
      const c = this.conf;
      if (st.n && st.n === c.nonce) {
        if (p.get('access_token')) {
          c.token = p.get('access_token');
          c.exp = Date.now() + (+p.get('expires_in') || 3600) * 1000;
          c.enabled = true;
          c.reconnect = false;
          lsSet(c);
          if (!c.email) this.fetchEmail();
        } else {
          c.reconnect = true;  // prompt=none refusé : il faudra toucher « Reconnecter »
          lsSet(c);
        }
      }
      history.replaceState(null, '', location.pathname + (st.r || '#/'));
    }
    dbEvents.addEventListener('change', () => this.schedule());
    window.addEventListener('online', () => this.schedule(500));
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') this.schedule(1500); });
    if (!this.enabled) { this.set('off'); return false; }
    if (!(await this.clientId())) { this.set('noconfig'); return false; }
    if (this.tokenValid()) { this.schedule(800); return false; }
    // jeton expiré : renouvellement silencieux, une fois par ouverture, seulement en ligne
    if (!this.conf.reconnect && navigator.onLine && !sessionStorage.getItem('musimix-gdrive-try')) {
      sessionStorage.setItem('musimix-gdrive-try', '1');
      await this.connect({ silent: true });
      return true;
    }
    this.set('reconnect', 'Touche pour reprendre la synchro');
    return false;
  }

  /** Part chez Google (page entière) ; revient sur l'appli avec le jeton. */
  async connect({ silent = false } = {}) {
    const id = await this.clientId();
    if (!id) { this.set('noconfig'); throw new Error('Identifiant Google manquant (Réglages → Synchronisation).'); }
    const c = this.conf;
    c.nonce = Math.random().toString(36).slice(2);
    lsSet(c);
    const q = new URLSearchParams({
      client_id: id,
      redirect_uri: location.origin + location.pathname,
      response_type: 'token',
      scope: SCOPE,
      include_granted_scopes: 'true',
      state: JSON.stringify({ n: c.nonce, r: location.hash && !/access_token|error=/.test(location.hash) ? location.hash : '#/' }),
    });
    if (silent) q.set('prompt', 'none');
    if (c.email) q.set('login_hint', c.email);
    location.assign('https://accounts.google.com/o/oauth2/v2/auth?' + q);
  }

  disconnect() {
    const c = this.conf;
    if (c.token) fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(c.token), { method: 'POST' }).catch(() => {});
    lsSet({});
    this.set('off');
  }

  async fetchEmail() {
    try {
      const r = await this.api('https://www.googleapis.com/oauth2/v3/userinfo');
      const c = this.conf; c.email = r.email || ''; lsSet(c); this.dispatchEvent(new Event('change'));
    } catch { /* */ }
  }

  schedule(ms = 4000) {
    if (!this.enabled) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.run(), ms);
  }

  /** Lance une synchro (ou en programme une autre si une est en cours). */
  async run() {
    if (!this.enabled) return;
    if (this.running) { this.again = true; return this.running; }
    if (!navigator.onLine) { this.set('idle', 'Hors ligne : synchro à la reconnexion'); return; }
    if (!this.tokenValid()) { this.set('reconnect', 'Touche pour reprendre la synchro'); return; }
    this.running = this.pass().then(
      (n) => {
        const c = this.conf; c.last = Date.now(); lsSet(c);
        this.set('idle', n ? `${n} changement${n > 1 ? 's' : ''} synchronisé${n > 1 ? 's' : ''}` : '');
        if (n) this.dispatchEvent(new Event('pulled'));
      },
      (e) => {
        console.warn('[sync]', e);
        if (e.status === 401) { const c = this.conf; c.exp = 0; lsSet(c); this.set('reconnect', 'Touche pour reprendre la synchro'); }
        else this.set('error', e.message || 'Erreur de synchro');
      },
    ).finally(() => {
      this.running = null;
      if (this.again) { this.again = false; this.schedule(1000); } else if (this.deferred) this.schedule(30_000);
    });
    return this.running;
  }

  // ───────────────────────────────────────────── Drive ──

  async api(url, opts = {}, kind = 'json') {
    const r = await fetch(url, { ...opts, headers: { Authorization: 'Bearer ' + this.conf.token, ...(opts.headers || {}) } });
    if (!r.ok) {
      let msg = `Google Drive : erreur ${r.status}`;
      try { const j = await r.json(); if (j.error?.message) msg += ' – ' + j.error.message; } catch { /* */ }
      const err = new Error(msg); err.status = r.status; throw err;
    }
    if (kind === 'none' || r.status === 204) return null;
    return kind === 'blob' ? r.blob() : r.json();
  }

  async folder() {
    const c = this.conf;
    if (c.folder) {
      try { const f = await this.api(`${API}/files/${c.folder}?fields=id,trashed`); if (!f.trashed) return c.folder; } catch (e) { if (e.status !== 404) throw e; }
    }
    const q = encodeURIComponent("name='MusiMix' and mimeType='application/vnd.google-apps.folder' and trashed=false");
    const r = await this.api(`${API}/files?q=${q}&fields=files(id)&spaces=drive&orderBy=createdTime`);
    const id = r.files[0]?.id || (await this.api(`${API}/files?fields=id`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'MusiMix', mimeType: 'application/vnd.google-apps.folder' }),
    })).id;
    const c2 = this.conf; c2.folder = id; lsSet(c2);
    return id;
  }

  async listAll(folder) {
    const out = [];
    let page = '';
    do {
      const q = encodeURIComponent(`'${folder}' in parents and trashed=false`);
      const r = await this.api(`${API}/files?q=${q}&fields=nextPageToken,files(id,name,appProperties)&pageSize=1000&spaces=drive${page ? '&pageToken=' + page : ''}`);
      out.push(...r.files);
      page = r.nextPageToken || '';
    } while (page);
    return out;
  }

  /** Crée (fileId absent) ou remplace un fichier ; petits fichiers : envoi en une fois. */
  async putSmall({ fileId, name, folder, appProperties, data }) {
    const meta = fileId ? { appProperties } : { name, parents: [folder], appProperties, mimeType: 'application/json' };
    const b = 'musimix' + Math.random().toString(36).slice(2);
    const body = new Blob([
      `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`,
      `--${b}\r\nContent-Type: application/json\r\n\r\n`, data, `\r\n--${b}--`,
    ]);
    return this.api(`${UP}/files${fileId ? '/' + fileId : ''}?uploadType=multipart&fields=id`, {
      method: fileId ? 'PATCH' : 'POST', headers: { 'Content-Type': `multipart/related; boundary=${b}` }, body,
    });
  }

  /** Téléversement d'un fichier audio (envoi « reprenable », pour les gros fichiers). */
  async putAudio({ name, folder, appProperties, blob }) {
    const r = await fetch(`${UP}/files?uploadType=resumable&fields=id`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + this.conf.token, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': blob.type || 'application/octet-stream' },
      body: JSON.stringify({ name, parents: [folder], appProperties, mimeType: blob.type || 'application/octet-stream' }),
    });
    if (!r.ok) { const e = new Error(`Google Drive : envoi refusé (${r.status})`); e.status = r.status; throw e; }
    const loc = r.headers.get('Location');
    const up = await fetch(loc, { method: 'PUT', headers: { 'Content-Type': blob.type || 'application/octet-stream' }, body: blob });
    if (!up.ok) { const e = new Error(`Google Drive : envoi audio interrompu (${up.status})`); e.status = up.status; throw e; }
    return up.json();
  }

  // ───────────────────────────────────────────── une passe ──

  async pass() {
    this.set('syncing', 'Synchronisation…');
    const folder = await this.folder();
    const files = await this.listAll(folder);
    const rSongs = new Map(), rAudio = new Map();
    let rSets = null;
    for (const f of files) {
      const ap = f.appProperties || {};
      if (ap.sid) rSongs.set(ap.sid, { id: f.id, upd: +ap.upd || 0, del: ap.del === '1' });
      else if (ap.bid) rAudio.set(ap.bid, f.id);
      else if (f.name === 'setlists.json') rSets = f;
    }
    const local = new Map((await db.allSongs()).map((s) => [s.id, s]));
    const tombs = await db.get('syncTombs', {});
    const openId = this.app.view?.song?.id;  // morceau ouvert : on ne le remplace pas sous les pieds
    let n = 0;
    this.deferred = false;

    const ids = new Set([...local.keys(), ...Object.keys(tombs.songs || {}), ...rSongs.keys()]);
    for (const id of ids) {
      const L = local.get(id);
      const lt = L ? L.updatedAt || 0 : tombs.songs?.[id] || 0;
      const R = rSongs.get(id);
      const rt = R?.upd || 0;
      if (lt > rt) {
        // ── envoi
        if (!L) {
          if (!R || R.del) continue;
          const old = await this.api(`${API}/files/${R.id}?alt=media`).catch(() => null);
          for (const st of old?.stems || []) {
            const fid = rAudio.get(st.blobId);
            if (fid && ![...local.values()].some((s) => s.stems?.some((x) => x.blobId === st.blobId))) { await this.api(`${API}/files/${fid}`, { method: 'DELETE' }, 'none').catch(() => {}); rAudio.delete(st.blobId); }
          }
          await this.putSmall({ fileId: R.id, appProperties: { sid: id, upd: String(lt), del: '1' }, data: JSON.stringify({ id, deleted: true, updatedAt: lt }) });
        } else {
          for (const st of L.stems || []) {
            if (!st.blobId || rAudio.has(st.blobId)) continue;
            const blob = await db.getBlob(st.blobId);
            if (!blob) continue;
            this.set('syncing', `Envoi de « ${L.title || 'morceau'} »…`);
            const f = await this.putAudio({ name: `audio-${st.blobId}`, folder, appProperties: { bid: st.blobId }, blob });
            rAudio.set(st.blobId, f.id);
          }
          await this.putSmall({ fileId: R?.id, name: `morceau-${id}.json`, folder, appProperties: { sid: id, upd: String(lt), del: '0' }, data: JSON.stringify(L) });
        }
        n++;
      } else if (rt > lt) {
        // ── réception
        if (id === openId) { this.deferred = true; continue; }
        if (R.del) {
          if (L) { await db.deleteSongRaw(id); n++; }
          tombs.songs = { ...(tombs.songs || {}), [id]: rt };
          continue;
        }
        const S = await this.api(`${API}/files/${R.id}?alt=media`);
        if (!S?.id) continue;
        for (const st of S.stems || []) {
          if (!st.blobId || (await db.getBlob(st.blobId))) continue;
          const fid = rAudio.get(st.blobId);
          if (!fid) continue;
          this.set('syncing', `Réception de « ${S.title || 'morceau'} »…`);
          const blob = await this.api(`${API}/files/${fid}?alt=media`, {}, 'blob');
          await db.putBlob(st.mime && blob.type !== st.mime ? new Blob([blob], { type: st.mime }) : blob, st.blobId);
        }
        // pistes retirées ailleurs : on libère la place ici
        for (const st of L?.stems || []) if (st.blobId && !S.stems?.some((x) => x.blobId === st.blobId)) await db.deleteBlob(st.blobId);
        S.updatedAt = rt;
        await db.putSongRaw(S);
        if (tombs.songs?.[id]) delete tombs.songs[id];
        n++;
      }
    }

    // ── setlists : fusion élément par élément
    const remote = rSets ? await this.api(`${API}/files/${rSets.id}?alt=media`).catch(() => null) : null;
    const rItems = remote?.items || {}, rTombs = remote?.tombs || {};
    const lItems = Object.fromEntries((await db.allSetlists()).map((s) => [s.id, s]));
    const lTombs = tombs.setlists || {};
    const mItems = {}, mTombs = {};
    let changedLocal = false, changedRemote = !rSets;
    for (const id of new Set([...Object.keys(rItems), ...Object.keys(rTombs), ...Object.keys(lItems), ...Object.keys(lTombs)])) {
      const cands = [
        lItems[id] && { t: lItems[id].updatedAt || 0, v: lItems[id], src: 'l' },
        lTombs[id] && { t: lTombs[id], del: true, src: 'l' },
        rItems[id] && { t: rItems[id].updatedAt || 0, v: rItems[id], src: 'r' },
        rTombs[id] && { t: rTombs[id], del: true, src: 'r' },
      ].filter(Boolean).sort((a, b) => b.t - a.t || (a.del ? -1 : 1));
      const w = cands[0];
      if (w.del) mTombs[id] = w.t; else mItems[id] = w.v;
      const lNow = lItems[id] ? (lItems[id].updatedAt || 0) : lTombs[id] ? -lTombs[id] : null;
      const lWant = w.del ? -w.t : w.t;
      if (lNow !== lWant) {
        changedLocal = true;
        if (w.del) { if (lItems[id]) await db.deleteSetlistRaw(id); } else await db.putSetlistRaw(w.v);
      }
      const rNow = rItems[id] ? (rItems[id].updatedAt || 0) : rTombs[id] ? -rTombs[id] : null;
      if (rNow !== lWant) changedRemote = true;
    }
    tombs.setlists = mTombs;
    await db.set('syncTombs', tombs);
    if (changedRemote) await this.putSmall({ fileId: rSets?.id, name: 'setlists.json', folder, appProperties: { kind: 'setlists' }, data: JSON.stringify({ items: mItems, tombs: mTombs }) });
    if (changedLocal || changedRemote) n++;
    return n;
  }
}
