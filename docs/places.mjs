import {MILE, pointAt} from './core.mjs?v=georgia-1';
import {insideGeorgia} from './georgia.mjs?v=2';
import {overpassQuery} from './makeup.mjs?v=places-1';

const radius = MILE / 4;
const names = {marta: 'MARTA station', bike: 'Bike shop', fuel: 'Gas station'};
const tileUrl = new URL('./georgia-places.json?v=20261119', import.meta.url);

function routeMatches(route, places) {
  const mid = route.points[(route.points.length / 2) | 0][0];
  const lonScale = 111195 * Math.cos(mid * Math.PI / 180);
  const points = route.points.map(([lat, lon]) => [lon * lonScale, lat * 111195]);
  const bounds = points.reduce(([west, south, east, north], [x, y]) =>
    [Math.min(west, x), Math.min(south, y), Math.max(east, x), Math.max(north, y)],
    [Infinity, Infinity, -Infinity, -Infinity]);
  const matches = [];
  for (const [kind, lat, lon, name] of places) {
    const x = lon * lonScale, y = lat * 111195;
    if (x < bounds[0] - radius || x > bounds[2] + radius || y < bounds[1] - radius || y > bounds[3] + radius) continue;
    let distance = radius, meters;
    for (let i = 1; i < points.length; i++) {
      if (route.segmentBreaks.has(i)) continue;
      const [ax, ay] = points[i - 1], [bx, by] = points[i];
      const dx = bx - ax, dy = by - ay;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
      const offset = Math.hypot(x - ax - t * dx, y - ay - t * dy);
      if (offset > distance) continue;
      distance = offset;
      meters = route.cumulative[i - 1] + t * (route.cumulative[i] - route.cumulative[i - 1]);
    }
    if (meters !== undefined) matches.push({kind, lat, lon, name, distance, meters});
  }
  matches.sort((a, b) => a.distance - b.distance);
  const unique = [];
  for (const place of matches) {
    if (!unique.some(other => other.kind === place.kind &&
        (!other.name || !place.name || other.name.toLowerCase() === place.name.toLowerCase()) &&
        Math.hypot((other.lon - place.lon) * lonScale, (other.lat - place.lat) * 111195) < 60)) unique.push(place);
  }
  return unique.sort((a, b) => a.meters - b.meters);
}

async function loadPlaces(route, signal, showPartial) {
  let data;
  try {
    const response = await fetch(tileUrl, {signal});
    if (response.ok) data = await response.json();
  } catch {
    signal.throwIfAborted();
  }
  const local = data?.places ?? [];
  const geometry = data?.boundary;
  const polygons = geometry?.type === 'Polygon' ? [geometry.coordinates] : geometry?.coordinates;
  const starts = [];
  if (polygons) {
    for (let start = 0; start < route.distanceMeters; start += 25) {
      const {lat, lng} = pointAt(route, (start + Math.min(start + 25, route.distanceMeters)) / 2);
      if (!insideGeorgia(lat, lng, polygons)) starts.push(start);
    }
    if (!starts.length) return {places: routeMatches(route, local), partial: false};
  }
  const localMatches = routeMatches(route, local);
  if (localMatches.length) showPartial(localMatches);
  try {
    const selectors = ['nwr[amenity=fuel]', 'nwr[shop=bicycle]'];
    if (!data) selectors.push('nwr[railway=station][station=subway][network=MARTA]');
    const query = overpassQuery(route, polygons ? starts : undefined, selectors, 'out center;', .006);
    const url = 'https://overpass-api.de/api/interpreter?' + new URLSearchParams({data: query});
    const response = await fetch(url, {signal: AbortSignal.any([signal, AbortSignal.timeout(25000)]), credentials: 'omit', referrerPolicy: 'no-referrer'});
    if (!response.ok) throw new Error();
    const result = await response.json();
    if (result.remark || !Array.isArray(result.elements)) throw new Error();
    const remote = result.elements.flatMap(({center, lat, lon, tags = {}}) => {
      const point = center ?? {lat, lon};
      if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) return [];
      const kind = tags.shop === 'bicycle' ? 'bike' : tags.amenity === 'fuel' ? 'fuel' : 'marta';
      return [[kind, point.lat, point.lon, tags.name || tags.brand || '']];
    });
    return {places: routeMatches(route, [...local, ...remote]), partial: false};
  } catch {
    signal.throwIfAborted();
    return {places: localMatches, partial: true};
  }
}

export function attachPlaces(map, route, signal) {
  const panel = document.getElementById('routePlaces');
  const status = document.getElementById('placesStatus');
  const list = document.getElementById('placesList');
  const toggles = [...panel.querySelectorAll('input')];
  const markers = L.layerGroup().addTo(map);
  let places = [], loading = false, loaded = false, partial = false;
  function render() {
    const enabled = new Set(toggles.filter(input => input.checked).map(input => input.value));
    markers.clearLayers();
    list.replaceChildren();
    if (!enabled.size) { status.textContent = ''; return; }
    const shown = places.filter(place => enabled.has(place.kind));
    status.textContent = loading ? 'Looking for nearby stops…' : partial
      ? 'Live stop lookup unavailable. Showing saved Georgia results.'
      : shown.length ? '' : 'No selected stops within ¼ mile.';
    for (const place of shown) {
      const label = place.name || names[place.kind];
      const detail = 'Mile ' + (place.meters / MILE).toFixed(1) + ' · ' +
        (place.distance / MILE).toFixed(2) + ' mi from route';
      const pin = L.marker([place.lat, place.lon], {
        title: label,
        icon: L.divIcon({className: 'place-marker place-' + place.kind,
          html: {marta: 'M', bike: 'B', fuel: 'G'}[place.kind], iconSize: [24, 24], iconAnchor: [12, 12]}),
      }).addTo(markers);
      const popup = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = label;
      popup.append(title, document.createElement('br'), detail);
      pin.bindPopup(popup);
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'light';
      button.textContent = label + ' · ' + detail;
      button.onclick = () => { map.panTo(pin.getLatLng()); pin.openPopup(); };
      item.append(button);
      list.append(item);
    }
  }
  async function update() {
    if (!loaded && !loading && toggles.some(input => input.checked)) {
      loading = true;
      render();
      try {
        const result = await loadPlaces(route, signal, matches => { places = matches; render(); });
        if (signal.aborted) return;
        ({places, partial} = result);
        loaded = !partial;
      } catch {
        if (signal.aborted) return;
        partial = true;
      }
      loading = false;
    }
    render();
  }
  for (const toggle of toggles) toggle.addEventListener('change', update, {signal});
  panel.hidden = false;
  void update();
}
