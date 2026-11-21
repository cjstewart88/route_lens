export async function importRideWithGps(link, signal) {
  const value = link.trim();
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(value) ? value : 'https://' + value);
  } catch {}
  const match = url?.pathname.match(/^\/routes\/(\d+)\/?$/);
  if (!match || !['ridewithgps.com', 'www.ridewithgps.com'].includes(url.hostname) || url.username || url.password || url.port) {
    throw new Error('Paste a Ride with GPS route link, such as ridewithgps.com/routes/12345.');
  }
  const endpoint = new URL('https://ridewithgps.com/routes/' + match[1] + '.json');
  if (url.searchParams.has('privacy_code')) endpoint.searchParams.set('privacy_code', url.searchParams.get('privacy_code'));
  let data;
  try {
    const response = await fetch(endpoint, {signal, credentials: 'omit'});
    if (!response.ok) throw new Error();
    data = await response.json();
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error('Could not open this route. Check that the link opens while signed out, or upload a GPX file.');
  }
  const points = data?.track_points;
  if (!Array.isArray(points) || points.length < 2) throw new Error('This route has no usable track. Try uploading its GPX file.');
  if (points.length > 100000) throw new Error('This route exceeds the 100,000-point limit.');
  const name = String(data.name || 'Ride with GPS route').slice(0, 180)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const track = points.map(({x, y, e}) => {
    if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 180 || Math.abs(y) > 90) {
      throw new Error('This route contains invalid coordinates. Try uploading its GPX file.');
    }
    const elevation = Number.isFinite(e) ? '<ele>' + e + '</ele>' : '';
    return '<trkpt lat="' + y + '" lon="' + x + '">' + elevation + '</trkpt>';
  }).join('');
  const bytes = new TextEncoder().encode('<gpx xmlns="http://www.topografix.com/GPX/1/1" version="1.1" creator="Route Lens"><trk><name>' + name + '</name><trkseg>' + track + '</trkseg></trk></gpx>');
  return {bytes, rwgpsId: match[1]};
}
