/* Sideroad web-sovellus: kartta, haku, reititys ja tulokset. */
(function () {
  'use strict';
  var S = window.Sideroad;
  var G = null, SEARCH = [], PLACES = [];
  var state = { a: null, b: null, vehicle: 'mopoauto', mode: 'suositeltu', results: null, car: null, showCar: true, active: null };
  var COLORS = { safe: '#1F8A5E', s60: '#E3A600', s80: '#E07B1F', s90: '#D63C3C', asf: '#0F1A21' };
  var $ = function (id) { return document.getElementById(id); };
  var VEH_ADE = { mopoauto: 'mopoautolla', polle: 'traktorimönkijällä', car: 'autolla' };
  var VEH_GEN = { mopoauto: 'Mopoauton', polle: 'Traktorimönkijän', car: 'Auton' };

  // ---------- Apurit ----------
  function fmtKm(m) { if (m < 950) return (Math.round(m / 10) * 10) + ' m'; return (m / 1000).toFixed(m < 10000 ? 1 : 0).replace('.', ',') + ' km'; }
  function fmtTime(s) { var m = Math.round(s / 60); if (m < 60) return Math.max(1, m) + ' min'; return Math.floor(m / 60) + ' h ' + String(m % 60).padStart(2, '0') + ' min'; }
  function scoreCls(v) { return v >= 80 ? 's-hi' : v >= 55 ? 's-mid' : 's-lo'; }
  function speedColor(sp) { return sp <= 50 ? COLORS.safe : sp <= 60 ? COLORS.s60 : sp <= 80 ? COLORS.s80 : COLORS.s90; }
  function norm(s) { return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function toast(msg) { var t = $('toast'); t.textContent = msg; t.style.display = 'block'; clearTimeout(toast.h); toast.h = setTimeout(function () { t.style.display = 'none'; }, 3500); }

  // ---------- Datan lataus ----------
  function b64ToBytes(b64) { var bin = atob(b64), out = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
  function inflate(bytes) {
    if (typeof DecompressionStream !== 'undefined') {
      var ds = new DecompressionStream('deflate');
      return new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer().then(function (b) { return new Uint8Array(b); });
    }
    return new Promise(function (res, rej) {
      var sc = document.createElement('script');
      sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/pako/2.1.0/pako.min.js';
      sc.onload = function () { res(window.pako.inflate(bytes)); }; sc.onerror = rej; document.head.appendChild(sc);
    });
  }
  Promise.all([fetch('graph.json').then(function (r) { return r.json(); }), fetch('search.json').then(function (r) { return r.json(); })])
    .then(function (res) {
      var g = res[0]; SEARCH = res[1]; PLACES = g.places || [];
      SEARCH.forEach(function (s) { s.k = norm(s.n); });
      return inflate(b64ToBytes(g.data)).then(function (raw) { G = new S.Graph(raw, g.names); });
    })
    .then(function () { buildLayers(); fitBounds(); $('loading').style.display = 'none'; draw(); })
    .catch(function (err) { $('loadmsg').textContent = 'Lataus epäonnistui: ' + err.message; });

  // ---------- Kartta ----------
  var cv = $('map'), ctx = cv.getContext('2d'), dpr = 1, W = 0, H = 0;
  var view = { cx: 0, cy: 0, s: 0.02, rot: 0 }; // s = px / m, rot = kartan kierto (rad, ajosuunta ylös)
  var layers = null, DR = null;
  function resize() {
    dpr = window.devicePixelRatio || 1; var r = cv.getBoundingClientRect(); W = r.width; H = r.height;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); draw();
  }
  window.addEventListener('resize', resize);

  function buildLayers() {
    var tiers = { minor: new Path2D(), mid: new Path2D(), major: new Path2D(), motor: new Path2D(), banMop: new Path2D(), banPol: new Path2D() };
    for (var e = 0; e < G.nE; e++) {
      var c = G.eClass[e], fl = G.eFlags[e];
      var t = c <= 1 ? 'motor' : c <= 5 ? 'major' : c <= 9 ? 'mid' : 'minor';
      var pts = G.edgePoints(e + 1), p = tiers[t];
      p.moveTo(pts[0][0], pts[0][1]); for (var i = 1; i < pts.length; i++) p.lineTo(pts[i][0], pts[i][1]);
      if (!(fl & S.F.MOP)) { tiers.banMop.moveTo(pts[0][0], pts[0][1]); for (i = 1; i < pts.length; i++) tiers.banMop.lineTo(pts[i][0], pts[i][1]); }
      if (!(fl & S.F.POL)) { tiers.banPol.moveTo(pts[0][0], pts[0][1]); for (i = 1; i < pts.length; i++) tiers.banPol.lineTo(pts[i][0], pts[i][1]); }
    }
    layers = tiers;
    // Ajonäkymää varten: kaarien pisteet yhtenä taulukkona ja ruudukkoindeksi
    var tot = 0; for (e = 0; e < G.nE; e++) tot += G.eGeomCount[e] + 2;
    var EX = new Float32Array(tot * 2), EO = new Uint32Array(G.nE), EC = new Uint16Array(G.nE), k = 0, grid = new Map(), CELL = 300;
    for (e = 0; e < G.nE; e++) {
      var q = G.edgePoints(e + 1), x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      EO[e] = k; EC[e] = q.length;
      for (i = 0; i < q.length; i++) { EX[2 * k] = q[i][0]; EX[2 * k + 1] = q[i][1]; k++; x0 = Math.min(x0, q[i][0]); x1 = Math.max(x1, q[i][0]); y0 = Math.min(y0, q[i][1]); y1 = Math.max(y1, q[i][1]); }
      for (var gx = Math.floor(x0 / CELL); gx <= Math.floor(x1 / CELL); gx++) for (var gy = Math.floor(y0 / CELL); gy <= Math.floor(y1 / CELL); gy++) {
        var key = gx + ',' + gy, arr = grid.get(key); if (!arr) { arr = []; grid.set(key, arr); } arr.push(e);
      }
    }
    DR = { EX: EX, EO: EO, EC: EC, grid: grid, CELL: CELL, stamp: new Uint32Array(G.nE), frame: 0 };
  }
  function fitBounds(pts) {
    var minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity, i;
    if (!pts) { pts = []; for (i = 0; i < G.nN; i += 7) pts.push(G.xy(i)); }
    pts.forEach(function (p) { minx = Math.min(minx, p[0]); maxx = Math.max(maxx, p[0]); miny = Math.min(miny, p[1]); maxy = Math.max(maxy, p[1]); });
    var r = cv.getBoundingClientRect(); W = r.width; H = r.height;
    view.cx = (minx + maxx) / 2; view.cy = (miny + maxy) / 2; view.rot = 0;
    view.s = Math.min(W / Math.max(200, (maxx - minx) * 1.15), H / Math.max(200, (maxy - miny) * 1.15));
    view.s = Math.max(0.003, Math.min(view.s, 2));
  }
  // Ankkuri: ajotilassa oma sijainti on ruudun alaosassa, jotta edessä oleva tie näkyy
  function ancX() { return W / 2; }
  function ancY() { return D.on && !D.overview ? H * 0.68 : H / 2; }
  function w2s(x, y) {
    var dx = (x - view.cx) * view.s, dy = (y - view.cy) * view.s, c = Math.cos(view.rot), sn = Math.sin(view.rot);
    return [dx * c + dy * sn + ancX(), -dx * sn + dy * c + ancY()];
  }
  function s2w(px, py) {
    var dx = px - ancX(), dy = py - ancY(), c = Math.cos(view.rot), sn = Math.sin(view.rot);
    return [(dx * c - dy * sn) / view.s + view.cx, (dx * sn + dy * c) / view.s + view.cy];
  }

  function strokeLayer(path, color, px) { ctx.strokeStyle = color; ctx.lineWidth = px / view.s; ctx.stroke(path); }
  function polyline(pts, color, px, dash) {
    ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.strokeStyle = color; ctx.lineWidth = px / view.s; ctx.setLineDash(dash ? dash.map(function (d) { return d / view.s; }) : []); ctx.stroke(); ctx.setLineDash([]);
  }
  function routePts(r) { var all = []; r.path.forEach(function (s) { var p = G.edgePoints(s); for (var i = all.length ? 1 : 0; i < p.length; i++) all.push(p[i]); }); return all; }

  var raf = 0;
  function draw() { if (!raf) raf = requestAnimationFrame(render); }
  function render() {
    raf = 0; if (!W) { var r = cv.getBoundingClientRect(); W = r.width; H = r.height; }
    if (D.on && G && DR) { renderDrive(); return; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = '#E4EAE7'; ctx.fillRect(0, 0, W, H);
    if (!G || !layers) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.translate(ancX(), ancY()); ctx.rotate(-view.rot);
    ctx.scale(view.s, view.s); ctx.translate(-view.cx, -view.cy);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    var z = view.s;
    if (z > 0.012) strokeLayer(layers.minor, '#FFFFFF', z > 0.15 ? 4 : z > 0.05 ? 2 : 1);
    strokeLayer(layers.mid, '#FFFFFF', z > 0.05 ? 5 : 2);
    strokeLayer(layers.major, '#F7D58A', z > 0.05 ? 6 : 3);
    strokeLayer(layers.motor, '#E9A27E', z > 0.05 ? 7 : 3.5);
    if (state.vehicle !== 'car') {
      var ban = state.vehicle === 'polle' ? layers.banPol : layers.banMop;
      ctx.setLineDash([3 / z, 4 / z]); strokeLayer(ban, 'rgba(214,60,60,.75)', z > 0.05 ? 3 : 1.6); ctx.setLineDash([]);
    }

    // Autoreitti vertailuna
    if (state.showCar && state.car && state.vehicle !== 'car') {
      polyline(routePts(state.car), 'rgba(15,26,33,.55)', 3, [6, 6]);
      var fl = state.vehicle === 'polle' ? S.F.POL : S.F.MOP;
      state.car.path.forEach(function (s) { var e = (s > 0 ? s : -s) - 1; if (!(G.eFlags[e] & fl)) polyline(G.edgePoints(s), COLORS.s90, 5); });
    }
    // Vaihtoehtoiset reitit ohuina, valittu värikoodattuna
    if (state.results) {
      ['suositeltu', 'nopein', 'turvallisin'].forEach(function (m) { if (m !== state.mode && state.results[m]) polyline(routePts(state.results[m]), 'rgba(15,26,33,.28)', 5); });
      var r = state.results[state.mode];
      if (r) {
        polyline(routePts(r), COLORS.asf, 9);
        r.path.forEach(function (s) { var e = (s > 0 ? s : -s) - 1; polyline(G.edgePoints(s), speedColor(G.eSpeed[e]), 5.5); });
      }
    }
    // Nimet
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    var maxRank = z > 0.06 ? 4 : z > 0.025 ? 2 : z > 0.008 ? 1 : 0, placed = [];
    [state.a, state.b].forEach(function (m) { if (m) { var mx = G.xy(m.node); placed.push(w2s(mx[0], mx[1])); } });
    PLACES.forEach(function (p) {
      if (p.r > maxRank) return;
      var xy = G.toXY(p.lat, p.lon), sp = w2s(xy[0], xy[1]);
      if (sp[0] < -50 || sp[1] < -20 || sp[0] > W + 50 || sp[1] > H + 20) return;
      for (var i = 0; i < placed.length; i++) if (Math.abs(placed[i][0] - sp[0]) < 90 && Math.abs(placed[i][1] - sp[1]) < 22) return;
      placed.push(sp);
      ctx.font = (p.r <= 1 ? '600 15px' : '500 12px') + " Figtree, sans-serif";
      ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.strokeText(p.n, sp[0], sp[1]);
      ctx.fillStyle = p.r <= 1 ? '#0F1A21' : '#3F4E54'; ctx.fillText(p.n, sp[0], sp[1]);
    });
    // Oma sijainti
    if (D.on && D.pos && D.disp) {
      var ps = w2s(D.disp[0], D.disp[1]);
      ctx.beginPath(); ctx.arc(ps[0], ps[1], Math.max(12, D.pos.acc * view.s), 0, Math.PI * 2); ctx.fillStyle = 'rgba(37,99,235,.15)'; ctx.fill();
      if (D.head !== null) {
        ctx.save(); ctx.translate(ps[0], ps[1]); ctx.rotate(D.headDisp - view.rot);
        ctx.beginPath(); ctx.moveTo(0, -17); ctx.lineTo(9, 7); ctx.lineTo(0, 3); ctx.lineTo(-9, 7); ctx.closePath();
        ctx.fillStyle = '#2563EB'; ctx.fill(); ctx.lineWidth = 2.5; ctx.strokeStyle = '#fff'; ctx.stroke(); ctx.restore();
      } else {
        ctx.beginPath(); ctx.arc(ps[0], ps[1], 9, 0, Math.PI * 2); ctx.fillStyle = '#2563EB'; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = '#fff'; ctx.stroke();
      }
    }
    // Merkit
    [['a', state.a], ['b', state.b]].forEach(function (m) {
      if (!m[1]) return; var xy = G.xy(m[1].node), sp = w2s(xy[0], xy[1]);
      ctx.beginPath();
      if (m[0] === 'a') { ctx.arc(sp[0], sp[1], 9, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); ctx.lineWidth = 4; ctx.strokeStyle = COLORS.asf; ctx.stroke(); }
      else { ctx.rect(sp[0] - 10, sp[1] - 10, 20, 20); ctx.fillStyle = '#FFC21A'; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = COLORS.asf; ctx.stroke(); }
    });
  }

  // ---------- Ajonäkymä: tumma kartta ja 3D-perspektiivi ----------
  var DT = { bg: '#0E3A4A', casing: '#2B3866', minor: '#5A6A9E', mid: '#7181BA', major: '#8A99D3', motor: '#A2AEE2', ban: 'rgba(242,139,130,.9)',
    routeCase: '#08778C', route: '#22D3EE', routeFast: '#FDBA4D', label: '#E8EAED' };
  var TIER_W = [5.5, 7.5, 9.5, 11.5]; // tien leveys metreinä: pienet, keskisuuret, pääteiden, moottoriteiden
  function renderDrive() {
    var tilt = D.overview ? 0 : 0.87, P = H * 1.1, cT = Math.cos(tilt), sT = Math.sin(tilt);
    var ax = ancX(), ay = ancY(), s = view.s, cr = Math.cos(view.rot), sr = Math.sin(view.rot), cx = view.cx, cy = view.cy;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = DT.bg; ctx.fillRect(0, 0, W, H);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    var out = [0, 0, 0];
    function proj(x, y) {
      var dx = x - cx, dy = y - cy, X = (dx * cr + dy * sr) * s, Y = (-dx * sr + dy * cr) * s;
      var den = P - Y * sT; if (den < P * 0.3) return false;
      var k = P / den; out[0] = ax + X * k; out[1] = ay + Y * cT * k; out[2] = k; return true;
    }
    // Näkyvät kaaret ruudukosta
    var R = D.overview ? Math.hypot(W, H) / s : Math.min(4000, Math.max(900, 2.6 * H / s));
    var C = DR.CELL, g0x = Math.floor((cx - R) / C), g1x = Math.floor((cx + R) / C), g0y = Math.floor((cy - R) / C), g1y = Math.floor((cy + R) / C);
    var fr = ++DR.frame, edges = [];
    for (var gx = g0x; gx <= g1x; gx++) for (var gy = g0y; gy <= g1y; gy++) {
      var arr = DR.grid.get(gx + ',' + gy); if (!arr) continue;
      for (var j = 0; j < arr.length; j++) { var e = arr[j]; if (DR.stamp[e] !== fr) { DR.stamp[e] = fr; edges.push(e); } }
    }
    // Tiet: tasot × syvyysluokat, ensin reunus, sitten täyttö
    var NB = 5, BK = [0.35, 0.55, 0.8, 1.1, 1.5];
    var paths = [], banP = new Path2D(), banFlag = state.vehicle === 'polle' ? S.F.POL : S.F.MOP, showBan = state.vehicle !== 'car';
    for (var t = 0; t < 4; t++) { paths.push([]); for (var b = 0; b < NB; b++) paths[t].push(new Path2D()); }
    var EX = DR.EX;
    for (var n = 0; n < edges.length; n++) {
      var ed = edges[n], c = G.eClass[ed], tier = c <= 1 ? 3 : c <= 5 ? 2 : c <= 9 ? 1 : 0;
      var o = DR.EO[ed], m = DR.EC[ed], started = false, kSum = 0, kN = 0, pth = null, segs = [];
      for (var q = 0; q < m; q++) {
        if (proj(EX[2 * (o + q)], EX[2 * (o + q) + 1])) { segs.push(out[0], out[1], started ? 1 : 0); kSum += out[2]; kN++; started = true; }
        else started = false;
      }
      if (kN < 2) continue;
      var kk = kSum / kN, bi = kk < 0.45 ? 0 : kk < 0.67 ? 1 : kk < 0.95 ? 2 : kk < 1.3 ? 3 : 4;
      pth = paths[tier][bi];
      var ban = showBan && !(G.eFlags[ed] & banFlag);
      for (var z = 0; z < segs.length; z += 3) {
        if (segs[z + 2]) { pth.lineTo(segs[z], segs[z + 1]); if (ban) banP.lineTo(segs[z], segs[z + 1]); }
        else { pth.moveTo(segs[z], segs[z + 1]); if (ban) banP.moveTo(segs[z], segs[z + 1]); }
      }
    }
    var cols = [DT.minor, DT.mid, DT.major, DT.motor];
    for (t = 0; t < 4; t++) for (b = 0; b < NB; b++) {
      var wpx = Math.max(1.2, TIER_W[t] * s * BK[b]);
      ctx.strokeStyle = DT.casing; ctx.lineWidth = wpx + 3; ctx.stroke(paths[t][b]);
    }
    for (t = 0; t < 4; t++) for (b = 0; b < NB; b++) {
      ctx.strokeStyle = cols[t]; ctx.lineWidth = Math.max(1.2, TIER_W[t] * s * BK[b]); ctx.stroke(paths[t][b]);
    }
    if (showBan) { ctx.strokeStyle = DT.ban; ctx.lineWidth = 2.5; ctx.setLineDash([7, 6]); ctx.stroke(banP); ctx.setLineDash([]); }

    // Reitti: vain jäljellä oleva osuus, paksuus syvyyden mukaan
    if (D.pts) {
      var P2 = D.pts, from = Math.max(0, D.last - 1), seg = [];
      for (var ri = from; ri < P2.length; ri++) {
        if (proj(P2[ri].x, P2[ri].y)) seg.push([out[0], out[1], out[2], G.eSpeed[P2[ri].e]]); else seg.push(null);
      }
      // ensimmäinen piste kiinni omaan sijaintiin, jotta reitti alkaa nuolesta
      if (D.disp && D.follow && seg.length && seg[0] && proj(D.disp[0], D.disp[1])) seg[0] = [out[0], out[1], out[2], seg[0][3]];
      for (var pass = 0; pass < 2; pass++) {
        for (ri = 1; ri < seg.length; ri++) {
          var A = seg[ri - 1], B = seg[ri]; if (!A || !B) continue;
          var w = Math.max(4, 13 * s * (A[2] + B[2]) / 2);
          ctx.beginPath(); ctx.moveTo(A[0], A[1]); ctx.lineTo(B[0], B[1]);
          if (pass === 0) { ctx.strokeStyle = DT.routeCase; ctx.lineWidth = w + 5; }
          else { ctx.strokeStyle = B[3] >= 70 && state.vehicle !== 'car' ? DT.routeFast : DT.route; ctx.lineWidth = w; }
          ctx.stroke();
        }
      }
    }
    // Usva horisontissa
    if (tilt > 0) {
      var gr = ctx.createLinearGradient(0, 0, 0, H * 0.34);
      gr.addColorStop(0, 'rgba(14,58,74,1)'); gr.addColorStop(0.45, 'rgba(14,58,74,.85)'); gr.addColorStop(1, 'rgba(14,58,74,0)');
      ctx.fillStyle = gr; ctx.fillRect(0, 0, W, H * 0.34);
    }
    // Paikannimet
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    var maxR = s > 0.6 ? 4 : s > 0.25 ? 3 : 2, placed = [];
    PLACES.forEach(function (p) {
      if (p.r > maxR) return;
      var xy = G.toXY(p.lat, p.lon); if (Math.abs(xy[0] - cx) > R || Math.abs(xy[1] - cy) > R) return;
      if (!proj(xy[0], xy[1])) return;
      var px = out[0], py = out[1], k = out[2];
      if (py < H * 0.2 || py > H - 140 || px < 10 || px > W - 10) return;
      for (var i = 0; i < placed.length; i++) if (Math.abs(placed[i][0] - px) < 100 && Math.abs(placed[i][1] - py) < 24) return;
      placed.push([px, py]);
      ctx.font = '500 ' + Math.round(Math.max(11, Math.min(16, 14 * k))) + 'px Figtree, sans-serif';
      ctx.lineWidth = 3.5; ctx.strokeStyle = 'rgba(14,58,74,.95)'; ctx.strokeText(p.n, px, py);
      ctx.fillStyle = DT.label; ctx.fillText(p.n, px, py);
    });
    // Määränpää (punainen nuppineula)
    if (state.b) {
      var bx = G.xy(state.b.node);
      if (proj(bx[0], bx[1]) && out[1] > 0) {
        var X0 = out[0], Y0 = out[1];
        ctx.beginPath(); ctx.arc(X0, Y0, 7, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = '#111'; ctx.stroke();
        ctx.beginPath(); ctx.moveTo(X0, Y0 - 6); ctx.bezierCurveTo(X0 - 16, Y0 - 26, X0 - 13, Y0 - 44, X0, Y0 - 44); ctx.bezierCurveTo(X0 + 13, Y0 - 44, X0 + 16, Y0 - 26, X0, Y0 - 6);
        ctx.fillStyle = '#EA4335'; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = '#A50E0E'; ctx.stroke();
        ctx.beginPath(); ctx.arc(X0, Y0 - 31, 5, 0, Math.PI * 2); ctx.fillStyle = '#A50E0E'; ctx.fill();
      }
    }
    // Oma ajoneuvo
    if (D.disp && proj(D.disp[0], D.disp[1])) drawCar(out[0], out[1], D.head === null ? 0 : D.headDisp - view.rot, tilt > 0 ? 0.78 : 1);
  }
  function drawCar(x, y, ang, squash) {
    var g = ctx.createRadialGradient(x, y, 4, x, y, 42); g.addColorStop(0, 'rgba(66,133,244,.45)'); g.addColorStop(1, 'rgba(66,133,244,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(x, y, 42, 42 * squash, 0, 0, Math.PI * 2); ctx.fill();
    ctx.save(); ctx.translate(x, y); ctx.scale(1, squash); ctx.rotate(ang);
    function rr(x0, y0, w, h, r) { ctx.beginPath(); ctx.moveTo(x0 + r, y0); ctx.arcTo(x0 + w, y0, x0 + w, y0 + h, r); ctx.arcTo(x0 + w, y0 + h, x0, y0 + h, r); ctx.arcTo(x0, y0 + h, x0, y0, r); ctx.arcTo(x0, y0, x0 + w, y0, r); ctx.closePath(); }
    ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = 8; ctx.shadowOffsetY = 3;
    rr(-14, -24, 28, 48, 10); ctx.fillStyle = '#E8EAED'; ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#9AA0A6'; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-11, -9); ctx.lineTo(11, -9); ctx.lineTo(9, -16); ctx.lineTo(-9, -16); ctx.closePath(); ctx.fillStyle = '#1F3A68'; ctx.fill();   // tuulilasi
    rr(-10, -7, 20, 20, 4); ctx.fillStyle = '#FFFFFF'; ctx.fill();                                                                                            // katto
    ctx.beginPath(); ctx.moveTo(-10, 15); ctx.lineTo(10, 15); ctx.lineTo(8, 20); ctx.lineTo(-8, 20); ctx.closePath(); ctx.fillStyle = '#1F3A68'; ctx.fill();   // takalasi
    ctx.fillStyle = '#FFC21A'; ctx.fillRect(-12, -23, 6, 3); ctx.fillRect(6, -23, 6, 3);                                                                      // valot
    ctx.fillStyle = '#EA4335'; ctx.fillRect(-12, 21, 5, 2.5); ctx.fillRect(7, 21, 5, 2.5);
    ctx.restore();
  }

  // Panorointi, zoomaus, napautus
  var ptrs = new Map(), drag = null, moved = 0;
  cv.addEventListener('pointerdown', function (e) {
    cv.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, [e.offsetX, e.offsetY]);
    if (ptrs.size === 1) { drag = { x: e.offsetX, y: e.offsetY, cx: view.cx, cy: view.cy }; moved = 0; cv.classList.add('drag'); }
    else if (ptrs.size === 2) { var p = Array.from(ptrs.values()); drag = { pinch: Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]), s: view.s, mid: [(p[0][0] + p[1][0]) / 2, (p[0][1] + p[1][1]) / 2] }; moved = 99; }
  });
  cv.addEventListener('pointermove', function (e) {
    if (!ptrs.has(e.pointerId) || !drag) return; ptrs.set(e.pointerId, [e.offsetX, e.offsetY]);
    if (drag.pinch && ptrs.size === 2) {
      var p = Array.from(ptrs.values()), d = Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]);
      zoomAt(drag.mid[0], drag.mid[1], (drag.s * d / drag.pinch) / view.s);
    } else if (!drag.pinch) {
      var dx = e.offsetX - drag.x, dy = e.offsetY - drag.y; moved = Math.max(moved, Math.abs(dx) + Math.abs(dy));
      if (moved > 6 && D.on && D.follow) { D.follow = false; setRecenter(); }
      var c = Math.cos(view.rot), sn = Math.sin(view.rot);
      view.cx = drag.cx - (dx * c - dy * sn) / view.s; view.cy = drag.cy - (dx * sn + dy * c) / view.s; draw();
    }
  });
  function endPtr(e) {
    var wasTap = ptrs.size === 1 && moved < 6 && drag && !drag.pinch;
    ptrs.delete(e.pointerId); cv.classList.remove('drag');
    if (wasTap && e.type === 'pointerup') tapAt(e.offsetX, e.offsetY);
    if (ptrs.size === 0) drag = null;
    else if (ptrs.size === 1) { var p = Array.from(ptrs.values())[0]; drag = { x: p[0], y: p[1], cx: view.cx, cy: view.cy }; }
  }
  cv.addEventListener('pointerup', endPtr); cv.addEventListener('pointercancel', endPtr);
  cv.addEventListener('wheel', function (e) { e.preventDefault(); zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * 0.0015)); }, { passive: false });
  function zoomAt(px, py, f) {
    var w = s2w(px, py); view.s = Math.max(0.003, Math.min(view.s * f, 3));
    if (D.on && !D.overview) { D.userZoom = true; if (D.follow) { draw(); return; } }
    var dx = px - ancX(), dy = py - ancY(), c = Math.cos(view.rot), sn = Math.sin(view.rot);
    view.cx = w[0] - (dx * c - dy * sn) / view.s; view.cy = w[1] - (dx * sn + dy * c) / view.s; draw();
  }
  $('zin').onclick = function () { zoomAt(W / 2, H / 2, 1.6); };
  $('zout').onclick = function () { zoomAt(W / 2, H / 2, 1 / 1.6); };
  $('zfit').onclick = function () { if (D.on) D.follow = false; fitRoute(); };
  function fitRoute() {
    if (!G) return;
    var r = state.results && state.results[state.mode];
    var pts = [state.a, state.b].filter(Boolean);
    if (r) fitBounds(routePts(r));
    else if (pts.length === 2) fitBounds(pts.map(function (p) { return G.xy(p.node); }));
    else if (pts.length === 1) { var xy = G.xy(pts[0].node); view.cx = xy[0]; view.cy = xy[1]; view.s = Math.max(view.s, 0.06); }
    else fitBounds();
    draw();
  }

  function nodeLabel(n) {
    for (var a = G.adjStart[n]; a < G.adjStart[n + 1]; a++) { var s = G.adj[a], e = (s > 0 ? s : -s) - 1; if (G.eName[e] >= 0 && !G.names[G.eName[e]].startsWith('Tie ')) return G.names[G.eName[e]]; }
    for (a = G.adjStart[n]; a < G.adjStart[n + 1]; a++) { s = G.adj[a]; e = (s > 0 ? s : -s) - 1; if (G.eName[e] >= 0) return G.names[G.eName[e]]; }
    return 'Karttapiste';
  }
  function tapAt(px, py) {
    if (!G || D.on) return;
    var w = s2w(px, py), ll = G.fromXY(w[0], w[1]);
    var which = state.active || (!state.a ? 'a' : 'b');
    setPoint(which, ll[0], ll[1], null);
    state.active = null;
  }

  // ---------- Pisteet ja haku ----------
  function profFlag() { return S.PROFILES[state.vehicle].flag; }
  function setPoint(which, lat, lon, label) {
    var sn = G.nearest(lat, lon, profFlag());
    if (!sn) { toast('Tältä kohdalta ei löytynyt ajettavaa tietä.'); return; }
    if (sn.dist > 1500) toast('Lähin ajettava tie on ' + fmtKm(sn.dist) + ' päässä.');
    state[which] = { node: sn.node, lat: lat, lon: lon, label: label || nodeLabel(sn.node) };
    $(which === 'a' ? 'inA' : 'inB').value = state[which].label;
    compute();
  }

  // "Suutarintie 7, Naantali" -> { main: "suutarintie", num: "7", muni: "naantali" }
  var MUNIS = null, lastHouseNo = null;
  function parseQuery(v) {
    if (!MUNIS) MUNIS = PLACES.filter(function (p) { return p.r <= 1; }).map(function (p) { return norm(p.n); });
    var parts = norm(v.trim()).split(','), main = parts[0].trim(), muni = (parts[1] || '').trim(), num = null;
    if (!muni) {
      var words = main.split(/\s+/), last = words[words.length - 1];
      if (words.length > 1 && MUNIS.indexOf(last) >= 0) { muni = last; main = words.slice(0, -1).join(' '); }
    }
    var m = main.match(/^(.*?\D)\s*(\d+\s*[a-z]?(\s*[a-z]?\s*\d+)?)$/);
    if (m && m[1].trim().length >= 2) { main = m[1].trim(); num = m[2].replace(/\s+/g, ' ').trim(); }
    return { main: main, num: num, muni: muni };
  }

  function setupSearch(inputId, listId, which) {
    var inp = $(inputId), list = $(listId), items = [], act = -1;
    function close() { list.style.display = 'none'; act = -1; }
    function render() {
      list.innerHTML = items.map(function (s, i) { return '<button type="button" role="option" data-i="' + i + '"' + (i === act ? ' class="act"' : '') + '>' + esc(s.n) + '<small>' + esc(s.s) + '</small></button>'; }).join('');
      list.style.display = items.length ? 'block' : 'none';
    }
    function pick(i) {
      var s = items[i]; if (!s) return; close();
      var label = s.n + (s.t === 's' && lastHouseNo ? ' ' + lastHouseNo : '');
      setPoint(which, s.lat, s.lon, label); inp.blur();
      if (s.t === 's' && lastHouseNo) toast('Talonumerot eivät ole vielä mukana. Merkki on kadun keskellä, siirrä sitä napauttamalla karttaa tarvittaessa.');
    }
    inp.addEventListener('focus', function () { state.active = which; if (inp.value && state[which] && inp.value === state[which].label) inp.select(); });
    inp.addEventListener('input', function () {
      var pq = parseQuery(inp.value), q = pq.main; act = -1; lastHouseNo = pq.num;
      if (q.length < 2) { items = []; render(); return; }
      var starts = [], wordStarts = [], incl = [];
      for (var i = 0; i < SEARCH.length && starts.length < 60; i++) {
        var s = SEARCH[i], k = s.k;
        if (k.startsWith(q)) starts.push(s); else if (k.indexOf(' ' + q) >= 0) wordStarts.push(s); else if (k.indexOf(q) >= 0) incl.push(s);
      }
      var rank = { p: 0, k: 1, s: 2 };
      starts.sort(function (a, b) { return rank[a.t] - rank[b.t] || a.n.length - b.n.length; });
      var all = starts.concat(wordStarts, incl);
      if (pq.muni) {
        var inMuni = all.filter(function (s) { return norm(s.s).indexOf(pq.muni) >= 0 || s.k.indexOf(pq.muni) >= 0; });
        if (inMuni.length) all = inMuni;
      }
      items = all.slice(0, 8); render();
    });
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { act = Math.min(items.length - 1, act + 1); render(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { act = Math.max(0, act - 1); render(); e.preventDefault(); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        if (items.length) pick(act >= 0 ? act : 0);
        else if (inp.value.trim().length >= 2) toast('Ei osumia Turun seudulta. Kokeile kadun nimeä tai napauta karttaa.');
      }
      else if (e.key === 'Escape') close();
    });
    list.addEventListener('mousedown', function (e) { e.preventDefault(); });
    list.addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) pick(+b.dataset.i); });
    inp.addEventListener('blur', function () { setTimeout(close, 150); });
  }
  setupSearch('inA', 'sgA', 'a'); setupSearch('inB', 'sgB', 'b');
  $('swap').onclick = function () { var t = state.a; state.a = state.b; state.b = t; $('inA').value = state.a ? state.a.label : ''; $('inB').value = state.b ? state.b.label : ''; compute(); };

  Array.prototype.forEach.call(document.querySelectorAll('#veh button'), function (b) {
    b.onclick = function () {
      state.vehicle = b.dataset.v;
      document.querySelectorAll('#veh button').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      if (G) { ['a', 'b'].forEach(function (w) { if (state[w]) { var p = state[w]; var sn = G.nearest(p.lat, p.lon, profFlag()); if (sn) p.node = sn.node; } }); }
      compute();
    };
  });

  // ---------- Reititys ja tulokset ----------
  function compute() {
    draw();
    if (!G || !state.a || !state.b) { renderResults(); return; }
    if (state.a.node === state.b.node) { state.results = null; state.car = null; renderResults('Lähtö ja määränpää ovat samassa kohdassa.'); return; }
    $('results').innerHTML = '<p class="empty">Lasketaan reittiä…</p>';
    setTimeout(function () {
      var res = {};
      ['suositeltu', 'nopein', 'turvallisin'].forEach(function (m) {
        // Autolla suositeltu = nopein, joten nopeinta ei näytetä erikseen
        if (state.vehicle === 'car' && m === 'nopein') return;
        res[m] = G.route(state.a.node, state.b.node, state.vehicle, state.vehicle === 'car' && m === 'suositeltu' ? 'nopein' : m);
      });
      if (state.vehicle === 'car' && state.mode === 'nopein') state.mode = 'suositeltu';
      var ca = G.nearest(state.a.lat, state.a.lon, S.F.CAR), cb = G.nearest(state.b.lat, state.b.lon, S.F.CAR);
      state.car = ca && cb ? G.route(ca.node, cb.node, 'car', 'nopein') : null;
      state.results = res.suositeltu ? res : null;
      renderResults(state.results ? null : 'Sallittua reittiä ei löytynyt. Määränpää voi olla tien varrella, jolla ' + VEH_ADE[state.vehicle] + ' ei saa ajaa.');
      fitRoute();
    }, 20);
  }

  var TURN = {
    start: ['Lähde', 'M12 20V5M6 11l6-6 6 6'], straight: ['Jatka suoraan', 'M12 20V4M6 10l6-6 6 6'],
    right: ['Käänny oikealle', 'M7 20v-8a4 4 0 0 1 4-4h8M15 4l4 4-4 4'], left: ['Käänny vasemmalle', 'M17 20v-8a4 4 0 0 0-4-4H5M9 4 5 8l4 4'],
    'slight-right': ['Kaarra oikealle', 'M8 20v-6l8-8M10 6h6v6'], 'slight-left': ['Kaarra vasemmalle', 'M16 20v-6L8 6M14 6H8v6'],
    uturn: ['Käänny ympäri', 'M8 20V9a4 4 0 0 1 8 0v4M12 10l4 4 4-4'], rbt: ['Aja liikenneympyrään', 'M12 20v-5M12 15a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM16 11h4']
  };
  function icon(d, color, size) { size = size || 20; return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="' + (color || '#0F1A21') + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + d + '"/></svg>'; }

  function renderResults(msg) {
    var box = $('results');
    if (msg) { box.innerHTML = '<p class="empty">' + esc(msg) + '</p>'; return; }
    if (!state.results) { box.innerHTML = '<p class="empty">Valitse lähtö ja määränpää. Näytämme reitin, jota saat ajaa, ja kerromme kuinka turvallinen se on.</p>'; return; }
    var R = state.results, labels = { suositeltu: 'Suositeltu', nopein: 'Nopein', turvallisin: 'Turvallisin' };
    var html = '<p class="lbl">Reittivaihtoehdot</p><div class="opts">';
    ['suositeltu', 'nopein', 'turvallisin'].forEach(function (m) {
      var r = R[m]; if (!r) return;
      html += '<button type="button" class="opt" data-m="' + m + '" aria-pressed="' + (m === state.mode) + '"><span class="t">' + labels[m] + ' · ' + fmtTime(r.time) + '</span>' +
        '<span class="score ' + scoreCls(r.safety) + '">' + r.safety + '<small>SAFETY</small></span><span class="m">' + fmtKm(r.length) + '</span></button>';
    });
    html += '</div>';
    html += '<button type="button" class="go" id="startdrive"><svg width="22" height="22" viewBox="0 0 24 24" fill="#0F1A21" aria-hidden="true"><path d="M12 2 4 21l8-4 8 4z"/></svg>Aloita ajo</button>';
    var r = R[state.mode];
    // Nopeusjakauma
    var cats = [['≤50', '≤ 50 km/h', COLORS.safe], ['60', '60 km/h', COLORS.s60], ['70–80', '70–80 km/h', COLORS.s80], ['90+', '90+ km/h', COLORS.s90]];
    html += '<div class="bar" role="img" aria-label="Reitin jakauma nopeusrajoituksen mukaan">';
    cats.forEach(function (c) { var v = r.bySpeed[c[0]] || 0; if (v) html += '<span style="width:' + (100 * v / r.length) + '%;background:' + c[2] + '"></span>'; });
    html += '</div><div class="legend">';
    cats.forEach(function (c) { var v = r.bySpeed[c[0]] || 0; if (v) html += '<span><i style="background:' + c[2] + '"></i>' + c[1] + ' ' + fmtKm(v) + '</span>'; });
    html += '</div>';
    var fast = (r.bySpeed['70–80'] || 0) + (r.bySpeed['90+'] || 0);
    if (fast > 300 && state.vehicle !== 'car') html += '<div class="note warn">Reitillä on ' + fmtKm(fast) + ' teillä, joilla autot ajavat 70 km/h tai lujempaa. Pysy oikeassa reunassa ja päästä jono ohi.</div>';
    // Vertailu autoreittiin
    var veh = VEH_ADE[state.vehicle];
    if (state.car && state.vehicle !== 'car') {
      var bannedKm = state.vehicle === 'polle' ? state.car.banned.pol : state.car.banned.mop;
      if (bannedKm > 50) html += '<div class="note car">Autoreitti (' + fmtTime(state.car.time) + ') kulkee <b>' + fmtKm(bannedKm) + '</b> teillä, joilla ' + veh + ' ei saa ajaa. Ne näkyvät kartalla punaisella.</div>';
      else html += '<div class="note ok">Autoreitti olisi tällä kertaa sallittu, mutta sen Safety Score on ' + state.car.safety + ' (tämä reitti ' + r.safety + ').</div>';
      html += '<label class="chk"><input type="checkbox" id="showcar"' + (state.showCar ? ' checked' : '') + '> Näytä autoreitti kartalla</label>';
    }
    // Reittiohjeet
    html += '<details><summary>Reittiohjeet (' + r.steps.length + ')</summary><ol class="steps">';
    r.steps.forEach(function (st, i) {
      var t = TURN[st.turn] || TURN.straight;
      if (i > 0 && r.steps[i - 1].turn === 'rbt' && st.turn !== 'rbt') t = ['Poistu liikenneympyrästä', TURN.straight[1]];
      html += '<li>' + icon(t[1]) + '<span>' + t[0] + (st.turn === 'rbt' ? '' : ': ') + '<b>' + (st.turn === 'rbt' ? '' : esc(st.name || 'nimetön tie')) + '</b>' +
        (st.speed >= 70 ? '<span class="fast">Nopeusrajoitus ' + st.speed + ' km/h</span>' : '') + '</span><span class="d">' + fmtKm(st.len) + '</span></li>';
    });
    html += '<li>' + icon('M12 21s-6-5.5-6-10a6 6 0 0 1 12 0c0 4.5-6 10-6 10zM12 13a2 2 0 1 0 0-4 2 2 0 0 0 0 4z') + '<span>Perillä: <b>' + esc(state.b.label) + '</b></span></li></ol></details>';
    box.innerHTML = html;
    Array.prototype.forEach.call(box.querySelectorAll('.opt'), function (b) { b.onclick = function () { state.mode = b.dataset.m; renderResults(); draw(); }; });
    var sc = $('showcar'); if (sc) sc.onchange = function () { state.showCar = sc.checked; draw(); };
    var sd = $('startdrive'); if (sd) sd.onclick = startDrive;
  }

  // ---------- Sijainti ja ajotila ----------
  var D = { on: false, watch: null, pos: null, follow: true, muted: false, pts: null, stepAt: null, total: 0, last: 0, off: 0, said: {}, lock: null, rerouting: false, arrived: false };
  function geoErr(err) {
    if (err && err.code === 1) toast('Sijaintilupa puuttuu. Salli sijainti selaimen asetuksista ja yritä uudelleen.');
    else toast('Sijaintia ei saatu. Sijainti toimii vain beta-osoitteessa (ei claude.ai:n esikatselussa).');
  }
  $('useloc').onclick = function () {
    if (!navigator.geolocation || !G) { geoErr(); return; }
    $('useloc').disabled = true;
    navigator.geolocation.getCurrentPosition(function (p) {
      $('useloc').disabled = false;
      setPoint('a', p.coords.latitude, p.coords.longitude, 'Oma sijainti');
    }, function (e) { $('useloc').disabled = false; geoErr(e); }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 });
  };

  function buildDrive(r) {
    var pts = [], d = 0, eLenSum = 0;
    r.path.forEach(function (s) {
      var e = (s > 0 ? s : -s) - 1, p = G.edgePoints(s); eLenSum += G.eLen[e];
      for (var i = pts.length ? 1 : 0; i < p.length; i++) {
        if (pts.length) { var q = pts[pts.length - 1]; d += Math.hypot(p[i][0] - q.x, p[i][1] - q.y); }
        pts.push({ x: p[i][0], y: p[i][1], d: d, e: e });
      }
    });
    var k = eLenSum ? d / eLenSum : 1, acc = 0;
    D.stepAt = r.steps.map(function (st) { var v = acc * k; acc += st.len; return v; });
    D.pts = pts; D.total = d; D.last = 0; D.said = {}; D.off = 0; D.arrived = false; D.route = r;
  }
  function project(x, y) {
    var P = D.pts, best = { off: Infinity, along: 0, i: 0 };
    function scan(a, b) {
      for (var i = Math.max(0, a); i < Math.min(P.length - 1, b); i++) {
        var A = P[i], B = P[i + 1], vx = B.x - A.x, vy = B.y - A.y, L2 = vx * vx + vy * vy;
        var t = L2 ? Math.max(0, Math.min(1, ((x - A.x) * vx + (y - A.y) * vy) / L2)) : 0;
        var px = A.x + t * vx, py = A.y + t * vy, off = Math.hypot(x - px, y - py);
        if (off < best.off) best = { off: off, along: A.d + t * (B.d - A.d), i: i };
      }
    }
    scan(D.last - 30, D.last + 400);
    if (best.off > 60) scan(0, P.length);
    return best;
  }
  function spokenDist(m) { return m < 100 ? Math.round(m / 10) * 10 + ' metrin' : m < 1000 ? Math.round(m / 50) * 50 + ' metrin' : (m / 1000).toFixed(1).replace('.', ',') + ' kilometrin'; }
  function stepText(i) {
    var st = D.route.steps[i], t = TURN[st.turn] || TURN.straight;
    if (i > 0 && D.route.steps[i - 1].turn === 'rbt' && st.turn !== 'rbt') return ['Poistu liikenneympyrästä', st.name, TURN.straight[1]];
    return [t[0], st.turn === 'rbt' ? null : st.name, t[1]];
  }
  function say(text) {
    if (D.muted || !window.speechSynthesis) return;
    try {
      var u = new SpeechSynthesisUtterance(text); u.lang = 'fi-FI'; u.rate = 1.0;
      var v = speechSynthesis.getVoices().filter(function (x) { return /^fi/i.test(x.lang); })[0]; if (v) u.voice = v;
      speechSynthesis.cancel(); speechSynthesis.speak(u);
    } catch (e) { /* ei puhetta */ }
  }
  function keepAwake() {
    if (!('wakeLock' in navigator) || !D.on) return;
    navigator.wakeLock.request('screen').then(function (l) { D.lock = l; }).catch(function () {});
  }
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && D.on) keepAwake(); });

  function startDrive() {
    var r = state.results && state.results[state.mode];
    if (!r) return;
    if (!navigator.geolocation) { geoErr(); return; }
    buildDrive(r); D.on = true; D.follow = true; D.overview = false; D.pos = null; D.disp = null; D.head = null; D.userZoom = false; D.zoom = 1.2;
    document.body.classList.add('driving'); resize(); setRecenter();
    $('navdist').textContent = 'Haetaan sijaintia…'; $('navtxt').textContent = ''; $('navic').innerHTML = ''; $('navthen').style.display = 'none'; $('spd').classList.remove('on');
    say('Aloitetaan. ' + VEH_GEN[state.vehicle] + ' reitti, ' + fmtTime(r.time) + '.');
    keepAwake();
    D.watch = navigator.geolocation.watchPosition(onPos, function (e) {
      if (e.code === 1) { geoErr(e); stopDrive(); }
      else if (D.pos) { if (performance.now() - (D.tFix || 0) > 15000) toast('GPS-signaali on heikko. Jatka ajoa, sijainti päivittyy kun signaali palaa.'); }
      else geoErr(e);
    },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 });
  }
  function stopDrive() {
    if (D.watch !== null) navigator.geolocation.clearWatch(D.watch);
    D.watch = null; D.on = false; D.pos = null; D.disp = null; D.overview = false; view.rot = 0;
    if (D.lock) { try { D.lock.release(); } catch (e) {} D.lock = null; }
    if (window.speechSynthesis) speechSynthesis.cancel();
    document.body.classList.remove('driving'); resize(); fitRoute();
  }
  $('navstop').onclick = stopDrive;
  function setRecenter() { $('recenter').style.display = D.on && (!D.follow || D.overview) ? 'grid' : 'none'; }
  $('recenter').onclick = function () { D.follow = true; D.overview = false; D.userZoom = false; setRecenter(); animate(); draw(); };
  $('navover').onclick = function () {
    if (!D.route) return; D.overview = true; D.follow = false; setRecenter();
    fitBounds(D.pts.map(function (p) { return [p.x, p.y]; })); view.s *= 0.85; draw();
  };
  // Ilmoitukset: tallennetaan puhelimeen, lähetetään kopioimalla
  function loadReports() { try { return JSON.parse(localStorage.getItem('sideroad_reports') || '[]'); } catch (e) { return []; } }
  function saveReports(a) { try { localStorage.setItem('sideroad_reports', JSON.stringify(a)); } catch (e) {} }
  function reportsText(a) {
    return 'Sideroad-ilmoitukset (' + a.length + ')\n' + a.map(function (r, i) {
      var d = new Date(r.t);
      return (i + 1) + '. ' + d.getDate() + '.' + (d.getMonth() + 1) + '. ' + String(d.getHours()).padStart(2, '0') + '.' + String(d.getMinutes()).padStart(2, '0') +
        ' – ' + r.k + ' – ' + (r.street || '?') + ' (' + r.v + ')\n   https://www.openstreetmap.org/?mlat=' + r.lat.toFixed(5) + '&mlon=' + r.lon.toFixed(5) + '#map=18/' + r.lat.toFixed(5) + '/' + r.lon.toFixed(5);
    }).join('\n');
  }
  function showReports() {
    var a = loadReports(); $('reports').classList.toggle('has', a.length > 0);
    $('repcount').textContent = a.length + ' ilmoitusta tallennettu tähän puhelimeen. Kopioi ja lähetä ne viestillä.';
  }
  $('navreport').onclick = function () { $('report').classList.add('open'); };
  $('repcancel').onclick = function () { $('report').classList.remove('open'); };
  Array.prototype.forEach.call(document.querySelectorAll('#report .opts2 button'), function (b) {
    b.onclick = function () {
      $('report').classList.remove('open');
      if (!D.pos) { toast('Sijaintia ei vielä ole, ilmoitusta ei tallennettu.'); return; }
      var sn = G.nearest(D.pos.lat, D.pos.lon, 0), a = loadReports();
      a.push({ t: Date.now(), k: b.dataset.r, lat: D.pos.lat, lon: D.pos.lon, v: S.PROFILES[state.vehicle].label, street: sn ? nodeLabel(sn.node) : '' });
      saveReports(a); showReports(); toast('Kiitos! Ilmoitus tallennettu.');
    };
  });
  $('repcopy').onclick = function () {
    var txt = reportsText(loadReports()), ta = $('reptext');
    ta.value = txt; ta.style.display = 'block';
    if (navigator.clipboard) navigator.clipboard.writeText(txt).then(function () { toast('Ilmoitukset kopioitu. Liitä ne viestiin.'); }, function () { ta.select(); toast('Valitse teksti ja kopioi se.'); });
    else { ta.select(); toast('Valitse teksti ja kopioi se.'); }
  };
  $('repclear').onclick = function () { saveReports([]); $('reptext').style.display = 'none'; showReports(); };
  showReports();
  $('navnorth').onclick = function () {
    D.northUp = !D.northUp; $('navnorth').setAttribute('aria-pressed', String(D.northUp));
    $('navnorth').setAttribute('aria-label', D.northUp ? 'Pohjoinen ylös. Vaihda ajosuunta ylös' : 'Ajosuunta ylös. Vaihda pohjoinen ylös');
    toast(D.northUp ? 'Pohjoinen ylöspäin' : 'Ajosuunta ylöspäin'); animate();
  };

  // Kamera: liikuttaa sijaintia tasaisesti GPS-pisteiden välillä ja kääntää kartan ajosuuntaan
  function angDiff(a, b) { var d = (b - a) % (2 * Math.PI); if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI; return d; }
  var animRaf = 0, animLast = 0;
  function animate() { if (!animRaf) { animLast = performance.now(); animRaf = requestAnimationFrame(tick); } }
  function tick(now) {
    animRaf = 0; if (!D.on || !D.disp) return;
    var dt = Math.min(100, now - animLast); animLast = now;
    var busy = false;
    // Sijainti: lineaarinen siirtymä edellisestä pisteestä uuteen
    var t = Math.min(1, (now - D.t0) / D.dur);
    D.disp = [D.from[0] + (D.to[0] - D.from[0]) * t, D.from[1] + (D.to[1] - D.from[1]) * t];
    if (t < 1) busy = true;
    // Suunta
    if (D.head !== null) {
      var dh = angDiff(D.headDisp, D.head); D.headDisp += dh * Math.min(1, dt / 250);
      if (Math.abs(dh) > 0.005) busy = true;
    }
    if (D.follow) {
      view.cx = D.disp[0]; view.cy = D.disp[1];
      var tr = D.northUp || D.head === null ? 0 : D.headDisp, dr = angDiff(view.rot, tr);
      view.rot += dr * Math.min(1, dt / 300); if (Math.abs(dr) > 0.003) busy = true;
      if (!D.userZoom) { var ds = D.zoom - view.s; view.s += ds * Math.min(1, dt / 600); if (Math.abs(ds) > 0.002) busy = true; }
    }
    render();
    var cmp = $('navnorth').firstElementChild; if (cmp) cmp.style.transform = 'rotate(' + (-view.rot) + 'rad)';
    if (busy) animRaf = requestAnimationFrame(tick);
  }
  function routeBearing(along) {
    // Suunta reitillä noin 30 m eteenpäin nykyisestä kohdasta
    var P = D.pts, i = D.last, a = null, b = null;
    for (var k = Math.max(0, i); k < P.length; k++) { if (P[k].d >= along) { a = k; break; } }
    if (a === null) return null;
    for (k = a; k < P.length; k++) { if (P[k].d >= along + 30) { b = k; break; } }
    if (b === null) b = P.length - 1;
    var A = a > 0 ? P[a - 1] : P[a], B = P[b];
    if (A === B || (Math.abs(B.x - A.x) + Math.abs(B.y - A.y)) < 1) return null;
    return Math.atan2(B.x - A.x, -(B.y - A.y));
  }
  $('navmute').onclick = function () {
    D.muted = !D.muted; $('navmute').setAttribute('aria-pressed', String(D.muted));
    $('navmute').setAttribute('aria-label', D.muted ? 'Ääniohjeet pois' : 'Ääniohjeet päällä');
    $('wave').style.display = D.muted ? 'none' : ''; $('mutex').style.display = D.muted ? '' : 'none';
    if (D.muted && window.speechSynthesis) speechSynthesis.cancel();
  };

  function reroute(lat, lon) {
    if (D.rerouting) return; D.rerouting = true;
    var sn = G.nearest(lat, lon, profFlag());
    var r = sn ? G.route(sn.node, state.b.node, state.vehicle, state.mode) : null;
    D.rerouting = false;
    if (!r) { toast('Uutta reittiä ei löytynyt tästä kohdasta.'); D.off = 0; return; }
    state.results[state.mode] = r; buildDrive(r); renderResults();
    say('Lasketaan uusi reitti.'); toast('Uusi reitti laskettu.');
  }

  function onPos(p) {
    var c = p.coords; D.pos = { lat: c.latitude, lon: c.longitude, acc: c.accuracy || 30, heading: c.heading, speed: c.speed };
    var xy = G.toXY(c.latitude, c.longitude), pr = project(xy[0], xy[1]), nowT = performance.now();
    // Tasainen liike: siirrytään edellisestä näyttöpisteestä uuteen GPS-pisteeseen GPS-välin aikana
    if (!D.disp) { D.disp = xy; D.from = xy; D.to = xy; D.t0 = nowT; D.dur = 1; view.cx = xy[0]; view.cy = xy[1]; view.s = 1.2; }
    else { D.from = D.disp; D.to = xy; D.dur = Math.max(300, Math.min(1500, nowT - (D.tFix || nowT - 1000))); D.t0 = nowT; }
    D.tFix = nowT;
    // Ajosuunta: reitin suunta kun ollaan reitillä, muuten GPS:n suunta liikkeessä
    var tolH = Math.max(45, Math.min(D.pos.acc, 80)), hd = null;
    if (pr.off <= tolH) hd = routeBearing(pr.along);
    if (hd === null && c.heading !== null && !isNaN(c.heading) && (c.speed || 0) > 1.5) hd = c.heading * Math.PI / 180;
    if (hd !== null) { if (D.head === null) D.headDisp = hd; D.head = hd; }
    // Zoom nopeuden mukaan: hitaasti lähempää, kovempaa kauempaa
    var v = c.speed || 0; D.zoom = v < 5 ? 1.5 : v < 10 ? 1.2 : v < 15 ? 0.95 : 0.75;
    animate();
    // Reitiltä poikkeaminen
    var tol = Math.max(45, Math.min(D.pos.acc, 80)), now = Date.now();
    if (pr.off > tol) {
      D.off++;
      var canReroute = now - (D.lastReroute || 0) > 15000;
      if (canReroute && (D.off >= 3 || (D.last === 0 && pr.off > 150))) {
        D.off = 0; D.lastReroute = now; reroute(c.latitude, c.longitude);
        pr = project(xy[0], xy[1]); D.last = pr.i;
      }
    } else { D.off = 0; D.last = pr.i; }
    var along = pr.along, remain = Math.max(0, D.total - along);
    // Nopeusrajoitus
    var e = D.pts[pr.i].e, lim = G.eSpeed[e];
    $('spd').classList.add('on'); $('spd').textContent = lim;
    // Perillä
    if (remain < 25 && !D.arrived) {
      D.arrived = true; say('Olet perillä.');
      $('navic').innerHTML = icon('M12 21s-6-5.5-6-10a6 6 0 0 1 12 0c0 4.5-6 10-6 10z', '#fff', 40); $('navdist').textContent = 'Perillä';
      $('navtxt').innerHTML = '<b>' + esc(state.b.label) + '</b>'; $('navthen').style.display = 'none';
      $('navrem').innerHTML = '<b>Perillä</b><span>' + esc(state.b.label) + '</span>'; return;
    }
    if (D.arrived) return;
    // Seuraava ohje
    var i = 1; while (i < D.stepAt.length && D.stepAt[i] <= along + 3) i++;
    var dist, txt;
    if (i < D.stepAt.length) {
      dist = D.stepAt[i] - along; txt = stepText(i);
    } else { dist = remain; txt = ['Perillä', state.b.label, 'M12 21s-6-5.5-6-10a6 6 0 0 1 12 0c0 4.5-6 10-6 10z']; }
    $('navic').innerHTML = icon(txt[2], '#fff', 44);
    var straight = txt[0] === 'Jatka suoraan' || txt[0] === 'Lähde';
    if (straight && txt[1]) { $('navdist').textContent = fmtKm(dist); $('navtxt').innerHTML = 'suuntaan <b>' + esc(txt[1]) + '</b>'; }
    else { $('navdist').textContent = fmtKm(dist); $('navtxt').innerHTML = esc(txt[0]) + (txt[1] ? '<br><b>' + esc(txt[1]) + '</b>' : ''); }
    // "ja sitten": seuraava käännös, jos se tulee pian
    var nt = $('navthen');
    var t2 = i + 1 < D.stepAt.length ? stepText(i + 1) : null;
    if (t2 && t2[2] !== TURN.straight[1] && D.stepAt[i + 1] - D.stepAt[i] < 300) { nt.innerHTML = 'ja sitten ' + icon(t2[2], '#fff', 22); nt.style.display = 'flex';
    } else nt.style.display = 'none';
    var spoken = txt[0].toLowerCase() + (txt[1] ? ', ' + txt[1] : '');
    if (dist < 400 && dist > 150 && !D.said[i + 'f']) { D.said[i + 'f'] = 1; say(spokenDist(dist) + ' päästä ' + spoken + '.'); }
    else if (dist <= 70 && !D.said[i + 'n']) { D.said[i + 'n'] = 1; D.said[i + 'f'] = 1; say(txt[0] === 'Perillä' ? 'Määränpää on edessä.' : txt[0] + ' nyt' + (txt[1] ? ', ' + txt[1] : '') + '.'); }
    // Jäljellä
    var r = D.route, secs = r.time * (remain / Math.max(1, D.total)), eta = new Date(Date.now() + secs * 1000);
    $('navrem').innerHTML = '<b>' + fmtTime(secs) + '</b><span>' + fmtKm(remain) + ' · ' + String(eta.getHours()).padStart(2, '0') + '.' + String(eta.getMinutes()).padStart(2, '0') + '</span>';
  }

  resize();
})();
