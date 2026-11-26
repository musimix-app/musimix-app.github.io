// MusiMix — « Tester mon matériel » : ce que le navigateur voit du Zoom R20, des claviers MIDI,
// des micros et des sorties, avec les messages MIDI reçus en direct et un rapport à copier.

import { dialog, toast, esc } from './ui.js';
import { isSurfaceName, MCU } from './surface.js';

const MCU_NAMES = { [MCU.PLAY]: 'PLAY', [MCU.STOP]: 'STOP', [MCU.REC]: 'REC', [MCU.REW]: '<<', [MCU.FF]: '>>', [MCU.CYCLE]: 'CYCLE', [MCU.BANK_L]: 'BANK ◀', [MCU.BANK_R]: 'BANK ▶' };
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ');
export function describeMidi([st, d1, d2]) {
  const cmd = st & 0xf0, ch = (st & 0x0f) + 1;
  if (cmd === 0xe0) return `fader ${ch === 9 ? 'master' : ch} → ${Math.round((((d2 << 7) | d1) / 16383) * 100)} %`;
  if (cmd === 0x90 && d2 > 0) {
    if (MCU_NAMES[d1]) return `bouton ${MCU_NAMES[d1]}`;
    if (d1 >= MCU.MUTE && d1 < MCU.MUTE + 8) return `bouton MUTE ${d1 - MCU.MUTE + 1}`;
    if (d1 >= MCU.SOLO && d1 < MCU.SOLO + 8) return `bouton SOLO ${d1 - MCU.SOLO + 1}`;
    return `note ${d1} (vélocité ${d2})`;
  }
  if (cmd === 0x80 || cmd === 0x90) return `relâché ${d1}`;
  if (cmd === 0xb0) return d1 === 64 ? `pédale ${d2 >= 64 ? 'enfoncée' : 'relâchée'}` : `contrôle ${d1} = ${d2} (canal ${ch})`;
  if (st === 0xf0) return 'sysex';
  return 'message';
}

export async function diagDialog(app) {
  const prefs = (await app.prefs?.()) || {};
  const d = dialog(`<div class="dlg diag">
    <div class="tu-head"><h2>Tester mon matériel</h2><button class="icon-btn" data-close="" aria-label="Fermer">✕</button></div>
    <p class="note">Branche le R20 (ou ton clavier), puis bouge un fader et appuie sur PLAY : chaque message reçu s’affiche ci-dessous. En cas de souci, touche « Copier le rapport » et colle-le à Claude.</p>
    <section><h3>Appareils MIDI</h3><div data-r="midi">Recherche…</div>
      <div class="opt-row"><span>Port du R20<br><small class="note">si le nom n’est pas reconnu tout seul</small></span><select data-r="port"><option value="">Automatique</option></select></div>
      <div class="diag-log" data-r="log"><span class="note">Aucun message pour l’instant.</span></div></section>
    <section><h3>Micro</h3><div data-r="mic"><button class="btn small" data-a="mic">Autoriser le micro et lister les entrées</button></div>
      <div class="diag-meter"><i data-r="lvl"></i></div></section>
    <section><h3>Son</h3><div data-r="out"></div><button class="btn small ghost" data-a="beep">Jouer un bip de test</button></section>
    <div class="actions"><button class="btn ghost" data-a="copy">Copier le rapport</button><button class="btn primary" data-close="">Fermer</button></div>
  </div>`, { cls: 'diag-dlg' });
  const el = d.el;
  const $ = (r) => el.querySelector(`[data-r="${r}"]`);
  const report = { navigateur: navigator.userAgent, midi: [], messages: [], micros: [], micro: null, sortie: null };
  let access = null, stream = null, ctx = null, raf = 0;
  const listeners = [];
  const stop = () => { cancelAnimationFrame(raf); listeners.forEach(([i, f]) => i.removeEventListener('midimessage', f)); stream?.getTracks().forEach((t) => t.stop()); ctx?.close().catch(() => {}); };
  d.done.then(stop);

  // ---- MIDI
  const log = (port, data) => {
    const line = `${new Date().toLocaleTimeString()} · ${port} · ${describeMidi(data)} · [${hex(data)}]`;
    report.messages.unshift(line); report.messages.length = Math.min(report.messages.length, 40);
    $('log').innerHTML = report.messages.slice(0, 12).map((l) => `<div>${esc(l)}</div>`).join('');
  };
  const drawPorts = () => {
    const ins = [...access.inputs.values()], outs = [...access.outputs.values()];
    report.midi = [...ins.map((i) => `entrée « ${i.name} » (${i.manufacturer || '?'}) ${i.state}`), ...outs.map((o) => `sortie « ${o.name} » (${o.manufacturer || '?'}) ${o.state}`)];
    $('midi').innerHTML = ins.length
      ? `<ul class="diag-list">${ins.map((i) => `<li>${isSurfaceName(i.name) || isSurfaceName(i.manufacturer) ? '🎚️' : '🎹'} <b>${esc(i.name || 'sans nom')}</b> <small>${esc(i.manufacturer || '')}</small></li>`).join('')}</ul>`
      : '<p class="err">Aucun appareil MIDI vu par le navigateur. Vérifie le câble (un câble de données, pas seulement de charge), puis, sur le R20 : interface audio en <b>Multi Track</b> et <b>DAW Control</b> sur On.</p>';
    $('port').innerHTML = '<option value="">Automatique</option>' + ins.map((i) => `<option ${prefs.r20Port === i.name ? 'selected' : ''}>${esc(i.name || '')}</option>`).join('');
    listeners.forEach(([i, f]) => i.removeEventListener('midimessage', f)); listeners.length = 0;
    for (const i of ins) { const f = (e) => log(i.name, e.data); i.addEventListener('midimessage', f); listeners.push([i, f]); }
  };
  if (!navigator.requestMIDIAccess) $('midi').innerHTML = '<p class="err">Ce navigateur ne gère pas le MIDI. Sur Android, utilise <b>Chrome</b> ; sur iPad/iPhone, ce n’est pas possible.</p>';
  else {
    try { access = await navigator.requestMIDIAccess({ sysex: false }); drawPorts(); access.onstatechange = drawPorts; }
    catch (err) { $('midi').innerHTML = `<p class="err">Accès MIDI refusé (${esc(err.name)}). Autorise « Appareils MIDI » pour ce site dans les réglages du navigateur.</p>`; }
  }
  $('port').addEventListener('change', (e) => { app.setPref?.('r20Port', e.target.value || null); toast(e.target.value ? `Le R20 sera lu sur « ${e.target.value} »` : 'Port du R20 : automatique'); });

  // ---- Micro
  const listMics = async (chosen) => {
    const devs = await navigator.mediaDevices.enumerateDevices();
    const mics = devs.filter((x) => x.kind === 'audioinput'), outs = devs.filter((x) => x.kind === 'audiooutput');
    report.micros = mics.map((m) => m.label || '(sans nom)');
    const cur = chosen || prefs.micId || '';
    $('mic').innerHTML = `<label class="field">Micro utilisé par MusiMix (prise, accordeur)
      <select data-r="micsel"><option value="">Par défaut du système</option>${mics.map((m) => `<option value="${esc(m.deviceId)}" ${m.deviceId === cur ? 'selected' : ''}>${esc(m.label || 'Micro')}</option>`).join('')}</select></label>
      <p class="note" data-r="micinfo"></p>`;
    $('out').innerHTML = outs.length ? `<p class="note">Sorties vues : ${outs.map((o) => esc(o.label || 'sortie')).join(' · ')}</p>` : '<p class="note">Sur Android, le son part tout seul vers l’appareil USB branché (le R20) : fais le bip de test, il doit sortir dans le casque du R20.</p>';
    $('micsel').addEventListener('change', (e) => { const o = e.target.selectedOptions[0]; app.setPref?.('micId', e.target.value || null); app.setPref?.('micLabel', e.target.value ? o.textContent : null); openMic(e.target.value); });
  };
  const openMic = async (id) => {
    stream?.getTracks().forEach((t) => t.stop()); cancelAnimationFrame(raf);
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: id ? { exact: id } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    } catch (err) { $('mic').insertAdjacentHTML('beforeend', `<p class="err">Micro inaccessible : ${esc(err.name)} ${esc(err.message)}</p>`); return; }
    const tr = stream.getAudioTracks()[0], st = tr.getSettings?.() || {};
    report.micro = `${tr.label} · ${st.channelCount ?? '?'} canal(aux) · ${st.sampleRate ?? '?'} Hz · latence ${st.latency != null ? Math.round(st.latency * 1000) + ' ms' : '?'}`;
    if (!$('micsel')) await listMics(st.deviceId);
    $('micinfo').textContent = `Reçu : ${report.micro}. Parle ou joue : la barre doit bouger.`;
    ctx ||= new AudioContext();
    const an = ctx.createAnalyser(); an.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Float32Array(an.fftSize);
    const tick = () => { raf = requestAnimationFrame(tick); an.getFloatTimeDomainData(buf); let p = 0; for (const v of buf) p = Math.max(p, Math.abs(v)); $('lvl').style.width = `${Math.min(100, p * 120)}%`; };
    tick();
    report.sortie = `${ctx.sampleRate} Hz · latence de sortie ${Math.round(((ctx.outputLatency || 0) + (ctx.baseLatency || 0)) * 1000)} ms`;
  };

  el.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'mic') await openMic(prefs.micId || '');
    if (a === 'beep') {
      ctx ||= new AudioContext(); await ctx.resume();
      const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.value = 880; g.gain.value = 0.15;
      o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.4);
      report.sortie = `${ctx.sampleRate} Hz · latence de sortie ${Math.round(((ctx.outputLatency || 0) + (ctx.baseLatency || 0)) * 1000)} ms`;
    }
    if (a === 'copy') {
      const txt = ['RAPPORT MUSIMIX', `Navigateur : ${report.navigateur}`, 'MIDI :', ...(report.midi.length ? report.midi : ['(aucun)']), 'Derniers messages :', ...(report.messages.slice(0, 20).length ? report.messages.slice(0, 20) : ['(aucun)']), `Micros : ${report.micros.join(' | ') || '(non listés)'}`, `Micro ouvert : ${report.micro || '(aucun)'}`, `Sortie : ${report.sortie || '?'}`].join('\n');
      try { await navigator.clipboard.writeText(txt); toast('Rapport copié : colle-le à Claude'); } catch { toast('Copie impossible ici'); }
    }
  });
}
