/*
 * Henry dashboard — holographic memory display.
 *
 * Hand-rolled 3D on a 2D canvas: no external libraries. Lives in a plain .js
 * asset (served by server.ts at /holo.js) rather than inside page.ts's template
 * literal, so backticks / ${...} / backslashes here can never break the page.
 *
 * Data: GET /api/memory/graph -> { nodes:[{id,label,tier,importance,useCount,...}], edges:[{src,dst,weight}] }
 */
(function () {
  'use strict';

  var MAX_NODES = 300;
  var MAX_EDGES = 1200;
  var ALWAYS_LABELS = 20;
  var LABEL_MAXLEN = 26;
  var BOOT_MS = 1200;
  var REVOLUTION_MS = 90000;      // one very slow ambient revolution
  var FRAME_MS = 1000 / 30;       // rAF capped ~30fps
  var IDLE_STOP_MS = 60000;       // stop the loop after 60s idle while paused
  var POLL_MS = 30000;
  var CAM_DIST = 3.6;
  var FOCAL_DEFAULT = 560, FOCAL_MIN = 260, FOCAL_MAX = 1600;
  var PITCH_LIMIT = 1.15;
  var TIER_COLORS = { episodic: [77, 217, 255], semantic: [185, 139, 255], procedural: [255, 190, 92] };
  var DEFAULT_COLOR = [110, 231, 255];
  var TIER_SHELL = { procedural: 0.46, semantic: 0.76, episodic: 1.06 };
  var DEFAULT_SHELL = 0.92;

  var canvas = document.getElementById('holo-canvas');
  var hud = document.getElementById('holo-hud');
  if (!canvas || !canvas.getContext) return;
  var ctx = canvas.getContext('2d');

  var S = {
    nodes: [], edges: [], total: 0, sig: null,
    w: 0, h: 0, dpr: 1,
    yaw: 0.6, pitch: 0.32, focal: FOCAL_DEFAULT,
    boot: 0, bootStart: 0,
    autoRotate: true, dragging: false, hover: null, selected: null,
    pointer: null, lastFrame: 0, lastInteraction: Date.now(),
    raf: null, running: false, empty: true, loaded: false, error: null, flicker: 1
  };
  window.__holo = S;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function hash32(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h * 16777619) >>> 0; }
    return h >>> 0;
  }
  function seeded(str, salt) { return (hash32(str + '#' + salt) % 100000) / 100000; }
  function tierColor(t) { return TIER_COLORS[t] || DEFAULT_COLOR; }
  function rgba(c, a) { return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a.toFixed(3) + ')'; }
  function truncate(s) {
    s = String(s == null || s === '' ? '(memory)' : s).replace(/\s+/g, ' ').trim();
    return s.length > LABEL_MAXLEN ? s.slice(0, LABEL_MAXLEN - 1) + '…' : s;
  }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function easeOutCubic(t) { var u = 1 - t; return 1 - u * u * u; }

  // ---- layout: deterministic jittered fibonacci sphere, tier shells ----
  function layout(list) {
    var n = list.length, ga = Math.PI * (3 - Math.sqrt(5));
    for (var i = 0; i < n; i++) {
      var nd = list[i];
      var y = n === 1 ? 0 : 1 - (i / (n - 1)) * 2;
      var r = Math.sqrt(Math.max(0, 1 - y * y));
      var theta = i * ga + seeded(nd.id, 'a') * 0.55;
      var shell = (TIER_SHELL[nd.tier] || DEFAULT_SHELL) * (0.88 + seeded(nd.id, 'b') * 0.24);
      var yy = y * (0.72 + seeded(nd.id, 'c') * 0.2);
      nd.x = Math.cos(theta) * r * shell;
      nd.y = yy * shell;
      nd.z = Math.sin(theta) * r * shell;
      var imp = typeof nd.importance === 'number' ? nd.importance : 0;
      var uc = nd.useCount || 0;
      nd.rw = (3.4 + imp * 7 + Math.log(uc + 1) / Math.LN2 * 1.2) / 100; // world radius
      nd.color = tierColor(nd.tier);
    }
  }

  function signature(data) {
    var nodes = data.nodes || [], edges = data.edges || [], sum = 0;
    for (var i = 0; i < nodes.length; i++) {
      sum += (nodes[i].useCount || 0) * 7 + Math.round((nodes[i].importance || 0) * 1000);
    }
    return nodes.length + ':' + edges.length + ':' + sum;
  }

  function build(data) {
    var all = (data.nodes || []).slice().sort(function (a, b) { return (b.importance || 0) - (a.importance || 0); });
    S.total = all.length;
    var nodes = all.slice(0, MAX_NODES);
    var index = {};
    nodes.forEach(function (nd, i) { index[nd.id] = i; });
    layout(nodes);
    var edges = [];
    var raw = data.edges || [];
    for (var i = 0; i < raw.length && edges.length < MAX_EDGES; i++) {
      var a = index[raw[i].src], b = index[raw[i].dst];
      if (a == null || b == null || a === b) continue;
      edges.push({ a: a, b: b, w: typeof raw[i].weight === 'number' ? raw[i].weight : 0.3 });
    }
    S.nodes = nodes; S.edges = edges; S.empty = nodes.length === 0; S.error = null;
    S.hover = null; S.selected = null;
  }

  // ---- projection ----
  function project(x, y, z) {
    var cy = Math.cos(S.yaw), sy = Math.sin(S.yaw);
    var rx = x * cy + z * sy;
    var rz = -x * sy + z * cy;
    var cp = Math.cos(S.pitch), sp = Math.sin(S.pitch);
    var ry = y * cp - rz * sp;
    var rz2 = y * sp + rz * cp;
    var zc = CAM_DIST - rz2;
    if (zc < 0.35) zc = 0.35;
    var s = S.focal / zc;
    return { sx: S.w / 2 + rx * s, sy: S.h * 0.44 - ry * s, s: s, zc: zc };
  }
  function fog(zc) { return clamp(1 - (zc - (CAM_DIST - 1.25)) / 2.6, 0.12, 1); }

  function sizeCanvas() {
    var rect = canvas.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    S.w = rect.width || 800; S.h = rect.height || 460; S.dpr = dpr;
    canvas.width = Math.max(1, Math.round(S.w * dpr));
    canvas.height = Math.max(1, Math.round(S.h * dpr));
  }

  // ---- drawing ----
  function drawBackdrop() {
    ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
    ctx.fillStyle = '#03060b';
    ctx.fillRect(0, 0, S.w, S.h);
    var g = ctx.createRadialGradient(S.w / 2, S.h * 0.44, 0, S.w / 2, S.h * 0.44, Math.max(S.w, S.h) * 0.6);
    g.addColorStop(0, 'rgba(14,52,72,0.55)');
    g.addColorStop(1, 'rgba(3,6,11,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S.w, S.h);
  }

  function drawGrid(alpha) {
    if (alpha <= 0.01) return;
    var base = -1.25, rings = 5, maxR = 1.7, segments = 72;
    ctx.lineWidth = 1;
    for (var r = 1; r <= rings; r++) {
      var rad = (r / rings) * maxR * (0.35 + 0.65 * alpha);
      ctx.beginPath();
      for (var i = 0; i <= segments; i++) {
        var a = (i / segments) * Math.PI * 2;
        var p = project(Math.cos(a) * rad, base, Math.sin(a) * rad);
        if (i === 0) ctx.moveTo(p.sx, p.sy); else ctx.lineTo(p.sx, p.sy);
      }
      ctx.strokeStyle = rgba([90, 220, 240], 0.13 * alpha * (1 - r / (rings + 3)) + 0.04 * alpha);
      ctx.stroke();
    }
    var spokes = 16;
    for (var k = 0; k < spokes; k++) {
      var ang = (k / spokes) * Math.PI * 2;
      var inner = project(Math.cos(ang) * maxR * 0.16, base, Math.sin(ang) * maxR * 0.16);
      var outer = project(Math.cos(ang) * maxR * (0.35 + 0.65 * alpha), base, Math.sin(ang) * maxR * (0.35 + 0.65 * alpha));
      ctx.beginPath(); ctx.moveTo(inner.sx, inner.sy); ctx.lineTo(outer.sx, outer.sy);
      ctx.strokeStyle = rgba([90, 220, 240], 0.07 * alpha);
      ctx.stroke();
    }
  }

  function drawEmpty() {
    ctx.save();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = '13px ui-monospace,SFMono-Regular,Menlo,monospace';
    ctx.shadowColor = 'rgba(77,217,255,0.9)'; ctx.shadowBlur = 14;
    ctx.fillStyle = 'rgba(140,235,255,0.85)';
    ctx.fillText(S.error || (S.loaded ? 'memory graph is empty' : 'establishing neural link…'), S.w / 2, S.h * 0.44);
    ctx.restore();
  }

  function draw(now) {
    if (!S.w) sizeCanvas();
    var boot = S.bootStart ? clamp((now - S.bootStart) / BOOT_MS, 0, 1) : 1;
    S.boot = boot;
    var e = easeOutCubic(boot);
    drawBackdrop();
    drawGrid(e);
    if (S.empty) { drawEmpty(); return; }

    var nodes = S.nodes, i;
    for (i = 0; i < nodes.length; i++) {
      var nd = nodes[i];
      var p = project(nd.x * e, nd.y * e, nd.z * e);
      nd.px = p.sx; nd.py = p.sy; nd.pr = Math.max(1.4, nd.rw * p.s); nd.zc = p.zc; nd.fog = fog(p.zc);
    }

    // edges — thin translucent light-lines, fading with depth
    ctx.lineWidth = 1;
    for (i = 0; i < S.edges.length; i++) {
      var ed = S.edges[i];
      var a = nodes[ed.a], b = nodes[ed.b];
      if (!a || !b) continue;
      var hi = (S.hover != null && (ed.a === S.hover || ed.b === S.hover)) ||
               (S.selected != null && (ed.a === S.selected || ed.b === S.selected));
      var depth = Math.min(a.fog, b.fog);
      var alpha = (hi ? 0.75 : Math.min(0.3, 0.05 + ed.w * 0.28)) * depth * e;
      if (alpha < 0.012) continue;
      ctx.strokeStyle = rgba(hi ? [150, 245, 255] : [78, 190, 220], alpha);
      ctx.beginPath(); ctx.moveTo(a.px, a.py); ctx.lineTo(b.px, b.py); ctx.stroke();
    }

    // nodes — painter's algorithm, far to near
    var order = [];
    for (i = 0; i < nodes.length; i++) order.push(i);
    order.sort(function (x, y) { return nodes[y].zc - nodes[x].zc; });
    for (i = 0; i < order.length; i++) {
      var idx = order[i], n2 = nodes[idx];
      var lit = S.hover === idx || S.selected === idx;
      var r = n2.pr * (lit ? 1.4 : 1);
      var f = n2.fog * (0.55 + 0.45 * e);
      var col = n2.color;
      var glow = ctx.createRadialGradient(n2.px, n2.py, 0, n2.px, n2.py, r * 3.2);
      glow.addColorStop(0, rgba(col, 0.9 * f));
      glow.addColorStop(0.35, rgba(col, 0.34 * f));
      glow.addColorStop(1, rgba(col, 0));
      ctx.fillStyle = glow;
      ctx.beginPath(); ctx.arc(n2.px, n2.py, r * 3.2, 0, Math.PI * 2); ctx.fill();
      ctx.save();
      ctx.shadowColor = rgba(col, 0.85 * f); ctx.shadowBlur = lit ? 22 : 10;
      ctx.fillStyle = rgba([Math.min(255, col[0] + 70), Math.min(255, col[1] + 40), 255], Math.min(1, 0.55 + 0.45 * f));
      ctx.beginPath(); ctx.arc(n2.px, n2.py, r * 0.55, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      if (lit) {
        ctx.strokeStyle = rgba([160, 250, 255], 0.75);
        ctx.beginPath(); ctx.arc(n2.px, n2.py, r * 2.1, 0, Math.PI * 2); ctx.stroke();
      }
    }

    // labels — top-N by importance always on, plus hover/selection
    ctx.font = '10px ui-monospace,SFMono-Regular,Menlo,monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (i = 0; i < nodes.length; i++) {
      var lit2 = S.hover === i || S.selected === i;
      if (i >= ALWAYS_LABELS && !lit2) continue;
      var nl = nodes[i];
      var la = (lit2 ? 0.95 : 0.34 + nl.fog * 0.42) * e;
      ctx.fillStyle = rgba(lit2 ? [200, 250, 255] : [150, 205, 225], la);
      ctx.fillText(truncate(nl.label), nl.px, nl.py + nl.pr * 1.6 + 3);
    }

    // leader line from focused node to the HUD readout
    var focus = S.hover != null ? S.hover : S.selected;
    if (focus != null && nodes[focus]) {
      var fn = nodes[focus];
      var anchorX = S.w - 232, anchorY = 74;
      ctx.strokeStyle = rgba([120, 235, 255], 0.5);
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(fn.px, fn.py);
      ctx.lineTo(fn.px + (anchorX - fn.px) * 0.6, anchorY);
      ctx.lineTo(anchorX, anchorY);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // ---- HUD ----
  function hudShell() {
    if (!hud) return;
    hud.innerHTML =
      '<div class="holo-hud-bar">' +
        '<button id="holo-toggle" type="button" title="pause/resume ambient rotation">⏸</button>' +
        '<span id="holo-note" class="holo-note"></span>' +
      '</div>' +
      '<div id="holo-readout" class="holo-readout"></div>';
    var toggle = document.getElementById('holo-toggle');
    if (toggle) toggle.addEventListener('click', function (evt) {
      evt.stopPropagation();
      S.autoRotate = !S.autoRotate;
      toggle.textContent = S.autoRotate ? '⏸' : '▶';
      interacted();
    });
  }
  function hudUpdate() {
    var note = document.getElementById('holo-note');
    if (note) {
      note.textContent = !S.loaded ? 'linking…' : S.total > MAX_NODES
        ? 'top ' + MAX_NODES + ' of ' + S.total
        : S.total + ' node' + (S.total === 1 ? '' : 's');
    }
    var out = document.getElementById('holo-readout');
    if (!out) return;
    var focus = S.hover != null ? S.hover : S.selected;
    var nd = focus != null ? S.nodes[focus] : null;
    if (!nd) {
      out.className = 'holo-readout';
      out.innerHTML = '<span class="holo-dim">hover a node · drag to orbit · scroll ↔ to spin</span>';
      return;
    }
    var imp = typeof nd.importance === 'number' ? nd.importance.toFixed(2) : String(nd.importance == null ? '—' : nd.importance);
    out.className = 'holo-readout active' + (S.selected === focus ? ' locked' : '');
    out.innerHTML =
      '<b>' + esc(truncate(nd.label)) + '</b>' +
      '<span>tier <i>' + esc(nd.tier || 'memory') + '</i></span>' +
      '<span>importance <i>' + esc(imp) + '</i></span>' +
      '<span>used <i>' + esc(nd.useCount == null ? 0 : nd.useCount) + '</i></span>' +
      (S.selected === focus ? '<span class="holo-dim">locked · click to release</span>' : '');
  }

  // ---- loop ----
  function tick(ts) {
    S.raf = null;
    if (document.hidden) { S.running = false; return; }
    var now = ts || performance.now();
    if (now - S.lastFrame >= FRAME_MS - 1) {
      var dt = Math.min(120, now - (S.lastFrame || now));
      S.lastFrame = now;
      if (S.autoRotate && !S.dragging && S.hover == null) S.yaw += (Math.PI * 2) * (dt / REVOLUTION_MS);
      draw(now);
    }
    var settled = S.boot >= 1;
    var idle = Date.now() - S.lastInteraction > IDLE_STOP_MS;
    if (settled && !S.autoRotate && idle && !S.dragging) { S.running = false; return; } // fully static: stop the loop
    S.running = true;
    S.raf = requestAnimationFrame(tick);
  }
  function ensureLoop() {
    if (S.running || S.raf != null || document.hidden) return;
    S.running = true; S.lastFrame = 0;
    S.raf = requestAnimationFrame(tick);
  }
  function interacted() { S.lastInteraction = Date.now(); ensureLoop(); }

  // ---- input ----
  function pointerPos(evt) {
    var rect = canvas.getBoundingClientRect();
    return { x: evt.clientX - rect.left, y: evt.clientY - rect.top };
  }
  function hitTest(pos) {
    var best = null, bestD = Infinity;
    for (var i = 0; i < S.nodes.length; i++) {
      var nd = S.nodes[i];
      if (nd.px == null) continue;
      var dx = nd.px - pos.x, dy = nd.py - pos.y;
      var d = Math.sqrt(dx * dx + dy * dy);
      if (d <= Math.max(6, nd.pr * 1.8) + 3 && d < bestD) { best = i; bestD = d; }
    }
    return best;
  }
  canvas.addEventListener('pointerdown', function (evt) {
    S.dragging = true; S.pointer = { x: evt.clientX, y: evt.clientY, moved: 0 };
    canvas.classList.add('dragging');
    if (canvas.setPointerCapture) { try { canvas.setPointerCapture(evt.pointerId); } catch (e) { /* capture unsupported */ } }
    interacted();
  });
  canvas.addEventListener('pointermove', function (evt) {
    if (S.dragging && S.pointer) {
      var dx = evt.clientX - S.pointer.x, dy = evt.clientY - S.pointer.y;
      S.pointer.x = evt.clientX; S.pointer.y = evt.clientY;
      S.pointer.moved += Math.abs(dx) + Math.abs(dy);
      S.yaw += dx * 0.006;
      S.pitch = clamp(S.pitch + dy * 0.005, -PITCH_LIMIT, PITCH_LIMIT);
      interacted();
      return;
    }
    var hit = hitTest(pointerPos(evt));
    if (hit !== S.hover) { S.hover = hit; hudUpdate(); }
    interacted();
  });
  function endDrag(evt) {
    if (!S.dragging) return;
    var moved = S.pointer ? S.pointer.moved : 0;
    S.dragging = false; S.pointer = null;
    canvas.classList.remove('dragging');
    if (moved < 5 && evt) {
      var hit = hitTest(pointerPos(evt));
      S.selected = hit != null && S.selected === hit ? null : hit;
      hudUpdate();
    }
    interacted();
  }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', function () { endDrag(null); });
  canvas.addEventListener('mouseleave', function () {
    if (S.hover != null) { S.hover = null; hudUpdate(); }
    interacted();
  });
  canvas.addEventListener('wheel', function (evt) {
    // horizontal scroll / two-finger swipe -> orbit yaw; vertical wheel / pinch -> zoom
    if (Math.abs(evt.deltaX) > Math.abs(evt.deltaY)) {
      S.yaw += evt.deltaX * 0.004;
    } else {
      S.focal = clamp(S.focal * (1 - evt.deltaY * 0.0012), FOCAL_MIN, FOCAL_MAX);
    }
    evt.preventDefault();
    interacted();
  }, { passive: false });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) { S.lastFrame = 0; interacted(); }
  });
  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { sizeCanvas(); interacted(); }, 150);
  });

  // ---- data ----
  function load(first) {
    fetch('/api/memory/graph').then(function (r) { return r.json(); }).then(function (data) {
      S.loaded = true;
      var sig = signature(data);
      if (sig === S.sig) return;
      S.sig = sig;
      build(data);
      if (first) { S.bootStart = performance.now(); S.boot = 0; }
      hudUpdate();
      interacted();
    }).catch(function () {
      S.loaded = true;
      S.nodes = []; S.edges = []; S.empty = true; S.error = 'memory graph unavailable'; S.sig = null;
      hudUpdate(); interacted();
    });
  }

  hudShell();
  hudUpdate();
  sizeCanvas();
  S.bootStart = performance.now();
  ensureLoop();
  load(true);
  setInterval(function () { if (!document.hidden) load(false); }, POLL_MS);
})();
