import {parseGpx, encodeGpx, decodeGpx, maxGpxBytes, maxSharedUrlLength} from './gpx.mjs';
import {lookupRouteMakeup} from './makeup.mjs?v=us-1';
import {attachPlaces} from './places.mjs?v=14';
import {importRideWithGps, RouteUnavailableError} from './rwgps.mjs?v=recents-1';
import {listRecentRoutes, readRecentFile, forgetRecentRoute, rememberRoute} from './recents.mjs';
import {MILE,categories,pointAt,routeHeading,tripDistance,tripPosition,calculate,composition,sampleType} from './core.mjs?v=georgia-1';
if (new URLSearchParams(location.search).get('layout') === 'map') {
  await import('./map-layout.mjs?v=1');
}

const $=id=>document.getElementById(id);let route,map,marker,line,selected=0,travelDirection=1,tripLeg="outbound",tripMeters=0,analysis,syncTimer,selectedView,directionAnchor=0,overrides={};
const storageKey = kind => `routeLens.${kind}.${route.id}`;
const embedKey = document.querySelector('meta[name="maps-embed-key"]').content.trim();
const playbackStepMeters = 160;
const playbackHoldMs = 1000;
const playbackLookahead = 2;
const queuedViews = new Map();
let playbackRunning = false;
let playbackTimer;
let panoramaPending = false;
let pendingFrame;
let panoramaTimeout;
let displayedView;

function updatePlaybackButton() {
  const button = $('routePlayback');
  button.dataset.playing = String(playbackRunning);
  button.setAttribute('aria-label', playbackRunning ? 'Pause route' : 'Play route');
}

function pausePlayback() {
  playbackRunning = false;
  clearTimeout(playbackTimer);
  playbackTimer = undefined;
  updatePlaybackButton();
  for (const view of queuedViews.values()) view.frame.remove();
  queuedViews.clear();
}

function chooseTripPosition(meters, followLeg = false) {
  const position = tripPosition(route, meters);
  const direction = followLeg ? (position.leg === 'outbound' ? 1 : -1) : null;
  choose(position.meters, true, position.leg, false, direction);
}

function nextPlaybackPosition(meters) {
  const turnaround = route.distanceMeters;
  const legEnd = meters < turnaround ? turnaround : tripDistance(route);
  const next = meters + playbackStepMeters;
  return legEnd - next <= 5 ? legEnd : next;
}

function streetViewAt(meters, direction) {
  const point = pointAt(route, meters);
  const samples = analysis.samples;
  const index = Math.min(Math.floor(meters / 25), samples.length - 1);
  const sample = samples[index];
  const isPath = sample && meters >= sample.start && meters <= sample.end && sampleType(sample, overrides) === 'path';
  return {
    radius: embedKey && isPath ? 15 : 50,
    coords: point.lat.toFixed(6) + ',' + point.lng.toFixed(6),
    yaw: routeHeading(route, meters, direction).toFixed(1),
  };
}

function viewKey(view) {
  return [view.coords, view.yaw, view.radius].join('/');
}

function fillPlaybackQueue() {
  let meters = tripMeters;
  const upcoming = new Map();
  for (let i = 0; i < playbackLookahead && meters < tripDistance(route); i++) {
    meters = nextPlaybackPosition(meters);
    const point = tripPosition(route, meters);
    const view = streetViewAt(point.meters, point.leg === 'outbound' ? 1 : -1);
    upcoming.set(viewKey(view), view);
  }
  for (const [key, record] of queuedViews) {
    if (upcoming.has(key)) continue;
    record.frame.remove();
    queuedViews.delete(key);
  }
  for (const [key, view] of upcoming) {
    if (queuedViews.has(key)) continue;
    const record = {view};
    queuedViews.set(key, record);
    loadStreetFrame(record);
  }
}

function schedulePlaybackStep() {
  if (!playbackRunning || panoramaPending || playbackTimer !== undefined) return;
  fillPlaybackQueue();
  playbackTimer = setTimeout(() => {
    playbackTimer = undefined;
    chooseTripPosition(nextPlaybackPosition(tripMeters), true);
    if (tripMeters >= tripDistance(route)) pausePlayback();
    else schedulePlaybackStep();
  }, playbackHoldMs);
}

function togglePlayback() {
  if (playbackRunning) {
    pausePlayback();
    return;
  }
  playbackRunning = true;
  updatePlaybackButton();
  if (tripMeters >= tripDistance(route)) chooseTripPosition(0, true);
  schedulePlaybackStep();
}

function loadStreetFrame(record) {
  const frame = $('streetFrame').cloneNode(false);
  frame.removeAttribute('id');
  frame.dataset.pending = 'true';
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  record.frame = frame;
  frame.addEventListener('load', () => {
    record.ready = true;
    if (pendingFrame === record) showStreetFrame(record);
  }, {once: true});
  const {coords, yaw, radius} = record.view;
  if (embedKey) {
    frame.src = 'https://www.google.com/maps/embed/v1/streetview?' + new URLSearchParams({
      key: embedKey, location: coords, heading: yaw, radius: String(radius),
    });
  } else {
    frame.src = 'https://www.google.com/maps?' + new URLSearchParams({
      layer: 'c', cbll: coords, cbp: '12,' + yaw + ',0,0,0', output: 'svembed',
    });
  }
  $('streetViewer').append(frame);
}

function showStreetFrame(record) {
  clearTimeout(panoramaTimeout);
  $('streetFrame').remove();
  const {frame, view} = record;
  frame.id = 'streetFrame';
  delete frame.dataset.pending;
  frame.removeAttribute('aria-hidden');
  frame.removeAttribute('tabindex');
  pendingFrame = undefined;
  displayedView = view;
  panoramaPending = false;
  const viewer = $('streetViewer');
  viewer.dataset.ready = 'true';
  viewer.dataset.loading = 'false';
  schedulePlaybackStep();
}

function queueStreetView(view) {
  clearTimeout(syncTimer);
  clearTimeout(panoramaTimeout);
  pendingFrame?.frame?.remove();
  pendingFrame = undefined;

  const viewer = $('streetViewer');
  const status = $('viewerLoading');
  const key = viewKey(view);
  const alreadyVisible = displayedView && viewKey(displayedView) === key;
  panoramaPending = !alreadyVisible;
  viewer.dataset.loading = String(panoramaPending);
  if (alreadyVisible) {
    schedulePlaybackStep();
    return;
  }
  const queued = queuedViews.get(key);
  if (queued) queuedViews.delete(key);
  if (queued?.ready) {
    showStreetFrame(queued);
    return;
  }
  status.textContent = displayedView ? 'Updating view…' : 'Loading Street View…';

  const record = queued || {view};
  pendingFrame = record;
  const begin = () => {
    panoramaTimeout = setTimeout(() => {
      if (pendingFrame !== record) return;
      status.textContent = displayedView ? 'Still updating view…' : 'Street View is taking longer than expected.';
      panoramaPending = false;
      schedulePlaybackStep();
    }, 12000);
    if (!record.frame) loadStreetFrame(record);
  };
  if (queued) begin();
  else syncTimer = setTimeout(begin, 450);
}
function choose(meters,pan=false,forcedLeg=null,inferLeg=false,directionHint=null){const next=meters>=route.distanceMeters?route.distanceMeters:Math.max(0,meters),delta=next-directionAnchor;const moved=Math.abs(delta)>2;if(moved||directionHint!==null){travelDirection=directionHint??(delta>0?1:-1);directionAnchor=next;}if(forcedLeg)tripLeg=forcedLeg;else if(inferLeg&&moved&&route.roundTrip!==false)tripLeg=travelDirection>0?'outbound':'return';selected=next;tripMeters=tripLeg==='outbound'?selected:tripDistance(route)-selected;const p=pointAt(route,selected);marker?.setLatLng([p.lat,p.lng]);if(pan&&map&&!map.getBounds().contains([p.lat,p.lng]))map.panTo([p.lat,p.lng]);updateTripBar();
const view = streetViewAt(selected, travelDirection);
const arrow = marker?.getElement()?.querySelector('.travel-arrow');
if (arrow) arrow.style.transform = 'rotate(' + view.yaw + 'deg)';
if (!selectedView || viewKey(selectedView) !== viewKey(view)) {
  selectedView = view;
  queueStreetView(view);
}}
function updateTripBar() {
  const slider = $('position');
  const total = tripDistance(route);
  const miles = (tripMeters / MILE).toFixed(1);
  slider.value = tripMeters;
  slider.setAttribute('aria-valuetext', 'mile ' + miles);
  $('mile').textContent = miles;
  $('remaining').textContent = ((total - tripMeters) / MILE).toFixed(2) + ' mi to end';
}

function nearest(latlng){const q=map.latLngToLayerPoint(latlng);let best=Infinity,meters=0;for(let i=1;i<route.points.length;i++){if(route.segmentBreaks?.has(i))continue;const a=map.latLngToLayerPoint(route.points[i-1].slice(0,2)),b=map.latLngToLayerPoint(route.points[i].slice(0,2)),dx=b.x-a.x,dy=b.y-a.y,t=Math.max(0,Math.min(1,((q.x-a.x)*dx+(q.y-a.y)*dy)/(dx*dx+dy*dy||1))),d=(q.x-a.x-t*dx)**2+(q.y-a.y-t*dy)**2;if(d<best){best=d;meters=route.cumulative[i-1]+t*(route.cumulative[i]-route.cumulative[i-1]);}}return meters;}
function drawComposition(){const totals=composition(analysis.samples,overrides);$('compositionBar').replaceChildren();$('compositionRows').replaceChildren();for(const [key,c] of Object.entries(categories)){const pct=totals[key]/route.distanceMeters*100,bar=document.createElement('div');bar.style.width=pct+'%';bar.style.background=c.color;bar.title=`${c.label}: ${pct.toFixed(1)}%`;$('compositionBar').append(bar);const row=document.createElement('div');row.className='composition-row';const swatch=document.createElement('span');swatch.className='swatch';swatch.style.background=c.color;const label=document.createElement('span');label.textContent=c.label;const percent=document.createElement('strong');percent.textContent=pct.toFixed(1)+'%';const miles=document.createElement('small');miles.textContent=(totals[key]*tripDistance(route)/route.distanceMeters/MILE).toFixed(2)+' mi';row.append(swatch,label,percent,miles);$('compositionRows').append(row);}drawSurfaceLines();}

function drawSurfaceLines() {
  if (!map || !analysis.samples.length) return;
  line.clearLayers();
  let sampleIndex = 0;
  let activeCategory;
  let coordinates = [];
  function flush() {
    if (coordinates.length > 1) {
      L.polyline(coordinates, {color: categories[activeCategory].color, weight: 6, opacity: 1, interactive: false}).addTo(line);
    }
    coordinates = [];
  }
  for (let i = 1; i < route.points.length; i++) {
    if (route.segmentBreaks.has(i)) {
      flush();
      continue;
    }
    const start = route.cumulative[i - 1];
    const end = route.cumulative[i];
    const [lat, lng] = route.points[i - 1];
    const [nextLat, nextLng] = route.points[i];
    let position = start;
    while (position < end) {
      while (sampleIndex < analysis.samples.length && analysis.samples[sampleIndex].end <= position) sampleIndex++;
      const sample = analysis.samples[sampleIndex];
      const category = sample ? sampleType(sample, overrides) : 'unknown';
      if (category !== activeCategory) flush();
      activeCategory = category;
      if (!coordinates.length) {
        const t = (position - start) / (end - start);
        coordinates.push([lat + t * (nextLat - lat), lng + t * (nextLng - lng)]);
      }
      position = Math.min(end, sample?.end ?? end);
      const t = (position - start) / (end - start);
      coordinates.push([lat + t * (nextLat - lat), lng + t * (nextLng - lng)]);
    }
  }
  flush();
  routeHitLine.setStyle({opacity: 0});
}

const rideTimeStorageKey = 'routeLens.rideTime.v1';
function updateRideTime() {
  if (!route) return;
  const speed = $('avgSpeed');
  const stops = $('stopTime');
  const result = calculate(tripDistance(route) / MILE, speed.valueAsNumber, 'custom',
    stops.value === '' && !stops.validity.badInput ? 0 : stops.valueAsNumber);
  const minutes = Math.round(result?.total / 60);
  const hours = Math.floor(minutes / 60);
  $('rideTimeTotal').textContent = !Number.isFinite(minutes) ? '—'
    : hours ? hours + ' hr ' + (minutes % 60) + ' min' : minutes + ' min';
}

function savedStopMinutes(value) {
  if (typeof value !== 'string' || !value.includes(':')) return value;
  const migrated = /^(?:(\d+):)?([0-5]?\d):([0-5]\d)$/.exec(value.trim());
  if (!migrated) return undefined;
  const [, hours = '0', minutes, seconds] = migrated;
  return String(Number((Number(hours) * 60 + Number(minutes) + Number(seconds) / 60).toFixed(2)));
}

function initRideTime() {
  const fields = ['avgSpeed', 'stopTime'];
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem(rideTimeStorageKey));
  } catch {
    // Defaults remain usable if storage is unavailable.
  }
  const initial = {avgSpeed: saved?.avgSpeed, stopTime: savedStopMinutes(saved?.stopTime)};
  for (const id of fields) {
    if (typeof initial[id] === 'string' && (initial[id] === '' || Number.isFinite(Number(initial[id])))) {
      $(id).value = initial[id];
    }
    $(id).addEventListener('input', () => {
      updateRideTime();
      const values = Object.fromEntries(fields.map(field => [field, $(field).value]));
      const status = $('rideTimeSaveStatus');
      try {
        localStorage.setItem(rideTimeStorageKey, JSON.stringify(values));
        status.hidden = true;
      } catch {
        status.hidden = false;
        status.textContent = 'This browser couldn’t save your edits.';
      }
    });
  }
}
let currentGpx;
let downloadUrl;
let routeRequest = 0;
let mapListeners;
let makeupRequest;

function message(text) {
  const status = $('gpxMessage');
  status.textContent = text;
  status.hidden = !text;
}

function resetViewer() {
  pausePlayback();
  clearTimeout(syncTimer);
  clearTimeout(panoramaTimeout);
  pendingFrame?.frame?.remove();
  pendingFrame = undefined;
  displayedView = undefined;
  selectedView = undefined;
  panoramaPending = false;
  const frame = $('streetFrame');
  const emptyFrame = frame.cloneNode(false);
  emptyFrame.removeAttribute('src');
  frame.replaceWith(emptyFrame);
  $('streetViewer').dataset.ready = 'false';
}

let routeHitLine;
function drawRouteMap() {
  if (!window.L) {
    $('map').textContent = 'The map library could not load. Use the distance slider to explore the route.';
    $('fit').disabled = true;
    return;
  }
  const container = $('map');
  container.replaceChildren();
  map = L.map(container, {scrollWheelZoom: true, zoomSnap: .25, closePopupOnClick: false});
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  const coordinates = route.points.map(([lat, lng]) => [lat, lng]);
  const starts = route.segmentStarts ?? [0];
  const segments = starts.map((start, i) => coordinates.slice(start, starts[i + 1] ?? coordinates.length));
  const bounds = L.latLngBounds(coordinates);
  const fitRoute = () => map.fitBounds(bounds, {padding: [35, 30]});
  fitRoute();
  line = L.layerGroup().addTo(map);
  routeHitLine = L.polyline(segments, {color: categories.unknown.color, weight: 6, opacity: .95}).addTo(map);
  const finish = route.roundTrip === false ? 'End' : 'Turnaround';
  for (const [point, label] of [[coordinates[0], 'Start'], [coordinates.at(-1), finish]]) {
    L.marker(point, {icon: L.divIcon({className: 'endpoint', iconSize: [11, 11]})}).addTo(map).bindTooltip(label);
  }
  marker = L.marker(coordinates[0], {
    draggable: true, keyboard: true, title: 'Drag to explore the route',
    icon: L.divIcon({className: 'route-handle', html: '<span class="travel-arrow">↑</span>', iconSize: [24, 24], iconAnchor: [12, 12]}),
  }).addTo(map);
  const selectOnMap = event => choose(nearest(event.latlng), false, null, true);
  marker.on('dragstart', pausePlayback);
  marker.on('drag', event => choose(nearest(event.target.getLatLng()), false, null, true));
  marker.on('dragend', () => choose(selected));
  let popupOpen = false;
  map.on('popupopen', () => { popupOpen = true; });
  map.on('popupclose', () => { popupOpen = false; });
  map.on('click', event => {
    if (popupOpen) {
      map.closePopup();
      return;
    }
    pausePlayback();
    selectOnMap(event);
  });
  let draggingRoute = false;
  routeHitLine.on('mousedown', event => {
    if (popupOpen) return;
    pausePlayback();
    draggingRoute = true;
    map.dragging.disable();
    selectOnMap(event);
    L.DomEvent.stop(event.originalEvent);
  });
  map.on('mousemove', event => { if (draggingRoute) selectOnMap(event); });
  mapListeners = new AbortController();
  attachPlaces(map, route, mapListeners.signal, pausePlayback, () => marker.getLatLng());
  document.addEventListener('mouseup', () => {
    if (!draggingRoute) return;
    draggingRoute = false;
    map.dragging.enable();
  }, {signal: mapListeners.signal});
  $('fit').disabled = false;
  $('fit').onclick = fitRoute;
}

function setMakeupStatus(text) {
  const note = $('makeupNote');
  note.textContent = text;
  note.hidden = !text;
}

async function analyzeMakeup() {
  makeupRequest?.abort();
  const request = new AbortController();
  const currentRoute = route;
  makeupRequest = request;
  setMakeupStatus('Checking nearby roads and paths…');
  try {
    const estimate = await lookupRouteMakeup(currentRoute, currentGpx, request.signal, delay => {
      if (!request.signal.aborted) {
        setMakeupStatus(delay
          ? 'Map lookup unavailable. Retrying in ' + Math.ceil(delay / 1000) + ' seconds…'
          : 'Checking nearby roads and paths again…');
      }
    });
    if (request.signal.aborted) return;
    analysis = estimate;
    $('compositionBar').hidden = false;
    $('compositionRows').hidden = false;
    drawComposition();
    choose(selected);
    setMakeupStatus('');
  } catch (error) {
    if (request.signal.aborted) return;
    setMakeupStatus(error.message);
  }
}

function presentRoute(nextRoute, bytes, estimate) {
  showShareToast('');
  makeupRequest?.abort();
  resetViewer();
  mapListeners?.abort();
  map?.remove();
  map = marker = line = undefined;
  route = nextRoute;
  route.segmentBreaks = new Set((route.segmentStarts ?? []).slice(1));
  currentGpx = bytes;
  selected = tripMeters = directionAnchor = 0;
  travelDirection = 1;
  tripLeg = 'outbound';
  overrides = {};
  if (estimate) {
    try { overrides = JSON.parse(localStorage.getItem(storageKey('overrides')) || '{}') || {}; } catch {}
  }
  analysis = estimate ?? {samples: [{start: 0, end: route.distanceMeters, category: 'unknown'}]};
  $('compositionBar').hidden = !estimate;
  $('compositionRows').hidden = !estimate;
  setMakeupStatus('');
  $('routeTitle').textContent = route.name;
  document.title = route.name + ' · Route Lens';
  $('routeDistance').textContent = (tripDistance(route) / MILE).toFixed(2) + ' mi';
  $('rideTimeLabel').textContent = route.roundTrip === false ? 'Estimated route time' : 'Estimated round-trip time';
  updateRideTime();
  $('emptyRoute').hidden = true;
  $('routeExplorer').hidden = false;
  $('routeResults').hidden = false;
  $('gpxUpload').hidden = false;
  $('gpxShare').hidden = false;
  $('gpxDownload').hidden = false;
  $('gpxShareUrl').hidden = true;
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  downloadUrl = URL.createObjectURL(new Blob([bytes], {type: 'application/gpx+xml'}));
  $('gpxDownload').href = downloadUrl;
  $('gpxDownload').download = (route.name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'route') + '.gpx';

  const slider = $('position');
  slider.max = tripDistance(route);
  slider.step = 'any';
  slider.value = 0;
  drawRouteMap();
  if (estimate) drawComposition();
  else void analyzeMakeup();
  choose(0);
  $('routePlayback').disabled = false;
  message('');
  void rememberRoute(nextRoute, bytes).then(refreshRecents).catch(() => {});
}

function setImportBusy(busy) {
  $('routeImporter').setAttribute('aria-busy', String(busy));
}

async function loadSharedRoute(request) {
  const params = new URLSearchParams(location.hash.slice(1));
  const fromRwgps = params.has('rwgps');
  setImportBusy(fromRwgps || params.has('gpx'));
  if (!fromRwgps && !params.has('gpx')) return;
  message('');
  try {
    if (fromRwgps) {
      const id = params.get('rwgps');
      if (!/^\d+$/.test(id)) throw new Error('This Ride with GPS route ID is invalid.');
      const {bytes, rwgpsId, rwgpsLink} = await importRideWithGps('https://ridewithgps.com/routes/' + id);
      if (request === routeRequest) presentRoute({...parseGpx(bytes), rwgpsId, rwgpsLink}, bytes);
      return;
    }
    const bytes = await decodeGpx(params.get('gpx'));
    const shared = parseGpx(bytes, params.get('name') || undefined);
    shared.roundTrip = params.get('round') === '1';
    if (request === routeRequest) presentRoute(shared, bytes);
  } catch (error) {
    if (request === routeRequest) message(fromRwgps ? error.message : 'This GPX link could not be opened. Ask for the GPX file and upload it here.');
  } finally {
    if (request === routeRequest) setImportBusy(false);
  }
}

let shareToastTimer;
function showShareToast(text) {
  clearTimeout(shareToastTimer);
  const toast = $('shareToast');
  toast.textContent = text;
  if (text) shareToastTimer = setTimeout(() => { toast.textContent = ''; }, 4500);
}

async function shareRoute() {
  message('');
  showShareToast('');
  const file = currentGpx;
  const sharedRoute = route;
  const button = $('gpxShare');
  const field = $('gpxShareUrl');
  field.hidden = true;
  button.disabled = true;
  try {
    const url = new URL(location.href);
    if (sharedRoute.rwgpsId) {
      url.hash = new URLSearchParams({rwgps: sharedRoute.rwgpsId}).toString();
    } else {
      const encoded = await encodeGpx(file);
      if (file !== currentGpx) return;
      const params = new URLSearchParams({gpx: encoded, name: sharedRoute.name});
      if (sharedRoute.roundTrip !== false) params.set('round', '1');
      url.hash = params.toString();
    }
    if (url.href.length > maxSharedUrlLength) {
      showShareToast('This GPX is too large for a link. Use Download GPX to share the file.');
      return;
    }
    try {
      await navigator.clipboard.writeText(url.href);
      if (file === currentGpx) showShareToast('Share link copied.');
    } catch {
      if (file !== currentGpx) return;
      field.value = url.href;
      field.hidden = false;
      field.select();
      message('Copy the link below to share this route.');
    }
  } catch {
    if (file === currentGpx) showShareToast('Could not create a share link. You can still use Download GPX.');
  } finally {
    button.disabled = false;
  }
}

const recentPageSize = 10;
let recentLimit = recentPageSize;
let openRecentRoute;
let recentRefresh = 0;

async function refreshRecents() {
  const refresh = ++recentRefresh;
  const entries = await listRecentRoutes().catch(() => []);
  if (refresh !== recentRefresh) return;
  $('recentRoutes').hidden = !entries.length;
  $('recentMore').hidden = entries.length <= recentLimit;
  const items = entries.slice(0, recentLimit).map(entry => {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'light';
    button.textContent = entry.name;
    button.onclick = () => openRecentRoute(entry);
    item.append(button);
    return item;
  });
  $('recentList').replaceChildren(...items);
}

function initRouteControls() {
  const input = $('gpxFile');
  const dialog = $('importDialog');
  const importer = $('routeImporter');
  const status = $('importStatus');
  let pending;
  $('recentMore').onclick = () => {
    recentLimit += recentPageSize;
    void refreshRecents();
  };
  $('gpxUpload').onclick = () => {
    pausePlayback();
    dialog.append(importer, $('shareToast'));
    status.textContent = '';
    dialog.showModal();
    $('routeLink').focus();
  };
  $('closeImport').onclick = () => dialog.close();
  const onBackdrop = event => {
    if (event.target !== dialog) return false;
    const {left, right, top, bottom} = dialog.getBoundingClientRect();
    return event.clientX < left || event.clientX > right ||
      event.clientY < top || event.clientY > bottom;
  };
  let pressedBackdrop = false;
  dialog.addEventListener('pointerdown', event => { pressedBackdrop = onBackdrop(event); });
  dialog.addEventListener('click', event => {
    if (pressedBackdrop && onBackdrop(event)) dialog.close();
    pressedBackdrop = false;
  });
  dialog.onclose = () => {
    pending?.abort();
    $('emptyRoute').append(importer);
    document.querySelector('main').append($('shareToast'));
    $('gpxUpload').focus();
  };
  async function openRoute(read, filename, entry) {
    pending?.abort();
    const controller = new AbortController();
    pending = controller;
    const request = ++routeRequest;
    status.textContent = '';
    message('');
    setImportBusy(true);
    $('openLink').disabled = true;
    try {
      const {bytes, rwgpsId, rwgpsLink} = await read(controller.signal);
      if (request !== routeRequest || controller.signal.aborted) return;
      let nextRoute;
      try {
        nextRoute = parseGpx(bytes, filename);
      } catch (error) {
        if (entry) throw new RouteUnavailableError(error.message);
        throw error;
      }
      nextRoute.rwgpsId = rwgpsId;
      nextRoute.rwgpsLink = rwgpsLink;
      if (entry) nextRoute.roundTrip = entry.roundTrip;
      presentRoute(nextRoute, bytes);
      if (location.hash) history.replaceState(null, '', location.pathname + location.search);
      $('routeLink').value = '';
      status.textContent = '';
      if (dialog.open) dialog.close();
    } catch (error) {
      if (request !== routeRequest || controller.signal.aborted) return;
      if (entry && error instanceof RouteUnavailableError) {
        try {
          await forgetRecentRoute(entry.id);
          void refreshRecents();
          if (request === routeRequest && !controller.signal.aborted) showShareToast('Route unavailable. Removed from Recents.');
        } catch {
          if (request === routeRequest && !controller.signal.aborted) showShareToast('Route unavailable. Could not update Recents.');
        }
      } else if (entry) {
        showShareToast('Could not open this route right now. Try again.');
      } else {
        status.textContent = error.message || 'Could not open this route.';
      }
    } finally {
      if (pending === controller) {
        pending = null;
        if (request === routeRequest) setImportBusy(false);
        $('openLink').disabled = false;
      }
    }
  }
  openRecentRoute = entry => openRoute(async signal => {
    if (entry.source) return importRideWithGps(entry.source, signal);
    const bytes = await readRecentFile(entry.id);
    if (!bytes) throw new RouteUnavailableError('The saved GPX is missing.');
    return {bytes};
  }, entry.name, entry);
  void refreshRecents();
  $('linkForm').onsubmit = event => {
    event.preventDefault();
    void openRoute(signal => importRideWithGps($('routeLink').value, signal));
  };
  $('chooseFile').onclick = () => input.click();
  input.onchange = () => {
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    void openRoute(async () => {
      if (file.size > maxGpxBytes) throw new Error('Choose a GPX file under 5 MB.');
      return {bytes: new Uint8Array(await file.arrayBuffer())};
    }, file.name);
  };
  $('gpxShare').onclick = shareRoute;
  const slider = $('position');
  slider.addEventListener('pointerdown', pausePlayback);
  slider.oninput = event => {
    pausePlayback();
    chooseTripPosition(Number(event.target.value));
  };
  $('routePlayback').onclick = togglePlayback;
  window.addEventListener('hashchange', () => {
    if (!location.hash) location.reload();
    else void loadSharedRoute(++routeRequest);
  });
}

initRideTime();
initRouteControls();
void loadSharedRoute(++routeRequest);
