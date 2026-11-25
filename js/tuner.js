// MusiMix — accordeur au micro.
// Hauteur : YIN (de Cheveigné & Kawahara 2002) sur le signal décimé ×2, interpolation parabolique,
// médiane glissante + garde anti-octave, aiguille à ressort amorti. Précision ≈ ±1 cent sur corde tenue.

import { dialog, esc } from './ui.js';

const LETTERS = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const FR = ['Do', 'Do♯', 'Ré', 'Ré♯', 'Mi', 'Fa', 'Fa♯', 'Sol', 'Sol♯', 'La', 'La♯', 'Si'];
export const TUNINGS = {
  standard: { label: 'Standard', sub: 'E A D G B E', strings: [40, 45, 50, 55, 59, 64] },
  half: { label: '½ ton plus bas', sub: 'E♭ A♭ D♭ G♭ B♭ E♭', strings: [39, 44, 49, 54, 58, 63] },
  dropd: { label: 'Drop D', sub: 'D A D G B E', strings: [38, 45, 50, 55, 59, 64] },
  ukulele: { label: 'Ukulélé', sub: 'G C E A', strings: [67, 60, 64, 69] },
  chroma: { label: 'Chromatique', sub: 'toutes les notes', strings: null },
};
const FLATS = { 'C♯': 'D♭', 'D♯': 'E♭', 'F♯': 'G♭', 'G♯': 'A♭', 'A♯': 'B♭' };
const midiOf = (f, a4) => 69 + 12 * Math.log2(f / a4);
const pc = (m) => ((Math.round(m) % 12) + 12) % 12;
const letter = (m, flat) => { const l = LETTERS[pc(m)]; return flat ? FLATS[l] || l : l; };
const octave = (m) => Math.floor(Math.round(m) / 12) - 1;

/** YIN : { f, conf } ou null. buf : signal mono, sr : fréquence d'échantillonnage. */
export function yin(buf, sr, { min = 55, max = 1100, threshold = 0.1 } = {}) {
  const tauMin = Math.max(2, Math.floor(sr / max));
  const tauMax = Math.min(Math.ceil(sr / min), Math.floor(buf.length / 2) - 1);
  const W = buf.length - tauMax - 1;
  const cm = new Float32Array(tauMax + 2);
  let run = 0;
  cm[0] = 1;
  for (let tau = 1; tau <= tauMax + 1; tau++) {
    let s = 0;
    for (let i = 0; i < W; i++) { const x = buf[i] - buf[i + tau]; s += x * x; }
    run += s;
    cm[tau] = run ? (s * tau) / run : 1;
  }
  let tau = -1;
  for (let t = tauMin; t <= tauMax; t++) {
    if (cm[t] < threshold) { while (t + 1 <= tauMax && cm[t + 1] < cm[t]) t++; tau = t; break; }
  }
  if (tau < 0) { // pas sous le seuil : minimum global, s'il est assez net
    let best = tauMin; for (let t = tauMin; t <= tauMax; t++) if (cm[t] < cm[best]) best = t;
    if (cm[best] > 0.25) return null; tau = best;
  }
  const a = cm[tau - 1], b = cm[tau], c = cm[tau + 1];
  const den = a + c - 2 * b;
  const t = den > 0 ? tau + (a - c) / (2 * den) : tau;
  return { f: sr / t, conf: 1 - b };
}

// Cadran : arc de −50 à +50 cents sur 120°
const R = 120, CX = 150, CY = 150, SPAN = 60;
const pt = (deg, r) => { const a = ((deg - 90) * Math.PI) / 180; return [CX + r * Math.cos(a), CY + r * Math.sin(a)]; };
const arc = (d0, d1, r) => { const [x0, y0] = pt(d0, r), [x1, y1] = pt(d1, r); return `M${x0.toFixed(1)} ${y0.toFixed(1)}A${r} ${r} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`; };
function dialSvg() {
  let ticks = '';
  for (let c = -50; c <= 50; c += 5) {
    const deg = (c / 50) * SPAN, big = c % 25 === 0;
    const [x0, y0] = pt(deg, R - (big ? 16 : c % 10 === 0 ? 10 : 6)), [x1, y1] = pt(deg, R);
    ticks += `<line x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}" class="${big ? 'big' : ''}"/>`;
  }
  const lab = [-50, -25, 25, 50].map((c) => { const [x, y] = pt((c / 50) * SPAN, R + 14); return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}">${c > 0 ? '+' : '−'}${Math.abs(c)}</text>`; }).join('');
  const [nx, ny] = pt(0, R - 22);
  return `<svg class="tu-dial" viewBox="0 8 300 160" aria-hidden="true">
    <path class="tu-track" d="${arc(-SPAN, SPAN, R)}"/>
    <path class="tu-ok" d="${arc(-SPAN * 0.1, SPAN * 0.1, R)}"/>
    <g class="tu-ticks">${ticks}</g><g class="tu-labs">${lab}</g>
    <text class="tu-side" x="40" y="150">♭</text><text class="tu-side" x="260" y="150">♯</text>
    <g class="tu-needle" data-r="needle"><line x1="${CX}" y1="${CY}" x2="${nx.toFixed(1)}" y2="${ny.toFixed(1)}"/><circle cx="${CX}" cy="${CY}" r="7"/></g>
  </svg>`;
}

/** « D A D G B E » ou « D2 A2 D3… » → { strings: [midi…], names: […] } ou { error }. */
export function parseTuning(text) {
  const toks = String(text || '').trim().split(/[\s,;\-–]+/).filter(Boolean);
  if (toks.length < 1 || toks.length > 10) return { error: 'Entre de 1 à 10 notes, de la corde la plus grave à la plus aiguë.' };
  const strings = [], names = [];
  let prev = null;
  for (const t of toks) {
    const m = /^([A-Ga-g]|do|ré|re|mi|fa|sol|la|si)([#♯b♭]?)(-?\d)?$/i.exec(t.normalize('NFC'));
    if (!m) return { error: `« ${t} » n’est pas une note (exemples : D, F#, Bb, D2).` };
    const FRL = { do: 'C', ré: 'D', re: 'D', mi: 'E', fa: 'F', sol: 'G', la: 'A', si: 'B' };
    const L = (FRL[m[1].toLowerCase()] || m[1].toUpperCase());
    const acc = m[2] === '#' || m[2] === '♯' ? 1 : m[2] ? -1 : 0;
    const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[L] + acc;
    let midi;
    if (m[3] != null) midi = (+m[3] + 1) * 12 + base;
    else if (prev == null) { midi = 36 + ((base % 12) + 12) % 12; if (midi < 35) midi += 12; while (Math.abs(midi + 12 - 40) < Math.abs(midi - 40)) midi += 12; }
    else { midi = 12 * Math.floor(prev / 12) + (((base % 12) + 12) % 12); while (midi < prev) midi += 12; } // l'unisson est permis (Open C : … C C)
    if (midi < 21 || midi > 96) return { error: `« ${t} » est hors de portée.` };
    strings.push(midi);
    names.push(L + (acc > 0 ? '♯' : acc < 0 ? '♭' : ''));
    prev = midi;
  }
  return { strings, names };
}

export async function tunerDialog(app) {
  const prefs = (await app.prefs?.()) || {};
  let customs = Array.isArray(prefs.tunerCustom) ? prefs.tunerCustom : [];
  const all = () => ({ ...TUNINGS, ...Object.fromEntries(customs.map((c) => [c.id, { ...c, sub: c.names.join(' '), custom: true }])) });
  let mode = all()[prefs.tunerMode] ? prefs.tunerMode : 'standard';
  const cur = () => all()[mode] || TUNINGS.standard;
  let a4 = prefs.tunerA4 || 440;
  let lock = -1; // corde imposée (−1 = automatique)
  const done = new Set();
  const d = dialog(`<div class="dlg tuner">
    <div class="tu-head"><h2>Accordeur</h2><button class="icon-btn" data-close="" aria-label="Fermer">✕</button></div>
    <div class="tu-modes" data-r="modes"></div>
    <div class="tu-edit" data-r="edit" hidden></div>
    <div class="tu-main">
    <div class="tu-stage">
      ${dialSvg()}
      <div class="tu-read"><div class="tu-note"><b data-r="note">–</b><sup data-r="acc"></sup><sub data-r="oct"></sub></div>
      <div class="tu-cents" data-r="cents">&nbsp;</div></div>
    </div>
    <p class="tu-msg" data-r="msg">Autorisation du micro…</p>
    <div class="tu-strings" data-r="strings"></div>
    <div class="tu-foot"><span class="tu-hz" data-r="hz">— Hz</span>
      <span class="tu-a4">La = <button type="button" data-a="-1" aria-label="Baisser">−</button><output data-r="a4">${a4}</output><button type="button" data-a="1" aria-label="Monter">+</button> Hz</span></div>
    </div>
  </div>`, { cls: 'tuner-dlg' });
  const el = d.el;
  const $ = (r) => el.querySelector(`[data-r="${r}"]`);
  const box = el.querySelector('.tuner');
  const label = (i) => { const t = cur(); return t.names ? t.names[i] : letter(t.strings[i], mode === 'half'); };
  const drawModes = () => {
    $('modes').innerHTML = Object.entries(all()).map(([k, v]) => `<button type="button" data-m="${k}" class="${k === mode ? 'on' : ''} ${v.custom ? 'mine' : ''}" title="${esc(v.sub)}">${esc(v.label)}</button>`).join('')
      + '<button type="button" class="tu-add" data-edit="new" title="Créer un accordage sur mesure">＋ Sur mesure</button>';
  };
  const drawStrings = () => {
    drawModes();
    const st = cur().strings;
    $('strings').innerHTML = st
      ? st.map((m, i) => `<button type="button" data-s="${i}" class="${lock === i ? 'lock' : ''} ${done.has(i) ? 'done' : ''}" title="Corde ${st.length - i} (${label(i)}${octave(m)}) — toucher pour la cibler"><b>${esc(label(i))}</b><small>${st.length - i}</small></button>`).join('')
        + `<span class="tu-auto">${lock < 0 ? 'Auto' : '<button type="button" data-s="-1">Auto</button>'}${cur().custom ? ` · <button type="button" data-edit="${mode}">Modifier</button>` : ''}</span>`
      : '<span class="tu-auto on">Toutes les notes, de La0 à Do♯6</span>';
  };
  drawStrings();

  // ---- éditeur d'accordage sur mesure ----
  const openEdit = (id) => {
    const c = customs.find((x) => x.id === id);
    const ed = $('edit');
    ed.hidden = false;
    el.querySelector('.tu-main').hidden = true;
    ed.innerHTML = `<h3>${c ? 'Modifier l’accordage' : 'Nouvel accordage'}</h3>
      <label class="tu-field"><span>Nom</span><input data-f="name" maxlength="24" placeholder="ex. Open G, DADGAD…" value="${esc(c?.label || '')}"></label>
      <label class="tu-field"><span>Notes, de la corde la plus grave à la plus aiguë</span><input data-f="notes" placeholder="ex. C G E G C C" value="${esc(c ? c.strings.map((m, i) => c.names[i] + octave(m)).join(' ') : '')}" autocapitalize="characters" spellcheck="false"></label>
      <p class="note">Octave facultative : « D A D G A D » suffit pour une guitare. Ajoute-la si besoin (« G4 C4 E4 A4 » pour un ukulélé). Dièse : #, bémol : b.</p>
      <div class="tu-ex">Exemples : ${[['Open C', 'C G E G C C'], ['Open G', 'D G D G B D'], ['Open D', 'D A D F# A D'], ['DADGAD', 'D A D G A D'], ['Drop C', 'C G C F A D']].map(([n, t]) => `<button type="button" class="chip" data-ex="${t}" data-exn="${n}">${n}</button>`).join('')}</div>
      <div class="tu-prev" data-r="prev"></div>
      <div class="actions">${c ? '<button type="button" class="btn ghost danger" data-ed="del">Supprimer</button>' : ''}<span style="flex:1"></span><button type="button" class="btn ghost" data-ed="cancel">Annuler</button><button type="button" class="btn primary" data-ed="save">Enregistrer</button></div>`;
    const notes = ed.querySelector('[data-f="notes"]'), name = ed.querySelector('[data-f="name"]');
    const preview = () => {
      const r = parseTuning(notes.value);
      $('prev').innerHTML = !notes.value.trim() ? '' : r.error ? `<span class="err">${esc(r.error)}</span>`
        : r.strings.map((m, i) => `<span><b>${esc(r.names[i])}</b><small>${octave(m)}</small></span>`).join('');
      return r;
    };
    notes.addEventListener('input', preview);
    preview();
    (c ? notes : name).focus();
    ed.onclick = (e) => {
      const ex = e.target.closest('[data-ex]');
      if (ex) { notes.value = ex.dataset.ex; if (!name.value.trim()) name.value = ex.dataset.exn; preview(); return; }
      const a = e.target.closest('[data-ed]')?.dataset.ed;
      if (!a) return;
      if (a === 'save') {
        const r = preview();
        if (!notes.value.trim() || r.error) { notes.focus(); if (!notes.value.trim()) $('prev').innerHTML = '<span class="err">Entre les notes des cordes.</span>'; return; }
        const nm = name.value.trim() || r.names.join(' ');
        const item = { id: c?.id || 'c' + Date.now().toString(36), label: nm, strings: r.strings, names: r.names };
        customs = c ? customs.map((x) => (x.id === c.id ? item : x)) : [...customs, item];
        mode = item.id;
      } else if (a === 'del') {
        customs = customs.filter((x) => x.id !== c.id);
        mode = 'standard';
      }
      if (a !== 'cancel') { app.setPref?.('tunerCustom', customs); app.setPref?.('tunerMode', mode); lock = -1; done.clear(); }
      ed.hidden = true; ed.innerHTML = '';
      el.querySelector('.tu-main').hidden = false;
      drawStrings();
    };
    ed.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); ed.querySelector('[data-ed="save"]').click(); } };
  };

  el.addEventListener('click', (e) => {
    const ed = e.target.closest('[data-edit]');
    if (ed) { openEdit(ed.dataset.edit); return; }
    const m = e.target.closest('[data-m]');
    if (m) { mode = m.dataset.m; lock = -1; done.clear(); drawStrings(); app.setPref?.('tunerMode', mode); m.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); }
    const s = e.target.closest('[data-s]');
    if (s) { const i = +s.dataset.s; lock = lock === i ? -1 : i; drawStrings(); }
    const aa = e.target.closest('[data-a]');
    if (aa) { a4 = Math.max(415, Math.min(466, a4 + +aa.dataset.a)); $('a4').textContent = a4; app.setPref?.('tunerA4', a4); }
  });

  let stream, ctx, raf, alive = true;
  const stop = () => { alive = false; cancelAnimationFrame(raf); stream?.getTracks().forEach((t) => t.stop()); ctx?.close().catch(() => {}); };
  d.done.then(stop);
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  } catch (err) {
    $('msg').innerHTML = err.name === 'NotAllowedError' || err.name === 'SecurityError'
      ? '<b>Micro refusé.</b> Autorise le micro pour MusiMix (icône à gauche de l’adresse), puis rouvre l’accordeur.'
      : err.name === 'NotFoundError' || err.name === 'OverconstrainedError'
        ? '<b>Aucun micro trouvé sur cet appareil.</b> Branche un micro (casque, webcam, Zoom R20 en USB…) puis rouvre l’accordeur, ou accorde avec le téléphone.'
        : err.name === 'NotReadableError'
          ? '<b>Le micro est déjà utilisé</b> par un autre programme (visio, enregistreur…). Ferme-le puis rouvre l’accordeur.'
          : `<b>Micro inaccessible.</b> ${esc(err.message)}`;
    box.classList.add('off');
    return;
  }
  if (!alive) { stream.getTracks().forEach((t) => t.stop()); return; }
  ctx = new AudioContext();
  ctx.resume().catch(() => {});
  const src = ctx.createMediaStreamSource(stream);
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 45; // coupe ronflette et chocs
  const an = ctx.createAnalyser(); an.fftSize = 4096;
  src.connect(hp).connect(an);
  const sr = ctx.sampleRate;
  const big = new Float32Array(an.fftSize);
  const half = new Float32Array(an.fftSize / 2);
  const sr2 = sr / 2;
  $('msg').textContent = cur().strings ? 'Joue une corde à vide, laisse-la sonner.' : 'Joue une note, laisse-la sonner.';

  const hist = [];
  let stable = null, lastSeen = 0, needle = 0, vel = 0, shown = 0, okSince = 0, lastT = performance.now(), frame = 0;
  let curSi = -1, curTarget = null;
  const anim = (now) => {
    raf = requestAnimationFrame(anim);
    const dt = Math.min(0.05, (now - lastT) / 1000); lastT = now;
    // analyse ~30 fois/s
    if (frame++ % 2 === 0) analyse(now);
    // ressort amorti vers la cible
    const k = 90, damp = 2 * Math.sqrt(k) * 0.9;
    const acc = k * (shown - needle) - damp * vel;
    vel += acc * dt; needle += vel * dt;
    const deg = Math.max(-SPAN - 4, Math.min(SPAN + 4, (needle / 50) * SPAN));
    $('needle').setAttribute('transform', `rotate(${deg.toFixed(2)} ${CX} ${CY})`);
  };
  const silence = (now) => {
    if (now - lastSeen > 900) {
      shown = 0; hist.length = 0; stable = null; okSince = 0;
      box.classList.remove('ok', 'live', 'near');
      if (now - lastSeen > 2500) { $('note').textContent = '–'; $('acc').textContent = ''; $('oct').textContent = ''; $('cents').innerHTML = '&nbsp;'; $('hz').textContent = '— Hz'; }
    }
  };
  function analyse(now) {
    an.getFloatTimeDomainData(big);
    let rms = 0;
    for (let i = 0; i < half.length; i++) { const v = (big[2 * i] + big[2 * i + 1]) * 0.5; half[i] = v; rms += v * v; }
    rms = Math.sqrt(rms / half.length);
    if (rms < 0.004) return silence(now);
    const r = yin(half, sr2);
    if (!r || r.conf < 0.8) return silence(now);
    let f = r.f;
    // garde anti-octave : un saut d'octave isolé est replié sur la note tenue
    if (stable) {
      const ratio = f / stable;
      for (const k of [2, 0.5, 3, 1 / 3]) if (Math.abs(ratio / k - 1) < 0.03) { f = f / k; break; }
    }
    hist.push(f); if (hist.length > 7) hist.shift();
    const med = [...hist].sort((x, y) => x - y)[hist.length >> 1];
    if (stable && Math.abs(1200 * Math.log2(med / stable)) > 80) { hist.length = 0; hist.push(f); } // nouvelle note
    stable = stable && Math.abs(1200 * Math.log2(med / stable)) < 80 ? stable * 0.6 + med * 0.4 : med;
    lastSeen = now;
    const m = midiOf(stable, a4);
    const st = cur().strings;
    let target = Math.round(m), si = -1;
    if (st) {
      if (lock >= 0) si = lock;
      else si = st.reduce((bi, s, i) => (Math.abs(s - m) < Math.abs(st[bi] - m) ? i : bi), 0);
      target = st[si];
    }
    const cents = (m - target) * 100;
    shown = Math.max(-55, Math.min(55, cents));
    const L = si >= 0 ? label(si) : letter(target, false);
    if (curTarget !== target) {
      curTarget = target;
      $('note').textContent = L[0]; $('acc').textContent = L.slice(1);
      $('oct').textContent = octave(target);
      el.querySelector('.tu-note').title = `${FR[pc(target)]}${octave(target)}`;
    }
    if (si !== curSi) { curSi = si; el.querySelectorAll('.tu-strings [data-s]').forEach((x) => x.classList.toggle('cur', +x.dataset.s === si)); }
    $('hz').textContent = `${stable.toFixed(1)} Hz`;
    const ac = Math.abs(cents);
    $('cents').textContent = ac < 0.5 ? '0 cent' : `${cents > 0 ? '+' : '−'}${ac < 10 ? ac.toFixed(1) : Math.round(ac)} cents`;
    box.classList.add('live');
    box.classList.toggle('near', ac < 10);
    const ok = ac < 3;
    if (ok) { okSince ||= now; } else okSince = 0;
    const held = ok && now - okSince > 350;
    box.classList.toggle('ok', held);
    if (held && st && !done.has(si)) { done.add(si); el.querySelector(`.tu-strings [data-s="${si}"]`)?.classList.add('done'); navigator.vibrate?.(30); }
    const far = st && Math.abs(m - target) > 1.5;
    $('msg').textContent = held ? 'Juste ✓'
      : far ? (m < target ? `Corde ${st.length - si} très basse : resserre franchement` : `Corde ${st.length - si} très haute : desserre franchement`)
      : ac < 3 ? 'Presque… tiens la note'
      : cents < 0 ? 'Trop bas : resserre' : 'Trop haut : desserre';
  }
  raf = requestAnimationFrame(anim);
}
