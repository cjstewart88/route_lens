"""Build Route Lens's Georgia road snapshot. Requires Python 3.10+ and osmium==4.3.2.

Download georgia-latest.osm.pbf and georgia.geojson from SOURCE, then run:
  python scripts/build-georgia.py georgia-latest.osm.pbf georgia.geojson output/georgia

Build into a fresh output directory and publish the complete directory together.
The PBF stays local. The result is a derived OSM database under ODbL 1.0.
"""

import argparse
import collections
import gzip
import json
from pathlib import Path

import osmium


SOURCE = "https://download.geofabrik.de/north-america/us/georgia/"
SCALE = 100_000
CELL = SCALE // 20
# 0.00045 degrees is at least 40 m throughout Georgia. The matcher uses 25 m.
MARGIN = 45


def tile_bounds(y1, x1, y2, x2):
    return ((min(y1, y2) - MARGIN) // CELL, (min(x1, x2) - MARGIN) // CELL,
            (max(y1, y2) + MARGIN) // CELL, (max(x1, x2) + MARGIN) // CELL)


def tile_runs(points):
    """Yield continuous geometry in each padded tile, keeping original vertices."""
    rows, cols = zip(*points)
    south, west, north, east = tile_bounds(min(rows), min(cols), max(rows), max(cols))
    if south == north and west == east:
        yield (south, west), points
        return

    active = {}
    for a, b in zip(points, points[1:]):
        south, west, north, east = tile_bounds(*a, *b)
        following = {}
        for row in range(south, north + 1):
            for col in range(west, east + 1):
                key = row, col
                run = active.pop(key, None)
                if run is None:
                    run = [a]
                run.append(b)
                following[key] = run
        yield from active.items()
        active = following
    yield from active.items()


def build(pbf, polygon, output):
    boundary = json.loads(polygon.read_text(encoding="utf-8"))
    if boundary.get("type") == "FeatureCollection" and len(boundary["features"]) == 1:
        boundary = boundary["features"][0]
    if boundary.get("type") == "Feature":
        boundary = boundary["geometry"]
    if boundary.get("type") not in {"MultiPolygon", "Polygon"}:
        raise ValueError("Expected Geofabrik extract boundary as a polygon or multipolygon.")
    if output.exists() and any(output.iterdir()):
        raise ValueError("Choose an empty output directory to avoid mixing snapshot versions.")
    output.mkdir(parents=True, exist_ok=True)
    processor = (osmium.FileProcessor(str(pbf)).with_locations("sparse_mem_array")
                 .with_filter(osmium.filter.EntityFilter(osmium.osm.WAY))
                 .with_filter(osmium.filter.KeyFilter("highway")))
    version = processor.header.get("osmosis_replication_timestamp")
    if not version:
        raise ValueError("Missing Geofabrik replication timestamp in PBF header.")
    print(f"Reading roads from {version}", flush=True)
    buffers = collections.defaultdict(bytearray)
    way_count = 0
    for way in processor:
        tags = way.tags
        if tags.get("area") == "yes":
            continue
        points = []
        for node in way.nodes:
            if not node.location.valid():
                raise ValueError(f"Way {way.id} references a missing node.")
            point = round(node.lat * SCALE), round(node.lon * SCALE)
            if not points or point != points[-1]:
                points.append(point)
        if len(points) < 2:
            continue
        attributes = [way.id, tags["highway"], tags.get("footway", ""), tags.get("surface", "")]
        for key, run in tile_runs(points):
            record = attributes + [[coord for point in run for coord in point]]
            buffer = buffers[key]
            buffer.extend(b"," if buffer else b"[")
            buffer.extend(json.dumps(record, separators=(",", ":")).encode("ascii"))
        way_count += 1
        if way_count % 250000 == 0:
            print(f"Processed {way_count:,} highway ways", flush=True)

    if not buffers:
        raise ValueError("No roads found in source.")
    tile_names = []
    for row, col in sorted(buffers):
        key = f"{row}_{col}"
        data = buffers.pop((row, col))
        data.extend(b"]")
        (output / f"{key}.json.gz").write_bytes(gzip.compress(data, compresslevel=6, mtime=0))
        tile_names.append(key)
    manifest = {
        "version": version,
        "tiles": tile_names,
        "boundary": boundary,
        "wayCount": way_count,
        "source": SOURCE,
        "attribution": "© OpenStreetMap contributors",
        "license": "https://opendatacommons.org/licenses/odbl/1-0/",
    }
    (output / "manifest.json").write_text(json.dumps(manifest, separators=(",", ":")), encoding="utf-8")
    print(f"Built {way_count:,} ways in {len(tile_names):,} tiles.", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pbf", type=Path)
    parser.add_argument("polygon", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    build(args.pbf, args.polygon, args.output)
