/* The Gemini stage (source/widget/stage3d.js, the netra_stage3d UI script).
 *
 * It is the whole UI script, loaded on the public page before anything
 * else paints, so it must stay small, plain ES5 and free of three.js; its API
 * is what the page mounts (mount/unmount/fps); it must never throw without
 * a GPU or a canvas, must pause when the tab is hidden, and must hold still
 * for a visitor who asked for reduced motion. */
var T = require('./lib/t'), fs = require('fs'), path = require('path'), vm = require('vm');
var SRC = fs.readFileSync(path.join(__dirname, '..', 'source', 'widget', 'stage3d.js'), 'utf8');

// a page with no WebGL and no 2D context: the worst case a locked-down VDI gives
function fakePage(opts) {
    opts = opts || {};
    var listeners = {}, rafs = [], added = [];
    function el(tag) {
        var e = { tagName: tag, style: {}, children: [], className: '', parentNode: null,
            setAttribute: function () {}, addEventListener: function () {},
            appendChild: function (k) { k.parentNode = e; e.children.push(k); added.push(k); return k; },
            removeChild: function (k) { e.children.splice(e.children.indexOf(k), 1); k.parentNode = null; },
            getBoundingClientRect: function () { return { left: 0, top: 0, width: 1280, height: 800 }; },
            getContext: function (kind) { return opts.ctx ? opts.ctx(kind) : null; } };
        return e;
    }
    var doc = { hidden: false, head: el('head'), documentElement: el('html'),
        createElement: el, getElementById: function () { return null; }, querySelector: function () { return null; },
        addEventListener: function (k, f) { listeners[k] = f; }, removeEventListener: function (k) { delete listeners[k]; } };
    var win = { innerWidth: 1280, innerHeight: 800, addEventListener: function () {}, removeEventListener: function () {},
        matchMedia: function () { return { matches: !!opts.reduced, addEventListener: function () {}, removeEventListener: function () {} }; } };
    var ctx = { window: win, document: doc, Math: Math, isFinite: isFinite, Float32Array: Float32Array,
        performance: { now: function () { return 0; } },
        requestAnimationFrame: function (f) { rafs.push(f); return rafs.length; }, cancelAnimationFrame: function () {} };
    win.window = win;
    vm.runInNewContext(SRC, ctx);
    return { S: win.NetraStage3D, doc: doc, listeners: listeners, rafs: rafs, host: el('div'), win: win };
}

T.test('the stage is small plain ES5 with no three.js, and its API is what the page mounts', function () {
    T.ok(SRC.length < 40000, 'size ' + SRC.length + ' bytes (the three.js stage was 666,905)');
    T.notMatch(SRC, /\bTHREE\b|\bthree\.js r\d|\bclass\s|=>|\blet\s|\bconst\s+[a-zA-Z_$]+\s*=(?![^;]*'\s*\+)/, 'ES5 only, no three.js');
    new vm.Script(SRC);
    var p = fakePage();
    ['mount', 'unmount', 'fps'].forEach(function (k) { T.eq(typeof p.S[k], 'function', k); });
});

T.test('with no GPU and no canvas it still mounts, paints nothing broken and never throws', function () {
    var p = fakePage();
    T.eq(p.S.mount(p.host), true, 'the dark stage still stands');
    T.eq(p.host.children.length, 1, 'one layer root');
    p.win.__netraState = 'speaking'; p.win.__netraLevel = 70;
    for (var i = 0; i < 5 && p.rafs.length; i++) p.rafs.shift()(16 * (i + 1));
    T.eq(typeof p.S.fps(), 'number');
    p.S.unmount();
    T.eq(p.host.children.length, 0, 'unmount leaves nothing behind');
});

T.test('it stops drawing while the tab is hidden, and starts again when it is back', function () {
    var p = fakePage();
    p.S.mount(p.host);
    T.ok(p.rafs.length >= 1, 'a frame is scheduled');
    p.rafs.length = 0;
    p.doc.hidden = true; p.listeners.visibilitychange();
    T.eq(p.rafs.length, 0, 'nothing scheduled while hidden');
    p.doc.hidden = false; p.listeners.visibilitychange();
    T.eq(p.rafs.length, 1, 'one frame scheduled on return');
    p.S.unmount();
    T.eq(p.listeners.visibilitychange, undefined, 'its listener is removed');
});

T.test('reduced motion: a composed still, redrawn only when something visible changes', function () {
    var draws = 0;
    var c2 = { fillRect: function () { draws++; }, clearRect: function () {}, drawImage: function () {},
        createRadialGradient: function () { return { addColorStop: function () {} }; } };
    var p = fakePage({ reduced: true, ctx: function (kind) { return kind === '2d' ? c2 : null; } });
    p.S.mount(p.host);
    var t = 0;
    for (var i = 0; i < 40; i++) { t += 16; if (p.rafs.length) p.rafs.shift()(t); }
    var still = draws;
    for (i = 0; i < 40; i++) { t += 16; if (p.rafs.length) p.rafs.shift()(t); }
    T.ok(draws - still <= 1, 'a still idle stage is not repainted: ' + (draws - still) + ' repaints in 40 frames');
    p.S.unmount();
});
T.run(__filename);
