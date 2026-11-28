// MusiMix Piano — « Mes morceaux » : les fichiers ajoutés par l'utilisateur (MIDI, .synthesia, packs),
// gardés sur l'appareil (IndexedDB) et proposés dans la bibliothèque de l'école.

const DB = 'mmx-piano', STORE = 'mine';
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    if (!('indexedDB' in globalThis)) { rej(new Error('Stockage indisponible')); return; }
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE, { keyPath: 'id' }); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error || new Error('Stockage indisponible'));
  });
  dbp.catch(() => { dbp = null; });
  return dbp;
}
async function tx(mode, fn) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => res(out?.result ?? out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('Enregistrement annulé (espace plein ?)'));
  });
}

/** Liste (sans les fichiers), du plus récent au plus ancien. */
export async function listMine() {
  const all = await tx('readonly', (s) => s.getAll());
  return (all || []).map(({ files, ...m }) => ({ ...m, size: files.reduce((a, f) => a + (f.blob?.size || 0), 0) })).sort((a, b) => b.added - a.added);
}
export async function getMine(id) { return tx('readonly', (s) => s.get(id)); }
export async function removeMine(id) { return tx('readwrite', (s) => s.delete(id)); }
export async function renameMine(id, title) {
  const r = await getMine(id);
  if (!r) return;
  r.title = title;
  return tx('readwrite', (s) => s.put(r));
}

const isMidi = (n) => /\.(mid|midi|kar|rmi)$/i.test(n);
const isSyn = (n) => /\.(synthesia|xml)$/i.test(n);
const isPack = (n) => /\.zip$/i.test(n);

/** « clair-de-lune_v2.mid » → « Clair de lune v2 » */
export function prettyName(name) {
  const s = String(name).replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : 'Sans titre';
}

/** Fichiers choisis → un morceau par MIDI ou pack (le .synthesia va avec ses MIDI). Renvoie les morceaux ajoutés. */
export async function addFiles(fileList, describe) {
  const files = [...fileList];
  const syn = files.filter((f) => isSyn(f.name));
  const mains = files.filter((f) => isMidi(f.name) || isPack(f.name));
  if (!mains.length) throw new Error('Choisis un fichier MIDI (.mid), éventuellement avec son .synthesia, ou un pack MusiMix (.zip).');
  const added = [];
  for (const f of mains) {
    const id = 'my-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const group = [f, ...(isMidi(f.name) ? syn : [])];
    // describe() lit le morceau (titre, compositeur…) et lève une erreur s'il n'y a rien à jouer
    const meta = describe ? await describe(group) : {};
    const rec = {
      id,
      title: meta.title || prettyName(f.name),
      composer: meta.composer || '',
      notes: meta.notes || 0, duration: meta.duration || 0,
      added: Date.now(),
      files: await Promise.all(group.map(async (x) => ({ name: x.name, type: x.type || '', blob: new Blob([await x.arrayBuffer()], { type: x.type || 'application/octet-stream' }) }))),
    };
    await tx('readwrite', (s) => s.put(rec));
    added.push(rec);
  }
  return added;
}

/** Fichiers d'un morceau, prêts pour loadFiles(). */
export function filesOf(rec) {
  return rec.files.map((f) => new File([f.blob], f.name, { type: f.type }));
}
