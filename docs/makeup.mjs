import {classify} from './core.mjs';

const endpoint = 'https://overpass-api.de/api/interpreter';
const geographicStep = .025;
const padding = .004;
const maxAreas = 64;
const cacheSlot = 'routeLens.uploadedMakeup.v1';

export function overpassQuery(route) {
  if (route.distanceMeters > 250000) throw new Error('Route makeup is available for GPX files up to 250 km.');
  const middle = route.points[Math.floor(route.points.length / 2)];
  const scale = Math.max(.05, Math.cos(middle[0] * Math.PI / 180));
  const longitudeStep = geographicStep / scale;
  const areas = new Set();

  function addArea(lat, lng) {
    if (Math.abs(lat) > 85) throw new Error('Route makeup is unavailable this close to the poles.');
    areas.add(`${Math.floor(lat / geographicStep)},${Math.floor(lng / longitudeStep)}`);
    if (areas.size > maxAreas) throw new Error('This GPX covers too much area for one route makeup estimate.');
  }

  for (const [index, [lat, lng]] of route.points.entries()) {
    addArea(lat, lng);
    if (!index || route.segmentBreaks?.has(index)) continue;
    const [lastLat, lastLng] = route.points[index - 1];
    if (Math.abs(lng - lastLng) > 180) throw new Error('Route makeup is unavailable for routes that cross the international date line.');
    // Sample the line into padded map cells so sparse GPX points still cover the route.
    const steps = Math.ceil(Math.max(Math.abs(lat - lastLat), Math.abs(lng - lastLng) * scale) / padding);
    for (let i = 1; i < steps; i++) {
      addArea(lastLat + (lat - lastLat) * i / steps, lastLng + (lng - lastLng) * i / steps);
    }
  }

  const ways = [...areas].map(area => {
    const [row, col] = area.split(',').map(Number);
    const bounds = [row * geographicStep - padding, Math.max(-180, col * longitudeStep - padding / scale),
      (row + 1) * geographicStep + padding, Math.min(180, (col + 1) * longitudeStep + padding / scale)];
    return 'way[highway](' + bounds.map(value => value.toFixed(5)).join(',') + ');';
  });
  return '[out:json][timeout:45];(' + ways.join('') + ');out tags geom;';
}

export async function lookupRouteMakeup(route, bytes, signal) {
  let key;
  try {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    key = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    const cached = JSON.parse(localStorage.getItem(cacheSlot));
    if (cached?.key === key && cached.result?.samples?.at(-1)?.end === route.distanceMeters) {
      return cached.result;
    }
  } catch {
    // The estimate can still run without browser storage.
  }

  const query = overpassQuery(route);
  let response;
  try {
    response = await fetch(endpoint + '?' + new URLSearchParams({data: query}), {
      credentials: 'omit', referrerPolicy: 'no-referrer',
      signal: AbortSignal.any([signal, AbortSignal.timeout(55000)]),
    });
  } catch {
    throw new Error('OpenStreetMap is taking too long or couldn’t be reached. Try again.');
  }
  if (!response.ok) throw new Error('OpenStreetMap is busy or unavailable. Try again.');
  const data = await response.json().catch(() => null);
  if (data?.remark || !Array.isArray(data?.elements)) throw new Error('OpenStreetMap couldn’t complete the estimate. Try again.');
  signal.throwIfAborted();
  const result = classify(route, data);
  if (key) {
    try { localStorage.setItem(cacheSlot, JSON.stringify({key, result})); } catch {}
  }
  return result;
}
