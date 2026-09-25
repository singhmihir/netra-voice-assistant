/* The loading screen, second pass: what a review of the gate found.
 *
 * An ear that is still loading can hear, whatever the browser lacks. The
 * portal's header and footer are never left inert once Netra goes, by Leave,
 * by a single-page navigation, or by a late timer. A refused Gemini key is
 * answered from the web, as the greeting promised, not refused once per
 * model. And a page answering from the web keeps doing so while the models
 * are only busy. */
var T = require('./lib/t'), N = require('./lib/netra'), S = require('./lib/session'), gem = S.gem;

function noop() {}
function page() {
    var cl = N.loadClient(), c = cl.c;
    c.events = []; c.heard = []; c.micHealth = {}; c.stats = {}; c.convo = []; c.hasSR = true; c.hasTTS = false;
    c.permission = 'granted'; c.data = {};
    ['logEvent', 'cue', '_convoPush', 'unlockAudio', '_silenceCurrentAudio', 'stopFillerChain', 'stopMicLevelMeter'].forEach(function (n) { cl.set(n, noop); });
    cl.set('$scope', { $applyAsync: noop, $on: noop });
    cl.set('$timeout', Object.assign(function () { return {}; }, { cancel: noop }));
    cl.set('_nativeVerdict', 'unknown'); cl.set('_nativeHeardWords', false); cl.set('_voiceCheckStart', Date.now());
    cl.set('_gateInert', []); cl.set('_gateHeld', null); cl.set('_ctrlDestroyed', false);
    c.ear = { mode: 'auto', size: 'auto', on: false, status: 'off', progress: 0, prepared: false, model: 'onnx-community/whisper-tiny.en', device: 'wasm', error: '', heard: 0, why: '' };
    c.gate = { open: false, everOpen: false, hearing: false, voice: false, brain: true, hearingText: '', voiceText: '', brainText: 'ready' };
    return cl;
}

/* ---- 1. an ear on its way can hear, even with no Worker in sight ---- */

T.test('an ear that is loading, on standby or on is never "can not hear", whatever the browser lacks', function () {
    var cl = page(), f = cl.fn, c = cl.c;
    delete global.Worker;   // as in Node: the old rule read this as "no ear"
    cl.set('_nativeVerdict', 'blocked');
    ['loading', 'standby'].forEach(function (st) {
        c.ear.status = st; c.ear.progress = 40;
        T.eq(f._cantHear(), false, st);
    });
    c.ear.status = 'on'; c.ear.on = true;
    T.eq(f._cantHear(), false, 'on');
    c.ear.on = false; c.ear.status = 'loading'; f._readyUpdate();
    T.eq(c.gate.cantHear, false);
    T.match(c.gate.hearingText, /loading my on-device ear 40%/, 'the card shows the download, not "type instead"');
    // a failed ear with no recognizer: typing is what is left
    c.ear.status = 'error';
    T.eq(f._cantHear(), true, 'error');
});

/* ---- 2. the portal is given back when Netra goes ---- */

function fakePage() {
    var doc = { activeElement: null };
    function el(tag, cls, kids, noInert) {
        var e = { tagName: tag.toUpperCase(), attrs: {}, children: [], parentNode: null };
        if (!noInert) e.inert = false;
        if (cls) e.attrs['class'] = cls;
        e.getAttribute = function (n) { return e.attrs.hasOwnProperty(n) ? e.attrs[n] : null; };
        e.setAttribute = function (n, v) { e.attrs[n] = String(v); };
        e.removeAttribute = function (n) { delete e.attrs[n]; };
        e.hasAttribute = function (n) { return e.attrs.hasOwnProperty(n); };
        e.contains = function (x) { for (; x; x = x.parentNode) if (x === e) return true; return false; };
        e.focus = function () { doc.activeElement = e; };
        e.querySelectorAll = function (sel) {
            var out = [];
            (function walk(n) { n.children.forEach(function (k) { if (sel.indexOf('.') !== 0 ? /^(A|BUTTON)$/.test(k.tagName) : (' ' + (k.attrs['class'] || '') + ' ').indexOf(' ' + sel.substring(1) + ' ') >= 0) out.push(k); walk(k); }); })(e);
            return out;
        };
        e.querySelector = function (sel) { return e.querySelectorAll(sel)[0] || null; };
        (kids || []).forEach(function (k) { k.parentNode = e; e.children.push(k); });
        return e;
    }
    var p = {};
    p.link = el('a', 'sp-link');
    p.header = el('header', 'sp-header', [p.link], true);   // a browser without inert
    p.start = el('button', 'netra-ready-start');
    p.dialog = el('div', 'netra-ready', [p.start]);
    p.stage = el('div', 'netra-stage', [p.dialog]);
    p.footer = el('footer', 'sp-footer');
    p.body = el('body', '', [p.header, p.stage, p.footer]);
    doc.body = p.body; doc.activeElement = p.body;
    doc.querySelector = function (sel) { return p.body.querySelector(sel); };
    doc.removeEventListener = noop;
    p.doc = doc;
    return p;
}
function inert(e) { return e.hasAttribute('inert') || e.getAttribute('aria-hidden') === 'true'; }
function shut(cl) {
    var p = fakePage();
    cl.set('$window', { document: p.doc, removeEventListener: noop, history: { length: 2, back: function () { p.back = true; } }, location: { assign: noop } });
    cl.c.liveMode = true;
    cl.fn._gateModal();
    T.ok(inert(p.header) && inert(p.footer), 'the modal is on');
    T.eq(p.link.getAttribute('tabindex'), '-1');
    return p;
}
function givenBack(p, how) {
    [p.header, p.footer].forEach(function (e) { T.ok(!inert(e), how + ': given back: ' + e.attrs['class']); });
    T.eq(p.link.getAttribute('tabindex'), null, how + ': the portal link is back in the tab order');
}

T.test('Leave, a single-page navigation and a late timer never leave the portal header inert', function () {
    // Leave on the loading card
    var cl = page(), p = shut(cl);
    cl.fn._liveExit();   // c.liveExit
    T.ok(p.back, 'it goes back');
    givenBack(p, 'Leave');
    // the portal destroys the widget but keeps its header and footer
    var cl2 = page(), p2 = shut(cl2);
    cl2.fn._destroyController();
    givenBack(p2, 'destroyed');
    // a modal timer queued before the destroy fires after it
    var cl3 = page(), p3 = fakePage();
    cl3.set('$window', { document: p3.doc, removeEventListener: noop });
    cl3.c.liveMode = true;
    cl3.fn._destroyController();
    cl3.fn._gateModal();
    givenBack(p3, 'late timer');
    T.ok(p3.doc.activeElement !== p3.start, 'and the focus is not pulled into a card that is gone');
});

/* ---- 3. a refused key: answered from the web, as promised ---- */

function webWorks(P) {
    var inner = P.HTTP;
    P.HTTP = function (req) {
        if (/wikipedia\.org\/api\/rest_v1\/page\/summary|wikipedia\.org\/w\/api\.php/.test(req.endpoint)) {
            return { status: 200, body: JSON.stringify({ type: 'standard', title: 'Kubernetes', extract: 'Kubernetes automates deploying, scaling and managing containers.', content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Kubernetes' } }, query: { search: [{ title: 'Kubernetes' }] } }) };
        }
        if (/bing\.com\/search/.test(req.endpoint)) return { status: 200, body: '<rss><channel><item><title>Kubernetes - Wikipedia</title><link>https://en.wikipedia.org/wiki/Kubernetes</link><description>Kubernetes automates deploying, scaling and managing containers.</description></item></channel></rss>' };
        return inner ? inner(req) : { status: 404, body: '' };
    };
}

T.test('server: after "my Gemini key was refused", the next question is answered, not refused once per model', function () {
    var refused = gem.http(401, { error: { code: 401, message: 'API key not valid.', status: 'UNAUTHENTICATED' } });
    var s = new S.Session();
    s.P.user = { sys_id: 'u_guest', name: 'Guest', user_name: 'guest' }; s.P.ROLES = {};
    var log = gem.install(s.P, [refused, refused, refused]);
    webWorks(s.P);
    var d = N.request({ action: 'ready_check' }).ready;
    T.eq(d.mode, 'web', 'the page was told web answers');
    var r = s.say('what is kubernetes');
    T.notMatch(r.message, /not authori[sz]ed|check the configuration/i);
    T.match(r.message, /Kubernetes automates deploying/);
    T.eq(log.generate.length, 2, 'one refusal for the question, not one per model');
    // signed in: basic mode, saying why once
    var s2 = new S.Session();
    gem.install(s2.P, [refused]);
    webWorks(s2.P);
    var r2 = s2.say('what is kubernetes');
    T.notMatch(r2.message, /not authori[sz]ed/i);
    T.match(r2.message, /my Gemini key was refused/);
});

/* ---- 4. web mode holds while the models are only busy ---- */

T.test('in web mode a "busy" check keeps the page answering; a web search that is down closes it', function () {
    function probe(reason) {
        var cl = page(), f = cl.fn, c = cl.c;
        cl.set('speak', noop);
        c.ready = true;
        c.gate = { open: true, everOpen: true, hearing: true, voice: true, brain: true, brainMode: 'web', hearingText: '', voiceText: '', brainText: 'answers from the web only' };
        c.server = { get: function () { return { then: function (ok) { ok({ data: { ready: { ready: false, reason: reason, wait_ms: 10000, say: 'The free AI models are overloaded right now - I will keep trying.' } } }); } }; } };
        f._brainProbe('web mode');
        return c.gate;
    }
    var g1 = probe('busy');
    T.eq(g1.open, true, 'no loading screen for one busy ping');
    T.eq(g1.brainMode, 'web');
    T.eq(g1.brainText, 'answers from the web only');
    var g2 = probe('search_down');
    T.eq(g2.open, false, 'no web and no models: the card comes back');
});

T.run(__filename);
