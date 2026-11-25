// MusiMix — encodage Ogg Opus dans le navigateur (WebCodecs AudioEncoder), sans bibliothèque.
// Utilisé pour enregistrer les pistes séparées : ~10 fois plus léger qu'un WAV, même rendu à l'oreille.

const OPUS_RATE = 48000;

export function opusSupported() {
  return typeof AudioEncoder !== 'undefined' && typeof AudioData !== 'undefined';
}

// ── CRC Ogg (polynôme 0x04c11db7, sans réflexion)
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();
function crc(bytes) {
  let c = 0;
  for (let i = 0; i < bytes.length; i++) c = ((c << 8) ^ CRC[((c >>> 24) ^ bytes[i]) & 255]) >>> 0;
  return c;
}

/** Une page Ogg : packets = tableau de Uint8Array complets. */
function page(packets, { granule, serial, seq, bos = false, eos = false }) {
  const lacing = [];
  for (const p of packets) {
    let n = p.length;
    while (n >= 255) { lacing.push(255); n -= 255; }
    lacing.push(n);
  }
  const body = packets.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(27 + lacing.length + body);
  const v = new DataView(out.buffer);
  out.set([0x4f, 0x67, 0x67, 0x53], 0); // OggS
  out[4] = 0;
  out[5] = (bos ? 2 : 0) | (eos ? 4 : 0);
  v.setBigInt64(6, BigInt(granule), true);
  v.setUint32(14, serial, true);
  v.setUint32(18, seq, true);
  out[26] = lacing.length;
  out.set(lacing, 27);
  let o = 27 + lacing.length;
  for (const p of packets) { out.set(p, o); o += p.length; }
  v.setUint32(22, crc(out), true);
  return out;
}

async function resample(channels, fromRate, toRate) {
  if (fromRate === toRate) return channels;
  const n = channels[0].length;
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new OAC(channels.length, Math.ceil(n * toRate / fromRate), toRate);
  const buf = ctx.createBuffer(channels.length, n, fromRate);
  channels.forEach((c, i) => buf.copyToChannel(c, i));
  const src = ctx.createBufferSource();
  src.buffer = buf; src.connect(ctx.destination); src.start();
  const r = await ctx.startRendering();
  return Array.from({ length: r.numberOfChannels }, (_, i) => r.getChannelData(i));
}

/**
 * channels : [gauche, droite] (Float32Array), sampleRate : fréquence d'origine.
 * Retourne un Blob audio/ogg (Opus). Lève une erreur si le navigateur ne sait pas encoder.
 */
export async function encodeOpus(channels, sampleRate, { bitrate = 160000 } = {}) {
  if (!opusSupported()) throw new Error('Encodage Opus indisponible dans ce navigateur');
  const nch = Math.min(2, channels.length);
  const pcm = await resample(channels.slice(0, nch), sampleRate, OPUS_RATE);
  const total = pcm[0].length;
  const config = { codec: 'opus', sampleRate: OPUS_RATE, numberOfChannels: nch, bitrate };
  const sup = await AudioEncoder.isConfigSupported(config);
  if (!sup.supported) throw new Error('Opus non pris en charge');

  const chunks = [];
  let preskip = 312;
  let failure = null;
  const enc = new AudioEncoder({
    output: (chunk, meta) => {
      const d = new Uint8Array(chunk.byteLength);
      chunk.copyTo(d);
      chunks.push({ data: d, samples: Math.round((chunk.duration || 20000) * OPUS_RATE / 1e6) });
      const desc = meta?.decoderConfig?.description;
      if (desc && desc.byteLength >= 12) {
        const b = desc instanceof ArrayBuffer ? new Uint8Array(desc) : new Uint8Array(desc.buffer, desc.byteOffset, desc.byteLength);
        if (String.fromCharCode(...b.slice(0, 8)) === 'OpusHead') preskip = b[10] | (b[11] << 8);
      }
    },
    error: (e) => { failure = e; },
  });
  enc.configure(config);
  const STEP = OPUS_RATE; // 1 s par bloc
  for (let off = 0; off < total; off += STEP) {
    const n = Math.min(STEP, total - off);
    const planar = new Float32Array(n * nch);
    for (let c = 0; c < nch; c++) planar.set(pcm[c].subarray(off, off + n), c * n);
    const ad = new AudioData({ format: 'f32-planar', sampleRate: OPUS_RATE, numberOfFrames: n, numberOfChannels: nch, timestamp: Math.round(off * 1e6 / OPUS_RATE), data: planar });
    enc.encode(ad);
    ad.close();
    if (enc.encodeQueueSize > 20) await new Promise((r) => setTimeout(r, 0));
    if (failure) throw failure;
  }
  await enc.flush();
  enc.close();
  if (failure) throw failure;

  // ── en-têtes
  const head = new Uint8Array(19);
  const hv = new DataView(head.buffer);
  head.set([...'OpusHead'].map((c) => c.charCodeAt(0)), 0);
  head[8] = 1; head[9] = nch;
  hv.setUint16(10, preskip, true);
  hv.setUint32(12, sampleRate, true);
  hv.setInt16(16, 0, true);
  head[18] = 0;
  const vendor = new TextEncoder().encode('MusiMix');
  const tags = new Uint8Array(8 + 4 + vendor.length + 4);
  const tv = new DataView(tags.buffer);
  tags.set([...'OpusTags'].map((c) => c.charCodeAt(0)), 0);
  tv.setUint32(8, vendor.length, true);
  tags.set(vendor, 12);
  tv.setUint32(12 + vendor.length, 0, true);

  const serial = (Math.random() * 0xffffffff) >>> 0;
  const pages = [page([head], { granule: 0, serial, seq: 0, bos: true }), page([tags], { granule: 0, serial, seq: 1 })];
  let seq = 2, granule = 0, group = [], segs = 0;
  const end = preskip + total;
  chunks.forEach((ch, i) => {
    const need = Math.floor(ch.data.length / 255) + 1;
    if (group.length && (segs + need > 255 || group.length >= 50)) {
      pages.push(page(group, { granule, serial, seq: seq++ }));
      group = []; segs = 0;
    }
    group.push(ch.data); segs += need;
    granule += ch.samples;
    if (i === chunks.length - 1) pages.push(page(group, { granule: Math.min(granule, end), serial, seq: seq++, eos: true }));
  });
  return new Blob(pages, { type: 'audio/ogg' });
}
