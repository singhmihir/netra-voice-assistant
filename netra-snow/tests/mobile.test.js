/* Netra on phones and as an installed app.
 *
 * The public page is installable (a web app manifest and a service worker,
 * served before anyone signs in), iOS gets a tap before any voice (it drops
 * speech otherwise), and on a phone nothing opens over the stage by itself. */
var T = require('./lib/t'), N = require('./lib/netra'), S = require('./lib/session');
var fs = require('fs'), path = require('path'), vm = require('vm');
var APP = fs.readFileSync(path.join(N.SRC, 'scripted_rest', 'app.js'), 'utf8').replace(/__NETRA_SCOPE__/g, 'x_196061_netra_v1');

// run the REST resource with a fake request/response
function serve(file) {
    var out = { status: 0, type: '', headers: {}, body: '' };
    var response = {
        setStatus: function (s) { out.status = s; }, setContentType: function (t) { out.type = t; },
        setHeader: function (k, v) { out.headers[k] = v; },
        getStreamWriter: function () { return { writeString: function (s) { out.body += s; } }; }
    };
    vm.runInNewContext(APP, { request: { pathParams: { file: file } }, response: response, JSON: JSON, String: String });
    return out;
}

T.test('the manifest has everything a phone needs to install Netra', function () {
    var r = serve('manifest');
    T.eq(r.status, 200);
    T.eq(r.type, 'application/manifest+json');
    var m = JSON.parse(r.body);
    T.eq(m.short_name, 'Netra');
    T.match(m.start_url, /^\/sp\?id=netra_live(&|$)/, 'opens the live page');
    T.eq(m.start_url.indexOf(m.scope), 0, 'the start page is inside the scope');
    T.eq(m.display, 'standalone');
    var sizes = m.icons.map(function (i) { return i.sizes + ':' + i.purpose; });
    T.ok(sizes.indexOf('192x192:any') >= 0 && sizes.indexOf('512x512:any') >= 0, 'the 192 and 512 icons Chrome requires: ' + sizes.join(', '));
    T.ok(sizes.indexOf('512x512:maskable') >= 0, 'a maskable icon for Android');
    m.icons.forEach(function (i) { T.match(i.src, /^\/netra-app-[\w-]+\.png$/, 'served from db_image'); });
    T.ok(/^#[0-9a-f]{6}$/i.test(m.theme_color) && /^#[0-9a-f]{6}$/i.test(m.background_color));
    T.eq(serve('manifest.webmanifest').status, 200, 'the usual file names work too');
});

T.test('the service worker parses, may control /sp, and only answers an offline navigation to Netra', function () {
    var r = serve('sw');
    T.eq(r.status, 200);
    T.eq(r.type, 'application/javascript');
    T.eq(r.headers['Service-Worker-Allowed'], '/', 'the page can register it for the /sp scope');
    T.match(r.headers['Cache-Control'], /no-cache/, 'a new version is picked up');
    new vm.Script(r.body);   // parses
    // exercise the fetch handler: other requests are left alone, an offline
    // navigation to the live page gets the offline page
    var handlers = {}, responded = [];
    var sw = { addEventListener: function (k, f) { handlers[k] = f; }, skipWaiting: function () {}, clients: { claim: function () {} } };
    function Resp(body, init) { this.body = body; this.init = init; }
    vm.runInNewContext(r.body, { self: sw, Response: Resp, fetch: function () { return Promise.reject(new Error('offline')); } });
    ['install', 'activate', 'fetch'].forEach(function (k) { T.ok(typeof handlers[k] === 'function', k + ' handler'); });
    handlers.fetch({ request: { mode: 'cors', method: 'GET', url: 'https://x/api/now/table/incident' }, respondWith: function (p) { responded.push(p); } });
    handlers.fetch({ request: { mode: 'navigate', method: 'GET', url: 'https://x/sp?id=index' }, respondWith: function (p) { responded.push(p); } });
    T.eq(responded.length, 0, 'the rest of the portal is untouched');
    handlers.fetch({ request: { mode: 'navigate', method: 'GET', url: 'https://x/sp?id=netra_live' }, respondWith: function (p) { responded.push(p); } });
    T.eq(responded.length, 1);
    return responded[0].then(function (res) {
        T.match(res.body, /Netra is offline/);
        T.match(res.init.headers['Content-Type'], /text\/html/);
    });
});

T.test('an unknown app file is a 404', function () {
    T.eq(serve('secrets').status, 404);
});

T.test('the page learns where the app files are', function () {
    new S.Session();
    T.eq(N.request({}).app_base, '/api/x_196061_netra_v1/voice/app');
    T.eq(N.request({}).ear_base, '/api/x_196061_netra_v1/voice/ear', 'v7.9 - the ear\'s files from this instance');
});

function page() {
    var cl = N.loadClient(), c = cl.c;
    c.events = []; c.data = c.data || {};
    ['logEvent', 'cue', '_convoPush', 'unlockAudio'].forEach(function (n) { cl.set(n, function () {}); });
    cl.set('$scope', { $applyAsync: function () {}, $on: function () {} });
    cl.set('_activated', false); cl.set('_voiceBlocked', false); cl.set('_installEvt', null);
    return cl;
}

T.test('install: the browser\'s own prompt where there is one, the Home Screen steps on iOS', function () {
    var cl = page(), c = cl.c, prompted = 0;
    c.app = { canInstall: true, standalone: false, ios: false, showHelp: false, installed: false };
    cl.set('_installEvt', { prompt: function () { prompted++; }, userChoice: { then: function (f) { f({ outcome: 'accepted' }); } } });
    cl.fn._installApp();
    T.eq(prompted, 1, 'Chrome\'s install dialog');
    T.eq(c.app.canInstall, false, 'a prompt can be used once');
    T.eq(c.app.showHelp, false);
    var cl2 = page(), c2 = cl2.c;
    c2.app = { canInstall: false, standalone: false, ios: true, showHelp: false, installed: false };
    cl2.fn._installApp();
    T.eq(c2.app.showHelp, true, 'iOS: Share > Add to Home Screen');
    cl2.fn._installApp();
    T.eq(c2.app.showHelp, false, 'the same button closes it');
});

T.test('iOS always gets the Start tap, and the tap unlocks speech inside the tap', function () {
    var cl = page(), f = cl.fn, c = cl.c, spoken = [];
    cl.set('$window', { navigator: { userActivation: { hasBeenActive: true } }, document: { addEventListener: function () {} } });
    c.app = { ios: true };
    T.eq(f._needsActivation(), true, 'even when the page reports an activation');
    c.app = { ios: false };
    T.eq(f._needsActivation(), false);
    // the tap speaks a silent line through the page's own synthesiser
    c.app = { ios: true }; c.hasTTS = true;
    global.SpeechSynthesisUtterance = function (t) { this.text = t; };
    cl.set('TTS', { speak: function (u) { spoken.push(u); } });
    cl.set('_gateUpdate', function () {});
    cl.set('_ctrlDestroyed', false);
    // the tap's touchend: the event WebKit counts as the gesture
    f._onPageActivated({ type: 'touchend' });
    T.eq(spoken.length, 1);
    T.eq(spoken[0].volume, 0, 'silent');
    T.eq(f._needsActivation(), false, 'after the tap');
    delete global.SpeechSynthesisUtterance;
});

T.test('the settings never open over the stage by themselves, on a phone, a desktop or for a Guest', function () {
    [[{ is_guest: true }, 1280, false], [{ is_guest: false }, 390, false], [{ is_guest: false }, 1280, false]].forEach(function (k) {
        var cl = page(), f = cl.fn, c = cl.c;
        c.data = k[0]; c.setupOn = false; c.labCalib = { stage: 'idle' };
        cl.set('$window', { innerWidth: k[1], navigator: {}, document: { addEventListener: function () {} } });
        cl.set('_firstRunPending', function () { return true; });
        cl.set('speak', function () {});
        cl.set('startCalibration', function () {});
        global.document = global.document || { querySelector: function () { return null; } };
        f._firstRunCheck();
        T.eq(c.setupOn, k[2], JSON.stringify(k[0]) + ' at ' + k[1] + ' px');
    });
});

T.run(__filename);
