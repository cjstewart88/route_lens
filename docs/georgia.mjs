import {classify, pointAt, sampleStarts} from './core.mjs?v=georgia-1';

// Both deployments use the same published road files. Local and self-hosted
// copies resolve the files alongside this module.
const moduleUrl = new URL(import.meta.url);
const root = moduleUrl.hostname.endsWith('.chatgpt.site')
  ? new URL('https://cjstewart88.github.io/route_lens/georgia/')
  : new URL('./georgia/', moduleUrl);

function inRing(lat, lon, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[i], [bx, by] = ring[j];
    if ((ay > lat) !== (by > lat) && lon < ax + (lat - ay) * (bx - ax) / (by - ay)) inside = !inside;
  }
  return inside;
}

export function insideCoverage(lat, lon, polygons) {
  return polygons.some(([outer, ...holes]) =>
    inRing(lat, lon, outer) && !holes.some(hole => inRing(lat, lon, hole)));
}

export async function readManifest(route, signal) {
  // Wider than the state. Avoid any regional request for distant routes.
  const lats = route.points.map(p => p[0]);
  if (lats.every(lat => lat < 30) || lats.every(lat => lat > 36) ||
      route.points.every(p => p[1] < -86) || route.points.every(p => p[1] > -80)) return null;
  try {
    const response = await fetch(new URL('manifest.json', root), {
      signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]), cache: 'no-cache',
    });
    if (!response.ok) return null;
    const manifest = await response.json();
    const geometry = manifest.boundary;
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    if (!manifest.version || !Array.isArray(manifest.tiles) || !polygons?.length) return null;
    return {version: manifest.version, tiles: new Set(manifest.tiles), polygons};
  } catch {
    signal.throwIfAborted();
    return null;
  }
}

async function downloadTile(key, version, signal) {
  const url = new URL(key + '.json.gz', root);
  url.searchParams.set('v', version);
  const response = await fetch(url, {signal: AbortSignal.any([signal, AbortSignal.timeout(20000)])});
  if (!response.ok) throw new Error('Road tile unavailable');
  const bytes = new Uint8Array(await response.arrayBuffer());
  // Some static hosts apply Content-Encoding: gzip and the browser decodes it.
  const blob = new Blob([bytes]);
  const records = bytes[0] === 31 && bytes[1] === 139
    ? await new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).json()
    : JSON.parse(await blob.text());
  return records;
}

function asWays(records) {
  return records.map(([id, highway, footway, surface, points]) => {
    const geometry = [];
    for (let i = 0; i < points.length; i += 2) {
      geometry.push({lat: points[i] / 1e5, lon: points[i + 1] / 1e5});
    }
    return {id, tags: {highway, footway, surface}, geometry};
  });
}

export async function classifyGeorgia(route, manifest, signal, starts) {
  return classifyTiles(route, manifest.polygons, (row, col) => {
    const key = row + '_' + col;
    return manifest.tiles.has(key) ? downloadTile(key, manifest.version, signal) : [];
  }, signal, starts);
}

export async function classifyTiles(route, polygons, readTile, signal, starts = sampleStarts(route)) {
  const groups = new Map();
  const outside = [];
  for (const start of starts) {
    const end = Math.min(start + 25, route.distanceMeters);
    const {lat, lng} = pointAt(route, (start + end) / 2);
    if (!insideCoverage(lat, lng, polygons)) {
      outside.push(start);
      continue;
    }
    const key = Math.floor(lat * 20) + '_' + Math.floor(lng * 20);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(start);
  }

  const samples = [];
  const entries = groups.entries();
  async function consume() {
    for (const [key, starts] of entries) {
      signal.throwIfAborted();
      let records;
      try {
        records = await readTile(...key.split('_').map(Number));
      } catch {
        signal.throwIfAborted();
        outside.push(...starts);
        continue;
      }
      samples.push(...classify(route, {elements: asWays(records)}, starts).samples);
    }
  }
  await Promise.all(Array.from({length: Math.min(groups.size, 4)}, consume));
  return {samples, outside};
}
