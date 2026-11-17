#!/usr/bin/env python3
"""Sideroad: Overpass JSON (out tags geom) -> pakattu reititysgraafi + hakuindeksi.

Käyttö: python3 build_graph.py <overpass.json> <ulos-kansio>

Kirjoittaa:
  graph.json   {"v":1,"names":[...],"places":[...],"bbox":[...],"data":"<base64 zlib binary>"}
  search.json  [{"n":nimi,"s":lisätieto,"t":tyyppi,"lat":..,"lon":..}, ...]
"""
import base64, json, math, re, struct, sys, zlib
from collections import defaultdict

CLASSES = ["motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link",
           "secondary", "secondary_link", "tertiary", "tertiary_link", "unclassified",
           "residential", "living_street", "service", "road"]
CLS = {c: i for i, c in enumerate(CLASSES)}

# Liput
F_FWD, F_BWD, F_CAR, F_MOP, F_POL, F_PRIV, F_EST, F_RBT = 1, 2, 4, 8, 16, 32, 64, 128

NO = {"no", "private_no"}
PRIVATE = {"private", "destination", "delivery", "customers", "permit", "agricultural", "forestry"}


def haversine(a, b):
    lat1, lon1 = a; lat2, lon2 = b
    p = math.pi / 180
    dlat = (lat2 - lat1) * p; dlon = (lon2 - lon1) * p
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1 * p) * math.cos(lat2 * p) * math.sin(dlon / 2) ** 2
    return 2 * 6371008.8 * math.asin(math.sqrt(h))


def parse_speed(v):
    if not v:
        return None
    v = v.strip().lower()
    if v in ("fi:urban",):
        return 50
    if v in ("fi:rural",):
        return 80
    if v in ("fi:motorway",):
        return 120
    if v == "walk":
        return 10
    if v == "none":
        return 120
    m = re.match(r"^(\d+)", v)
    if m:
        s = int(m.group(1))
        if "mph" in v:
            s = round(s * 1.609)
        return max(5, min(s, 140))
    return None


def default_speed(hw):
    if hw == "motorway":
        return 120
    if hw == "living_street":
        return 20
    if hw in ("residential", "service"):
        return 50
    return 80  # prototyypin sääntö: muut 80


def access_flags(t, hw):
    """Palauttaa (car_ok, mop_ok, polle_ok, private)."""
    def val(k):
        return (t.get(k) or "").lower()

    base_no = False
    private = False
    for k in ("access", "vehicle", "motor_vehicle"):
        v = val(k)
        if v == "no":
            base_no = True
        elif v in ("yes", "permissive", "designated"):
            base_no = False
        elif v in PRIVATE:
            private = True

    def ovr(key, ok):
        v = val(key)
        if v == "no":
            return False
        if v in ("yes", "designated", "permissive"):
            return True
        return ok

    car_ok = ovr("motorcar", not base_no)
    slow_road_ban = hw in ("motorway", "motorway_link") or val("motorroad") == "yes"
    mop_ok = ovr("moped", not base_no) and not slow_road_ban
    pol_ok = ovr("agricultural", not base_no) and not slow_road_ban
    return car_ok, mop_ok, pol_ok, private


def direction(t, hw):
    ow = (t.get("oneway") or "").lower()
    j = (t.get("junction") or "").lower()
    if ow in ("yes", "1", "true"):
        return True, False
    if ow == "-1":
        return False, True
    if ow == "no":
        return True, True
    if j in ("roundabout", "circular") or hw in ("motorway",):
        return True, False
    return True, True


def main(src, outdir):
    data = json.load(open(src, encoding="utf-8"))
    els = data["elements"]
    ways, pois = [], []
    for e in els:
        if e["type"] == "way" and "geometry" in e:
            hw = e.get("tags", {}).get("highway")
            if hw in CLS:
                ways.append(e)
        elif e["type"] == "node" and e.get("tags", {}).get("name"):
            pois.append(e)
    print(f"tieosuuksia {len(ways)}, nimettyjä pisteitä {len(pois)}")

    def key(p):
        return (round(p["lat"] * 1e6), round(p["lon"] * 1e6))

    # Risteykset: piste esiintyy useammassa tiessä tai on tien pää
    cnt = defaultdict(int)
    for w in ways:
        g = w["geometry"]
        for i, p in enumerate(g):
            k = key(p)
            cnt[k] += 1
            if i == 0 or i == len(g) - 1:
                cnt[k] += 1
        # sama piste kahdesti samassa tiessä (silmukka) -> risteys
    node_id = {}
    nodes = []

    def nid(k):
        if k not in node_id:
            node_id[k] = len(nodes)
            nodes.append(k)
        return node_id[k]

    names, name_idx = [], {}

    def name_of(t):
        n = t.get("name") or (("Tie " + t["ref"]) if t.get("ref") else None)
        if not n:
            return -1
        if n not in name_idx:
            name_idx[n] = len(names)
            names.append(n)
        return name_idx[n]

    edges = []  # (u, v, length, geom[list of keys], cls, speed, flags, name)
    for w in ways:
        t = w.get("tags", {})
        hw = t["highway"]
        sp = parse_speed(t.get("maxspeed"))
        est = sp is None
        if est:
            sp = default_speed(hw)
        car_ok, mop_ok, pol_ok, priv = access_flags(t, hw)
        if not (car_ok or mop_ok or pol_ok):
            continue
        fwd, bwd = direction(t, hw)
        fl = (F_FWD if fwd else 0) | (F_BWD if bwd else 0) | (F_CAR if car_ok else 0) | \
             (F_MOP if mop_ok else 0) | (F_POL if pol_ok else 0) | (F_PRIV if priv else 0) | \
             (F_EST if est else 0)
        if (t.get("junction") or "").lower() in ("roundabout", "circular"):
            fl |= F_RBT
        nm = name_of(t)
        g = [key(p) for p in w["geometry"]]
        # poista peräkkäiset duplikaatit
        g2 = [g[0]]
        for k in g[1:]:
            if k != g2[-1]:
                g2.append(k)
        g = g2
        if len(g) < 2:
            continue
        start = 0
        for i in range(1, len(g)):
            if cnt[g[i]] >= 2 or i == len(g) - 1:
                seg = g[start:i + 1]
                L = 0.0
                for a, b in zip(seg, seg[1:]):
                    L += haversine((a[0] / 1e6, a[1] / 1e6), (b[0] / 1e6, b[1] / 1e6))
                if L > 0.5:
                    edges.append((nid(seg[0]), nid(seg[-1]), L, seg[1:-1], CLS[hw], sp, fl, nm))
                start = i

    # Suurin yhtenäinen komponentti (suuntaamaton)
    parent = list(range(len(nodes)))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    for e in edges:
        a, b = find(e[0]), find(e[1])
        if a != b:
            parent[a] = b
    comp = defaultdict(int)
    for i in range(len(nodes)):
        comp[find(i)] += 1
    big = max(comp, key=comp.get)
    keep = [i for i in range(len(nodes)) if find(i) == big]
    remap = {old: new for new, old in enumerate(keep)}
    edges = [e for e in edges if e[0] in remap]
    nodes = [nodes[i] for i in keep]
    edges = [(remap[e[0]], remap[e[1]]) + e[2:] for e in edges]
    print(f"solmuja {len(nodes)}, kaaria {len(edges)} (suurin komponentti {comp[big]} / {len(parent)})")

    geom = []
    gstart, gcount = [], []
    for e in edges:
        gstart.append(len(geom))
        gcount.append(len(e[3]))
        geom.extend(e[3])
    if max(gcount, default=0) > 65535:
        raise SystemExit("liian pitkä geometria")

    nN, nE, nG = len(nodes), len(edges), len(geom)
    buf = bytearray()
    buf += struct.pack("<8i", 0x5344524F, nN, nE, nG, 0, 0, 0, 0)
    buf += struct.pack(f"<{2*nN}i", *[c for k in nodes for c in k])
    buf += struct.pack(f"<{nE}I", *[e[0] for e in edges])
    buf += struct.pack(f"<{nE}I", *[e[1] for e in edges])
    buf += struct.pack(f"<{nE}f", *[e[2] for e in edges])
    buf += struct.pack(f"<{nE}I", *gstart)
    buf += struct.pack(f"<{nE}i", *[e[7] for e in edges])
    buf += struct.pack(f"<{2*nG}i", *[c for k in geom for c in k])
    buf += struct.pack(f"<{nE}H", *gcount)
    buf += struct.pack(f"<{nE}B", *[e[4] for e in edges])
    buf += struct.pack(f"<{nE}B", *[e[5] for e in edges])
    buf += struct.pack(f"<{nE}B", *[e[6] for e in edges])
    comp_bytes = zlib.compress(bytes(buf), 9)
    print(f"binääri {len(buf)/1e6:.2f} Mt, pakattuna {len(comp_bytes)/1e6:.2f} Mt")

    lats = [k[0] / 1e6 for k in nodes]; lons = [k[1] / 1e6 for k in nodes]
    bbox = [min(lats), min(lons), max(lats), max(lons)]

    # Paikat karttanimiin ja hakuun
    PL_RANK = {"city": 0, "town": 1, "suburb": 2, "village": 2, "quarter": 3, "neighbourhood": 4, "hamlet": 4}
    places = []
    for p in pois:
        t = p["tags"]
        if t.get("place") in PL_RANK:
            places.append({"n": t["name"], "r": PL_RANK[t["place"]], "lat": round(p["lat"], 5), "lon": round(p["lon"], 5)})
    places.sort(key=lambda x: x["r"])

    def nearest_place(lat, lon, maxrank=2):
        best, bd = None, 1e18
        for pl in places:
            if pl["r"] > maxrank:
                continue
            d = (pl["lat"] - lat) ** 2 + ((pl["lon"] - lon) * 0.5) ** 2
            if d < bd:
                bd, best = d, pl["n"]
        return best or ""

    def area_label(lat, lon):
        sub, town = nearest_place(lat, lon, 2), nearest_place(lat, lon, 1)
        return sub if not town or sub == town else f"{sub}, {town}"

    search = []
    for pl in places:
        search.append({"n": pl["n"], "s": "Paikka" if pl["r"] <= 1 else ("Kaupunginosa · " + nearest_place(pl["lat"], pl["lon"], 1)),
                       "t": "p", "lat": pl["lat"], "lon": pl["lon"]})
    for p in pois:
        t = p["tags"]
        if t.get("amenity") in ("school", "college"):
            kind = "Koulu"
        elif t.get("shop") == "supermarket":
            kind = "Kauppa"
        else:
            continue
        search.append({"n": t["name"], "s": kind + " · " + area_label(p["lat"], p["lon"]), "t": "k",
                       "lat": round(p["lat"], 5), "lon": round(p["lon"], 5)})
    # Kadut: ryhmittele nimi + sijainti (2 km)
    by_name = defaultdict(list)
    for e in edges:
        if e[7] >= 0 and not names[e[7]].startswith("Tie "):
            a = nodes[e[0]]
            by_name[e[7]].append((a[0] / 1e6, a[1] / 1e6, e[2]))
    for ni, pts in by_name.items():
        clusters = []
        for lat, lon, L in pts:
            for c in clusters:
                if haversine((lat, lon), (c[0] / c[2], c[1] / c[2])) < 2000:
                    c[0] += lat * L; c[1] += lon * L; c[2] += L
                    break
            else:
                clusters.append([lat * L, lon * L, L])
        for c in clusters:
            lat, lon = c[0] / c[2], c[1] / c[2]
            search.append({"n": names[ni], "s": "Katu · " + area_label(lat, lon), "t": "s",
                           "lat": round(lat, 5), "lon": round(lon, 5)})
    print(f"hakukohteita {len(search)}")

    out = {"v": 1, "bbox": bbox, "names": names, "places": places,
           "data": base64.b64encode(comp_bytes).decode("ascii")}
    json.dump(out, open(f"{outdir}/graph.json", "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    json.dump(search, open(f"{outdir}/search.json", "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
