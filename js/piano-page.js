// MusiMix Piano — page piano.html de MusiMix : notes qui tombent, école, morceaux de la bibliothèque.
// piano.html#song-<id> ouvre un morceau de la bibliothèque (audio, pistes, grille, paroles, MIDI d'origine).

import { mountKeys } from './keys/view.js';
import { loadFiles, demoSong, fromMusimixSong } from './keys/model.js';
import { db } from './db.js';
import { mountSchool } from './keys/school.js';

const app = mountKeys(document.getElementById('app'), { soundsBase: 'assets/sounds/' });
const input = document.getElementById('file');
window.mmxPiano = app; // pour les tests
const school = mountSchool(document.body, app);
window.mmxSchool = school;
document.getElementById('btn-school').addEventListener('click', () => school.show());
document.getElementById('btn-start').addEventListener('click', async () => { await app.audio(); school.show('path'); });
document.getElementById('btn-lib').addEventListener('click', () => school.show('lib'));
document.getElementById('btn-fm').addEventListener('click', () => school.show('fm'));

async function openFiles(files) {
  if (!files?.length) return;
  try {
    const song = await loadFiles([...files]);
    if (!song.tracks.some((t) => t.notes.length) && !song.stems.length) { app.toast('Rien à jouer dans ces fichiers : ajoute un .mid, un pack MusiMix ou un audio avec sa grille.', 6000); return; }
    if (!song.tracks.some((t) => t.notes.length)) app.toast('Pas de notes MIDI : la grille d’accords devient les notes à jouer.', 5000);
    await app.open(song);
  } catch (e) {
    console.error(e);
    app.toast('Impossible d’ouvrir : ' + (e.message || e), 6000);
  }
}

input.addEventListener('change', () => { openFiles(input.files); input.value = ''; });
for (const id of ['btn-open', 'btn-open2']) document.getElementById(id).addEventListener('click', () => input.click());
document.getElementById('btn-demo').addEventListener('click', async () => { await app.audio(); await app.open(demoSong()); });

let depth = 0;
addEventListener('dragenter', (e) => { e.preventDefault(); depth++; document.body.classList.add('drop-on'); });
addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; document.body.classList.remove('drop-on'); } });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => { e.preventDefault(); depth = 0; document.body.classList.remove('drop-on'); openFiles(e.dataTransfer.files); });

// morceau de la bibliothèque MusiMix (piano.html#song-<id>)
async function openFromHash() {
  const id = /^#song-(.+)$/.exec(location.hash)?.[1];
  if (!id) return;
  const ms = await db.getSong(decodeURIComponent(id));
  if (!ms) { app.toast('Morceau introuvable dans la bibliothèque.'); return; }
  try { await app.open(await fromMusimixSong(ms, (b) => db.getBlob(b))); } catch (e) { app.toast('Impossible d’ouvrir : ' + (e.message || e), 6000); }
}
addEventListener('hashchange', openFromHash);
openFromHash();
