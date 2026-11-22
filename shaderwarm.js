/*
 * Deal Web shader warmer (web build only; no effect on the game's code or visuals).
 *
 * On a first visit the engine links ~270 WebGL programs one at a time, and the
 * browser translates each one for the GPU driver while the game waits (~75 s
 * on Windows / Direct3D). Browsers keep a cache of compiled programs, which is
 * why repeat visits are fast.
 *
 * This script compiles the same programs ahead of time in a separate, hidden
 * WebGL2 context, many at once (KHR_parallel_shader_compile), while the game
 * is still downloading and starting. When the engine then links a program, the
 * browser finds it in its cache. The programs come from shaderpack.json,
 * recorded from this exact build (see tools/web/).
 *
 * The browser runs this work and the game's drawing in the same GPU process,
 * so the warmer paces itself by the page's frame rate: it adds work only while
 * frames stay smooth and backs off when they slow down, so the menu stays
 * responsive while the 3D room's shaders are prepared.
 *
 * Browsers keep compiled shaders between visits, so once a full warm-up has
 * finished, the pack's id is remembered (localStorage) and later visits skip
 * the warmer. If the browser has dropped its cache meanwhile, the game builds
 * what it needs itself, as it always did.
 *
 * If anything is unsupported or fails, it simply stops: the game works the
 * same, only without the head start.
 */

/*
 * Area-light code removal (Godot 4.7.2 Compatibility renderer, web only).
 *
 * The engine leaves out area-light code only together with spot-light code,
 * so every lit shader reached by the table's spot light also carries the
 * area-light code: ~84% of its compile time on Windows / Direct3D. This game
 * has no area lights (no AreaLight3D anywhere), so that code never runs:
 * defining DISABLE_LIGHT_AREA (the engine's own switch, which it already sets
 * for other shader variants) removes dead code and changes nothing on screen.
 * Applies to the engine's and the warmer's contexts alike, so cache keys match.
 */
(function () {
  "use strict";
  var patch = (window.__dealShaderPatch = { area: 0 });
  if (!window.WebGL2RenderingContext) return;
  var P = WebGL2RenderingContext.prototype;
  var original = P.shaderSource;
  P.shaderSource = function (shader, src) {
    if (typeof src === "string" && src.indexOf("!defined(DISABLE_LIGHT_AREA)") >= 0 &&
        !/^#define DISABLE_LIGHT_AREA\b/m.test(src) && src.lastIndexOf("#version", 0) === 0) {
      var eol = src.indexOf("\n");
      src = src.slice(0, eol + 1) + "#define DISABLE_LIGHT_AREA\n" + src.slice(eol + 1);
      patch.area++;
    }
    return original.call(this, shader, src);
  };
})();

(function () {
  "use strict";
  var state = (window.__dealWarm = { total: 0, done: 0, failed: 0, ms: 0, ready: false, skipped: "" });
  var t0 = performance.now();
  // The game waits for `ready` before building its 3D room (web build only),
  // so every way out of this script must set it.
  function giveUp(why) { state.skipped = why; state.ready = true; }
  if (!window.WebGL2RenderingContext || !window.fetch) { giveUp("no webgl2"); return; }
  // The engine's WebGL2 context settings and extensions (shader translation
  // can depend on enabled extensions, so they must match for cache hits).
  var ATTRS = { alpha: false, depth: true, stencil: false, antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, powerPreference: "default" };
  var EXTS = ["WEBGL_multi_draw", "EXT_polygon_offset_clamp", "EXT_clip_control", "WEBGL_polygon_mode", "EXT_disjoint_timer_query_webgl2",
    "EXT_color_buffer_float", "EXT_color_buffer_half_float", "EXT_conservative_depth", "EXT_depth_clamp", "EXT_float_blend",
    "EXT_texture_compression_bptc", "EXT_texture_compression_rgtc", "EXT_texture_filter_anisotropic", "EXT_texture_norm16",
    "KHR_parallel_shader_compile", "NV_shader_noperspective_interpolation", "OES_texture_float_linear", "WEBGL_blend_func_extended",
    "WEBGL_clip_cull_distance", "WEBGL_compressed_texture_s3tc", "WEBGL_compressed_texture_s3tc_srgb", "OVR_multiview2"];

  fetch("shaderpack.json").then(function (r) { return r.ok ? r.json() : null; }).then(function (pack) {
    if (!pack || pack.v !== 1) { giveUp("no pack"); return; }
    // The key also names the source patch above: a cache warmed without it
    // does not hold the patched programs.
    var KEY = "deal.shaderwarm.area1";
    try { if (pack.id && localStorage.getItem(KEY) === pack.id) { giveUp("already warm"); return; } } catch (e) {}
    var canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    var gl = canvas.getContext("webgl2", ATTRS);
    if (!gl) { giveUp("no context"); return; }
    for (var e = 0; e < EXTS.length; e++) gl.getExtension(EXTS[e]);
    var par = gl.getExtension("KHR_parallel_shader_compile");
    if (!par) { giveUp("no parallel compile"); return; } // it would only compete with the game
    var lines = pack.lines, queue = pack.progs, next = 0, inflight = [];
    var MAX = Math.max(2, Math.min(16, navigator.hardwareConcurrency || 4));
    var limit = 1;          // programs allowed in flight right now
    var lastFrame = performance.now(), worstGap = 0;
    state.total = queue.length;
    // Frame-rate probe: the longest gap between frames since the last pump.
    (function frame(t) {
      var gap = t - lastFrame;
      lastFrame = t;
      if (gap > worstGap) worstGap = gap;
      if (!state.ready) requestAnimationFrame(frame);
    })(performance.now());

    function text(runs) {
      var out = [];
      for (var i = 0; i < runs.length; i += 2) for (var k = 0; k < runs[i + 1]; k++) out.push(lines[runs[i] + k]);
      return out.join("\n");
    }
    function start(p) {
      var vs = gl.createShader(gl.VERTEX_SHADER), fs = gl.createShader(gl.FRAGMENT_SHADER);
      gl.shaderSource(vs, text(p.vs)); gl.compileShader(vs);
      gl.shaderSource(fs, text(p.fs)); gl.compileShader(fs);
      var pr = gl.createProgram();
      gl.attachShader(pr, vs); gl.attachShader(pr, fs);
      for (var i = 0; i < p.a.length; i++) gl.bindAttribLocation(pr, p.a[i][0], p.a[i][1]);
      if (p.t) gl.transformFeedbackVaryings(pr, p.t[0], p.t[1]);
      gl.linkProgram(pr);
      return { pr: pr, vs: vs, fs: fs };
    }
    function pump() {
      try {
        for (var i = inflight.length - 1; i >= 0; i--) {
          var o = inflight[i];
          if (gl.getProgramParameter(o.pr, par.COMPLETION_STATUS_KHR)) {
            if (!gl.getProgramParameter(o.pr, gl.LINK_STATUS)) state.failed++;
            gl.deleteProgram(o.pr); gl.deleteShader(o.vs); gl.deleteShader(o.fs);
            inflight.splice(i, 1);
            state.done++;
          }
        }
        // Smooth frames: allow one more in flight. Janky frames: halve.
        var gap = Math.max(worstGap, performance.now() - lastFrame);
        worstGap = 0;
        if (gap > 120) limit = Math.max(1, limit >> 1);
        else if (gap < 50) limit = Math.min(MAX, limit * 2);
        while (inflight.length < limit && next < queue.length) inflight.push(start(queue[next++]));
      } catch (err) {
        giveUp("error"); // stop quietly; the game builds what it still needs itself
        return;
      }
      if (inflight.length || next < queue.length) { setTimeout(pump, 16); return; }
      state.ms = Math.round(performance.now() - t0);
      state.ready = true;
      try { if (pack.id && !state.failed) localStorage.setItem(KEY, pack.id); } catch (e) {}
      var lose = gl.getExtension("WEBGL_lose_context");
      if (lose) lose.loseContext();
    }
    pump();
  }).catch(function () { giveUp("fetch failed"); });
})();
