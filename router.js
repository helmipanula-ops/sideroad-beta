/* Sideroad reititin: graafin purku, A*-haku ajoneuvoprofiileille, Safety Score ja reittiohjeet.
   Toimii selaimessa (window.Sideroad) ja Nodessa (module.exports). */
(function (root) {
  'use strict';
  var F_FWD = 1, F_BWD = 2, F_CAR = 4, F_MOP = 8, F_POL = 16, F_PRIV = 32, F_EST = 64, F_RBT = 128;
  var CLASS_NAMES = ['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link',
    'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'unclassified', 'residential',
    'living_street', 'service', 'road'];
  // Autolla ajettava keskinopeus suhteessa rajoitukseen
  var CLASS_FACTOR = [0.92, 0.75, 0.88, 0.75, 0.85, 0.7, 0.8, 0.7, 0.78, 0.7, 0.72, 0.65, 0.5, 0.45, 0.6];

  var PROFILES = {
    mopoauto: { label: 'Mopoauto', vmax: 45, flag: F_MOP },
    polle: { label: 'Polle', vmax: 60, flag: F_POL },
    car: { label: 'Auto', vmax: 200, flag: F_CAR }
  };
  var MODES = {
    suositeltu: function (s) { return s >= 90 ? 0.3 : s >= 70 ? 0.6 : s >= 60 ? 0.9 : 1; },
    nopein: function () { return 1; },
    turvallisin: function (s) { return s >= 90 ? 0.15 : s >= 70 ? 0.4 : s >= 60 ? 0.8 : 1; }
  };

  function safetyOf(speed) { return speed <= 50 ? 100 : speed <= 60 ? 80 : speed <= 80 ? 40 : 0; }

  function Graph(raw, names) {
    var dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    var off = 0;
    function i32(n) { var a = new Int32Array(raw.buffer.slice(raw.byteOffset + off, raw.byteOffset + off + n * 4)); off += n * 4; return a; }
    function u32(n) { var a = new Uint32Array(raw.buffer.slice(raw.byteOffset + off, raw.byteOffset + off + n * 4)); off += n * 4; return a; }
    function f32(n) { var a = new Float32Array(raw.buffer.slice(raw.byteOffset + off, raw.byteOffset + off + n * 4)); off += n * 4; return a; }
    function u16(n) { var a = new Uint16Array(raw.buffer.slice(raw.byteOffset + off, raw.byteOffset + off + n * 2)); off += n * 2; return a; }
    function u8(n) { var a = new Uint8Array(raw.buffer.slice(raw.byteOffset + off, raw.byteOffset + off + n)); off += n; return a; }
    var hdr = i32(8);
    if (hdr[0] !== 0x5344524F) throw new Error('Tuntematon graafitiedosto');
    var nN = hdr[1], nE = hdr[2], nG = hdr[3];
    this.nN = nN; this.nE = nE;
    this.nodes = i32(2 * nN);
    this.eFrom = u32(nE); this.eTo = u32(nE); this.eLen = f32(nE); this.eGeomStart = u32(nE);
    this.eName = i32(nE); this.geom = i32(2 * nG); this.eGeomCount = u16(nE);
    this.eClass = u8(nE); this.eSpeed = u8(nE); this.eFlags = u8(nE);
    this.names = names || [];
    // Vierekkäisyys (CSR): jokainen kaari kumpaankin suuntaan, suunta merkitään etumerkillä
    var deg = new Uint32Array(nN + 1), e;
    for (e = 0; e < nE; e++) { deg[this.eFrom[e] + 1]++; deg[this.eTo[e] + 1]++; }
    for (var i = 0; i < nN; i++) deg[i + 1] += deg[i];
    var fill = deg.slice(0, nN), adj = new Int32Array(2 * nE);
    for (e = 0; e < nE; e++) {
      adj[fill[this.eFrom[e]]++] = e + 1;      // eteenpäin
      adj[fill[this.eTo[e]]++] = -(e + 1);     // taaksepäin
    }
    this.adjStart = deg; this.adj = adj;
    // Kustakin solmusta: mille profiileille solmuun pääsee
    var nodeMask = new Uint8Array(nN);
    for (e = 0; e < nE; e++) { var f = this.eFlags[e] & (F_CAR | F_MOP | F_POL); nodeMask[this.eFrom[e]] |= f; nodeMask[this.eTo[e]] |= f; }
    this.nodeMask = nodeMask;
    // Ruudukkoindeksi lähimmän solmun hakuun
    var lat0 = 0, lon0 = 0;
    for (i = 0; i < nN; i++) { lat0 += this.nodes[2 * i]; lon0 += this.nodes[2 * i + 1]; }
    this.lat0 = lat0 / nN / 1e6; this.lon0 = lon0 / nN / 1e6;
    this.kx = Math.cos(this.lat0 * Math.PI / 180) * 111320; this.ky = 110574;
    this.cell = 400; // m
    var grid = new Map();
    for (i = 0; i < nN; i++) {
      var p = this.xy(i), k = Math.floor(p[0] / this.cell) + ',' + Math.floor(p[1] / this.cell);
      var arr = grid.get(k); if (!arr) { arr = []; grid.set(k, arr); } arr.push(i);
    }
    this.grid = grid;
  }
  Graph.prototype.lat = function (i) { return this.nodes[2 * i] / 1e6; };
  Graph.prototype.lon = function (i) { return this.nodes[2 * i + 1] / 1e6; };
  Graph.prototype.toXY = function (lat, lon) { return [(lon - this.lon0) * this.kx, -(lat - this.lat0) * this.ky]; };
  Graph.prototype.xy = function (i) { return this.toXY(this.lat(i), this.lon(i)); };
  Graph.prototype.fromXY = function (x, y) { return [this.lat0 - y / this.ky, this.lon0 + x / this.kx]; };

  Graph.prototype.nearest = function (lat, lon, flag) {
    var p = this.toXY(lat, lon), cx = Math.floor(p[0] / this.cell), cy = Math.floor(p[1] / this.cell);
    var best = -1, bd = Infinity;
    for (var r = 0; r < 40; r++) {
      for (var dx = -r; dx <= r; dx++) for (var dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        var arr = this.grid.get((cx + dx) + ',' + (cy + dy)); if (!arr) continue;
        for (var j = 0; j < arr.length; j++) {
          var n = arr[j]; if (flag && !(this.nodeMask[n] & flag)) continue;
          var q = this.xy(n), d = (q[0] - p[0]) * (q[0] - p[0]) + (q[1] - p[1]) * (q[1] - p[1]);
          if (d < bd) { bd = d; best = n; }
        }
      }
      if (best >= 0 && Math.sqrt(bd) < r * this.cell) break;
    }
    return best < 0 ? null : { node: best, dist: Math.sqrt(bd) };
  };

  Graph.prototype.carSpeed = function (e) {
    return Math.max(5, this.eSpeed[e] * CLASS_FACTOR[this.eClass[e]]);
  };

  // Binäärikeko
  function Heap(cap) { this.k = new Float64Array(cap); this.v = new Int32Array(cap); this.n = 0; }
  Heap.prototype.push = function (key, val) {
    if (this.n >= this.k.length) { var k2 = new Float64Array(this.k.length * 2); k2.set(this.k); this.k = k2; var v2 = new Int32Array(this.v.length * 2); v2.set(this.v); this.v = v2; }
    var i = this.n++; var K = this.k, V = this.v;
    while (i > 0) { var p = (i - 1) >> 1; if (K[p] <= key) break; K[i] = K[p]; V[i] = V[p]; i = p; }
    K[i] = key; V[i] = val;
  };
  Heap.prototype.pop = function () {
    var K = this.k, V = this.v, top = V[0], last = --this.n, key = K[last], val = V[last], i = 0;
    while (true) { var l = 2 * i + 1; if (l >= last) break; var r = l + 1, c = (r < last && K[r] < K[l]) ? r : l; if (K[c] >= key) break; K[i] = K[c]; V[i] = V[c]; i = c; }
    K[i] = key; V[i] = val; return top;
  };

  Graph.prototype.route = function (src, dst, profileKey, modeKey) {
    var prof = PROFILES[profileKey], prio = MODES[modeKey] || MODES.nopein;
    var nN = this.nN, dist = new Float64Array(nN).fill(Infinity), via = new Int32Array(nN), done = new Uint8Array(nN);
    var vmaxMs = Math.min(prof.vmax, 120 * 0.92) / 3.6;
    var tlat = this.lat(dst), tlon = this.lon(dst), tp = this.toXY(tlat, tlon);
    var self = this;
    function h(n) { var q = self.xy(n); return Math.hypot(q[0] - tp[0], q[1] - tp[1]) / vmaxMs; }
    var heap = new Heap(1024); dist[src] = 0; heap.push(h(src), src);
    var settled = 0;
    while (heap.n) {
      var u = heap.pop(); if (done[u]) continue; done[u] = 1; settled++;
      if (u === dst) break;
      for (var a = this.adjStart[u], b = this.adjStart[u + 1]; a < b; a++) {
        var s = this.adj[a], fwd = s > 0, e = (fwd ? s : -s) - 1, fl = this.eFlags[e];
        if (!(fl & prof.flag)) continue;
        if (!(fl & (fwd ? F_FWD : F_BWD))) continue;
        var v = fwd ? this.eTo[e] : this.eFrom[e]; if (done[v]) continue;
        var spd = Math.min(this.carSpeed(e), prof.vmax * 0.93) / 3.6;
        var cost = this.eLen[e] / spd;
        var pr = prio(this.eSpeed[e]); if (fl & F_PRIV) pr *= 0.1;
        cost /= pr;
        var nd = dist[u] + cost;
        if (nd < dist[v]) { dist[v] = nd; via[v] = s; heap.push(nd + h(v), v); }
      }
    }
    if (!done[dst]) return null;
    var path = [], n = dst;
    while (n !== src) { var s2 = via[n], e2 = (s2 > 0 ? s2 : -s2) - 1; path.push(s2); n = s2 > 0 ? this.eFrom[e2] : this.eTo[e2]; }
    path.reverse();
    return this.describe(path, profileKey, src);
  };

  // Reitin tunnusluvut
  Graph.prototype.describe = function (path, profileKey, src) {
    var prof = PROFILES[profileKey], len = 0, time = 0, safeSum = 0, bySpeed = {}, warn = [], banned = { mop: 0, pol: 0 };
    for (var i = 0; i < path.length; i++) {
      var s = path[i], e = (s > 0 ? s : -s) - 1, L = this.eLen[e], sp = this.eSpeed[e], fl = this.eFlags[e];
      len += L; time += L / (Math.min(this.carSpeed(e), prof.vmax * 0.93) / 3.6);
      safeSum += L * safetyOf(sp);
      var cat = sp <= 50 ? '≤50' : sp <= 60 ? '60' : sp <= 80 ? '70–80' : '90+';
      bySpeed[cat] = (bySpeed[cat] || 0) + L;
      if (!(fl & F_MOP)) banned.mop += L;
      if (!(fl & F_POL)) banned.pol += L;
    }
    return { path: path, src: src, profile: profileKey, length: len, time: time, safety: len ? Math.round(safeSum / len) : 100,
      bySpeed: bySpeed, banned: banned, steps: this.steps(path, src) };
  };

  Graph.prototype.edgePoints = function (s) {
    var e = (s > 0 ? s : -s) - 1, pts = [this.xy(this.eFrom[e])];
    for (var g = this.eGeomStart[e], c = 0; c < this.eGeomCount[e]; c++, g++) pts.push(this.toXY(this.geom[2 * g] / 1e6, this.geom[2 * g + 1] / 1e6));
    pts.push(this.xy(this.eTo[e]));
    if (s < 0) pts.reverse();
    return pts;
  };

  function bearing(a, b) { return Math.atan2(b[0] - a[0], -(b[1] - a[1])) * 180 / Math.PI; }

  Graph.prototype.steps = function (path) {
    var out = [], cur = null;
    for (var i = 0; i < path.length; i++) {
      var s = path[i], e = (s > 0 ? s : -s) - 1, nm = this.eName[e], pts = this.edgePoints(s), rbt = !!(this.eFlags[e] & F_RBT);
      var name = nm >= 0 ? this.names[nm] : null;
      if (cur && (cur.name === name || (cur.rbt && rbt))) { cur.len += this.eLen[e]; cur.last = pts; cur.speed = Math.max(cur.speed, this.eSpeed[e]); continue; }
      var turn = 'start';
      if (cur) {
        var lp = cur.last, b1 = bearing(lp[lp.length - 2], lp[lp.length - 1]), b2 = bearing(pts[0], pts[1]);
        var d = ((b2 - b1 + 540) % 360) - 180;
        turn = rbt ? 'rbt' : d > 135 || d < -135 ? 'uturn' : d > 45 ? 'right' : d > 15 ? 'slight-right' : d < -45 ? 'left' : d < -15 ? 'slight-left' : 'straight';
      }
      cur = { name: name, len: this.eLen[e], turn: turn, last: pts, rbt: rbt, speed: this.eSpeed[e] };
      out.push(cur);
    }
    // Siisti: lyhyet pätkät (risteysalueet, liittymät) yhdistetään viereiseen ohjeeseen
    var merged = [];
    for (var j = 0; j < out.length; j++) {
      var st = { name: out[j].name, len: out[j].len, turn: out[j].turn, rbt: out[j].rbt, speed: out[j].speed };
      var prev = merged[merged.length - 1];
      var tiny = st.len < 40 || (!st.name && st.len < 80 && !st.rbt);
      if (prev && tiny) { prev.len += st.len; prev.speed = Math.max(prev.speed, st.speed); continue; }
      if (prev && prev.name && prev.name === st.name) { prev.len += st.len; prev.speed = Math.max(prev.speed, st.speed); continue; }
      merged.push(st);
    }
    // Ensimmäinen ohje: jos alku on lyhyt nimetön pätkä, aloitetaan seuraavasta nimetystä
    if (merged.length > 1 && (!merged[0].name || merged[0].len < 40) && merged[0].len < 150) {
      merged[1].len += merged[0].len; merged.shift();
    }
    if (merged.length) merged[0].turn = 'start';
    return merged;
  };

  var api = { Graph: Graph, PROFILES: PROFILES, MODES: MODES, CLASS_NAMES: CLASS_NAMES, safetyOf: safetyOf,
    F: { FWD: F_FWD, BWD: F_BWD, CAR: F_CAR, MOP: F_MOP, POL: F_POL, PRIV: F_PRIV, EST: F_EST, RBT: F_RBT } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Sideroad = api;
})(typeof window !== 'undefined' ? window : this);
