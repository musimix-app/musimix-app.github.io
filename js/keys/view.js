// MusiMix Piano — vue complète : cascade + clavier, lecture (audio MusiMix + notes MIDI),
// mixage de toutes les pistes, entraînement avec le clavier MIDI, paroles et grille d'accords.
// mountKeys(root, { soundsBase }) → { open(song), destroy() }

import { Engine } from '../engine.js';
import { midi } from '../midi-input.js';
import { KeysRoll, PALETTE, lowerBound, hexA, noteLabel } from './roll.js';
import { KeysSynth } from './synth.js';
import { Transport, Practice, TOLERANCE } from './practice.js';
import { INSTRUMENTS, DRUM_KITS, CREDITS, instrumentForProgram } from './sounds.js';
import { ROLE_LABELS, makeGridTrack } from './model.js';
import { addTime, addRun } from './stats.js';

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (t) => { t = Math.max(0, t); const m = Math.floor(t / 60), s = Math.floor(t % 60); return `${m}:${String(s).padStart(2, '0')}`; };
const store = {
  get(k, d) { try { const v = localStorage.getItem('mmx-piano:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('mmx-piano:' + k, JSON.stringify(v)); } catch { /* aperçu sans stockage */ } },
};

const DEFAULTS = {
  sectAuto: true, sectStart: 0.6,
  mode: 'listen', wait: false, rate: 1, look: 3.2, labels: 'c', range: 'auto', tol: 'normal', latency: 0,
  liveSound: true, noteNames: false, chordsMode: 'auto', fx: 'auto', liveInst: 'grand', liveVol: 0.9, hearMine: 0.35, metronome: false, metroVol: 0.5, velCurve: 'normal', master: 0.9, showPedal: true,
};

const STEM_COL = { vocals: '#ff62b6', backing: '#ff9bcf', drums: '#ffb52e', bass: '#ff8a4c', guitar: '#3fd3dc', piano: '#7aa7ff', other: '#9aa0ab', instrumental: '#3fd3dc', mix: '#9aa0ab', take: '#e5484d' };

export function mountKeys(root, { soundsBase = 'sounds/' } = {}) {
  const S = { ...DEFAULTS, ...store.get('settings', {}) };
  const saveSettings = () => store.set('settings', S);
  const el = {
    stage: $('#stage', root), canvas: $('#roll', root), play: $('#btn-play', root), time: $('#time', root), seek: $('#seek', root),
    seekFill: $('#seek-fill', root), seekMarks: $('#seek-marks', root), loopZone: $('#seek-loop', root),
    chordNow: $('#chord-now', root), chordNext: $('#chord-next', root), lyrics: $('#lyrics', root),
    hud: $('#hud', root), acc: $('#acc', root), accRing: $('#acc-ring', root), nHit: $('#n-hit', root), nWrong: $('#n-wrong', root), nMiss: $('#n-miss', root), streak: $('#streak', root),
    pops: $('#pops', root), waitHint: $('#wait-hint', root), title: $('#song-title', root), artist: $('#song-artist', root),
    midiPill: $('#midi-pill', root), soundPill: $('#sound-pill', root), drawer: $('#drawer', root), results: $('#results', root), empty: $('#empty', root),
    modes: $('#modes', root), rate: $('#rate', root), rateVal: $('#rate-val', root), wait: $('#btn-wait', root), metro: $('#btn-metro', root),
    loopA: $('#btn-a', root), loopB: $('#btn-b', root), toast: $('#toast', root),
  };

  const engine = new Engine();
  engine.latencyHint = 'interactive';
  let ctx = null, synth = null, transport = null;
  const roll = new KeysRoll(el.canvas);
  const practice = new Practice();
  let song = null, flat = [], schedPtr = 0, clickPtr = 0, fxPtr = 0, loop = null, waiting = false, stopAt = null, ended = false;
  const pressed = new Map();
  const noteBus = new EventTarget(); // toutes les notes jouées (MIDI, écran, ordinateur) : pour les exercices
  let lesson = null; // leçon en cours (parcours)
  let raf = 0, lastLyric = -2, lastChord = null;

  async function audio() {
    if (!ctx) {
      ctx = await engine.ensureContext();
      synth = new KeysSynth(ctx, engine.limiter, soundsBase);
      transport = new Transport(engine, ctx);
      synth.out.gain.value = S.master;
      synth.setBus('click', S.metroVol);
      synth.liveInst = S.liveInst;
      synth.setBus('live', S.liveSound ? S.liveVol : 0);
      synth.bank.addEventListener('progress', soundStatus);
      synth.bank.addEventListener('loaded', soundStatus);
      synth.bank.load('grand');
      synth.bank.load(S.liveInst);
    } else if (ctx.state !== 'running') { try { await ctx.resume(); } catch { /* */ } }
    return ctx;
  }

  function soundStatus() {
    const loading = [...synth.bank.inst.values()].filter((i) => !i.complete);
    const piano = synth.bank.get('grand');
    if (!loading.length) { el.soundPill.textContent = 'Sons prêts'; el.soundPill.dataset.state = 'ok'; setTimeout(() => { if (!loading.length) el.soundPill.dataset.state = 'idle'; }, 2500); return; }
    const p = piano && !piano.complete ? `Piano de concert ${Math.round((piano.zones.length / 240) * 100)} %` : `Sons : ${loading.map((i) => i.def.name).slice(0, 2).join(', ')}…`;
    el.soundPill.textContent = p; el.soundPill.dataset.state = 'load';
  }

  // ───────────────────────────────────────────────────────── morceau ──

  async function open(s, opts = {}) {
    lesson = opts.lesson ? opts : null;
    keepAwake();
    await audio().catch(() => {});
    if (transport) { transport.pause(); synth.stopAll(); }
    song = s;
    ended = false; loop = null; updateLoopUI(); sect = null; lastWeak = []; sectUI();
    const mix = store.get('mix:' + (s.title || ''), {});
    for (const t of s.tracks) {
      t.inst ||= t.isDrum ? 'drums' : t.kind === 'grid' ? 'grand' : instrumentForProgram(t.program);
      Object.assign(t, mix[t.id] || {});
    }
    for (const st of s.stems) Object.assign(st, mix[st.id] || {});
    if (mix.gridStyle) { s.gridStyle = mix.gridStyle; regenGrid(); }
    el.title.textContent = s.title || 'Sans titre';
    el.artist.textContent = [s.artist, s.key && frKey(s.key), s.bpm && `${Math.round(s.bpm)} bpm`].filter(Boolean).join(' · ');
    el.empty.hidden = true;
    root.classList.add('has-song');
    await engine.load(s.stems.map((st) => ({ id: st.id, kind: st.kind, label: st.label, blob: st.blob, vol: st.vol, mute: st.mute, solo: st.solo })), { duration: s.duration });
    transport.duration = Math.max(s.duration, engine.duration || 0);
    transport.offset = 0;
    transport.setRate(S.rate);
    applyGains();
    rebuild();
    for (const t of s.tracks) if (t.notes.length) synth.bank.load(t.inst);
    const first = flat.find((n) => n.hand !== 'X')?.t ?? 0;
    await transport.seek(!transport.hasAudio && first < 2 ? first - 2 : 0);
    resetPointers();
    renderDrawer();
    renderMarks();
    lastLyric = -2;
    if (lesson) {
      setMode(lesson.lesson.hands || 'RL');
      if (lesson.wait != null && lesson.wait !== S.wait) el.wait.click();
      toast(lesson.lesson.tip || `${lesson.lesson.kind === 'song' ? 'Morceau' : 'Exercice'} : ${lesson.lesson.title}. Appuie sur lecture quand tu es prêt.`, 6000);
    } else toast(s.info.length ? s.info.join(' · ') : 'Morceau prêt');
  }

  function regenGrid() {
    const i = song.tracks.findIndex((t) => t.id === 'grid');
    if (i < 0) return;
    const g = makeGridTrack(song, song.tracks[i]);
    g.inst = song.tracks[i].inst;
    song.tracks[i] = g;
  }

  function handOf(t, n) {
    switch (t.role) {
      case 'meta': return n.part || 'B';
      case 'right': return 'R';
      case 'left': return 'L';
      case 'both': return n.pitch >= 60 ? 'R' : 'L';
      case 'off': return 'X';
      default: return 'B';
    }
  }

  /** Liste à plat des notes (affichage, son, entraînement) d'après les rôles des pistes. */
  function rebuild() {
    if (!song) return;
    const mine = S.mode === 'listen' ? '' : S.mode === 'RL' ? 'RL' : S.mode;
    flat = [];
    for (const t of song.tracks) {
      for (const n of t.notes) {
        const hand = t.isDrum ? 'B' : handOf(t, n);
        const play = !!mine && mine.includes(hand) && !t.isDrum;
        flat.push({ t: n.t, d: n.d, ring: n.ring, pitch: n.pitch, vel: n.vel, hand, finger: n.finger, track: t, play, dim: !!mine && !play && hand !== 'B', hidden: t.isDrum || (t.kind === 'grid' && t.role === 'off') });
      }
    }
    flat.sort((a, b) => a.t - b.t || a.pitch - b.pitch);
    const showChords = S.chordsMode === 'on' || (S.chordsMode === 'auto' && song.chordSource !== 'detected');
    song._showChords = showChords;
    roll.setSong(flat, { chords: showChords ? song.chords : [], downbeats: song.downbeats, bookmarks: song.bookmarks, pedal: S.showPedal ? song.pedal : [] });
    roll.look = S.look; roll.labels = S.labels; roll.noteNames = S.noteNames;
    roll.setRange(S.range, flat.filter((n) => !n.hidden));
    practice.wait = S.wait;
    practice.tol = TOLERANCE[S.tol] || TOLERANCE.normal;
    practice.setNotes(flat);
    if (transport) practice.rewindTo(transport.time);
    root.dataset.mode = S.mode;
    updateHud();
    resetPointers();
  }

  function resetPointers() {
    if (!transport) return;
    const T = transport.time;
    schedPtr = lowerBound(flat, T - 0.01);
    fxPtr = schedPtr;
    clickPtr = lowerBound(song?.beats || [], T - 0.01, (x) => x);
    lastLyric = -2;
  }

  // ───────────────────────────────────────────────────────── mixage ──

  function audible(t) {
    const anySolo = song.tracks.some((x) => x.solo) || song.stems.some((x) => x.solo);
    return !t.mute && (!anySolo || t.solo);
  }
  function applyGains() {
    if (!song || !synth) return;
    const anySolo = song.tracks.some((x) => x.solo) || song.stems.some((x) => x.solo);
    for (const t of song.tracks) synth.setBus(t.id, audible(t) ? t.vol : 0);
    for (const st of song.stems) engine.setTrack(st.id, { vol: st.vol, mute: st.mute || (anySolo && !st.solo), solo: false });
    synth.setBus('mine', S.hearMine);
  }
  function saveMix() {
    if (!song) return;
    const m = { gridStyle: song.gridStyle };
    for (const t of song.tracks) m[t.id] = { vol: t.vol, mute: t.mute, solo: t.solo, role: t.role, inst: t.inst };
    for (const st of song.stems) m[st.id] = { vol: st.vol, mute: st.mute, solo: st.solo };
    store.set('mix:' + (song.title || ''), m);
  }

  // ───────────────────────────────────────────────────── boucle de rendu ──

  // qualité des effets : « auto » allège les halos si l'appareil n'arrive pas à suivre (< 45 images/s)
  let ema = 16, slowFor = 0, lastNow = 0;
  function quality(now) {
    if (lastNow) { const dt = Math.min(100, now - lastNow); ema = ema * 0.94 + dt * 0.06; }
    lastNow = now;
    if (S.fx !== 'auto') { roll.lite = S.fx === 'low'; return; }
    if (ema > 22) slowFor++; else slowFor = Math.max(0, slowFor - 2);
    if (!roll.lite && slowFor > 90) { roll.lite = true; roll.resize(); }
  }
  // temps de pratique : on compte quand la musique tourne ou qu'on joue (touche dans les 8 dernières secondes)
  let lastKeyAt = -1e9, practiceAcc = 0, lastFrameAt = 0;
  function countTime(now) {
    const dt = lastFrameAt ? Math.min(0.25, (now - lastFrameAt) / 1000) : 0;
    lastFrameAt = now;
    if (document.visibilityState !== 'visible') return;
    if (transport?.playing || waiting || now - lastKeyAt < 8000) practiceAcc += dt;
    if (practiceAcc >= 15) flushTime();
  }
  function flushTime() { if (practiceAcc > 0.5) addTime(practiceAcc); practiceAcc = 0; }
  addEventListener('pagehide', flushTime);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushTime(); });

  function frame(now) {
    raf = requestAnimationFrame(frame);
    quality(now || performance.now());
    countTime(now || performance.now());
    if (!transport || !song) { roll.draw(0, { keys: pressed, sounding: new Map(), playing: false }); return; }
    // ce qu'on voit = ce qu'on entend : on retire la latence de sortie audio
    const Traw = transport.time;
    const rate = transport.rate;
    const outLat = (ctx.outputLatency || ctx.baseLatency || 0);
    let T = Traw - outLat * rate;
    const playing = transport.playing;
    // mode attente
    if (S.mode !== 'listen' && S.wait) {
      stopAt = practice.update(T, rate);
      if (stopAt != null && (playing || waiting) && T >= stopAt - 0.004 && practice.waitingFor?.length) {
        if (playing) { transport.pause(); waiting = true; }
        T = stopAt;
      }
      if (waiting && !practice.waitingFor?.length) { waiting = false; transport.play(); }
    } else if (playing && S.mode !== 'listen') practice.update(T, rate);
    if (waiting) T = Math.min(T, stopAt ?? T);
    el.waitHint.hidden = !waiting;

    if (playing) schedule(Traw, rate, outLat);
    // boucle A-B
    if (loop && playing && T >= loop.b) { if (sect) sectionPass(); seek(loop.a); return; }
    // fin
    if (playing && T >= transport.duration - 0.05 && !loop) { transport.pause(); synth.stopAll(); onEnd(); }

    // touches qui sonnent (jouées par l'appli) et touches à jouer
    const sounding = new Map(), hint = new Map();
    for (let i = lowerBound(flat, T - roll.maxDur - 0.1); i < flat.length && flat[i].t <= T + 0.02; i++) {
      const n = flat[i];
      if (n.hidden || n.hand === 'X' || n.t + n.d <= T) continue;
      if (n.play) { if (n.state !== 'hit') hint.set(n.pitch, n.hand); else sounding.set(n.pitch, n.hand); } else sounding.set(n.pitch, n.hand);
    }
    if (waiting) for (const n of practice.waitingFor || []) hint.set(n.pitch, n.hand);
    // éclats quand les notes jouées par l'appli touchent la ligne
    if (playing) {
      while (fxPtr < flat.length && flat[fxPtr].t <= T) {
        const n = flat[fxPtr++];
        if (!n.hidden && !n.play && n.hand !== 'B' && n.hand !== 'X' && T - n.t < 0.1) roll.burst(n.pitch, n.hand, S.mode === 'listen' ? 0.55 : 0.3);
      }
    }
    roll.draw(T, { keys: pressed, sounding, hint, playing });
    ui(T);
  }

  function schedule(T, rate, outLat = 0) {
    const ahead = T + 0.22 * rate;
    const limit = S.wait && S.mode !== 'listen' && stopAt != null ? Math.min(ahead, stopAt + outLat * rate - 0.001) : ahead;
    while (schedPtr < flat.length && flat[schedPtr].t < limit) {
      const n = flat[schedPtr++];
      if (n.t < T - 0.04 || n.hand === 'X') continue;
      const t = n.track;
      if (!audible(t) || t.vol <= 0) continue;
      if (n.play && S.hearMine <= 0) continue;
      const when = Math.max(ctx.currentTime, transport.ctxTimeOf(n.t));
      synth.note(n.pitch, n.vel, when, Math.max(0.08, (n.ring || n.d) / rate), { bus: n.play ? 'mine' : t.id, inst: t.inst, drum: t.isDrum, program: t.program });
    }
    if (S.metronome && song.beats?.length) {
      const b = song.beats, db = new Set((song.downbeats || []).map((x) => Math.round(x * 100)));
      while (clickPtr < b.length && b[clickPtr] < ahead) {
        const x = b[clickPtr++];
        if (x < T - 0.04) continue;
        synth.click(Math.max(ctx.currentTime, transport.ctxTimeOf(x)), db.has(Math.round(x * 100)));
      }
    }
  }

  // ───────────────────────────────────────────────── interface (texte) ──

  function ui(T) {
    const D = transport.duration || 1;
    el.time.textContent = `${fmt(T)} / ${fmt(D)}`;
    el.seekFill.style.width = `${Math.max(0, Math.min(100, (T / D) * 100))}%`;
    el.play.classList.toggle('on', transport.playing || waiting);
    // accords
    const cs = song._showChords ? song.chords : [];
    let ci = -1;
    if (cs.length) { ci = lowerBound(cs, T + 0.001, (c) => c.s) - 1; }
    const cur = ci >= 0 && T < cs[ci].e + 0.05 ? cs[ci] : null;
    let nx = ci + 1;
    while (cs[nx] && cur && cs[nx].name === cur.name) nx++;
    const nxt = cs[nx];
    const key = (cur?.name || '') + '|' + (nxt?.name || '');
    if (key !== lastChord) {
      lastChord = key;
      el.chordNow.textContent = cur?.name || '';
      el.chordNow.classList.remove('flip'); void el.chordNow.offsetWidth; if (cur) el.chordNow.classList.add('flip');
      el.chordNext.textContent = nxt ? (cur ? `puis ${nxt.name}` : `bientôt ${nxt.name}`) : '';
      el.chordNow.parentElement.hidden = !cs.length;
    }
    lyrics(T);
  }

  function lyricLines() { return song.lines.filter((l) => l.type === 'lyric' && l.s != null); }
  function lyrics(T) {
    const ls = song._lyr || (song._lyr = lyricLines());
    if (!ls.length) { el.lyrics.hidden = true; return; }
    let i = lowerBound(ls, T + 0.25, (l) => l.s) - 1;
    if (i < 0) i = -1;
    const cur = ls[i];
    const show = cur && T < (cur.e ?? cur.s + 6) + 1.2 ? i : -1;
    const idx = show >= 0 ? show : (ls[i + 1] && ls[i + 1].s - T < 3 ? i + 1 : -2);
    if (idx !== lastLyric) {
      lastLyric = idx;
      el.lyrics.hidden = idx === -2;
      if (idx === -2) return;
      const line = ls[idx], next = ls[idx + 1];
      el.lyrics.innerHTML = `<div class="ly-cur">${lineHtml(line)}</div><div class="ly-next">${next ? esc(next.text) : ''}</div>`;
      el.lyrics.classList.remove('in'); void el.lyrics.offsetWidth; el.lyrics.classList.add('in');
      // une seule ligne : la taille du texte s'adapte à la largeur (tablette en portrait comprise)
      const cur = el.lyrics.querySelector('.ly-cur');
      cur.style.fontSize = '';
      let fs = parseFloat(getComputedStyle(cur).fontSize);
      while (cur.scrollWidth > cur.clientWidth + 1 && fs > 14) { fs -= 1; cur.style.fontSize = fs + 'px'; }
    }
    if (idx < 0) return;
    const line = ls[idx];
    const spans = el.lyrics.querySelectorAll('.ly-cur .w');
    spans.forEach((sp, k) => {
      const w = line.words?.[k];
      if (!w) return;
      const p = T <= w.s ? 0 : T >= w.e ? 1 : (T - w.s) / Math.max(0.05, w.e - w.s);
      sp.style.setProperty('--p', p.toFixed(3));
      sp.classList.toggle('now', p > 0 && p < 1);
    });
  }
  function lineHtml(line) {
    const toks = [...line.text.matchAll(/\S+/g)];
    const chordAt = new Map();
    for (const c of line.chords || []) {
      let k = 0;
      toks.forEach((m, j) => { if (m.index <= c.pos) k = j; });
      chordAt.set(k, (chordAt.get(k) ? chordAt.get(k) + ' ' : '') + c.name);
    }
    return toks.map((m, j) => `<span class="w" data-t="${esc(m[0])}">${chordAt.has(j) ? `<b class="ch">${esc(chordAt.get(j))}</b>` : ''}${esc(m[0])}</span>`).join(' ');
  }

  function updateHud() {
    const s = practice.stats;
    el.hud.hidden = S.mode === 'listen';
    el.acc.textContent = practice.accuracy + ' %';
    el.accRing.style.strokeDashoffset = String(100 - practice.accuracy);
    el.nHit.textContent = s.hit; el.nWrong.textContent = s.wrong; el.nMiss.textContent = s.miss;
    el.streak.textContent = s.streak > 1 ? `Série ${s.streak}` : '';
    el.streak.classList.toggle('hot', s.streak >= 10);
  }

  function pop(text, cls = '') {
    const d = document.createElement('div');
    d.className = 'pop ' + cls;
    d.textContent = text;
    el.pops.appendChild(d);
    setTimeout(() => d.remove(), 1100);
  }

  practice.addEventListener('hit', (e) => {
    const { note, perfect } = e.detail;
    roll.burst(note.pitch, note.hand, perfect ? 1.25 : 0.9);
    const s = practice.stats.streak;
    if ([10, 25, 50, 100, 200].includes(s)) pop(`Série de ${s} !`, 'big');
    else if (perfect && Math.random() < 0.18) pop('Parfait', 'ok');
    updateHud();
  });
  practice.addEventListener('wrong', (e) => { roll.burst(e.detail.pitch, 'bad', 0.6); updateHud(); });
  practice.addEventListener('miss', updateHud);

  function onEnd() {
    if (ended) return;
    ended = true;
    if (S.mode === 'listen' || !practice.notes.length) return;
    const s = practice.stats, a = practice.accuracy;
    let stars = a >= 95 ? 3 : a >= 80 ? 2 : a >= 55 ? 1 : 0;
    lastWeak = practice.weakSpots(song.downbeats);
    addRun({ id: lesson?.lesson.id || 'file:' + (song.title || ''), title: song.title || lesson?.lesson.title || 'Sans titre', kind: lesson ? (lesson.lesson.mine ? 'mine' : 'lesson') : 'file', acc: a, rate: Math.round(transport.rate * 100) / 100, wait: !!S.wait, hands: S.mode });
    const dyn = practice.dynamics();
    errMarks();
    let extra = '', nextBtn = '';
    if (lesson) {
      const r = lesson.onResult?.({ accuracy: a, wait: S.wait, rate: transport.rate, hit: s.hit, wrong: s.wrong, miss: s.miss }) || {};
      stars = r.newStars ?? stars;
      const mineSong = lesson.lesson.mine;
      extra = `<p class="lesson-res">${mineSong ? (r.improved ? `Nouveau record : ${a} %` : `Ton record : ${r.best} %`) : stars >= 1 ? (r.improved ? 'Nouveau record — étape validée !' : 'Étape validée.') : 'Il faut 75 % pour valider cette étape.'}${!r.full && a >= 90 ? ' Pour la 3e étoile : à 100 % de vitesse, sans « Attendre ».' : ''}</p>`;
      nextBtn = `<button class="btn ghost" data-act="school">${lesson.lesson.mine ? 'Mes morceaux' : 'Parcours'}</button>` + (r.next ? `<button class="btn primary" data-act="next">Étape suivante →</button>` : '');
    }
    el.results.innerHTML = `
      <div class="card res">
        <div class="stars">${[1, 2, 3].map((k) => `<span class="star ${k <= stars ? 'lit' : ''}" style="--d:${k * 0.18}s">★</span>`).join('')}</div>
        <h2>${a >= 95 ? 'Magnifique' : a >= 80 ? 'Très beau jeu' : a >= 55 ? 'Bien joué' : 'On continue'}</h2>
        <div class="big-acc">${a}<small> %</small></div>
        <div class="res-grid">
          <div><b class="ok">${s.hit}</b><span>justes</span></div>
          <div><b class="bad">${s.wrong}</b><span>fausses</span></div>
          <div><b class="miss">${s.miss}</b><span>manquées</span></div>
          <div><b>${s.best}</b><span>meilleure série</span></div>
        </div>
        ${extra}
        ${lastWeak.length ? `<div class="weak"><span>À retravailler</span>${lastWeak.map((w, i) => `<button class="chip" data-act="weak" data-i="${i}">${esc(barsLabel(w.a, w.b))}<em>${w.errors} erreur${w.errors > 1 ? 's' : ''}</em></button>`).join('')}</div>` : ''}
        ${dyn ? `<p class="dyn">Nuances respectées : <b>${dyn.fidelity} %</b>${Math.abs(dyn.bias) > 0.08 ? (dyn.bias > 0 ? ' · tu joues un peu trop fort' : ' · tu joues un peu trop doucement') : ' · bon équilibre'}</p>` : ''}
        <div class="row">
          <button class="btn ghost" data-act="slower">Plus lentement</button>
          <button class="btn ${nextBtn ? '' : 'primary'}" data-act="again">Rejouer</button>
          ${nextBtn}
        </div>
      </div>`;
    el.results.hidden = false;
  }
  el.results.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act && e.target !== el.results) return;
    el.results.hidden = true;
    if (act === 'weak') { const w = lastWeak[+e.target.closest('[data-i]').dataset.i]; if (w) startSection({ ...w, label: barsLabel(w.a, w.b) }); return; }
    if (act) renderMarks();
    if (act === 'next') { lesson?.onNext?.(); return; }
    if (act === 'school') { lesson?.onSchool?.(); return; }
    if (act === 'slower') setRate(Math.max(0.4, Math.round((S.rate - 0.15) * 20) / 20));
    if (act) { seek(loop?.a ?? (transport && !transport.hasAudio ? Math.min(0, (flat.find((n) => !n.hidden)?.t ?? 0) - 2) : 0)); togglePlay(true); }
  });

  // ─────────────────────────────────────────────────────── transport ──

  async function togglePlay(force) {
    if (!song) return;
    await audio();
    if (waiting && force !== true) { waiting = false; transport.pause(); synth.stopAll(); return; }
    if (transport.playing && force !== true) { transport.pause(); synth.stopAll(); return; }
    if (transport.time >= transport.duration - 0.2) await seek(0);
    el.results.hidden = true;
    ended = false;
    resetPointers();
    await transport.play();
  }
  async function seek(t) {
    if (!transport) return;
    waiting = false;
    synth?.stopAll();
    await transport.seek(t);
    practice.rewindTo(t);
    resetPointers();
    ended = false;
  }
  function setRate(r) {
    S.rate = r; saveSettings();
    transport?.setRate(r);
    el.rate.value = String(Math.round(r * 100));
    el.rate.style.setProperty('--v', ((r * 100 - 40) / 110) * 100 + '%');
    el.rateVal.textContent = Math.round(r * 100) + ' %';
    resetPointers();
  }
  function updateLoopUI() {
    el.loopA.classList.toggle('on', !!loop?.a || loop?.a === 0);
    el.loopB.classList.toggle('on', !!loop?.b);
    const D = transport?.duration || 1;
    el.loopZone.hidden = !(loop && loop.b);
    if (loop && loop.b) { el.loopZone.style.left = `${(loop.a / D) * 100}%`; el.loopZone.style.width = `${((loop.b - loop.a) / D) * 100}%`; }
  }
  function renderMarks() {
    const D = transport.duration || 1;
    el.seekMarks.innerHTML = song.bookmarks.map((b) => `<i style="left:${(b.t / D) * 100}%" title="${esc(b.label)}"></i>`).join('');
  }
  /** Après un essai : petits traits rouges sur la barre de progression aux erreurs (manquées et fausses). */
  function errMarks() {
    const D = transport.duration || 1;
    const ts = practice.notes.filter((n) => n.state === 'miss').map((n) => n.t).concat(practice.wrongs.map((w) => w.t));
    const seen = new Set();
    const marks = ts.map((t) => Math.round((t / D) * 400) / 4).filter((x) => !seen.has(x) && seen.add(x)).slice(0, 300);
    el.seekMarks.innerHTML = song.bookmarks.map((b) => `<i style="left:${(b.t / D) * 100}%" title="${esc(b.label)}"></i>`).join('') + marks.map((x) => `<i class="err" style="left:${x}%"></i>`).join('');
  }

  // ───────────────────────────────────────── clavier MIDI, écran, ordinateur ──

  function curve(v) { return S.velCurve === 'soft' ? v ** 0.7 : S.velCurve === 'hard' ? v ** 1.45 : v; }
  async function keyDown(pitch, vel = 0.7, ts) {
    // âge du message MIDI : si l'écran était occupé, on juge la note à l'instant où elle a été jouée
    const age = ts != null ? Math.max(0, Math.min(0.5, (performance.now() - ts) / 1000)) : 0;
    if (pressed.has(pitch)) keyUp(pitch);
    lastKeyAt = performance.now();
    if (!wakeLock) keepAwake();
    if (!ctx || ctx.state !== 'running') await audio();
    vel = curve(vel);
    if (S.liveSound) synth.liveOn(pitch, vel);
    if (calib?.running) { calib.presses.push(ctx.currentTime - age); pressed.set(pitch, { col: '#ffd27a', kind: 'free' }); calibTick(); return; }
    let kind = 'free';
    if (song && S.mode !== 'listen' && (transport.playing || waiting)) {
      // même repère que l'affichage (latence de sortie) + réglage « décalage du clavier »
      const lat = (ctx.outputLatency || ctx.baseLatency || 0) + S.latency / 1000;
      const T = waiting ? stopAt : transport.time - (lat + age) * transport.rate;
      kind = practice.press(pitch, T, transport.rate, vel);
    }
    noteBus.dispatchEvent(new CustomEvent('note', { detail: { note: pitch, vel } }));
    const col = kind === 'ok' ? PALETTE.ok : kind === 'bad' ? PALETTE.bad : '#ffd27a';
    pressed.set(pitch, { col, kind });
    if (kind === 'free') roll.burst(pitch, 'R', 0.35);
  }
  function keyUp(pitch) {
    pressed.delete(pitch);
    synth?.liveOff(pitch);
  }

  midi.skipSurface = true; // le Zoom R20 (surface de contrôle) ne joue pas de notes ici
  midi.addEventListener('noteon', (e) => keyDown(e.detail.note, e.detail.vel, e.detail.ts));
  midi.addEventListener('noteoff', (e) => keyUp(e.detail.note));
  midi.addEventListener('sustain', (e) => { synth?.setSustain(e.detail.down); el.midiPill.classList.toggle('ped-on', e.detail.down); });
  midi.addEventListener('devices', midiStatus);
  function midiStatus() {
    const d = midi.devices;
    el.midiPill.dataset.state = d.length ? 'ok' : midi.access ? 'wait' : 'off';
    el.midiPill.querySelector('span').textContent = d.length ? d[0] : midi.access ? 'Branche ton clavier' : 'Clavier MIDI';
  }
  el.midiPill.addEventListener('click', async () => {
    try { await midi.enable(); midiStatus(); toast(midi.devices.length ? `Clavier détecté : ${midi.devices.join(', ')}` : 'MIDI activé : branche ou allume ton clavier'); }
    catch (err) { el.midiPill.dataset.state = 'off'; toast(/permission|denied|allowed|security|policy/i.test(String(err)) ? 'Le MIDI est bloqué dans cette page d’aperçu. Il marchera dans MusiMix (Chrome / Edge). En attendant : touches à l’écran ou clavier de l’ordinateur.' : String(err.message || err), 7000); }
  });
  try { navigator.permissions?.query({ name: 'midi' }).then((p) => { if (p.state === 'granted') midi.enable().then(midiStatus).catch(() => {}); }).catch(() => {}); } catch { /* */ }

  // souris / toucher sur le clavier dessiné
  const touches = new Map();
  el.canvas.addEventListener('pointerdown', (e) => {
    const r = el.canvas.getBoundingClientRect();
    const p = roll.pitchAt(e.clientX - r.left, e.clientY - r.top);
    if (p == null) return;
    el.canvas.setPointerCapture(e.pointerId);
    touches.set(e.pointerId, p);
    const y = (e.clientY - r.top - roll.hitY) / roll.kbH;
    keyDown(p, 0.45 + Math.min(0.5, Math.max(0, y)) * 0.9);
  });
  el.canvas.addEventListener('pointermove', (e) => {
    if (!touches.has(e.pointerId)) return;
    const r = el.canvas.getBoundingClientRect();
    const p = roll.pitchAt(e.clientX - r.left, e.clientY - r.top);
    const old = touches.get(e.pointerId);
    if (p != null && p !== old) { keyUp(old); touches.set(e.pointerId, p); keyDown(p, 0.6); }
  });
  const endTouch = (e) => { const p = touches.get(e.pointerId); if (p != null) { keyUp(p); touches.delete(e.pointerId); } };
  el.canvas.addEventListener('pointerup', endTouch);
  el.canvas.addEventListener('pointercancel', endTouch);

  // clavier de l'ordinateur (positions physiques : marche en AZERTY comme en QWERTY)
  const KEYMAP = { KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7, KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11, KeyK: 12, KeyO: 13, KeyL: 14, KeyP: 15, Semicolon: 16, Quote: 17 };
  let octave = 60;
  const held = new Set();
  function onKey(e) {
    if (e.target.closest?.('input, select, textarea')) return;
    if (e.type === 'keydown') {
      if (e.code === 'Space') { e.preventDefault(); togglePlay(); return; }
      if (e.code === 'ArrowLeft') { seek((transport?.time || 0) - 5); return; }
      if (e.code === 'ArrowRight') { seek((transport?.time || 0) + 5); return; }
      if (e.code === 'KeyZ') { octave = Math.max(24, octave - 12); toast(`Clavier de l’ordinateur : ${noteLabel(octave)}`); return; }
      if (e.code === 'KeyX') { octave = Math.min(96, octave + 12); toast(`Clavier de l’ordinateur : ${noteLabel(octave)}`); return; }
    }
    const k = KEYMAP[e.code];
    if (k == null || e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    const p = octave + k;
    if (e.type === 'keydown') { if (held.has(p)) return; held.add(p); keyDown(p, 0.7); }
    else { held.delete(p); keyUp(p); }
  }
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKey);

  // ───────────────────────────────────────── travail d'un passage ──
  // le passage tourne en boucle ; « accélérer tout seul » : +10 % de vitesse à chaque essai réussi (≥ 90 %)
  let sect = null, lastWeak = [];
  const sectPill = document.createElement('div');
  sectPill.className = 'sect-pill'; sectPill.hidden = true;
  el.stage.appendChild(sectPill);
  const barOf = (t) => { const db = song?.downbeats || []; let lo = 0, hi = db.length; while (lo < hi) { const m = (lo + hi) >> 1; if (db[m] <= t + 0.01) lo = m + 1; else hi = m; } return lo; }; // n° de mesure (1…)
  const barsLabel = (a, b) => { if (!(song?.downbeats?.length > 2)) return `${fmt(a)} → ${fmt(b)}`; const x = barOf(a), y = Math.max(x, barOf(b - 0.02)); return x === y ? `Mesure ${x}` : `Mesures ${x} à ${y}`; };
  function sectionChoices() {
    const out = [];
    const T = Math.max(0, transport?.time || 0);
    for (const w of lastWeak) out.push({ a: w.a, b: w.b, label: barsLabel(w.a, w.b), sub: `À retravailler · ${w.errors} erreur${w.errors > 1 ? 's' : ''}`, hot: true });
    const db = song.downbeats || [];
    if (db.length > 2) {
      const i = Math.max(0, barOf(T) - 1);
      for (const n of [4, 8]) if (db[i + 1] != null) out.push({ a: db[i], b: db[Math.min(db.length - 1, i + n)] ?? song.duration, label: barsLabel(db[i], db[Math.min(db.length - 1, i + n)] ?? song.duration), sub: `${n} mesures à partir d’ici` });
    } else for (const n of [8, 16]) out.push({ a: T, b: Math.min(transport.duration, T + n), label: `${fmt(T)} → ${fmt(T + n)}`, sub: `${n} secondes à partir d’ici` });
    const bm = song.bookmarks || [];
    bm.forEach((m, k) => { const b = bm[k + 1]?.t ?? transport.duration; if (b - m.t > 1) out.push({ a: m.t, b, label: m.label, sub: barsLabel(m.t, b) }); });
    if (loop?.b && !sect) out.push({ a: Math.max(0, loop.a), b: loop.b, label: 'Ma boucle A-B', sub: barsLabel(Math.max(0, loop.a), loop.b) });
    return out;
  }
  function sectionSheet() {
    closePops();
    if (!song) return;
    if (S.mode === 'listen') setMode(song.tracks.some((t) => t.role === 'left') ? 'RL' : 'R');
    const list = sectionChoices();
    const box = document.createElement('div');
    box.className = 'calib sheet';
    box.innerHTML = `<div class="card">
      <h2>Travailler un passage</h2>
      <p class="muted small">Le passage tourne en boucle. Chaque essai est noté ; tu peux arrêter avec la croix en haut.</p>
      <div class="sect-list">${list.map((c, i) => `<button class="sect-item ${c.hot ? 'hot' : ''}" data-sect="${i}"><b>${esc(c.label)}</b><small>${esc(c.sub)}</small></button>`).join('')}</div>
      <label class="switch"><input type="checkbox" data-sectauto ${S.sectAuto ? 'checked' : ''}><span>Accélérer tout seul : de ${Math.round(S.sectStart * 100)} % à 100 %, +10 % à chaque essai réussi (90 %)</span></label>
      <div class="chips sect-start">${[0.5, 0.6, 0.7, 0.8].map((r) => `<button class="chip ${S.sectStart === r ? 'on' : ''}" data-sectstart="${r}">Départ ${r * 100} %</button>`).join('')}</div>
      <div class="row"><button class="btn ghost" data-sectclose>Fermer</button></div></div>`;
    el.stage.appendChild(box);
    box.addEventListener('click', (e) => {
      const i = e.target.closest('[data-sect]')?.dataset.sect;
      if (i != null) { box.remove(); startSection(list[+i]); return; }
      const st = e.target.closest('[data-sectstart]')?.dataset.sectstart;
      if (st) { S.sectStart = +st; saveSettings(); box.querySelectorAll('[data-sectstart]').forEach((c) => c.classList.toggle('on', c === e.target.closest('[data-sectstart]'))); box.querySelector('.switch span').textContent = `Accélérer tout seul : de ${Math.round(S.sectStart * 100)} % à 100 %, +10 % à chaque essai réussi (90 %)`; return; }
      if (e.target.closest('[data-sectclose]') || e.target === box) box.remove();
    });
    box.addEventListener('change', (e) => { if (e.target.matches('[data-sectauto]')) { S.sectAuto = e.target.checked; saveSettings(); } });
  }
  async function startSection(c) {
    el.results.hidden = true;
    const lead = Math.min(1.5, Math.max(0.6, 2 * (song.beats?.[1] - song.beats?.[0] || 0.6))); // un peu d'élan avant le passage
    sect = { a: c.a, b: c.b, label: c.label, pass: 0, ok: 0, last: null };
    loop = { a: Math.max(transport.hasAudio ? 0 : -2, c.a - lead), b: c.b };
    updateLoopUI();
    if (S.sectAuto) setRate(Math.min(S.rate, S.sectStart) || S.sectStart);
    practice.reset();
    await seek(loop.a);
    sectUI();
    togglePlay(true);
  }
  function stopSection() { sect = null; loop = null; updateLoopUI(); sectUI(); }
  function sectionPass() {
    const r = practice.range(sect.a, sect.b);
    sect.pass++; sect.last = r.accuracy;
    let msg = `Essai ${sect.pass} : ${r.accuracy} %`;
    if (r.accuracy >= 90) {
      sect.ok++;
      if (S.sectAuto && S.rate < 0.999) { setRate(Math.min(1, Math.round((S.rate + 0.1) * 20) / 20)); msg += ` · vitesse ${Math.round(S.rate * 100)} %`; }
      else if (S.rate >= 0.999) msg = sect.ok >= 2 ? `Passage maîtrisé ! ${r.accuracy} % à pleine vitesse` : msg + ' à pleine vitesse';
    } else if (S.sectAuto && r.accuracy < 60 && S.rate > 0.45) { setRate(Math.max(0.4, Math.round((S.rate - 0.1) * 20) / 20)); msg += ` · on ralentit à ${Math.round(S.rate * 100)} %`; }
    pop(msg, r.accuracy >= 90 ? 'big' : '');
    practice.reset();
    sectUI();
  }
  function sectUI() {
    sectPill.hidden = !sect;
    root.classList.toggle('in-sect', !!sect);
    if (!sect) return;
    sectPill.innerHTML = `<span class="sp-l">Passage</span><b>${esc(sect.label)}</b><span>${sect.pass ? `Essai ${sect.pass + 1} · dernier ${sect.last} %` : 'Premier essai'}</span><span class="sp-r">${Math.round(S.rate * 100)} %</span><button data-sectstop aria-label="Arrêter le passage">×</button>`;
  }
  sectPill.addEventListener('click', (e) => { if (e.target.closest('[data-sectstop]')) stopSection(); });
  root.addEventListener('click', (e) => { if (e.target.closest('#btn-sect')) sectionSheet(); });

  // ──────────────────────────────────── calage automatique du clavier MIDI ──
  // 4 clics pour écouter, puis 8 clics à accompagner d'une touche : la médiane des écarts devient le « décalage »
  let calib = null;
  const CAL_IV = 0.6, CAL_IN = 4, CAL_N = 8;
  function calibOpen() {
    closePops();
    el.drawer.hidden = true; root.classList.remove('drawer-open');
    if (transport?.playing || waiting) { waiting = false; transport.pause(); synth?.stopAll(); }
    calib?.box?.remove();
    const box = document.createElement('div');
    box.className = 'calib';
    el.stage.appendChild(box);
    calib = { box, running: false, presses: [] };
    calibScreen('intro');
  }
  function calibClose() { if (!calib) return; calib.running = false; clearInterval(calib.timer); calib.box.remove(); calib = null; }
  function calibScreen(kind, data = {}) {
    const dots = Array.from({ length: CAL_IN + CAL_N }, (_, i) => `<i class="${i < CAL_IN ? 'in' : ''}"></i>`).join('');
    const body = {
      intro: `<h2>Caler mon clavier</h2>
        <p>Tu vas entendre <b>4 clics</b> pour prendre le tempo, puis joue <b>n’importe quelle touche</b> en même temps que chacun des <b>8 clics</b> suivants.</p>
        <p class="muted small">Utilise le son que tu utilises pour jouer (celui de ta P-95 ou celui de l’appli). Le résultat règle le « décalage du clavier ».</p>
        <div class="row"><button class="btn ghost" data-cal="close">Annuler</button><button class="btn primary" data-cal="go">Commencer</button></div>`,
      run: `<h2>Écoute… puis joue avec le clic</h2><div class="cal-dots">${dots}</div><p class="muted small cal-hint">Prépare-toi</p>`,
      result: `<h2>${data.ok ? 'Ton clavier est calé' : 'Résultat irrégulier'}</h2>
        <div class="cal-big">${data.ms > 0 ? '+' : ''}${data.ms}<small> ms</small></div>
        <p>${data.ok ? (Math.abs(data.ms) <= 15 ? 'Presque aucun décalage : tout est déjà bien réglé.' : data.ms > 0 ? 'Tes notes arrivent un peu après le son : l’appli en tiendra compte.' : 'Tes notes arrivent un peu avant le son : l’appli en tiendra compte.') : `Tes frappes étaient trop éloignées les unes des autres (±${data.spread} ms) ou trop peu nombreuses (${data.n}/8). Recommence calmement, en suivant bien le clic.`}</p>
        <div class="row"><button class="btn ghost" data-cal="go">Recommencer</button>${data.ok ? `<button class="btn primary" data-cal="apply" data-ms="${data.ms}">Appliquer</button>` : '<button class="btn ghost" data-cal="close">Fermer</button>'}</div>`,
    }[kind];
    calib.box.innerHTML = `<div class="card">${body}</div>`;
  }
  async function calibStart() {
    await audio();
    calibScreen('run');
    calib.presses = [];
    const outLat = ctx.outputLatency || ctx.baseLatency || 0;
    const c0 = ctx.currentTime + 0.6;
    for (let i = 0; i < CAL_IN + CAL_N; i++) synth.click(c0 + i * CAL_IV, i % 4 === 0);
    Object.assign(calib, { running: true, c0, outLat });
    calib.timer = setInterval(calibTick, 40);
  }
  function calibTick() {
    if (!calib?.running) return;
    const k = Math.floor((ctx.currentTime - calib.outLat - calib.c0) / CAL_IV + 0.15);
    calib.box.querySelectorAll('.cal-dots i').forEach((d, i) => { d.classList.toggle('on', i === k); d.classList.toggle('past', i < k); });
    const hint = calib.box.querySelector('.cal-hint');
    if (hint) hint.textContent = k < 0 ? 'Prépare-toi' : k < CAL_IN ? `Écoute : ${k + 1}` : k < CAL_IN + CAL_N ? `Joue ! ${k - CAL_IN + 1} / ${CAL_N}` : 'Calcul…';
    if (ctx.currentTime > calib.c0 + (CAL_IN + CAL_N) * CAL_IV + 0.4) calibDone();
  }
  function calibDone() {
    calib.running = false; clearInterval(calib.timer);
    const errs = [];
    for (const p of calib.presses) {
      const k = Math.round((p - calib.outLat - calib.c0) / CAL_IV);
      if (k < CAL_IN || k >= CAL_IN + CAL_N) continue;
      const e = p - calib.outLat - (calib.c0 + k * CAL_IV);
      if (Math.abs(e) < 0.25) errs.push(e);
    }
    const med = (a) => { const b = [...a].sort((x, y) => x - y); return b.length ? (b.length % 2 ? b[(b.length - 1) / 2] : (b[b.length / 2 - 1] + b[b.length / 2]) / 2) : 0; };
    const m = med(errs);
    const spread = med(errs.map((e) => Math.abs(e - m)));
    const ms = Math.max(-150, Math.min(250, Math.round((m * 1000) / 5) * 5));
    calibScreen('result', { ok: errs.length >= 5 && spread < 0.045, ms, spread: Math.round(spread * 1000), n: errs.length });
  }
  root.addEventListener('click', (e) => {
    const a = e.target.closest('[data-cal]')?.dataset.cal;
    if (!a) return;
    if (a === 'open') calibOpen();
    else if (a === 'close') calibClose();
    else if (a === 'go') calibStart();
    else if (a === 'apply') { S.latency = +e.target.closest('[data-cal]').dataset.ms; saveSettings(); calibClose(); toast(`Décalage du clavier : ${S.latency} ms`); }
  });

  // ─────────────────────────────────────────── écran allumé, plein écran ──
  // la tablette ne se met pas en veille tant que la page est affichée et qu'on s'en sert
  let wakeLock = null;
  async function keepAwake() {
    if (wakeLock || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    try { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } catch { /* refusé (batterie faible, aperçu) */ }
  }
  const onVisible = () => { if (document.visibilityState === 'visible' && song) keepAwake(); };
  document.addEventListener('visibilitychange', onVisible);
  root.addEventListener('pointerdown', keepAwake, { passive: true });
  const fsBtn = $('#btn-fs', root);
  if (fsBtn && document.fullscreenEnabled) {
    fsBtn.hidden = false;
    fsBtn.addEventListener('click', async () => {
      try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen({ navigationUI: 'hide' }); } catch { toast('Plein écran indisponible sur cet appareil'); }
    });
    document.addEventListener('fullscreenchange', () => fsBtn.classList.toggle('on', !!document.fullscreenElement));
  }

  // ─────────────────────────────────────────────────────── commandes ──

  el.play.addEventListener('click', () => togglePlay());
  $('#btn-back', root).addEventListener('click', () => seek(loop?.a ?? (transport && !transport.hasAudio ? Math.min(0, (flat.find((n) => !n.hidden)?.t ?? 0) - 2) : 0)));
  $('#btn-rew', root).addEventListener('click', () => seek((transport?.time || 0) - 5));
  el.rate.addEventListener('input', () => setRate(+el.rate.value / 100));
  // fenêtres surgissantes (vitesse, plus d'options) : une seule ouverte à la fois, fermées au clic ailleurs
  const closePops = (except) => root.querySelectorAll('[data-pop]').forEach((b) => { if (b === except) return; b.setAttribute('aria-expanded', 'false'); const p = root.querySelector('#' + b.dataset.pop); if (p) p.hidden = true; });
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pop]');
    if (b) { const p = root.querySelector('#' + b.dataset.pop); const open = p.hidden; closePops(b); p.hidden = !open; b.setAttribute('aria-expanded', String(open)); return; }
    if (!e.target.closest('.popover')) closePops();
    const r = e.target.closest('[data-rate]');
    if (r) { setRate(+r.dataset.rate / 100); closePops(); }
  });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePops(); });
  el.rate.value = String(Math.round(S.rate * 100)); el.rateVal.textContent = Math.round(S.rate * 100) + ' %';
  const seekFrom = (e) => { const r = el.seek.getBoundingClientRect(); seek(((e.clientX - r.left) / r.width) * (transport?.duration || 0)); };
  el.seek.addEventListener('pointerdown', (e) => { if (!song) return; el.seek.setPointerCapture(e.pointerId); seekFrom(e); el.seek.dataset.drag = '1'; });
  el.seek.addEventListener('pointermove', (e) => { if (el.seek.dataset.drag) seekFrom(e); });
  el.seek.addEventListener('pointerup', () => { delete el.seek.dataset.drag; });

  function setMode(m) {
    S.mode = m; saveSettings();
    el.modes.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
    el.modes.style.setProperty('--i', String([...el.modes.querySelectorAll('button')].findIndex((b) => b.dataset.mode === m)));
    waiting = false;
    rebuild();
    if (m !== 'listen' && !midi.access) el.midiPill.classList.add('nudge');
  }
  el.modes.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setMode(b.dataset.mode); });
  el.wait.addEventListener('click', () => { S.wait = !S.wait; saveSettings(); el.wait.classList.toggle('on', S.wait); practice.wait = S.wait; if (!S.wait && waiting) { waiting = false; transport.play(); } toast(S.wait ? 'Attendre : la musique s’arrête jusqu’à ce que tu joues la bonne note' : 'Attendre désactivé : la musique continue'); });
  el.wait.classList.toggle('on', S.wait);
  el.metro.addEventListener('click', () => { S.metronome = !S.metronome; saveSettings(); el.metro.classList.toggle('on', S.metronome); resetPointers(); });
  el.metro.classList.toggle('on', S.metronome);
  el.loopA.addEventListener('click', () => { if (!transport) return; if (loop) { loop = null; if (sect) { sect = null; sectUI(); } } else { loop = { a: Math.max(0, transport.time), b: null }; } updateLoopUI(); });
  el.loopB.addEventListener('click', () => { if (!transport) return; if (!loop) loop = { a: 0, b: null }; const t = transport.time; if (t > loop.a + 0.5) { loop.b = t; seek(loop.a); } updateLoopUI(); });

  // tiroir : pistes, sons, réglages
  root.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openDrawer(b.dataset.open)));
  function openDrawer(tab) {
    const same = !el.drawer.hidden && el.drawer.dataset.tab === tab;
    el.drawer.hidden = same;
    el.drawer.dataset.tab = tab;
    root.classList.toggle('drawer-open', !same);
    if (!same) renderDrawer();
  }
  el.drawer.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) { el.drawer.hidden = true; root.classList.remove('drawer-open'); }
    // (le tiroir porte lui-même data-tab : on ne regarde que les onglets)
    const tab = e.target.closest('.tabs [data-tab]')?.dataset.tab;
    if (tab) { el.drawer.dataset.tab = tab; renderDrawer(); }
  });

  function instOptions(sel) {
    const groups = {};
    for (const i of INSTRUMENTS) (groups[i.group] ||= []).push(i);
    return Object.entries(groups).map(([g, list]) => `<optgroup label="${esc(g)}">${list.map((i) => `<option value="${i.id}" ${i.id === sel ? 'selected' : ''}>${esc(i.name)}</option>`).join('')}</optgroup>`).join('');
  }

  function renderDrawer() {
    const tab = el.drawer.dataset.tab || 'mix';
    el.drawer.querySelectorAll('.tabs [data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    const body = $('.drawer-body', el.drawer);
    if (tab === 'mix') body.innerHTML = mixHtml();
    else if (tab === 'sounds') body.innerHTML = soundsHtml();
    else body.innerHTML = settingsHtml();
  }

  const CHEV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
  const openTracks = new Set(); // pistes dépliées (rôle, son)
  function mixHtml() {
    if (!song) return '<p class="muted">Ouvre un morceau pour régler ses pistes.</p>';
    const line = (item, label, sub, more, meter = false) => `
        <div class="trk-head"><i class="dot"></i><span class="trk-name"><b>${esc(label)}</b>${sub ? `<span class="trk-sub">${esc(sub)}</span>` : ''}</span>${meter ? '<span class="meter"><i></i></span>' : ''}</div>
        <div class="trk-line">
          <input type="range" min="0" max="150" value="${Math.round(item.vol * 100)}" data-k="vol" aria-label="Volume ${esc(label)}">
          <button class="ms ${item.mute ? 'on' : ''}" data-k="mute" title="Couper">M</button><button class="ms solo ${item.solo ? 'on' : ''}" data-k="solo" title="Seul">S</button>
          ${more ? `<button class="trk-x" data-x="more" aria-label="Plus de réglages">${CHEV}</button>` : ''}
        </div>`;
    const stems = song.stems.map((st) => `
      <div class="trk" data-stem="${esc(st.id)}" style="--c:${STEM_COL[st.kind] || '#9aa0ab'}">${line(st, st.label, '', false, true)}</div>`).join('');
    const roles = (t) => (t.kind === 'grid' ? ['meta', 'right', 'left', 'bg', 'off'] : ['meta', 'right', 'left', 'both', 'bg', 'off'].filter((r) => r !== 'meta' || t.notes.some((n) => n.part)));
    const roleName = (t, r) => (r === 'meta' ? (t.kind === 'grid' ? 'Basse à gauche, accord à droite' : 'Mains du fichier .synthesia') : r === 'both' ? 'Deux mains (partage au Do 3)' : ROLE_LABELS[r]);
    const instName = (id) => (INSTRUMENTS.find((i) => i.id === id) || DRUM_KITS.find((i) => i.id === id))?.name || '';
    const tracks = song.tracks.filter((t) => t.notes.length && !(t.kind === 'grid' && t.role === 'off' && !openTracks.has(t.id) && song.tracks.some((x) => x.kind === 'midi'))).map((t) => {
      const col = t.role === 'left' ? PALETTE.L.glow : t.role === 'right' || t.role === 'both' || t.role === 'meta' ? PALETTE.R.glow : PALETTE.B.glow;
      const roleTxt = t.role === 'meta' ? 'Mains du fichier' : ROLE_LABELS[t.role];
      const sub = t.isDrum ? instName(t.inst) : [roleTxt === t.name ? '' : roleTxt, instName(t.inst)].filter(Boolean).join(' · ');
      return `
      <div class="trk ${openTracks.has(t.id) ? 'open' : ''}" data-track="${esc(t.id)}" style="--c:${col}">${line(t, t.name, sub, true)}
        <div class="trk-more">
          ${t.isDrum ? `<label>Batterie<select data-k="inst">${DRUM_KITS.map((k) => `<option value="${k.id}" ${k.id === t.inst ? 'selected' : ''}>${esc(k.name)}</option>`).join('')}</select></label>`
            : `<label>Qui joue<select data-k="role">${roles(t).map((r) => `<option value="${r}" ${r === t.role ? 'selected' : ''}>${esc(roleName(t, r))}</option>`).join('')}</select></label>
          <label>Son<select data-k="inst">${instOptions(t.inst)}</select></label>`}
          ${t.kind === 'grid' ? `<label>Rythme<select data-k="style">
            <option value="hold" ${song.gridStyle === 'hold' ? 'selected' : ''}>Accords tenus</option>
            <option value="bar" ${song.gridStyle === 'bar' ? 'selected' : ''}>Un accord par mesure</option>
            <option value="beat" ${song.gridStyle === 'beat' ? 'selected' : ''}>Un accord par temps</option></select></label>` : ''}
        </div>
      </div>`;
    }).join('');
    const hiddenGrid = song.tracks.find((t) => t.kind === 'grid' && t.role === 'off' && !openTracks.has(t.id) && song.tracks.some((x) => x.kind === 'midi'));
    return `
      ${stems ? `<h3>Pistes audio</h3>${stems}` : ''}
      ${tracks ? `<h3>Notes</h3>${tracks}` : ''}
      ${hiddenGrid ? '<button class="chip" data-x="showgrid">+ Jouer aussi la grille d’accords</button>' : ''}
      <details class="adv"><summary>Ta partie</summary>
        <label class="fld"><span>Entendre la partie que tu joues</span><input type="range" min="0" max="100" value="${Math.round(S.hearMine * 100)}" data-set="hearMine"></label>
      </details>
      <p class="muted small">Le mixage est gardé pour ce morceau sur cet appareil.</p>`;
  }

  function soundsHtml() {
    return `
      <h3>Le son de mes touches</h3>
      <label class="switch"><input type="checkbox" data-set="liveSound" ${S.liveSound ? 'checked' : ''}><span>L’appli joue mes touches</span></label>
      <p class="muted small">Ta Yamaha a son propre son : coupe ici pour n’entendre que le piano, ou coupe le son du piano (Local Control) pour n’entendre que l’appli.</p>
      <label class="fld"><span>Instrument</span><select data-set="liveInst">${instOptions(S.liveInst)}</select></label>
      <label class="fld"><span>Volume</span><input type="range" min="0" max="130" value="${Math.round(S.liveVol * 100)}" data-set="liveVol"></label>
      <div class="try">${['grand', 'epiano', 'strings', 'organ', 'nylon', 'choir'].map((id) => `<button class="chip ${S.liveInst === id ? 'on' : ''}" data-try="${id}">${esc(INSTRUMENTS.find((i) => i.id === id).name)}</button>`).join('')}</div>
      <details class="adv"><summary>Réglages avancés</summary>
      <label class="fld"><span>Toucher</span><select data-set="velCurve">
        <option value="soft" ${S.velCurve === 'soft' ? 'selected' : ''}>Léger (plus fort avec peu de force)</option>
        <option value="normal" ${S.velCurve === 'normal' ? 'selected' : ''}>Normal</option>
        <option value="hard" ${S.velCurve === 'hard' ? 'selected' : ''}>Lourd (nuances plus larges)</option></select></label>
      <label class="fld"><span>Volume général</span><input type="range" min="0" max="120" value="${Math.round(S.master * 100)}" data-set="master"></label>
      <label class="fld"><span>Métronome</span><input type="range" min="0" max="100" value="${Math.round(S.metroVol * 100)}" data-set="metroVol"></label>
      </details>
      <p class="credits">${esc(CREDITS)}</p>`;
  }

  function settingsHtml() {
    const opt = (k, v, label) => `<option value="${v}" ${String(S[k]) === String(v) ? 'selected' : ''}>${label}</option>`;
    return `
      <h3>Affichage</h3>
      <label class="fld"><span>Notes visibles à l’avance</span><input type="range" min="15" max="80" value="${Math.round(S.look * 10)}" data-set="look"><em>${S.look.toFixed(1)} s</em></label>
      <label class="fld"><span>Noms sur les touches</span><select data-set="labels">${opt('labels', 'none', 'Aucun')}${opt('labels', 'c', 'Les Do')}${opt('labels', 'all', 'Toutes les touches blanches')}</select></label>
      <label class="switch"><input type="checkbox" data-set="noteNames" ${S.noteNames ? 'checked' : ''}><span>Noms des notes sur les notes qui tombent</span></label>
      <label class="switch"><input type="checkbox" data-set="showPedal" ${S.showPedal ? 'checked' : ''}><span>Pédale du morceau (bande dorée à droite)</span></label>
      <h3>Entraînement</h3>
      <label class="fld"><span>Tolérance</span><select data-set="tol">${opt('tol', 'easy', 'Facile (±0,30 s)')}${opt('tol', 'normal', 'Normale (±0,20 s)')}${opt('tol', 'strict', 'Exigeante (±0,12 s)')}</select></label>
      <button class="btn cal-btn" data-cal="open"><span>Caler mon clavier</span><em>décalage actuel : ${S.latency} ms</em></button>
      <details class="adv"><summary>Réglages avancés</summary>
        <label class="fld"><span>Grille d’accords</span><select data-set="chordsMode">${opt('chordsMode', 'auto', 'Automatique (cachée si devinée d’après le MIDI)')}${opt('chordsMode', 'on', 'Toujours afficher')}${opt('chordsMode', 'off', 'Cacher')}</select></label>
        <label class="fld"><span>Clavier</span><select data-set="range">${opt('range', 'auto', 'D’après le morceau')}${opt('range', '61', '61 touches')}${opt('range', '76', '76 touches')}${opt('range', '88', '88 touches (P-95)')}</select></label>
        <label class="fld"><span>Effets lumineux</span><select data-set="fx">${opt('fx', 'auto', 'Automatique (allégés si l’appareil rame)')}${opt('fx', 'high', 'Maximum')}${opt('fx', 'low', 'Légers')}</select></label>
        <label class="fld"><span>Décalage du clavier</span><input type="range" min="-150" max="250" step="5" value="${S.latency}" data-set="latency"><em>${S.latency} ms</em></label>
        <p class="muted small">Réglé tout seul par « Caler mon clavier ». Si tes notes justes sont comptées « en retard », augmente-le.</p>
        <p class="muted small">Raccourcis : Espace = lecture / pause · ← → = 5 s · Q S D F G H J K L (et Z E T Y U) = jouer au clavier de l’ordinateur · W / X = octave.</p>
      </details>`;
  }


  // les curseurs montrent leur valeur (remplissage ambre jusqu'au bouton)
  function paintRange(r) { const v = ((+r.value - +r.min) / (+r.max - +r.min)) * 100; r.style.setProperty('--v', v + '%'); }
  root.addEventListener('input', (e) => { if (e.target.type === 'range') paintRange(e.target); });
  new MutationObserver(() => root.querySelectorAll('input[type=range]').forEach(paintRange)).observe(root, { childList: true, subtree: true });
  root.querySelectorAll('input[type=range]').forEach(paintRange);
  el.drawer.addEventListener('input', onDrawerInput);
  el.drawer.addEventListener('change', onDrawerInput);
  el.drawer.addEventListener('click', (e) => {
    const ms = e.target.closest('.ms');
    if (ms) {
      const item = findItem(ms);
      if (!item) return;
      item[ms.dataset.k] = !item[ms.dataset.k];
      ms.classList.toggle('on', item[ms.dataset.k]);
      applyGains(); saveMix();
    }
    const tr = e.target.closest('[data-try]');
    if (tr) tryInstrument(tr.dataset.try);
    const x = e.target.closest('[data-x]')?.dataset.x;
    if (x === 'more') { const card = e.target.closest('[data-track]'); const id = card.dataset.track; if (openTracks.has(id)) openTracks.delete(id); else openTracks.add(id); card.classList.toggle('open'); }
    if (x === 'showgrid') { const g = song.tracks.find((t) => t.kind === 'grid'); if (g) { openTracks.add(g.id); renderDrawer(); } }
  });
  function findItem(node) {
    const st = node.closest('[data-stem]')?.dataset.stem, tr = node.closest('[data-track]')?.dataset.track;
    return st ? song.stems.find((x) => x.id === st) : tr ? song.tracks.find((x) => x.id === tr) : null;
  }
  async function tryInstrument(id) {
    await audio();
    S.liveInst = id; synth.liveInst = id; saveSettings();
    await synth.bank.load(id).catch(() => {});
    const notes = [60, 64, 67, 72];
    notes.forEach((p, i) => synth.note(p, 0.7, ctx.currentTime + 0.05 + i * 0.12, 1.4, { bus: 'live', inst: id }));
    renderDrawer();
  }
  function onDrawerInput(e) {
    const t = e.target;
    const k = t.dataset.k, set = t.dataset.set;
    if (k) {
      const item = findItem(t);
      if (!item) return;
      if (k === 'vol') { item.vol = +t.value / 100; applyGains(); }
      if (e.type === 'change' && k === 'role') { item.role = t.value; openTracks.add(item.id); rebuild(); renderDrawer(); }
      if (e.type === 'change' && k === 'inst') { item.inst = t.value; synth.bank.load(t.value); openTracks.add(item.id); renderDrawer(); }
      if (e.type === 'change' && k === 'style') { song.gridStyle = t.value; regenGrid(); rebuild(); }
      saveMix();
      return;
    }
    if (!set) return;
    let v = t.type === 'checkbox' ? t.checked : t.type === 'range' ? +t.value : t.value;
    if (['hearMine', 'liveVol', 'master', 'metroVol'].includes(set)) v /= 100;
    if (set === 'look') v /= 10;
    S[set] = v; saveSettings();
    const em = t.parentElement.querySelector('em');
    if (em) em.textContent = set === 'look' ? `${v.toFixed(1)} s` : `${v} ms`;
    if (!synth) return;
    if (set === 'hearMine') applyGains();
    if (set === 'liveSound' || set === 'liveVol') synth.setBus('live', S.liveSound ? S.liveVol : 0);
    if (set === 'liveInst') { synth.liveInst = v; synth.bank.load(v); }
    if (set === 'master') synth.out.gain.setTargetAtTime(v, ctx.currentTime, 0.03);
    if (set === 'metroVol') synth.setBus('click', v);
    if (['look', 'labels', 'range', 'tol', 'noteNames', 'chordsMode', 'showPedal'].includes(set)) { rebuild(); lastChord = null; }
    if (set === 'fx') { roll.lite = v === 'low'; slowFor = 0; roll.resize(); }
  }

  // vumètres des pistes audio
  setInterval(() => {
    if (el.drawer.hidden || !song?.stems.length || !engine.ctx) return;
    const lv = engine.levels();
    el.drawer.querySelectorAll('[data-stem]').forEach((d) => { const i = d.querySelector('.meter i'); if (i) i.style.transform = `scaleX(${lv[d.dataset.stem] || 0})`; });
  }, 80);

  let toastT = 0;
  function toast(msg, ms = 3600) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastT);
    toastT = setTimeout(() => el.toast.classList.remove('show'), ms);
  }

  const ro = new ResizeObserver(() => { roll.resize(); root.style.setProperty('--kb', (roll.kbH + 6) + 'px'); });
  ro.observe(el.canvas);
  setMode(S.mode);
  frame();

  return {
    open, toast, audio,
    notes: noteBus,
    synth: () => synth,
    /** jouer / relâcher une note depuis une autre interface (exercices) */
    press(m, down) { if (down) keyDown(m, 0.7); else keyUp(m); },
    pause() { if (transport?.playing) { transport.pause(); synth?.stopAll(); } waiting = false; },
    /** état (pour les tests et le débogage) */
    debug: () => ({ song, calib: calib && { c0: calib.c0, outLat: calib.outLat, running: calib.running }, audioNow: ctx?.currentTime, wake: !!wakeLock, pedal: roll.pedal.length, notes: flat.length, toPlay: practice.notes.length, mode: S.mode, stats: { ...practice.stats }, time: transport?.time, range: [roll.lo, roll.hi], engine: { playing: engine.playing, ctx: ctx?.state, els: engine.tracks.map((t) => [t.el.paused, t.el.currentTime, t.el.readyState, t.el.error?.code ?? null]) } }),
    destroy() { flushTime(); cancelAnimationFrame(raf); wakeLock?.release?.(); document.removeEventListener('visibilitychange', onVisible); ro.disconnect(); window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onKey); engine.unload(); },
  };
}

/** « Db » → « Ré♭ majeur », « F#m » → « Fa♯ mineur » (sinon tel quel). */
function frKey(k) {
  const m = /^([A-G])([#b♯♭]?)(m|min|minor)?$/.exec(String(k).trim());
  if (!m) return `Tonalité ${k}`;
  const N = { C: 'Do', D: 'Ré', E: 'Mi', F: 'Fa', G: 'Sol', A: 'La', B: 'Si' };
  const acc = m[2] === '#' || m[2] === '♯' ? '♯' : m[2] ? '♭' : '';
  return `${N[m[1]]}${acc} ${m[3] ? 'mineur' : 'majeur'}`;
}
