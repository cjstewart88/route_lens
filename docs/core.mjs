export const MILE=1609.344;
export const actualMph=25.99/(10113/3600);
export const categories={sidewalk:{label:'Road / Sidewalk',color:'#27857f'},path:{label:'Dedicated / shared path',color:'#8ab637'},unknown:{label:'Unknown / ambiguous',color:'#bcc8cc'}};
export function pointAt(route,meters){meters=Math.max(0,Math.min(route.distanceMeters,meters));let lo=0,hi=route.cumulative.length-1;while(lo<hi){const m=Math.floor((lo+hi+1)/2);if(route.cumulative[m]<=meters)lo=m;else hi=m-1;}const i=Math.min(lo,route.points.length-2),a=route.points[i],b=route.points[i+1],t=(meters-route.cumulative[i])/(route.cumulative[i+1]-route.cumulative[i]);return {lat:a[0]+(b[0]-a[0])*t,lng:a[1]+(b[1]-a[1])*t,ele:a[2]+(b[2]-a[2])*t,index:i,meters};}
export function heading(a,b){const r=Math.PI/180,y=Math.sin((b.lng-a.lng)*r)*Math.cos(b.lat*r),x=Math.cos(a.lat*r)*Math.sin(b.lat*r)-Math.sin(a.lat*r)*Math.cos(b.lat*r)*Math.cos((b.lng-a.lng)*r);return (Math.atan2(y,x)/r+360)%360;}
export function routeHeading(route, meters, direction = 1) {
  let start = 0;
  let end = route.distanceMeters;
  const stops = route.segmentStarts ?? [];
  const nextStart = stops.find(index => route.cumulative[index] > meters);
  if (nextStart !== undefined) end = route.cumulative[nextStart] - 0.000001;
  const currentStart = stops.findLast(index => route.cumulative[index] <= meters);
  if (currentStart !== undefined) start = route.cumulative[currentStart];
  const a = pointAt(route, Math.max(start, meters - 12));
  const b = pointAt(route, Math.min(end, meters + 12));
  return direction >= 0 ? heading(a, b) : heading(b, a);
}
export function tripDistance(route) {
  return route.distanceMeters * (route.roundTrip === false ? 1 : 2);
}
export function tripPosition(route, meters) {
  const total = tripDistance(route);
  const t = Math.max(0, Math.min(total, meters));
  const returning = route.roundTrip !== false && t >= route.distanceMeters;
  return {meters: returning ? total - t : t, leg: returning ? 'return' : 'outbound', tripMeters: t};
}
export function duration(seconds){const s=Math.round(seconds);const h=Math.floor(s/3600),m=Math.floor(s%3600/60),sec=s%60;return h?`${h}h ${String(m).padStart(2,'0')}m ${String(sec).padStart(2,'0')}s`:`${m}m ${String(sec).padStart(2,'0')}s`;}
export function calculate(miles,speed,mode,custom=0){if(!Number.isFinite(miles)||miles<=0||!Number.isFinite(speed)||speed<=0||!Number.isFinite(custom)||custom<0)return null;const moving=miles/speed*3600,stops=mode==='fixed'?861:mode==='scaled'?861*miles/25.99:mode==='custom'?custom*60:0;return {moving,stops,total:moving+stops};}
export function typeOf(t){const h=t.highway;if(h==='construction'||h==='proposed')return 'unknown';if(t.footway==='sidewalk')return 'sidewalk';if(t.footway==='crossing'||h==='steps'||h==='pedestrian'||h==='track')return 'other';if(['cycleway','path','footway','bridleway'].includes(h))return 'path';if(['motorway','motorway_link','trunk','trunk_link','primary','primary_link','secondary','secondary_link','tertiary','tertiary_link','residential','unclassified','service','living_street','road'].includes(h))return 'road';return 'unknown';}
export function classify(route,osm){const middleLatitude=route.points[Math.floor(route.points.length/2)][0];const sx=111195*Math.cos(middleLatitude*Math.PI/180),sy=111195,project=p=>[p[1]*sx,p[0]*sy],cell=80,grid=new Map();let segments=[];
 for(const w of osm.elements||[]){if(!w.geometry||!w.tags?.highway||w.tags.area==='yes')continue;const category=typeOf(w.tags);for(let i=1;i<w.geometry.length;i++){const a=project([w.geometry[i-1].lat,w.geometry[i-1].lon]),b=project([w.geometry[i].lat,w.geometry[i].lon]),dx=b[0]-a[0],dy=b[1]-a[1],len=Math.hypot(dx,dy);if(!len)continue;const s={a,b,dx,dy,len,category,id:w.id,name:w.tags.name||w.tags.highway,surface:w.tags.surface||'Not tagged'};const index=segments.push(s)-1;for(let x=Math.floor(Math.min(a[0],b[0])/cell);x<=Math.floor(Math.max(a[0],b[0])/cell);x++)for(let y=Math.floor(Math.min(a[1],b[1])/cell);y<=Math.floor(Math.max(a[1],b[1])/cell);y++){const k=x+','+y;if(!grid.has(k))grid.set(k,[]);grid.get(k).push(index);}}}
 const samples=[];for(let start=0;start<route.distanceMeters;start+=25){const end=Math.min(start+25,route.distanceMeters),mid=(start+end)/2,p=pointAt(route,mid),a=pointAt(route,Math.max(0,mid-8)),b=pointAt(route,Math.min(route.distanceMeters,mid+8)),q=project([p.lat,p.lng]),vx=(b.lng-a.lng)*sx,vy=(b.lat-a.lat)*sy,vl=Math.hypot(vx,vy),ids=new Set(),gx=Math.floor(q[0]/cell),gy=Math.floor(q[1]/cell);for(let x=gx-1;x<=gx+1;x++)for(let y=gy-1;y<=gy+1;y++)for(const id of grid.get(x+','+y)||[])ids.add(id);const candidates=[];
 for(const id of ids){const s=segments[id],t=Math.max(0,Math.min(1,((q[0]-s.a[0])*s.dx+(q[1]-s.a[1])*s.dy)/(s.len*s.len))),d=Math.hypot(q[0]-s.a[0]-t*s.dx,q[1]-s.a[1]-t*s.dy),alignment=Math.abs((vx*s.dx+vy*s.dy)/(vl*s.len));if(d<=25&&alignment>=.7)candidates.push({...s,d,score:d+(1-alignment)*15});}
 candidates.sort((a,b)=>a.score-b.score);const best=candidates[0],ambiguous=best&&candidates.some(c=>c.category!==best.category&&c.score-best.score<7);samples.push({start,end,category:!best||ambiguous?'unknown':best.category,name:best?.name||'No confident match',surface:best?.surface||'Not tagged',way:best?.id||null,ambiguous:!!ambiguous});}
 return {samples,osmDate:osm.osm3s?.timestamp_osm_base||null,method:'25 m samples; 25 m match radius; direction agreement; 7 m ambiguity margin'};
}
export function displayCategory(category) {
  if (category === 'road') return 'sidewalk';
  return Object.hasOwn(categories, category) ? category : 'unknown';
}
export function sampleType(sample, overrides) {
  const stretch = Math.floor(((sample.start + sample.end) / 2) / MILE * 10);
  return displayCategory(overrides[stretch] || sample.category);
}
export function composition(samples,overrides={}){const totals=Object.fromEntries(Object.keys(categories).map(k=>[k,0]));for(const s of samples)totals[sampleType(s,overrides)]+=s.end-s.start;return totals;}
