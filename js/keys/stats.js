// MusiMix Piano — journal de pratique : temps joué par jour, essais (morceaux, exercices, formation musicale).
// Gardé sur l'appareil (localStorage) ; fusionné entre appareils par la synchro Google Drive de MusiMix (piano.json).

const KEY = 'mmx-piano:log';
const PKEY = 'mmx-piano:progress';
const MAX_RUNS = 1500;

const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* aperçu sans stockage */ } };

/** Identifiant de cet appareil (le temps de chaque appareil est compté à part, puis additionné). */
export function deviceId() {
  let id = read('mmx-piano:device', null);
  if (!id) { id = 'd' + Math.random().toString(36).slice(2, 10); write('mmx-piano:device', id); }
  return id;
}

/** Date locale « 2026-11-28 ». */
export function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function getLog() {
  const L = read(KEY, null) || {};
  L.days ||= {}; L.runs ||= [];
  return L;
}

/** Secondes de pratique à ajouter pour aujourd'hui. */
export function addTime(sec) {
  if (!(sec > 0)) return;
  const L = getLog(), d = dayKey(), dev = deviceId();
  L.days[d] ||= {};
  L.days[d][dev] = Math.round(((L.days[d][dev] || 0) + sec) * 10) / 10;
  write(KEY, L);
}

/** Un essai terminé : { id, title, kind: 'lesson'|'mine'|'file'|'drill', acc, rate, wait, hands }. */
export function addRun(run) {
  const L = getLog();
  L.runs.push({ ...run, at: Date.now(), dev: deviceId() });
  if (L.runs.length > MAX_RUNS) L.runs = L.runs.slice(-MAX_RUNS);
  write(KEY, L);
}

/** Minutes jouées par jour (tous appareils). */
export function minutesByDay(L = getLog()) {
  const out = {};
  for (const [d, devs] of Object.entries(L.days)) out[d] = Object.values(devs).reduce((a, b) => a + b, 0) / 60;
  return out;
}

/** Série : jours consécutifs (jusqu'à aujourd'hui, ou hier si on n'a pas encore joué aujourd'hui) avec au moins `min` minutes. */
export function streak(L = getLog(), min = 3) {
  const m = minutesByDay(L);
  const d = new Date();
  if (!(m[dayKey(d)] >= min)) d.setDate(d.getDate() - 1);
  let n = 0;
  while (m[dayKey(d)] >= min) { n++; d.setDate(d.getDate() - 1); }
  return n;
}

/** Fusion avec ce qui vient d'un autre appareil (synchro). Renvoie { log, progress, changed }. */
export function mergeRemote(remote) {
  const L = getLog(), P = read(PKEY, {});
  let changed = false;
  for (const [d, devs] of Object.entries(remote?.log?.days || {})) {
    L.days[d] ||= {};
    for (const [dev, sec] of Object.entries(devs)) if ((L.days[d][dev] || 0) < sec) { L.days[d][dev] = sec; changed = true; }
  }
  const seen = new Set(L.runs.map((r) => r.at + ':' + r.dev + ':' + r.id));
  for (const r of remote?.log?.runs || []) if (!seen.has(r.at + ':' + r.dev + ':' + r.id)) { L.runs.push(r); changed = true; }
  L.runs.sort((a, b) => a.at - b.at);
  if (L.runs.length > MAX_RUNS) L.runs = L.runs.slice(-MAX_RUNS);
  for (const [id, r] of Object.entries(remote?.progress || {})) {
    const l = P[id];
    if (!l) { P[id] = r; changed = true; continue; }
    const m = { ...l, best: Math.max(l.best || 0, r.best || 0), stars: Math.max(l.stars || 0, r.stars || 0), plays: Math.max(l.plays || 0, r.plays || 0) };
    if ((r.last || 0) > (l.last || 0)) Object.assign(m, { last: r.last, lastAcc: r.lastAcc });
    if (JSON.stringify(m) !== JSON.stringify(l)) { P[id] = m; changed = true; }
  }
  write(KEY, L); write(PKEY, P);
  return { log: L, progress: P, changed };
}

/** Ce qu'on envoie à la synchro. */
export function snapshot() { return { log: getLog(), progress: read(PKEY, {}), v: 1 }; }
