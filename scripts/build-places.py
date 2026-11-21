"""Extract cycling stops from the same Georgia PBF and boundary as the road tiles."""
import json
import sys
from pathlib import Path

import osmium


def kind(tags):
    if tags.get("railway") in {"station", "halt", "tram_stop"} and tags.get("station") != "funicular":
        return "rail"
    if tags.get("shop") == "bicycle":
        return "bike"
    if tags.get("amenity") == "fuel":
        return "fuel"


def build(pbf, manifest, output):
    source = json.loads(Path(manifest).read_text(encoding="utf-8"))
    places = []
    features = (osmium.FileProcessor(pbf).with_locations("sparse_mem_array")
                .with_filter(osmium.filter.EntityFilter(osmium.osm.NODE | osmium.osm.WAY))
                .with_filter(osmium.filter.KeyFilter("railway", "shop", "amenity")))
    for feature in features:
        tags = feature.tags
        category = kind(tags)
        if not category:
            continue
        if feature.is_node():
            lat, lon = feature.lat, feature.lon
        else:
            nodes = [node for node in feature.nodes if node.location.valid()]
            if not nodes:
                continue
            lat = (min(node.lat for node in nodes) + max(node.lat for node in nodes)) / 2
            lon = (min(node.lon for node in nodes) + max(node.lon for node in nodes)) / 2
        name = tags.get("name") or tags.get("brand") or ""
        street = tags.get("addr:full") or " ".join(filter(None, (
            tags.get("addr:housenumber"), tags.get("addr:street"))))
        address = ", ".join(filter(None, (
            street, tags.get("addr:city"), tags.get("addr:postcode"))))
        # The shop's current address is missing from this point in the extract.
        # https://peachtreebikes.com/pages/contact
        if not address and (name, round(lat, 6), round(lon, 6)) == ("Peachtree Bikes", 33.879616, -84.380261):
            address = "4540 Roswell Rd, Sandy Springs, GA 30342"
        record = [category, round(lat, 6), round(lon, 6), name]
        if address:
            record.append(address)
        places.append(record)
    data = {key: source[key] for key in ("version", "boundary", "source", "license", "attribution")}
    data["places"] = places
    Path(output).write_text(json.dumps(data, ensure_ascii=True, separators=(",", ":")), encoding="utf-8")
    print(f"Extracted {len(places)} locations")


if __name__ == "__main__":
    build(*sys.argv[1:])
