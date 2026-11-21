let database;
function openDatabase() {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('route-lens-recents', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('routes', {keyPath: 'id'});
      request.result.createObjectStore('files');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return database;
}

async function read(store, id) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const table = db.transaction(store).objectStore(store);
    const request = id === undefined ? table.getAll() : table.get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function write(update) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['routes', 'files'], 'readwrite');
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error);
    update(tx.objectStore('routes'), tx.objectStore('files'));
  });
}

export async function listRecentRoutes() {
  return (await read('routes')).sort((a, b) => b.opened - a.opened);
}

export function readRecentFile(id) {
  return read('files', id);
}

export function forgetRecentRoute(id) {
  return write((routes, files) => { routes.delete(id); files.delete(id); });
}

export async function rememberRoute(route, bytes) {
  const opened = Date.now();
  const roundTrip = route.roundTrip !== false;
  const source = route.rwgpsLink;
  let id = 'rwgps:' + route.rwgpsId;
  if (!source) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    id = 'gpx:' + Array.from(digest, n => n.toString(16).padStart(2, '0')).join('') + ':' + Number(roundTrip);
  }
  const entry = {id, source, name: route.name, roundTrip, opened};
  return write((routes, files) => {
    routes.put(entry);
    if (!source) files.put(bytes, id);
  });
}
