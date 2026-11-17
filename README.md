# Sideroad – reittisuunnittelija (beta)

Reittisuunnittelu ja navigointi hitaille ajoneuvoille: mopoauto (45 km/h) ja traktorimönkijä (60 km/h).
Näyttää reitin, jota saa ajaa (ei moottori- tai moottoriliikenneteitä eikä ajoneuvokohtaisia kieltoja),
ja kertoo kuinka turvallinen se on (Safety Score).

Beta toimii Turun seudulla (Naantali, Raisio, Turku, Kaarina, Lieto).

## Ominaisuudet
- Suositeltu / Nopein / Turvallisin reitti ja Safety Score
- Vertailu autoreittiin: näyttää osuudet, joilla hitaalla ajoneuvolla ei saa ajaa
- Ajotila: oma sijainti, seuraava käännös, ääniohjeet suomeksi, uusi reitti jos poikkeat reitiltä
- Kaikki laskenta tapahtuu puhelimessa – sijaintia ei lähetetä minnekään

## Rakenne
- `index.html`, `app.js` – käyttöliittymä, kartta, ajotila
- `router.js` – reititys (A*), ajoneuvoprofiilit, Safety Score, reittiohjeet
- `graph.json`, `search.json` – tieverkko ja hakuindeksi
- `tools/build_graph.py` – muuntaa OpenStreetMap-datan (Overpass JSON) graafiksi

## Data
Karttadata © OpenStreetMapin tekijät, ODbL-lisenssi – https://www.openstreetmap.org/copyright

Beta-versio. Noudata aina liikennemerkkejä.
