"""Build range-addressable Route Lens packs from a Geofabrik extract (osmium 4.3.2)."""
import collections
import gzip
import importlib
import json
import sys
from pathlib import Path

import osmium

roads = importlib.import_module("build-georgia")
stops = importlib.import_module("build-places")
roads.MARGIN = 90  # At least 25 m of longitude padding at Alaska's northern edge.
PACK_CELLS = 40
MAX_PACK_BYTES = 45 * 1024 * 1024
SOURCE = "https://download.geofabrik.de/north-america/us/"


def compact(value):
    return json.dumps(value, separators=(",", ":")).encode("ascii")


def center(feature, points):
    if feature.is_node():
        return round(feature.lat * roads.SCALE), round(feature.lon * roads.SCALE)
    if points:
        rows, cols = zip(*points)
        return round((min(rows) + max(rows)) / 2), round((min(cols) + max(cols)) / 2)


def build(pbf, boundary, work):
    coverage = json.loads(boundary.read_text(encoding="utf-8"))
    if coverage["type"] == "Feature":
        coverage = coverage["geometry"]
    if coverage["type"] not in {"Polygon", "MultiPolygon"}:
        raise ValueError("Expected extract coverage as Polygon or MultiPolygon")
    spool = work / "spool"
    output = work / "packs"
    if spool.exists() or output.exists():
        raise ValueError("Use a fresh build directory")
    spool.mkdir(parents=True)
    output.mkdir()
    location_file = work / "nodes.bin"
    processor = (osmium.FileProcessor(str(pbf)).with_locations("sparse_file_array," + str(location_file.resolve()))
                 .with_filter(osmium.filter.EntityFilter(osmium.osm.NODE | osmium.osm.WAY))
                 .with_filter(osmium.filter.KeyFilter("highway", "railway", "shop", "amenity")))
    version = processor.header.get("osmosis_replication_timestamp")
    if not version:
        raise ValueError("Missing extract timestamp")
    handles = collections.OrderedDict()

    def emit(tile, record, prefix=""):
        row, col = tile
        pack = f"{row // PACK_CELLS}_{col // PACK_CELLS}"
        handle = handles.pop(pack, None)
        if handle is None:
            if len(handles) == 96:
                handles.popitem(last=False)[1].close()
            handle = (spool / (pack + ".txt")).open("ab")
        handles[pack] = handle
        handle.write(f"{prefix}{row}_{col}\t".encode("ascii") + record + b"\n")

    count = 0
    place_count = 0
    print(f"Reading U.S. roads and stops from {version}", flush=True)
    for feature in processor:
        tags = feature.tags
        highway = tags.get("highway") if feature.is_way() and tags.get("area") != "yes" else None
        category = stops.kind(tags)
        if not highway and not category:
            continue
        points = []
        if feature.is_way():
            for node in feature.nodes:
                if not node.location.valid():
                    continue
                point = round(node.lat * roads.SCALE), round(node.lon * roads.SCALE)
                if not points or point != points[-1]:
                    points.append(point)
        if highway and len(points) >= 2:
            # Exclude the discontinuity in the unlikely event a way wraps the date line.
            runs = [[]]
            for point in points:
                if runs[-1] and abs(point[1] - runs[-1][-1][1]) > 180 * roads.SCALE:
                    runs.append([])
                runs[-1].append(point)
            tags_row = [feature.id, highway, tags.get("footway", ""), tags.get("surface", "")]
            for section in runs:
                if len(section) < 2:
                    continue
                for key, run in roads.tile_runs(section):
                    emit(key, compact(tags_row + [[value for point in run for value in point]]))
            count += 1
            if count % 1000000 == 0:
                print(f"{count:,} road ways extracted", flush=True)
        if category and (point := center(feature, points)):
            lat, lon = (v / roads.SCALE for v in point)
            street = tags.get("addr:full") or " ".join(filter(None, (tags.get("addr:housenumber"), tags.get("addr:street"))))
            address = ", ".join(filter(None, (street, tags.get("addr:city"), tags.get("addr:postcode"))))
            row = [category, lat, lon, tags.get("name") or tags.get("brand") or "", address]
            emit((point[0] // roads.CELL, point[1] // roads.CELL), compact(row), "p")
            place_count += 1
    for handle in handles.values():
        handle.close()
    del processor
    try:
        location_file.unlink()
    except PermissionError:
        # Windows can retain the mapped index until the process exits.
        pass
    pack_snapshot(spool, output, coverage, version, count, place_count)

def pack_snapshot(spool, output, coverage, version, count=None, place_count=None):
    pack_names = []
    for path in sorted(spool.glob("*.txt")):
        tiles = collections.defaultdict(bytearray)
        with path.open("rb") as stream:
            for line in stream:
                key, value = line.rstrip(b"\n").split(b"\t", 1)
                buf = tiles[key.decode("ascii")]
                buf.extend(b"," if buf else b"[")
                buf.extend(value)
        name = path.stem
        index = {}
        part = 0
        pack = (output / (name + ".bin")).open("wb")
        try:
            for key, buf in sorted(tiles.items()):
                buf.extend(b"]")
                payload = gzip.compress(buf, compresslevel=3, mtime=0)
                if len(payload) > MAX_PACK_BYTES:
                    raise ValueError(f"Oversized tile in {name}: {key}")
                if pack.tell() + len(payload) > MAX_PACK_BYTES:
                    pack.close()
                    part += 1
                    pack = (output / f"{name}.{part}.bin").open("wb")
                index[key] = [pack.tell(), len(payload)]
                if part:
                    index[key].append(part)
                pack.write(payload)
        finally:
            pack.close()
        (output / (name + ".json")).write_bytes(compact(index))
        pack_names.append(name)
        path.unlink()
    manifest = {"version": version, "packs": pack_names, "boundary": coverage, "wayCount": count,
                "placeCount": place_count, "attribution": "© OpenStreetMap contributors",
                "license": "https://opendatacommons.org/licenses/odbl/1-0/", "source": SOURCE}
    (output / "manifest.json").write_bytes(compact(manifest))
    print(f"Built {len(pack_names):,} packs", flush=True)


if __name__ == "__main__":
    build(*map(Path, sys.argv[1:]))
