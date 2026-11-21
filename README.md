# Route Lens

[Open Route Lens on GitHub Pages](https://cjstewart88.github.io/route_lens/)

A browser-based GPX viewer with an interactive map, Street View, route playback, and a ride-time estimate. Open a `.gpx` file with **Upload GPX**. The route follows the file as recorded, including separate track segments. Route Lens estimates makeup and finds nearby stops using cached U.S. OpenStreetMap data. The app downloads only the ranges it needs along the route and uses Overpass as a fallback. Unmatched stretches are shown as unknown.

For Ride with GPS imports, **Copy share link** shares the route ID. Opening the link fetches the current public route from Ride with GPS. For file uploads, **Copy share link** puts the gzip-compressed GPX in the URL fragment. Anyone who receives the full link can decode the original file, including its metadata. The file is processed in the browser. Map tiles and Street View still load from their respective providers. For long files or services that truncate links, send the original using **Download GPX**.

## Run locally

Serve the `docs` directory with any static HTTP server, for example `python -m http.server 8000 --directory docs`.

For GitHub Pages, use branch `main` and the `/docs` folder as the publishing source. The public app starts without a route. The app is published through GitHub Pages. The U.S. data branch serves route-sized ranges from the GitHub raw file host.

## Refresh map data

A request to refresh or update map data means replacing the snapshot Route Lens uses for road surfaces and nearby train stations, bike shops, and gas stations. This is a manual refresh. Opening a route continues to work with the last published snapshot between refreshes.

1. Check which snapshot the app uses in `docs/map-snapshots.mjs` and read that branch's `manifest.json`. If the app is still on the Georgia snapshot, finish the initial nationwide release before changing its live data source.
2. Download a dated `us-YYMMDD.osm.pbf`, its published MD5 file, and `us.geojson` from [Geofabrik's U.S. index](https://download.geofabrik.de/north-america/us/). Use the date in the download listing and verify the PBF against the matching checksum. A dated file can be resumed reliably. Keep these files in a workspace directory outside the repository.
3. Install the build dependency with `python -m pip install osmium==4.3.2`. Run `python scripts/build-us.py <extract.pbf> <us.geojson> <fresh-output-directory>`. Allow space for the 12 GB input, the disk-backed node index, intermediate files, and Git packaging. The first U.S. build used a node index of roughly 26 GB. The build's `packs/` directory is the publishable output, and its manifest records the source timestamp.
4. Validate road and stop ranges locally with routes in several regions, including Alaska and Hawaii. Check the checksum result, the manifest coverage, and the index offsets and lengths. The road classifier should receive gzipped records for each requested range. Keep the current production snapshot while validating.
5. Publish `packs/` to a versioned data branch in this public repository from a separate checkout. Keep individual binary files below GitHub's 100 MB file limit and split large pushes into batches under GitHub's 2 GB push limit. Publish the manifest last. Confirm a cross-origin `Range` request to `raw.githubusercontent.com` returns HTTP 206 for an indexed tile before switching the app. GitHub Pages serves the app from `main:/docs`.
6. Update the data branch in `docs/map-snapshots.mjs` and bump the module URLs that import it, including the app and HTML entry point where needed. Publish the app and check a live route outside Georgia. If the private Route Lens deployment is being maintained, roll the same app update into it. Check GitHub's repository size before retaining multiple multi-gigabyte releases.

The app reads road and stop data from [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) under the [Open Database License](https://opendatacommons.org/licenses/odbl/1-0/).

## Refresh map data for [state]

Use this workflow when a request names a state, such as "refresh map data for Tennessee".

1. Find the state on [Geofabrik's U.S. index](https://download.geofabrik.de/north-america/us/). Download its dated PBF, matching MD5, and GeoJSON coverage boundary. Verify the checksum.
2. Run `python scripts/build-us.py <state.pbf> <state.geojson> <fresh-output-directory> --source <state-index-url>` with the same build dependency as the nationwide refresh. The state extract contains roads and stops. Only that state's extract needs downloading.
3. Validate the state output with a route inside the state and a ride that crosses a state line. Publish the packs and manifest together on a versioned data branch such as `state-data-tn-YYYYMMDD`. Follow the same GitHub file and push limits as the nationwide workflow.
4. In `docs/map-snapshots.mjs`, add or replace the state's entry in `stateSnapshots` with `{ref: 'state-data-tn-YYYYMMDD', bounds: [south, west, north, east]}`. Take the bounds from the state's GeoJSON. These bounds select candidate snapshots. The exact polygon determines coverage. Put the newest overlapping snapshots first.
5. Bump the cache-busting module URLs and publish the app. Verify the live browser fetches the state snapshot for a route in that state and uses the nationwide snapshot for the rest of a cross-border ride. When the national data is newer than an overlay, remove that overlay from the app configuration during the next nationwide release.
