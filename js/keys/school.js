// MusiMix Piano — l'école : parcours de méthode (8 niveaux), bibliothèque de morceaux,
// formation musicale (lecture, rythme, oreille, théorie), progression enregistrée.

import { LESSONS, LEVELS, LIBRARY, buildLesson, loadProgress, saveResult, levelStats, nextLesson } from './lessons.js';
import { DRILLS, DRILL_LEVELS, CATS, runDrill } from './drills.js';

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
      </div>
      <button class="ib" data-close aria-label="Fermer l’école"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
    </header>
    <div class="sc-body"></div>
    <div class="sc-drill" hidden></div>`;
  root.appendChild(el);
  const body = el.querySelector('.sc-body');
  const drillHost = el.querySelector('.sc-drill');
  let tab = 'path', libFilter = 0, libQuery = '', fmCat = 'all', drillRun = null;

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
      <div class="lib-grid">${list.map((l) => {
        const r = P[l.id];
        return `<button class="song-card" data-lesson="${l.id}" style="--c:${LCOL[l.level - 1]}">
          <span class="sc-art"><i>♪</i></span>
          <b>${esc(l.title)}</b><small>${esc(l.composer || 'Traditionnel')}</small>
          <span class="sc-meta"><em>Niveau ${l.level} · ${esc(LEVELS[l.level - 1].name)}</em>${starsHtml(r?.stars || 0)}</span>
        </button>`;
      }).join('') || '<p class="muted">Aucun morceau ne correspond.</p>'}</div>
      <p class="muted small lib-note">Tous les morceaux sont du domaine public, arrangés pour la méthode. Tes propres fichiers (MIDI, .synthesia, packs MusiMix) s’ouvrent avec le bouton d’ouverture en haut.</p>`;
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
      onDone: (r) => saveResult(d.id, { accuracy: r.accuracy, wait: false, rate: 1, hit: r.score, wrong: r.count - r.score, miss: 0 }),
      onClose: () => { drillRun?.stop(); drillRun = null; drillHost.hidden = true; render(); },
    });
  }

  el.addEventListener('click', (e) => {
    const t = e.target.closest('[data-t]')?.dataset.t;
    if (t) { show(t); return; }
    if (e.target.closest('[data-close]')) { hide(); return; }
    const ls = e.target.closest('[data-lesson]')?.dataset.lesson;
    if (ls) { openLesson(ls); return; }
    const dr = e.target.closest('[data-drill]')?.dataset.drill;
    if (dr) { openDrill(dr); return; }
    const lf = e.target.closest('[data-lf]')?.dataset.lf;
    if (lf != null) { libFilter = +lf; render(); return; }
    const fc = e.target.closest('[data-fc]')?.dataset.fc;
    if (fc) { fmCat = fc; render(); }
  });
  el.addEventListener('input', (e) => {
    if (e.target.matches('[data-q]')) {
      libQuery = e.target.value;
      const pos = e.target.selectionStart;
      render();
      const inp = body.querySelector('[data-q]'); inp.focus(); inp.setSelectionRange(pos, pos);
    }
  });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !el.hidden) { if (!drillHost.hidden) { drillRun?.stop(); drillRun = null; drillHost.hidden = true; render(); } else hide(); } });

  return { show, hide, openLesson, openDrill };
}
