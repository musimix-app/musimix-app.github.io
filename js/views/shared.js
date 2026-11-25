// MusiMix — page « Morceaux partagés » : ouverte depuis un lien #/partage/<dossier>,
// elle liste les morceaux qu'une autre personne partage et les ajoute à la bibliothèque (sans compte).

import { db } from '../db.js';
import { esc, icon, fmtTime, toast } from '../ui.js';
import { readShare, fetchShareFile } from '../sync.js';

export class SharedView {
  constructor(app) { this.app = app; this.busy = new Set(); }

  async open(folderId) {
    this.folder = folderId;
    const el = document.createElement('section');
    el.className = 'view';
    el.innerHTML = `
      <header class="topbar"><button class="icon-btn" data-act="back" aria-label="Retour">${icon('back')}</button><div class="song-title"><b>Morceaux partagés</b></div></header>
      <main class="settings shared-view"><div data-r="body"><p class="note">Lecture du partage…</p></div></main>`;
    this.el = el;
    this.app.mount(el);
    el.addEventListener('click', (e) => this.onClick(e));
    await this.load();
  }

  close() { this.el?.remove(); this.el = null; }

  async load() {
    const body = this.el.querySelector('[data-r="body"]');
    try {
      this.index = await readShare(this.folder);
    } catch (e) {
      body.innerHTML = `<div class="callout"><b>Partage indisponible.</b> ${esc(e.message)}</div>`;
      return;
    }
    await this.render();
  }

  async status(item) {
    const local = await db.getSong(item.id);
    if (!local) return 'new';
    if (!local.sharedFrom) return 'mine';
    return (local.sharedFrom.upd || 0) < item.upd ? 'update' : 'ok';
  }

  async render() {
    if (!this.el) return;
    const body = this.el.querySelector('[data-r="body"]');
    const items = this.index.songs || [];
    if (!items.length) { body.innerHTML = '<div class="callout">Ce partage ne contient aucun morceau pour l’instant.</div>'; return; }
    const st = await Promise.all(items.map((it) => this.status(it)));
    const todo = items.filter((_, i) => st[i] === 'new' || st[i] === 'update').length;
    body.innerHTML = `
      <div class="group">
        <p class="note">${items.length} morceau${items.length > 1 ? 'x' : ''} partagé${items.length > 1 ? 's' : ''} avec toi : paroles, accords, minutage et pistes. Une fois ajoutés, ils restent dans ta bibliothèque, même hors ligne ; reviens sur ce lien pour récupérer les mises à jour.</p>
        ${todo > 1 ? `<p><button class="btn primary" data-act="all">${icon('download')} Tout ajouter (${todo})</button></p>` : ''}
        <ul class="songs">${items.map((it, i) => {
          const s = st[i];
          const mb = Math.round(it.stems.reduce((n, x) => n + (x.size || 0), 0) / 1e6);
          const btn = this.busy.has(it.id) ? '<span class="note">Ajout…</span>'
            : s === 'new' ? `<button class="btn small primary" data-add="${esc(it.id)}">${icon('plus')} Ajouter</button>`
            : s === 'update' ? `<button class="btn small" data-add="${esc(it.id)}">${icon('sync')} Mettre à jour</button>`
            : s === 'mine' ? '<span class="note">C’est ton morceau</span>'
            : `<button class="btn small ghost" data-open="${esc(it.id)}">${icon('play')} Ouvrir</button>`;
          return `<li class="song-row"><div class="t"><b>${esc(it.title || 'Sans titre')}</b><span>${esc(it.artist || '—')}</span></div>
            <div class="meta"><span class="dur">${it.duration ? fmtTime(it.duration) : ''}</span><span class="note">${it.stems.length > 1 ? it.stems.length + ' pistes' : ''}${mb ? ' · ' + mb + ' Mo' : ''}</span></div>${btn}</li>`;
        }).join('')}</ul>
      </div>`;
  }

  async onClick(e) {
    const a = e.target.closest('[data-act]')?.dataset.act;
    if (a === 'back') { this.app.go('#/'); return; }
    const add = e.target.closest('[data-add]');
    if (add) { await this.add(add.dataset.add); return; }
    const op = e.target.closest('[data-open]');
    if (op) { this.app.go(`#/play/${op.dataset.open}`); return; }
    if (a === 'all') {
      for (const it of this.index.songs) { const s = await this.status(it); if (s === 'new' || s === 'update') await this.add(it.id, true); }
      toast('Morceaux ajoutés à ta bibliothèque');
    }
  }

  async add(id, quiet = false) {
    const it = this.index.songs.find((x) => x.id === id);
    if (!it || this.busy.has(id)) return;
    this.busy.add(id);
    this.render();
    try {
      const song = await fetchShareFile(it.json);
      const files = new Map(it.stems.map((x) => [x.bid, x.file]));
      for (const st of song.stems || []) {
        if (!st.blobId || (await db.getBlob(st.blobId))) continue;
        const fid = files.get(st.blobId);
        if (!fid) continue;
        const blob = await fetchShareFile(fid, 'blob');
        await db.putBlob(st.mime && blob.type !== st.mime ? new Blob([blob], { type: st.mime }) : blob, st.blobId);
      }
      const local = await db.getSong(id);
      if (local && !local.sharedFrom) throw new Error('Un morceau avec le même identifiant existe déjà');
      // une mise à jour garde les réglages de la personne (mixage, transposition…)
      if (local) { song.mix = local.mix || song.mix; song.prefs = local.prefs || song.prefs; song.playCount = local.playCount; }
      for (const st of local?.stems || []) if (st.blobId && !(song.stems || []).some((x) => x.blobId === st.blobId)) await db.deleteBlob(st.blobId);
      song.sharedFrom = { folder: this.folder, upd: it.upd, at: Date.now() };
      delete song.shared;
      await db.putSong(song);
      if (!quiet) toast(`Ajouté : ${song.title}`);
    } catch (err) {
      console.error(err);
      toast(`« ${it.title} » : ${err.message}`, 6000);
    } finally {
      this.busy.delete(id);
      this.render();
    }
  }
}
