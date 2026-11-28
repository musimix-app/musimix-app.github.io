// MusiMix — séparation des pistes directement dans le navigateur (sans le Studio).
// Moteur : unblend (MIT, js/vendor/unblend) + onnxruntime-web sur la carte graphique (WebGPU).
//   « Qualité max » : BS-RoFormer 6 pistes (voix, batterie, basse, guitare, piano, autres) — WebGPU obligatoire.
//   « Rapide »      : HTDemucs 6 pistes — marche aussi sans WebGPU (plus lent sur le processeur).
// Les modèles sont téléchargés une fois depuis Hugging Face puis gardés dans le navigateur.

import { db } from './db.js';
import { decodeAt, encodeWav } from './wav.js';
import { encodeOpus, opusSupported } from './opus.js';
import { addSeparatedStems } from './songs.js';
import { levelOf } from './levels.js';

const ORT_WASM = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0/dist/';
const KIND = { vocals: 'vocals', drums: 'drums', bass: 'bass', guitar: 'guitar', piano: 'piano', other: 'other' };

export const QUALITIES = {
  best: { model: 'bs_roformer_sw', label: 'Qualité max (BS-RoFormer, 6 pistes)', webgpu: true, shifts: 1, bitrate: 192000 },
  // Expert : 4 passages décalés moyennés (moins d'artefacts aux coupures), puis la voix refaite par un 2e modèle
  // spécialisé (Mel-Band RoFormer de Kim) et moyennée avec la 1re ; pistes enregistrées en Opus 256 kb/s.
  expert: { model: 'bs_roformer_sw', label: 'Expert (2 modèles, 4 passages — très long)', webgpu: true, shifts: 4, vocal: { model: 'melband_roformer_kim', shifts: 2 }, bitrate: 256000 },
  fast: { model: 'htdemucs_6s', label: 'Rapide (Demucs, 6 pistes)', webgpu: false, shifts: 1, bitrate: 160000 },
};

let lib = null;
// réseau capricieux : un deuxième essai avant d'abandonner (et pas de promesse ratée gardée en mémoire)
const loadLib = () => (lib ||= import('./vendor/unblend/index.js')
  .catch(() => new Promise((r) => setTimeout(r, 1500)).then(() => import(`./vendor/unblend/index.js?r=${Date.now()}`)))
  .catch((e) => { lib = null; throw e; }));

export async function gpuInfo() {
  try {
    if (!navigator.gpu) return { webgpu: false, f16: false };
    const a = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!a) return { webgpu: false, f16: false };
    return { webgpu: true, f16: a.features.has('shader-f16') };
  } catch { return { webgpu: false, f16: false }; }
}

/** Taille du téléchargement (Mo) et état du cache, pour l'afficher avant de lancer. */
export async function modelInfo(quality) {
  const { MODEL_ARTIFACTS } = await loadLib();
  const g = await gpuInfo();
  const q = QUALITIES[quality] || QUALITIES.best;
  const precision = q.webgpu && !g.f16 ? 'fp32' : 'fp16';
  const arts = [MODEL_ARTIFACTS[q.model][precision], ...(q.vocal ? [MODEL_ARTIFACTS[q.vocal.model][precision]] : [])];
  let cached = true;
  try { const c = await caches.open('unblend-models'); for (const a of arts) if (!(await c.match(a.url))) cached = false; } catch { cached = false; }
  return { ...g, precision, mb: Math.round(arts.reduce((x, a) => x + a.sizeBytes, 0) / 1e6), cached, usable: !q.webgpu || g.webgpu };
}

/**
 * Sépare la piste « Morceau » d'un morceau et l'enregistre avec ses nouvelles pistes.
 * onProgress({ progress 0..1, message })
 */
export async function separateSong(songId, { quality = 'best', onProgress = () => {}, signal } = {}) {
  const song = await db.getSong(songId);
  if (!song) throw new Error('Morceau introuvable');
  const src = song.stems.find((s) => s.kind === 'mix') || song.stems[0];
  const blob = src && (await db.getBlob(src.blobId));
  if (!blob) throw new Error('Pas de fichier audio à séparer');

  const { Separator } = await loadLib();
  let q = QUALITIES[quality] || QUALITIES.best;
  const g = await gpuInfo();
  if (q.webgpu && !g.webgpu) {
    q = QUALITIES.fast;
    onProgress({ progress: 0, message: 'Pas de carte graphique utilisable ici : mode rapide' });
  }
  const precision = q.webgpu && !g.f16 ? 'fp32' : 'fp16';

  // 0 → 0,15 : téléchargement du modèle (une seule fois) ; 0,15 → 0,9 : séparation (Expert : 2 modèles) ; 0,9 → 1 : enregistrement
  onProgress({ progress: 0, message: 'Chargement du moteur…' });
  onProgress({ progress: 0.02, message: 'Décodage de l’audio…' });
  const audio = await decodeAt(blob, 44100);
  const run = async (model, shifts, p0, p1, label) => {
    const sep = await Separator.load(model, {
      backend: g.webgpu ? 'webgpu' : 'wasm', precision, wasmPaths: ORT_WASM, numThreads: 1, signal,
      onProgress: (phase, loaded, total, source) => {
        if (phase === 'download') {
          const mb = (x) => Math.round(x / 1e6);
          onProgress({ progress: p0 + 0.1 * (p1 - p0) * (total ? loaded / total : 0), message: source === 'cache' ? 'Lecture du modèle enregistré…' : `Téléchargement du modèle${label ? ` (${label})` : ''}, une seule fois : ${mb(loaded)} / ${mb(total)} Mo` });
        } else onProgress({ progress: p0 + 0.1 * (p1 - p0), message: 'Préparation du modèle sur la carte graphique…' });
      },
    });
    try {
      const t0 = performance.now();
      const a = p0 + 0.1 * (p1 - p0);
      return await sep.separate(audio, {
        signal, shifts,
        onProgress: (pp) => {
          const f = pp.fraction || 0;
          const el = (performance.now() - t0) / 1000;
          const left = f > 0.03 ? Math.max(0, el / f - el) : 0;
          const tl = left > 5400 ? ` · encore ~${Math.round(left / 3600)} h` : left ? ` · encore ~${Math.ceil(left / 60)} min` : '';
          onProgress({ progress: a + (p1 - a) * f, message: `Séparation${label ? ` (${label})` : ''}… ${Math.round(f * 100)} %${tl}` });
        },
      });
    } finally { sep.unload().catch(() => {}); }
  };
  let result;
  if (q.vocal) {
    result = await run(q.model, q.shifts, 0.03, 0.62, '1/2 : toutes les pistes, 4 passages');
    const v2 = await run(q.vocal.model, q.vocal.shifts, 0.62, 0.9, '2/2 : voix, modèle spécialisé');
    // voix : moyenne des deux modèles (l'ensemble enlève une partie des défauts propres à chacun)
    const a = result.stems.vocals, b = v2.stems.vocals;
    if (a && b && a.length === b.length) for (let k = 0; k < a.length; k++) a[k] = 0.5 * (a[k] + b[k]);
  } else result = await run(q.model, q.shifts ?? 1, 0.03, 0.9, '');

  // ── enregistrement des pistes (Opus si possible, sinon WAV)
  const names = Object.keys(result.stems).filter((n) => KIND[n]);
  const out = [];
  let i = 0;
  for (const name of names) {
    onProgress({ progress: 0.9 + 0.1 * (i++ / names.length), message: 'Enregistrement des pistes…' });
    const inter = result.stems[name];
    const n = inter.length / 2;
    const L = new Float32Array(n), R = new Float32Array(n);
    for (let k = 0; k < n; k++) { L[k] = inter[2 * k]; R[k] = inter[2 * k + 1]; }
    delete result.stems[name];
    let file;
    if (opusSupported()) {
      try { file = { blob: await encodeOpus([L, R], 44100, { bitrate: q.bitrate || 192000 }), ext: 'opus' }; } catch (e) { console.warn('[séparation] Opus indisponible, WAV', e); }
    }
    if (!file) file = { blob: encodeWav([L, R], 44100, 16), ext: 'wav' };
    out.push({ kind: KIND[name], blob: file.blob, name: `${name}.${file.ext}`, level: levelOf([L, R]) });
  }
  const fresh = await db.getSong(songId);  // l'utilisateur a pu modifier le morceau pendant ce temps
  await addSeparatedStems(fresh, out, src.id, q.vocal ? `${q.model} + ${q.vocal.model} (expert)` : q.model);
  await db.putSong(fresh);
  return fresh;
}
