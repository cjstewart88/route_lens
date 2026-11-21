# Route Lens agent instructions

Treat "refresh map data", "update map data", and similar requests as a request to rebuild and publish the OpenStreetMap snapshot used for route makeup and nearby stops. For a request that names a state, follow **Refresh map data for [state]**. For a nationwide request, follow **Refresh map data** in the README. A refresh is complete after the live site retrieves the new snapshot and opens a route with it.

Use a dated extract from Geofabrik and verify its published checksum. Keep the source PBF, temporary node index, and intermediate files outside this repository. Keep the current live snapshot available until the new data passes validation. Publish only public map data to the data branch. Never commit user GPX files, route history, or credentials.
