// MusiMix Piano — l'école : parcours de méthode (8 niveaux), bibliothèque de morceaux,
// formation musicale (lecture, rythme, oreille, théorie), progression enregistrée.

import { LESSONS, LEVELS, LIBRARY, buildLesson, loadProgress, saveResult, levelStats, nextLesson } from './lessons.js';
import { DRILLS, DRILL_LEVELS, CATS, runDrill } from './drills.js';
import { listMine, getMine, removeMine, addFiles, filesOf } from './mylib.js';
import { loadFiles } from './model.js';
import { getLog, minutesByDay, streak, dayKey, addRun } from './stats.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const LCOL = ['#3fd3dc', '#4cc9f0', '#7aa7ff', '#a78bfa', '#ffb52e', '#ff8a4c', '#ff62b6', '#ff4f7b'];
const DCOL = ['#3fd3dc', '#7aa7ff', '#ffb52e', '#ff8a4c', '#ff62b6'];
const HANDS = { R: 'Main droite', L: 'Main gauche', RL: 'Deux mains' };
const CAT_ICON = {
  read: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M3 7h18M3 11h18M3 15h18M3 19h18"/><ellipse cx="9" cy="15" rx="2.6" ry="1.9" fill="currentColor" transform="rotate(-20 9 15)"/><path d="M11.4 14.6V4"/></svg>',
  rhythm: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><ellipse cx="6" cy="18" rx="2.6" ry="1.9" fill="currentColor"/><ellipse cx="16" cy="16" rx="2.6" ry="1.9" fill="currentColor"/><path d="M8.5 17.5V5l10-2v12.5"/><path d="M8.5 8.5l10-2"/></svg>',
  ear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M7 9a5 5 0 0 1 10 0c0 3-3 3.5-3 6.5a2.5 2.5 0 0 1-5 0"/><path d="M10 9.5a2 2 0 0 1 4 0"/></svg>',
  theory: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H20v3H6.5"/></svg>',
};

const starsHtml = (n) => `<span class="st3">${[1, 2, 3].map((k) => `<i class="${k <= n ? 'on' : ''}">★</i>`).join('')}</span>`;

export function mountSchool(root, app) {
  const el = document.createElement('div');
  el.className = 'school';
  el.hidden = true;
  el.innerHTML = `
    <header class="sc-head">
      <div class="sc-tabs" role="tablist">
        <button data-t="path" class="on">Parcours piano</button>
        <button data-t="lib">Bibliothèque</button>
        <button data-t="fm">Formation musicale</button>
        <button data-t="prog">Progrès</button>
      </div>
      <button class="ib" data-close aria-label="Fermer l’école"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
    </header>
    <div class="sc-body"></div>
    <div class="sc-drill" hidden></div>
    <input type="file" class="my-file" multiple hidden accept=".mid,.midi,.kar,.rmi,.synthesia,.xml,.zip">`;
  root.appendChild(el);
  const body = el.querySelector('.sc-body');
  const drillHost = el.querySelector('.sc-drill');
  let tab = 'path', libFilter = 0, libQuery = '', fmCat = 'all', drillRun = null;
  let mine = [], mineErr = null, confirmDel = null;
  const myInput = el.querySelector('.my-file');
  async function refreshMine() {
    try { mine = await listMine(); mineErr = null; } catch (e) { mine = []; mineErr = e.message || String(e); }
    if (!el.hidden && tab === 'lib') render();
  }
  refreshMine();

  function show(t) {
    if (t) tab = t;
    el.hidden = false;
    app.pause();
    el.querySelectorAll('.sc-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === tab));
    render();
  }
  function hide() { el.hidden = true; drillRun?.stop(); drillRun = null; drillHost.hidden = true; }

  function render() {
    const P = loadProgress();
    if (tab === 'path') body.innerHTML = pathHtml(P);
    else if (tab === 'lib') body.innerHTML = libHtml(P);
    else if (tab === 'prog') body.innerHTML = progHtml(P);
    else body.innerHTML = fmHtml(P);
    body.scrollTop = 0;
  }

  // ── parcours
  function pathHtml(P) {
    const nx = nextLesson(P);
    const done = LESSONS.filter((l) => P[l.id]?.stars >= 1).length;
    const stars = LESSONS.reduce((a, l) => a + (P[l.id]?.stars || 0), 0);
    const pct = Math.round((100 * done) / LESSONS.length);
    const lv = LEVELS.find((x) => x.id === nx.level);
    return `
      <section class="hero2">
        <div class="hero2-txt">
          <h2>Ton parcours</h2>
          <p>Du premier Do jusqu’au répertoire de concert : chaque étape se valide à 75 % de notes justes. Trois étoiles à 97 %, à pleine vitesse et sans « Attendre ».</p>
          <div class="kpis"><div><b>${done}</b><span>étapes validées sur ${LESSONS.length}</span></div><div><b>${stars}</b><span>étoiles</span></div><div><b>${pct} %</b><span>du parcours</span></div></div>
        </div>
        <button class="continue" data-lesson="${nx.id}" style="--c:${LCOL[nx.level - 1]}">
          <small>${done ? 'Continuer' : 'Commencer'} · Niveau ${nx.level} — ${esc(lv.name)}</small>
          <b>${esc(nx.title)}</b>
          <span>${nx.kind === 'song' ? 'Morceau' : 'Exercice'} · ${HANDS[nx.hands]}</span>
          <i class="go">▶</i>
        </button>
      </section>
      <ol class="path">
        ${LEVELS.map((L) => {
          const st = levelStats(L.id, P);
          const items = LESSONS.filter((l) => l.level === L.id);
          return `<li class="lvl ${st.done === st.total ? 'complete' : ''}" style="--c:${LCOL[L.id - 1]}">
            <div class="lvl-node"><span>${L.id}</span></div>
            <div class="lvl-card">
              <div class="lvl-head"><div><small>Niveau ${L.id} · ${esc(L.name)}</small><h3>${esc(L.tag)}</h3><p>${esc(L.goal)}</p></div>
                <div class="lvl-prog"><b>${st.done}/${st.total}</b><span class="pbar"><i style="width:${(100 * st.done) / st.total}%"></i></span></div></div>
              <ul class="items">${items.map((it) => {
                const r = P[it.id];
                return `<li><button class="item ${it.id === nx.id ? 'next' : ''} ${r?.stars ? 'done' : ''}" data-lesson="${it.id}">
                  <i class="kind">${it.kind === 'song' ? '♪' : '◆'}</i>
                  <span class="it-t"><b>${esc(it.title)}</b><small>${it.composer ? esc(it.composer) + ' · ' : ''}${HANDS[it.hands]}</small></span>
                  <span class="it-r">${r ? `<em>${r.best} %</em>` : ''}${starsHtml(r?.stars || 0)}</span></button></li>`;
              }).join('')}</ul>
            </div></li>`;
        }).join('')}
      </ol>`;
  }

  // ── bibliothèque
  function libHtml(P) {
    const q = libQuery.toLowerCase();
    const list = LIBRARY.filter((l) => (!libFilter || l.level === libFilter) && (!q || (l.title + ' ' + (l.composer || '')).toLowerCase().includes(q)));
    return `
      <div class="lib-tools">
        <input type="search" placeholder="Chercher un morceau ou un compositeur" value="${esc(libQuery)}" data-q aria-label="Chercher">
        <div class="chips">${[[0, 'Tous']].concat(LEVELS.map((L) => [L.id, L.name])).filter(([id]) => !id || LIBRARY.some((l) => l.level === id)).map(([id, n]) => `<button class="chip ${libFilter === id ? 'on' : ''}" data-lf="${id}">${esc(n)}</button>`).join('')}</div>
      </div>
      ${libFilter ? '' : myHtml(P, q)}
      ${libFilter ? '' : '<h3 class="lib-h">Morceaux de la méthode</h3>'}
      <div class="lib-grid">${list.map((l) => {
        const r = P[l.id];
        return `<button class="song-card" data-lesson="${l.id}" style="--c:${LCOL[l.level - 1]}">
          <span class="sc-art"><i>♪</i></span>
          <b>${esc(l.title)}</b><small>${esc(l.composer || 'Traditionnel')}</small>
          <span class="sc-meta"><em>Niveau ${l.level} · ${esc(LEVELS[l.level - 1].name)}</em>${starsHtml(r?.stars || 0)}</span>
        </button>`;
      }).join('') || '<p class="muted">Aucun morceau ne correspond.</p>'}</div>
      <p class="muted small lib-note">Les morceaux de la méthode sont du domaine public, arrangés pour l’apprentissage.</p>`;
  }
  function myHtml(P, q) {
    const list = mine.filter((m) => !q || (m.title + ' ' + m.composer).toLowerCase().includes(q));
    if (q && !list.length) return '';
    const dur = (d) => (d ? `${Math.floor(d / 60)} min ${String(Math.round(d % 60)).padStart(2, '0')}` : '');
    return `
      <h3 class="lib-h">Mes morceaux</h3>
      <div class="lib-grid mine">
        ${list.map((m) => {
          const r = P[m.id];
          const del = confirmDel === m.id;
          return `<div class="song-card my ${del ? 'confirm' : ''}" data-my="${m.id}" role="button" tabindex="0" style="--c:#ffb52e">
            <span class="sc-art"><i>♪</i></span>
            <b>${esc(m.title)}</b><small>${esc(m.composer || 'Mon fichier')}${m.duration ? ' · ' + dur(m.duration) : ''}</small>
            <span class="sc-meta"><em>${r ? `Record ${r.best} %` : 'Pas encore joué'}</em>${starsHtml(r?.stars || 0)}</span>
            <button class="my-del" data-mydel="${m.id}" aria-label="Retirer ${esc(m.title)}">${del ? 'Retirer ?' : '×'}</button>
          </div>`;
        }).join('')}
        ${q ? '' : `<button class="song-card add" data-myadd>
          <span class="sc-art"><i>+</i></span>
          <b>Ajouter un morceau</b><small>MIDI (.mid), avec son .synthesia si tu l’as, ou pack MusiMix</small>
        </button>`}
      </div>
      ${mineErr ? `<p class="muted small">Tes morceaux ne peuvent pas être gardés ici (${esc(mineErr)}).</p>` : ''}`;
  }

  async function addMine(files) {
    if (!files?.length) return;
    try {
      const added = await addFiles(files, async (group) => {
        const song = await loadFiles(group);
        const n = song.tracks.reduce((a, t) => a + t.notes.length, 0);
        if (!n) throw new Error(`Pas de notes dans « ${group[0].name} »`);
        return { title: song.synthesia?.title || '', composer: song.artist || '', notes: n, duration: song.duration };
      });
      await refreshMine();
      app.toast(added.length === 1 ? `Ajouté à tes morceaux : ${added[0].title}` : `${added.length} morceaux ajoutés`);
      if (tab !== 'lib') show('lib'); else render();
    } catch (e) { app.toast(e.message || String(e), 6000); }
  }
  myInput.addEventListener('change', () => { addMine([...myInput.files]); myInput.value = ''; });

  async function openMine(id) {
    const rec = await getMine(id).catch(() => null);
    if (!rec) { app.toast('Morceau introuvable'); refreshMine(); return; }
    hide();
    try {
      const song = await loadFiles(filesOf(rec));
      if (!song.title || song.title === rec.files[0].name.replace(/\.[^.]+$/, '')) song.title = rec.title;
      const item = { id: rec.id, title: rec.title, kind: 'song', hands: 'RL', mine: true, tip: `${rec.title} : choisis la main en bas, puis appuie sur lecture.` };
      await app.open(song, {
        lesson: item,
        onResult: (r) => ({ ...saveResult(rec.id, r), next: null }),
        onSchool: () => show('lib'),
      });
    } catch (e) { app.toast('Impossible d’ouvrir : ' + (e.message || e), 6000); }
  }

  // ── progrès : temps de pratique, série de jours, morceaux travaillés
  function progHtml(P) {
    const L = getLog(), M = minutesByDay(L);
    const today = M[dayKey()] || 0;
    const days = [];
    for (let i = 13; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); days.push({ k: dayKey(d), d, m: M[dayKey(d)] || 0 }); }
    const week = days.slice(-7).reduce((a, x) => a + x.m, 0);
    const total = Object.values(M).reduce((a, b) => a + b, 0);
    const st = streak(L);
    const fmtMin = (m) => (m >= 60 ? `${Math.floor(m / 60)} h ${String(Math.round(m % 60)).padStart(2, '0')}` : `${Math.round(m)} min`);
    // barres : minutes par jour (14 jours), une seule série → pas de légende
    const W = 900, H = 200, pad = { l: 34, r: 8, t: 12, b: 24 };
    const max = Math.max(15, ...days.map((x) => x.m));
    const step = max <= 30 ? 10 : max <= 60 ? 15 : max <= 120 ? 30 : 60;
    const top = Math.ceil(max / step) * step;
    const bw = (W - pad.l - pad.r) / days.length;
    const y = (m) => pad.t + (H - pad.t - pad.b) * (1 - m / top);
    const ticks = []; for (let v = 0; v <= top; v += step) ticks.push(v);
    const WD = ['di', 'lu', 'ma', 'me', 'je', 've', 'sa'];
    const bars = days.map((x, i) => {
      const bx = pad.l + i * bw + bw * 0.18, w = bw * 0.64, h = Math.max(0, y(0) - y(x.m));
      const tip = `${x.d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })} : ${x.m >= 1 ? fmtMin(x.m) : 'pas joué'}`;
      return `<g class="pb ${i === days.length - 1 ? 'today' : ''}" data-tip="${esc(tip)}"><rect class="hit" x="${pad.l + i * bw}" y="${pad.t}" width="${bw}" height="${H - pad.t - pad.b}"/>${h > 0.5 ? `<path d="M${bx},${y(0)} V${y(x.m) + Math.min(4, h)} q0,-${Math.min(4, h)} ${Math.min(4, w / 2)},-${Math.min(4, h)} H${bx + w - Math.min(4, w / 2)} q${Math.min(4, w / 2)},0 ${Math.min(4, w / 2)},${Math.min(4, h)} V${y(0)} Z"/>` : ''}<text x="${pad.l + i * bw + bw / 2}" y="${H - 7}">${i === days.length - 1 ? 'auj.' : WD[x.d.getDay()]}</text></g>`;
    }).join('');
    const chart = `<svg class="pchart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Minutes de pratique par jour, 14 derniers jours">
      ${ticks.map((v) => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}"/><text class="ax" x="${pad.l - 6}" y="${y(v) + 4}">${v}</text>`).join('')}
      ${bars}</svg>`;
    // morceaux travaillés : dernier essai, record, courbe de précision
    const byId = new Map();
    for (const r of L.runs) if (r.kind !== 'drill') { const e = byId.get(r.id) || { id: r.id, title: r.title, kind: r.kind, runs: [] }; e.runs.push(r); e.title = r.title; byId.set(r.id, e); }
    const pieces = [...byId.values()].sort((a, b) => b.runs.at(-1).at - a.runs.at(-1).at).slice(0, 12);
    const spark = (runs) => {
      const rs = runs.slice(-20), w = 120, h = 34;
      if (rs.length < 2) return '';
      const X = (i) => 3 + (i * (w - 6)) / (rs.length - 1), Y = (a) => 3 + (h - 6) * (1 - a / 100);
      return `<svg class="spark" viewBox="0 0 ${w} ${h}" aria-hidden="true"><line x1="0" x2="${w}" y1="${Y(75)}" y2="${Y(75)}"/><path d="${rs.map((r, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(r.acc).toFixed(1)}`).join(' ')}"/><circle cx="${X(rs.length - 1)}" cy="${Y(rs.at(-1).acc)}" r="3.5"/></svg>`;
    };
    const ago = (t) => { const d = Math.floor((Date.now() - t) / 864e5); return d <= 0 ? 'aujourd’hui' : d === 1 ? 'hier' : `il y a ${d} jours`; };
    const drills = L.runs.filter((r) => r.kind === 'drill');
    return `
      <section class="prog-kpis">
        <div class="kpi"><small>Aujourd’hui</small><b>${fmtMin(today)}</b></div>
        <div class="kpi"><small>Série</small><b>${st} jour${st > 1 ? 's' : ''}</b><em>${st ? 'au moins 3 min par jour' : 'joue 3 min pour commencer'}</em></div>
        <div class="kpi"><small>7 derniers jours</small><b>${fmtMin(week)}</b></div>
        <div class="kpi"><small>Depuis le début</small><b>${fmtMin(total)}</b><em>${L.runs.length} essai${L.runs.length > 1 ? 's' : ''}</em></div>
      </section>
      <section class="prog-card"><h3>Temps de pratique</h3><p class="muted small">Minutes par jour, sur 14 jours (musique en lecture ou clavier joué).</p><div class="pchart-wrap">${chart}<div class="ptip" hidden></div></div></section>
      <section class="prog-card"><h3>Morceaux travaillés</h3>
        ${pieces.length ? `<ul class="pieces">${pieces.map((e) => {
          const last = e.runs.at(-1), best = Math.max(...e.runs.map((r) => r.acc));
          const open = e.kind === 'lesson' ? `data-lesson="${esc(e.id)}"` : e.kind === 'mine' ? `data-my="${esc(e.id)}"` : '';
          return `<li><button class="piece" ${open} ${open ? '' : 'disabled'}><span class="pc-t"><b>${esc(e.title)}</b><small>${e.runs.length} essai${e.runs.length > 1 ? 's' : ''} · ${ago(last.at)}${last.rate < 0.999 ? ` · ${Math.round(last.rate * 100)} %` : ''}</small></span>${spark(e.runs)}<span class="pc-n"><b>${last.acc} %</b><small>record ${best} %</small></span></button></li>`;
        }).join('')}</ul>` : '<p class="muted">Joue un morceau jusqu’au bout pour voir ta progression ici.</p>'}
      </section>
      ${drills.length ? `<section class="prog-card"><h3>Formation musicale</h3><p class="muted small">${drills.length} série${drills.length > 1 ? 's' : ''} · moyenne ${Math.round(drills.reduce((a, r) => a + r.acc, 0) / drills.length)} % · dernière ${ago(drills.at(-1).at)}</p></section>` : ''}
      <p class="muted small lib-note">Ta progression est gardée sur cet appareil. Si la synchronisation Google Drive est activée dans MusiMix, elle est partagée avec tes autres appareils à chaque ouverture de MusiMix.</p>`;
  }

  // ── formation musicale
  function fmHtml(P) {
    const cats = Object.keys(CATS);
    const sugg = cats.map((c) => DRILLS.find((d) => d.cat === c && !(P[d.id]?.stars >= 1))).filter(Boolean);
    return `
      <section class="fm-intro">
        <div><h2>Formation musicale</h2><p>Lecture de notes, rythme, oreille et théorie, de l’éveil au niveau professionnel. Dix questions par série, toujours différentes. Réponds à l’écran, ou en jouant sur ta P-95.</p></div>
        <div class="fm-sugg">${sugg.map((d) => `<button class="sugg" data-drill="${d.id}" style="--c:${DCOL[d.level - 1]}"><i class="ci">${CAT_ICON[d.cat]}</i><span><small>${CATS[d.cat]}</small><b>${esc(d.title)}</b></span></button>`).join('')}</div>
      </section>
      <div class="chips fm-cats">${[['all', 'Tout']].concat(Object.entries(CATS)).map(([k, n]) => `<button class="chip ${fmCat === k ? 'on' : ''}" data-fc="${k}">${esc(n)}</button>`).join('')}</div>
      ${cats.filter((c) => fmCat === 'all' || fmCat === c).map((c) => `
        <section class="fm-cat"><h3><i class="ci">${CAT_ICON[c]}</i>${CATS[c]}</h3>
          <div class="fm-grid">${DRILLS.filter((d) => d.cat === c).map((d) => {
            const r = P[d.id];
            return `<button class="drill-card" data-drill="${d.id}" style="--c:${DCOL[d.level - 1]}">
              <span class="lvl-pill">${DRILL_LEVELS[d.level - 1]}</span>
              <b>${esc(d.title)}</b><small>${esc(d.desc)}</small>
              <span class="dc-r">${r ? `<em>${r.best} %</em>` : '<em class="new">Nouveau</em>'}${starsHtml(r?.stars || 0)}</span>
            </button>`;
          }).join('')}</div></section>`).join('')}`;
  }

  // ── ouverture d'une leçon / d'un exercice
  async function openLesson(id) {
    const item = LESSONS.find((l) => l.id === id);
    if (!item) return;
    hide();
    const P = loadProgress();
    const song = buildLesson(item);
    await app.open(song, {
      lesson: item,
      wait: !(P[item.id]?.stars >= 1) && item.level <= 3 ? true : undefined,
      onResult: (r) => {
        const res = saveResult(item.id, r);
        const i = LESSONS.indexOf(item);
        return { ...res, next: res.newStars >= 1 ? LESSONS[i + 1] : null };
      },
      onNext: () => { const i = LESSONS.indexOf(item); if (LESSONS[i + 1]) openLesson(LESSONS[i + 1].id); },
      onSchool: () => show('path'),
    });
  }

  function openDrill(id) {
    const d = DRILLS.find((x) => x.id === id);
    if (!d) return;
    drillHost.hidden = false;
    drillRun?.stop();
    drillRun = runDrill(drillHost, d, {
      audio: app.audio, synth: app.synth, notes: app.notes, press: app.press,
      onDone: (r) => { addRun({ id: d.id, title: d.title, kind: 'drill', acc: r.accuracy }); return saveResult(d.id, { accuracy: r.accuracy, wait: false, rate: 1, hit: r.score, wrong: r.count - r.score, miss: 0 }); },
      onClose: () => { drillRun?.stop(); drillRun = null; drillHost.hidden = true; render(); },
    });
  }

  el.addEventListener('click', (e) => {
    const t = e.target.closest('[data-t]')?.dataset.t;
    if (t) { show(t); return; }
    if (e.target.closest('[data-close]')) { hide(); return; }
    const del = e.target.closest('[data-mydel]')?.dataset.mydel;
    if (del) {
      if (confirmDel === del) { confirmDel = null; removeMine(del).then(refreshMine); }
      else { confirmDel = del; render(); setTimeout(() => { if (confirmDel === del) { confirmDel = null; if (tab === 'lib' && !el.hidden) render(); } }, 3500); }
      return;
    }
    if (e.target.closest('[data-myadd]')) { myInput.click(); return; }
    const my = e.target.closest('[data-my]')?.dataset.my;
    if (my) { openMine(my); return; }
    const ls = e.target.closest('[data-lesson]')?.dataset.lesson;
    if (ls) { openLesson(ls); return; }
    const dr = e.target.closest('[data-drill]')?.dataset.drill;
    if (dr) { openDrill(dr); return; }
    const lf = e.target.closest('[data-lf]')?.dataset.lf;
    if (lf != null) { libFilter = +lf; render(); return; }
    const fc = e.target.closest('[data-fc]')?.dataset.fc;
    if (fc) { fmCat = fc; render(); }
  });
  body.addEventListener('pointermove', (e) => {
    const tipEl = body.querySelector('.ptip');
    if (!tipEl) return;
    const g = e.target.closest?.('.pb');
    if (!g) { tipEl.hidden = true; return; }
    const r = body.querySelector('.pchart-wrap').getBoundingClientRect();
    tipEl.textContent = g.dataset.tip; tipEl.hidden = false;
    tipEl.style.left = Math.min(r.width - 10, Math.max(10, e.clientX - r.left)) + 'px'; tipEl.style.top = (e.clientY - r.top - 12) + 'px';
  });
  body.addEventListener('pointerleave', () => { const t = body.querySelector('.ptip'); if (t) t.hidden = true; });
  el.addEventListener('input', (e) => {
    if (e.target.matches('[data-q]')) {
      libQuery = e.target.value;
      const pos = e.target.selectionStart;
      render();
      const inp = body.querySelector('[data-q]'); inp.focus(); inp.setSelectionRange(pos, pos);
    }
  });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !el.hidden) { if (!drillHost.hidden) { drillRun?.stop(); drillRun = null; drillHost.hidden = true; render(); } else hide(); } });

  el.addEventListener('keydown', (e) => { const my = e.target.closest?.('[data-my]'); if (my && (e.key === 'Enter' || e.key === ' ') && e.target === my) { e.preventDefault(); openMine(my.dataset.my); } });
  // glisser-déposer des fichiers sur l'école : ajout à « Mes morceaux »
  el.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); });
  el.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); document.body.classList.remove('drop-on'); addMine([...e.dataTransfer.files]); });

  return { show, hide, openLesson, openDrill, openMine, addMine, refreshMine };
}
