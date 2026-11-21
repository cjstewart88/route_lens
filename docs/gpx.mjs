export const maxGpxBytes = 5 * 1024 * 1024;
export const maxSharedUrlLength = 48000;

function childElements(element, name) {
  return Array.from(element.children).filter(child => child.localName === name);
}

function childText(element, name) {
  return element && childElements(element, name)[0]?.textContent.trim();
}

function distanceBetween(a, b) {
  const rad = Math.PI / 180;
  const lat = (b[0] - a[0]) * rad;
  const lng = (b[1] - a[1]) * rad;
  const h = Math.sin(lat / 2) ** 2 +
    Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(lng / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(Math.min(1, h)));
}

export function parseGpx(bytes, filename = 'Uploaded route.gpx') {
  if (bytes.byteLength > maxGpxBytes) throw new Error('Choose a GPX file under 5 MB.');
  const xml = new TextDecoder().decode(bytes);
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const root = doc.documentElement;
  if (root.localName !== 'gpx' || doc.getElementsByTagName('parsererror').length) {
    throw new Error('This file is not valid GPX.');
  }

  const tracks = childElements(root, 'trk');
  const routes = childElements(root, 'rte');
  const trackSegments = tracks.flatMap(track => childElements(track, 'trkseg'));
  const streams = trackSegments.length
    ? trackSegments.map(segment => childElements(segment, 'trkpt'))
    : routes.map(route => childElements(route, 'rtept'));
  if (streams.reduce((count, nodes) => count + nodes.length, 0) > 100000) {
    throw new Error('This GPX exceeds the 100,000-point limit.');
  }

  const points = [];
  const cumulative = [];
  const segmentStarts = [];
  let distanceMeters = 0;
  for (const nodes of streams) {
    const segment = [];
    for (const node of nodes) {
      if (!node.hasAttribute('lat') || !node.hasAttribute('lon') ||
          !node.getAttribute('lat').trim() || !node.getAttribute('lon').trim()) continue;
      const lat = Number(node.getAttribute('lat'));
      const lng = Number(node.getAttribute('lon'));
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
      const previous = segment.at(-1);
      if (previous?.[0] === lat && previous?.[1] === lng) continue;
      const elevation = Number(childText(node, 'ele'));
      segment.push([lat, lng, Number.isFinite(elevation) ? elevation : 0]);
    }
    if (segment.length < 2) continue;
    segmentStarts.push(points.length);
    for (const [index, point] of segment.entries()) {
      if (index) distanceMeters += distanceBetween(segment[index - 1], point);
      points.push(point);
      cumulative.push(distanceMeters);
    }
  }
  if (!distanceMeters) throw new Error('This GPX needs a track or route with at least two distinct points.');

  const metadata = childElements(root, 'metadata')[0];
  const name = childText(tracks[0], 'name') || childText(routes[0], 'name') ||
    childText(metadata, 'name') || filename.replace(/\.gpx$/i, '');
  return {name: (name || 'Uploaded route').slice(0, 180), points, cumulative, segmentStarts, distanceMeters, roundTrip: false};
}

export async function encodeGpx(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
  let binary = '';
  for (let i = 0; i < compressed.length; i += 8192) {
    binary += String.fromCharCode(...compressed.subarray(i, i + 8192));
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export async function decodeGpx(payload) {
  if (!payload || payload.length > maxSharedUrlLength || !/^[\w-]+$/.test(payload)) {
    throw new Error('This GPX link is invalid or too long.');
  }
  const bytes = Uint8Array.from(atob(payload.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const {value, done} = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxGpxBytes) {
      await reader.cancel();
      throw new Error('The GPX in this link exceeds 5 MB.');
    }
    chunks.push(value);
  }
  return new Uint8Array(await new Blob(chunks).arrayBuffer());
}
