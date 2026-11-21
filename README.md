# Route Lens

A browser-based GPX viewer with an interactive map, Street View, route playback, and a ride-time estimate. Open a `.gpx` file with **Upload GPX**. The route follows the file as recorded, including separate track segments. Route Lens estimates makeup in the browser from static Georgia road tiles. It requests nearby roads from Overpass for stretches outside the extract or with unavailable tiles. Unmatched stretches are shown as unknown.

For Ride with GPS imports, **Copy share link** shares the route ID. Opening the link fetches the current public route from Ride with GPS. For file uploads, **Copy share link** puts the gzip-compressed GPX in the URL fragment. Anyone who receives the full link can decode the original file, including its metadata. The file is processed in the browser. Map tiles and Street View still load from their respective providers. For long files or services that truncate links, send the original using **Download GPX**.

## Run locally

Serve the `docs` directory with any static HTTP server, for example `python -m http.server 8000 --directory docs`.

For GitHub Pages, use branch `main` and the `/docs` folder as the publishing source. The public app starts without a route. The published Georgia snapshot contains OpenStreetMap road data.

## Refresh Georgia road data

Download the Georgia OSM PBF extract and its GeoJSON boundary from [Geofabrik](https://download.geofabrik.de/north-america/us/georgia/). Install the build dependency with `python -m pip install osmium==4.3.2`, then run `python scripts/build-georgia.py georgia-latest.osm.pbf georgia.geojson output/georgia`. Replace the published `docs/georgia` directory with the complete new output. Keep the source extract outside the repository.

The tiles contain data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), under the [Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/). The manifest records the snapshot date.
To refresh nearby stops from the same extract, run python scripts/build-places.py georgia-latest.osm.pbf docs/georgia/manifest.json docs/georgia-places.json and update the snapshot version in places.mjs.
