import {pointAt, sampleStarts} from './core.mjs?v=georgia-2';
import {insideCoverage, classifyTiles} from './georgia.mjs?v=4';
import {nationalRef, stateSnapshots} from './map-snapshots.mjs?v=1';

const source = 'https://raw.githubusercontent.com/cjstewart88/route_lens/';
const packWidth = 40;
const tileSize = 20;

async function fetchData(ref, path, signal, options = {}) {
  const response = await fetch(new URL(ref + '/' + path, source), {
    ...options, signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
  });
  if (!response.ok) throw new Error('U.S. map data unavailable');
  return response;
}

export async function readNationalManifest(route, signal) {
  if (route.points.every(([lat]) => lat < 18 || lat > 73)) return null;
  return readSnapshot(nationalRef, signal);
}

export async function readStateManifests(route, signal) {
  const candidates = stateSnapshots.filter(({bounds: [south, west, north, east]}) =>
    !route.points.every(([lat]) => lat < south) && !route.points.every(([lat]) => lat > north) &&
    !route.points.every(([, lng]) => lng < west) && !route.points.every(([, lng]) => lng > east));
  return (await Promise.all(candidates.map(({ref}) => readSnapshot(ref, signal)))).filter(Boolean);
}

async function readSnapshot(ref, signal) {
  try {
    const data = await (await fetchData(ref, 'manifest.json', signal)).json();
    const {type, coordinates} = data.boundary;
    const polygons = type === 'Polygon' ? [coordinates] : coordinates;
    if (!data.version || !data.packs?.length || !polygons?.length) return null;
    return {ref, version: ref + ':' + data.version, polygons, packs: new Set(data.packs)};
  } catch {
    signal.throwIfAborted();
    return null;
  }
}

function makeTileReader(manifest, signal) {
  const indexes = new Map();
  return async (row, col, prefix = '') => {
    const name = Math.floor(row / packWidth) + '_' + Math.floor(col / packWidth);
    if (!manifest.packs.has(name)) return [];
    if (!indexes.has(name)) {
      indexes.set(name, fetchData(manifest.ref, name + '.json', signal).then(response => response.json()));
    }
    const index = await indexes.get(name);
    const range = index[prefix + row + '_' + col];
    if (!range) return [];
    const [offset, length, suffix] = range;
    const response = await fetchData(manifest.ref, name + (suffix ? '.' + suffix : '') + '.bin', signal, {
      headers: {Range: 'bytes=' + offset + '-' + (offset + length - 1)},
    });
    if (response.status !== 206 && !(offset === 0 && Number(response.headers.get('Content-Length')) === length)) {
      await response.body?.cancel();
      throw new Error('Map host did not return the requested range');
    }
    return new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).json();
  };
}

export function classifyNational(route, manifest, signal, starts) {
  return classifyTiles(route, manifest.polygons, makeTileReader(manifest, signal), signal, starts);
}

export async function nationalPlaces(route, manifest, signal) {
  const tiles = new Map();
  const outside = [];
  for (const start of sampleStarts(route)) {
    const {lat, lng} = pointAt(route, (start + Math.min(start + 25, route.distanceMeters)) / 2);
    if (!insideCoverage(lat, lng, manifest.polygons)) outside.push(start);
    const lonPad = .004 / Math.max(.05, Math.cos(lat * Math.PI / 180));
    for (let row = Math.floor((lat - .004) * tileSize); row <= Math.floor((lat + .004) * tileSize); row++) {
      for (let col = Math.floor((lng - lonPad) * tileSize); col <= Math.floor((lng + lonPad) * tileSize); col++) {
        const key = row + '_' + col;
        if (!tiles.has(key)) tiles.set(key, {row, col, starts: new Set()});
        tiles.get(key).starts.add(start);
      }
    }
  }
  const places = [];
  let incomplete = false;
  const readTile = makeTileReader(manifest, signal);
  const iterator = tiles.values();
  async function consume() {
    for (const {row, col, starts} of iterator) {
      try {
        places.push(...await readTile(row, col, 'p'));
      } catch {
        signal.throwIfAborted();
        incomplete = true;
        for (const start of starts) outside.push(start);
      }
    }
  }
  await Promise.all(Array.from({length: Math.min(4, tiles.size)}, consume));
  return {places, outside: [...new Set(outside)], incomplete};
}
