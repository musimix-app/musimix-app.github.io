// MusiMix — fil de calcul du calage des paroles : modèle de reconnaissance vocale NeMo FastConformer CTC
// multilingue (français, anglais, espagnol, allemand, italien…, licence CC-BY-4.0, NVIDIA), exécuté avec
// onnxruntime-web, puis alignement forcé des paroles connues (ctc-core.js).
//
// messages reçus  : { id, type: 'load' } | { id, type: 'probs', pcm (16 kHz mono) } | { id, type: 'align', lines, gpen? }
// messages envoyés : { id, type: 'progress', progress, message } | { id, type: 'done', result } | { id, type: 'error', message }

import { logMel, parseTokens, ctcAlign, SR } from '../ctc-core.js';

const ORT = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0/dist/';
const MODEL_DIR = new URL('../../assets/models/ctc/', import.meta.url).href;
let ort = null, session = null, voc = null;
let lp = null, T = 0; // probabilités du dernier morceau écouté (gardées pour réaligner sans tout refaire)

const post = (m) => self.postMessage(m);

async function fetchCached(url, onBytes) {
  let cache = null;
  try { cache = await caches.open('musimix-models'); const hit = await cache.match(url); if (hit) return new Uint8Array(await hit.arrayBuffer()); } catch { cache = null; }
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Téléchargement impossible (${r.status}) : ${url.split('/').pop()}`);
  const total = +r.headers.get('content-length') || 0;
  const reader = r.body.getReader();
  const chunks = []; let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length; onBytes?.(got, total);
  }
  const buf = new Uint8Array(got); let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.length; }
  try { await cache?.put(url, new Response(buf)); } catch { /* quota : on gardera en mémoire seulement */ }
  return buf;
}

async function load(id) {
  if (session) return;
  ort = await import(`${ORT}ort.webgpu.bundle.min.mjs`); // même fichier que la séparation des pistes (déjà en cache)
  ort.env.wasm.wasmPaths = ORT;
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
  const man = await (await fetch(MODEL_DIR + 'manifest.json')).json();
  voc = parseTokens(new TextDecoder().decode(await fetchCached(MODEL_DIR + man.tokens)));
  const parts = [];
  let before = 0;
  for (const p of man.parts) {
    const b = await fetchCached(MODEL_DIR + p.file, (got) => post({ id, type: 'progress', progress: Math.min(0.99, (before + got) / man.size) * 0.3, message: `Modèle d’écoute (une seule fois) : ${Math.round((before + got) / 1e6)} / ${Math.round(man.size / 1e6)} Mo` }));
    parts.push(b); before += b.length;
  }
  const model = new Uint8Array(before); let o = 0;
  for (const b of parts) { model.set(b, o); o += b.length; }
  post({ id, type: 'progress', progress: 0.3, message: 'Préparation du modèle d’écoute…' });
  session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
}

/** Probabilités du modèle sur tout le morceau, par tranches de 30 s (recouvrement de 2 s). */
async function probs(id, pcm) {
  const step = 30 * SR, ov = 2 * SR, hop = 1280; // 80 ms
  const V = voc.V;
  const nOut = Math.ceil(pcm.length / hop);
  const out = new Float32Array(nOut * V).fill(-50);
  const t0 = performance.now();
  for (let i = 0; i < pcm.length; i += step) {
    const a = Math.max(0, i - ov), b = Math.min(pcm.length, i + step + ov);
    const { mel, T: TT } = logMel(pcm.subarray(a, b));
    const feeds = {
      audio_signal: new ort.Tensor('float32', mel, [1, 80, TT]),
      length: new ort.Tensor('int64', BigInt64Array.from([BigInt(TT)]), [1]),
    };
    const r = await session.run(feeds);
    const lpT = r.logprobs || r[Object.keys(r)[0]];
    const rows = lpT.dims[1], data = lpT.data;
    const skip = Math.round((i - a) / hop), take = Math.min(Math.round(step / hop), nOut - Math.round(i / hop));
    for (let k = 0; k < take && skip + k < rows; k++) out.set(data.subarray((skip + k) * V, (skip + k + 1) * V), (Math.round(i / hop) + k) * V);
    const f = Math.min(1, b / pcm.length);
    const el = (performance.now() - t0) / 1000;
    post({ id, type: 'progress', progress: 0.3 + 0.65 * f, message: `Écoute de la voix… ${Math.round(f * 100)} %${f > 0.05 && f < 1 ? ` · encore ~${Math.max(1, Math.round((el / f - el) / 60))} min` : ''}` });
  }
  lp = out; T = nOut;
}

self.onmessage = async (e) => {
  const { id, type } = e.data;
  try {
    if (type === 'load') { await load(id); post({ id, type: 'done', result: true }); }
    else if (type === 'probs') { await load(id); await probs(id, e.data.pcm); post({ id, type: 'done', result: { T } }); }
    else if (type === 'align') {
      if (!lp) throw new Error('Rien à aligner : la voix n’a pas encore été écoutée');
      const r = ctcAlign(lp, T, voc, e.data.lines, { gpen: e.data.gpen ?? 4 });
      post({ id, type: 'done', result: r });
    }
  } catch (err) {
    post({ id, type: 'error', message: err?.message || String(err) });
  }
};
