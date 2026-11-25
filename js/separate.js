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
  best: { model: 'bs_roformer_sw', label: 'Qualité max (BS-RoFormer, 6 pistes)', webgpu: true },
  fast: { model: 'htdemucs_6s', label: 'Rapide (Demucs, 6 pistes)', webgpu: false },
};

let lib = null;
const loadLib = () => (lib ||= import('./vendor/unblend/index.js'));

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
  const art = MODEL_ARTIFACTS[q.model][precision];
  let cached = false;
  try { const c = await caches.open('unblend-models'); cached = !!(await c.match(art.url)); } catch { /* */ }
  return { ...g, precision, mb: Math.round(art.sizeBytes / 1e6), cached, usable: !q.webgpu || g.webgpu };
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

  // 0 → 0,15 : téléchargement du modèle (une seule fois) ; 0,15 → 0,9 : séparation ; 0,9 → 1 : enregistrement
  onProgress({ progress: 0, message: 'Chargement du moteur…' });
  const sep = await Separator.load(q.model, {
    backend: g.webgpu ? 'webgpu' : 'wasm', precision, wasmPaths: ORT_WASM, numThreads: 1, signal,
    onProgress: (phase, loaded, total, source) => {
      if (phase === 'download') {
        const mb = (x) => Math.round(x / 1e6);
        onProgress({ progress: 0.15 * (total ? loaded / total : 0), message: source === 'cache' ? 'Lecture du modèle enregistré…' : `Téléchargement du modèle (une seule fois) : ${mb(loaded)} / ${mb(total)} Mo` });
      } else onProgress({ progress: 0.15, message: 'Préparation du modèle sur la carte graphique…' });
    },
  });
  let result;
  try {
    onProgress({ progress: 0.15, message: 'Décodage de l’audio…' });
    const audio = await decodeAt(blob, 44100);
    const t0 = performance.now();
    result = await sep.separate(audio, {
      signal, shifts: 1,
      onProgress: (p) => {
        const f = p.fraction || 0;
        const el = (performance.now() - t0) / 1000;
        const left = f > 0.03 ? Math.max(0, el / f - el) : 0;
        onProgress({ progress: 0.15 + 0.75 * f, message: `Séparation des pistes… ${Math.round(f * 100)} %${left ? ` · encore ~${Math.ceil(left / 60)} min` : ''}` });
      },
    });
  } finally {
    sep.unload().catch(() => {});
  }

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
      try { file = { blob: await encodeOpus([L, R], 44100), ext: 'opus' }; } catch (e) { console.warn('[séparation] Opus indisponible, WAV', e); }
    }
    if (!file) file = { blob: encodeWav([L, R], 44100, 16), ext: 'wav' };
    out.push({ kind: KIND[name], blob: file.blob, name: `${name}.${file.ext}`, level: levelOf([L, R]) });
  }
  const fresh = await db.getSong(songId);  // l'utilisateur a pu modifier le morceau pendant ce temps
  await addSeparatedStems(fresh, out, src.id, q.model);
  await db.putSong(fresh);
  return fresh;
}
