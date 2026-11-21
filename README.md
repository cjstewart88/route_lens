# Route Lens

A browser-based GPX viewer with an interactive map, Street View, route playback, and a ride-time estimate. Open a `.gpx` file with **Upload GPX**. The route follows the file as recorded, including separate track segments. On route load, Route Lens requests nearby highway data from OpenStreetMap via Overpass and estimates route makeup. The request uses coarse map areas around the route. Unmatched stretches are shown as unknown.

**Copy share link** puts the gzip-compressed GPX in the URL fragment. Anyone who receives the full link can decode the original file, including its metadata. The file is processed in the browser. Map tiles and Street View still load from their respective providers. For long files or services that truncate links, send the original using **Download GPX**.

## Run locally

Serve the `docs` directory with any static HTTP server, for example `python -m http.server 8000 --directory docs`.

For GitHub Pages, use branch `main` and the `/docs` folder as the publishing source. The public app starts without a route. Personal routes and bundled classification data are excluded from this repository.
