import {classify, MILE, pointAt} from './core.mjs?v=georgia-1';
import {overpassQuery} from './makeup.mjs?v=us-1';

const endpoints = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
const selectors = ['way[highway]', 'node[highway=crossing]', 'node[highway=traffic_signals]'];
const lanes = new Map([
  ['track', 'Separated cycle track'], ['lane', 'Bike lane'], ['shared_lane', 'Shared lane'],
  ['share_busway', 'Shared bus lane'], ['no', 'No bike lane'], ['separate', 'Mapped separately'],
]);

export function bikeFacility(tags) {
  if (tags.highway === 'cycleway') return 'Cycleway';
  const values = ['cycleway', 'cycleway:both', 'cycleway:left', 'cycleway:right']
    .map(key => lanes.get(tags[key])).filter(Boolean);
  if (new Set(values).size > 1) return 'Varies by side';
  return values[0] || 'Unknown';
}

export function speedBand(value) {
  const match = /^(\d+(?:\.\d+)?)\s*(mph|km\/h|kph)?$/i.exec(value?.trim() ?? '');
  if (!match) return 'Unknown';
  const mph = Number(match[1]) * (match[2]?.toLowerCase() === 'mph' ? 1 : .621371);
  return mph >= 35 ? '35 mph or higher' : mph >= 25 ? '25–34 mph' : 'Under 25 mph';
}

function crossingLabel(tags) {
  if (tags.highway === 'traffic_signals' || tags.crossing === 'traffic_signals' || tags['crossing:signals'] === 'yes') return 'Signalized crossing or junction';
  if (tags['crossing:island'] === 'yes' || tags.crossing === 'island') return 'Crossing with refuge island';
  if (tags.crossing === 'marked' || tags.crossing === 'zebra' || (tags['crossing:markings'] && tags['crossing:markings'] !== 'no')) return 'Marked crossing';
  if (tags.crossing === 'unmarked' || tags['crossing:markings'] === 'no') return 'Unmarked crossing';
  return 'Mapped crossing';
}

function crossingsNearRoute(route, elements) {
  const step = 10;
  const radius = 15;
  const cell = 50;
  const lonScale = 111195 * Math.cos(route.points[Math.floor(route.points.length / 2)][0] * Math.PI / 180);
  const bins = new Map();
  for (const node of elements) {
    if (node.type !== 'node' || !Number.isFinite(node.lat) || !Number.isFinite(node.lon)) continue;
    const x = node.lon * lonScale, y = node.lat * 111195;
    const key = Math.floor(x / cell) + ':' + Math.floor(y / cell);
    if (!bins.has(key)) bins.set(key, []);
    bins.get(key).push({...node, x, y, distance: radius, meters: null});
  }
  for (let start = 0; start < route.distanceMeters + step; start += step) {
    const meters = Math.min(start, route.distanceMeters);
    const {lat, lng} = pointAt(route, meters);
    const x = lng * lonScale, y = lat * 111195;
    const col = Math.floor(x / cell), row = Math.floor(y / cell);
    for (let i = col - 1; i <= col + 1; i++) for (let j = row - 1; j <= row + 1; j++) {
      for (const node of bins.get(i + ':' + j) ?? []) {
        const distance = Math.hypot(node.x - x, node.y - y);
        if (distance <= node.distance) { node.distance = distance; node.meters = meters; }
      }
    }
  }
  return [...bins.values()].flat().filter(node => node.meters !== null)
    .sort((a, b) => a.meters - b.meters)
    .map(node => ({lat: node.lat, lon: node.lon, meters: node.meters, label: crossingLabel(node.tags)}));
}

export function summarizeCommute(route, data) {
  const {samples} = classify(route, data);
  const ways = new Map(data.elements.filter(element => element.type === 'way').map(way => [way.id, way.tags ?? {}]));
  const groups = {bike: new Map(), speed: new Map(), lighting: new Map()};
  for (const {start, end, way, ambiguous} of samples) {
    const tags = (!ambiguous && ways.get(way)) || {};
    const light = tags.lit === 'yes' || tags.lit === '24/7' ? 'Lit' : tags.lit === 'no' ? 'Unlit' : 'Unknown';
    for (const [name, label] of Object.entries({bike: bikeFacility(tags), speed: speedBand(tags.maxspeed), lighting: light})) {
      const group = groups[name];
      group.set(label, (group.get(label) ?? 0) + end - start);
    }
  }
  return {groups, crossings: crossingsNearRoute(route, data.elements)};
}

async function lookup(route, signal) {
  const query = overpassQuery(route, undefined, selectors);
  const params = new URLSearchParams({data: query});
  for (const endpoint of endpoints) {
    try {
      const useGet = params.toString().length < 7200;
      const response = await fetch(useGet ? endpoint + '?' + params : endpoint, {
        ...(useGet ? {} : {method: 'POST', body: params}),
        credentials: 'omit', signal: AbortSignal.any([signal, AbortSignal.timeout(55000)]),
      });
      if (!response.ok) continue;
      const data = await response.json();
      if (!data.remark && Array.isArray(data.elements)) return summarizeCommute(route, data);
    } catch {
      signal.throwIfAborted();
    }
  }
  throw new Error('Commute details are unavailable. Try again.');
}

export function attachCommute(map, route, signal, jumpTo) {
  const panel = document.getElementById('commuteDetails');
  const button = document.getElementById('loadCommute');
  const status = document.getElementById('commuteStatus');
  const groups = document.getElementById('commuteGroups');
  const crossingStatus = document.getElementById('commuteCrossingStatus');
  const toggle = document.getElementById('commuteCrossings');
  const layer = L.layerGroup();
  groups.replaceChildren();
  status.textContent = '';
  crossingStatus.hidden = true;
  toggle.checked = false;
  button.disabled = false;
  button.hidden = false;
  panel.hidden = false;
  toggle.onchange = () => toggle.checked ? layer.addTo(map) : layer.remove();
  button.onclick = async () => {
    button.disabled = true;
    status.textContent = 'Looking up bike lanes, speed limits, crossings, and lighting…';
    try {
      const result = await lookup(route, signal);
      if (signal.aborted) return;
      for (const [key, heading] of [['bike', 'Bike facilities'], ['speed', 'Posted speed'], ['lighting', 'Lighting']]) {
        const section = document.createElement('section');
        const title = document.createElement('h3');
        title.textContent = heading;
        const rows = document.createElement('dl');
        const ordered = [...result.groups[key]].sort(([a, left], [b, right]) =>
          Number(a === 'Unknown') - Number(b === 'Unknown') || right - left);
        for (const [name, meters] of ordered) {
          const label = document.createElement('dt');
          const distance = document.createElement('dd');
          label.textContent = name;
          distance.textContent = (meters / MILE).toFixed(2) + ' mi';
          rows.append(label, distance);
        }
        section.append(title, rows);
        groups.append(section);
      }
      for (const crossing of result.crossings) {
        const pin = L.marker([crossing.lat, crossing.lon], {
          title: crossing.label,
          icon: L.divIcon({className: 'place-marker commute-marker', html: '+', iconSize: [24, 24], iconAnchor: [12, 12]}),
        }).addTo(layer);
        pin.bindPopup(crossing.label + ' · Mile ' + (crossing.meters / MILE).toFixed(2));
        pin.on('click', () => jumpTo(crossing.meters));
      }
      document.getElementById('commuteCrossingCount').textContent = result.crossings.length + ' mapped crossings or signals near the route';
      crossingStatus.hidden = false;
      status.textContent = 'Distances cover one pass along the track. Missing or ambiguous tags count as unknown.';
      button.hidden = true;
    } catch {
      if (!signal.aborted) status.textContent = 'Commute details are unavailable. Try again.';
    } finally {
      if (!signal.aborted) button.disabled = false;
    }
  };
}
