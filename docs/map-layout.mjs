const explorer = document.getElementById('routeExplorer');
const streetView = document.querySelector('.street-panel');
const stops = document.getElementById('routePlaces');
const results = document.getElementById('routeResults');
const scrubber = document.querySelector('.scrubber');
const compact = window.matchMedia('(max-width: 720px)');

function panel(className, label, ...sections) {
  const details = document.createElement('details');
  details.className = 'map-overlay ' + className;
  const summary = document.createElement('summary');
  summary.textContent = label;
  details.append(summary, ...sections);
  return details;
}

const street = panel('map-overlay-street', 'Street View', streetView);
street.open = !compact.matches;
explorer.append(street);

const info = panel('map-overlay-info', 'Route details', stops, results);
explorer.append(info);

const standard = document.createElement('button');
standard.type = 'button';
standard.className = 'text-button map-standard';
standard.textContent = 'Standard layout';
standard.onclick = () => {
  scrubber.before(streetView);
  explorer.after(stops, results);
  street.remove();
  info.remove();
  standard.remove();
  document.documentElement.classList.remove('map-layout');
  const url = new URL(location.href);
  url.searchParams.delete('layout');
  history.replaceState(null, '', url);
  window.dispatchEvent(new Event('resize'));
};
document.getElementById('gpxUpload').before(standard);
for (const details of [street, info]) {
  details.addEventListener('toggle', () => {
    if (compact.matches && details.open) (details === street ? info : street).open = false;
  });
}
document.documentElement.classList.add('map-layout');
