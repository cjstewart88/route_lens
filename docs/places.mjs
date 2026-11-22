import {MILE, pointAt} from './core.mjs?v=georgia-1';
import {insideCoverage} from './georgia.mjs?v=3';
import {overpassQuery} from './makeup.mjs?v=us-1';
import {readNationalManifest, readStateManifests, nationalPlaces} from './national.mjs?v=1';

const radius = MILE / 4;
const names = {rail: 'Rail station', bike: 'Bike shop', fuel: 'Gas station'};
const tileUrl = new URL('./georgia-places.json?v=address-2', import.meta.url);

function routeMatches(route, places) {
  const mid = route.points[(route.points.length / 2) | 0][0];
  const lonScale = 111195 * Math.cos(mid * Math.PI / 180);
  const points = route.points.map(([lat, lon]) => [lon * lonScale, lat * 111195]);
  const bounds = points.reduce(([west, south, east, north], [x, y]) =>
    [Math.min(west, x), Math.min(south, y), Math.max(east, x), Math.max(north, y)],
    [Infinity, Infinity, -Infinity, -Infinity]);
  const matches = [];
  for (const [kind, lat, lon, name, address] of places) {
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
    if (meters !== undefined) matches.push({kind, lat, lon, name, address, distance, meters});
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
  let local = data?.places ?? [];
  const states = await readStateManifests(route, signal);
  const geometry = data?.boundary;
  const polygons = geometry?.type === 'Polygon' ? [geometry.coordinates] : geometry?.coordinates;
  let starts;
  if (polygons) {
    starts = [];
    for (let start = 0; start < route.distanceMeters; start += 25) {
      const {lat, lng} = pointAt(route, (start + Math.min(start + 25, route.distanceMeters)) / 2);
      if (!insideCoverage(lat, lng, polygons)) starts.push(start);
    }
    if (!starts.length && !states.length) return {places: routeMatches(route, local), partial: false};
  }
  const national = await readNationalManifest(route, signal);
  if (national) {
    const result = await nationalPlaces(route, national, signal);
    local = [...local, ...result.places.filter(([, lat, lon]) => !polygons || !insideCoverage(lat, lon, polygons))];
    starts = result.outside;
  }
  for (const state of [...states].reverse()) {
    const refreshed = await nationalPlaces(route, state, signal);
    if (refreshed.incomplete) continue;
    local = local.filter(([, lat, lon]) => !insideCoverage(lat, lon, state.polygons));
    local.push(...refreshed.places.filter(([, lat, lon]) => insideCoverage(lat, lon, state.polygons)));
    if (starts === undefined) starts = refreshed.outside;
    else {
      const remaining = new Set(refreshed.outside);
      starts = starts.filter(start => remaining.has(start));
    }
  }
  if (starts?.length === 0) return {places: routeMatches(route, local), partial: false};
  const localMatches = routeMatches(route, local);
  if (localMatches.length) showPartial(localMatches);
  try {
    const selectors = ['nwr[amenity=fuel]', 'nwr[shop=bicycle]', 'nwr[railway~"^(station|halt|tram_stop)$"][station!=funicular]'];
    const query = overpassQuery(route, starts, selectors, 'out center;', .006);
    const url = 'https://overpass-api.de/api/interpreter?' + new URLSearchParams({data: query});
    const response = await fetch(url, {signal: AbortSignal.any([signal, AbortSignal.timeout(25000)]), credentials: 'omit', referrerPolicy: 'no-referrer'});
    if (!response.ok) throw new Error();
    const result = await response.json();
    if (result.remark || !Array.isArray(result.elements)) throw new Error();
    const remote = result.elements.flatMap(({center, lat, lon, tags = {}}) => {
      const point = center ?? {lat, lon};
      if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) return [];
      const kind = tags.shop === 'bicycle' ? 'bike' : tags.amenity === 'fuel' ? 'fuel' : 'rail';
      const street = tags['addr:full'] || [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ');
      const address = [street, tags['addr:city'], tags['addr:postcode']].filter(Boolean).join(', ');
      return [[kind, point.lat, point.lon, tags.name || tags.brand || '', address]];
    });
    return {places: routeMatches(route, [...local, ...remote]), partial: false};
  } catch {
    signal.throwIfAborted();
    return {places: localMatches, partial: true};
  }
}

function clusterStops(map, stops) {
  const spacing = 46;
  const cells = new Map();
  const clusters = [];
  for (const stop of stops) {
    const point = map.project([stop.lat, stop.lon]);
    const x = Math.floor(point.x / spacing);
    const y = Math.floor(point.y / spacing);
    let nearby;
    let distance = spacing;
    for (let col = x - 1; col <= x + 1; col++) {
      for (let row = y - 1; row <= y + 1; row++) {
        for (const cluster of cells.get(col + ',' + row) ?? []) {
          const gap = point.distanceTo(cluster.anchor);
          if (gap < distance) {
            nearby = cluster;
            distance = gap;
          }
        }
      }
    }
    if (nearby) {
      nearby.stops.push(stop);
    } else {
      const cluster = {anchor: point, stops: [stop]};
      const key = x + ',' + y;
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(cluster);
      clusters.push(cluster);
    }
  }
  return clusters;
}

function stopDetail(place) {
  return 'Mile ' + (place.meters / MILE).toFixed(1) + ' · ' +
    (place.distance / MILE).toFixed(2) + ' mi from route';
}

function stopPopup(place) {
  const popup = document.createElement('div');
  popup.className = 'stop-card';
  const category = document.createElement('span');
  category.className = 'stop-category place-' + place.kind;
  category.textContent = names[place.kind];
  const title = document.createElement('strong');
  title.textContent = place.name || names[place.kind];
  popup.append(category, title);
  if (place.address) {
    const address = document.createElement('div');
    address.className = 'stop-address';
    address.textContent = place.address;
    popup.append(address);
  }
  const footer = document.createElement('div');
  footer.className = 'stop-footer';
  const detail = document.createElement('span');
  detail.textContent = stopDetail(place);
  const link = document.createElement('a');
  const mapsUrl = new URL('https://www.google.com/maps/search/');
  const coordinates = place.lat + ',' + place.lon;
  const searchableName = place.kind === 'rail' && place.name ? place.name + ' station' : place.name;
  const query = searchableName
    ? searchableName + (place.address ? ' ' + place.address : ' near ' + coordinates)
    : place.address || coordinates;
  mapsUrl.search = new URLSearchParams({api: '1', query});
  link.href = mapsUrl.href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.ariaLabel = 'Open in Google Maps';
  link.title = link.ariaLabel;
  link.textContent = '↗';
  footer.append(detail, link);
  popup.append(footer);
  return popup;
}

export function attachPlaces(map, route, signal, jumpTo) {
  const panel = document.getElementById('routePlaces');
  const status = document.getElementById('placesStatus');
  const list = document.getElementById('placesList');
  const toggles = [...panel.querySelectorAll('input')];
  const markers = L.layerGroup().addTo(map);
  let places = [], loading = false, loaded = false, partial = false;
  let shown = [], selectedStop;

  function addPin(place) {
    const label = place.name || names[place.kind];
    const pin = L.marker([place.lat, place.lon], {
      title: label,
      alt: label,
      icon: L.divIcon({className: 'place-marker place-' + place.kind,
        html: {rail: 'R', bike: 'B', fuel: 'G'}[place.kind], iconSize: [24, 24], iconAnchor: [12, 12]}),
    }).addTo(markers);
    pin.on('click', () => openStop(place));
    return pin;
  }

  function openStop(place) {
    const position = [place.lat, place.lon];
    const zoom = Math.min(map.getMaxZoom(), map.getZoom() + 1);
    map.setView(position, zoom, {animate: false});
    selectedStop = place;
    drawMarkers();
    const pin = addPin(place);
    jumpTo(place.meters);
    const popup = L.popup({
      className: 'stop-popup', maxWidth: 270, offset: [0, -22], autoPan: false,
    }, pin);
    popup.setLatLng(position).setContent(stopPopup(place)).openOn(map);
  }

  function stopButton(place) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'light';
    button.textContent = (place.name || names[place.kind]) + ' · ' + stopDetail(place);
    button.onclick = () => openStop(place);
    return button;
  }

  function drawMarkers() {
    map.closePopup();
    markers.clearLayers();
    for (const {stops} of clusterStops(map, shown.filter(place => place !== selectedStop))) {
      if (stops.length === 1) {
        addPin(stops[0]);
        continue;
      }
      const bounds = L.latLngBounds(stops.map(place => [place.lat, place.lon]));
      const size = stops.length >= 10 ? 38 : 32;
      const label = stops.length + ' nearby stops';
      const cluster = L.marker(bounds.getCenter(), {
        title: label,
        alt: label,
        icon: L.divIcon({className: 'place-cluster', html: String(stops.length),
          iconSize: [size, size], iconAnchor: [size / 2, size / 2]}),
      }).addTo(markers);
      cluster.on('click', () => {
        const zoom = map.getZoom();
        if (zoom < map.getMaxZoom()) {
          map.setView(bounds.getCenter(), Math.min(map.getMaxZoom(),
            Math.max(zoom + 1, map.getBoundsZoom(bounds, false, [80, 80]))));
          return;
        }
        const choices = document.createElement('div');
        choices.className = 'stop-cluster-list';
        choices.append(...stops.map(stopButton));
        L.popup({className: 'stop-popup', maxWidth: 270, maxHeight: 200, offset: [0, -26]})
          .setLatLng(cluster.getLatLng()).setContent(choices).openOn(map);
      });
    }
  }

  function render() {
    const enabled = new Set(toggles.filter(input => input.checked).map(input => input.value));
    shown = places.filter(place => enabled.has(place.kind));
    selectedStop = undefined;
    drawMarkers();
    list.replaceChildren();
    status.textContent = !enabled.size ? '' : loading ? 'Looking for nearby stops…' : partial
      ? 'Live stop lookup unavailable. Showing cached results.'
      : shown.length ? '' : 'No selected stops within ¼ mile.';
    for (const place of shown) {
      const item = document.createElement('li');
      item.append(stopButton(place));
      list.append(item);
    }
  }

  function zoomMarkers() {
    selectedStop = undefined;
    drawMarkers();
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
  map.on('zoomend', zoomMarkers);
  signal.addEventListener('abort', () => map.off('zoomend', zoomMarkers), {once: true});
  panel.hidden = false;
  void update();
}
