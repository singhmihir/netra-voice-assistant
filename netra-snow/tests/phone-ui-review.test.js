/* The phone and stage controls, second pass.
 *
 * Leaving Netra gives the portal back its header and footer; Escape closes
 * an open sheet or the typing box first, and otherwise stops her talking; Mute really stops
 * both ears and the cloud recognizer; while muted or ended the status never
 * says "talk to interrupt"; the Lab sheet clears the control bar at every
 * phone width. */
'use strict';
var T = require('./lib/t'), N = require('./lib/netra');
var fs = require('fs'), path = require('path');
var TPL = fs.readFileSync(path.join(N.SRC, 'widget', 'template.html'), 'utf8');
var CSS = fs.readFileSync(path.join(N.SRC, 'widget', 'stylesheet.scss'), 'utf8');
var SRC = fs.readFileSync(path.join(N.SRC, 'widget', 'client.js'), 'utf8');

global.window = global.window || {};

// a very small DOM: children, attributes and querySelectorAll by tag or [attr]
function El(tag, attrs) {
    this.tagName = String(tag).toUpperCase(); this.attrs = {}; this.children = []; this.parentNode = null;
    this.style = {}; this.offsetParent = {}; this.isConnected = true;
    for (var k in (attrs || {})) this.attrs[k] = attrs[k];
}
El.prototype.setAttribute = function (k, v) { this.attrs[k] = String(v); };
El.prototype.getAttribute = function (k) { return this.attrs.hasOwnProperty(k) ? this.attrs[k] : null; };
El.prototype.hasAttribute = function (k) { return this.attrs.hasOwnProperty(k); };
El.prototype.removeAttribute = function (k) { delete this.attrs[k]; };
El.prototype.appendChild = function (ch) { ch.parentNode = this; this.children.push(ch); return ch; };
El.prototype.focus = function () { DOC.activeElement = this; };
El.prototype.contains = function (el) { for (; el; el = el.parentNode) if (el === this) return true; return false; };
El.prototype.all = function () { var out = []; this.children.forEach(function (ch) { out.push(ch); out = out.concat(ch.all()); }); return out; };
El.prototype.matches = function (sel) {
    var self = this;
    return sel.split(',').some(function (s) {
        s = s.trim();
        var cls = s.match(/^\.([\w-]+)$/), m = s.match(/^([a-z]*)(?:\[([a-z-]+)\])?$/i);
        if (cls) return (' ' + (self.attrs['class'] || '') + ' ').indexOf(' ' + cls[1] + ' ') >= 0;
        if (!m) return false;
        if (m[1] && self.tagName !== m[1].toUpperCase()) return false;
        if (m[2] && !self.hasAttribute(m[2])) return false;
        return true;
    });
};
El.prototype.querySelectorAll = function (sel) { return this.all().filter(function (el) { return el.matches(sel); }); };
El.prototype.querySelector = function (sel) { return this.querySelectorAll(sel)[0] || null; };
El.prototype.closest = function (sel) { for (var el = this; el; el = el.parentNode) if (el.matches && el.matches(sel)) return el; return null; };
var DOC = null;
function makeDoc(withInert) {
    var d = new El('#document'); d.head = d.appendChild(new El('head')); d.body = d.appendChild(new El('body'));
    if (withInert) d.body.inert = false;
    d.activeElement = d.body;
    DOC = d; global.document = d;
    return d;
}
function el(tag, cls, attrs) { var e = new El(tag, attrs); if (cls) e.attrs['class'] = cls; return e; }

// the page's controller with its outside world stubbed
function page() {
    makeDoc(true);
    var cl = N.loadClient(), c = cl.c, set = cl.set, rec = { spoken: [], heard: [], stops: [], enq: [], barge: [], started: 0, later: [] };
    function noop() {}
    var now = function (fn) { if (typeof fn === 'function') fn(); return 0; };
    now.cancel = noop;
    set('$timeout', now);
    set('$scope', { $applyAsync: noop, $on: noop });
    set('speak', function (text, done) { rec.spoken.push(String(text)); if (done) done(); });
    set('logEvent', noop);
    set('_heardLog', function (t, conf, fate) { rec.heard.push(fate); });
    set('stopSpeaking', function (why) { rec.stops.push(why); });
    set('_enqueueFinalTranscript', function (t) { rec.enq.push(t); });
    set('_handleFinalWhileSpeaking', function (t) { rec.barge.push(t); return true; });
    ['cue', 'tone', 'openConversation', 'closeConversation', '_cancelPlanContinue', '_dropFinalBuffer', 'attachGrammar', '_earNext', '_readyUpdate']
        .forEach(function (n) { set(n, noop); });
    set('STATE_LABEL', { speaking: 'speaking', dormant: 'asleep' });
    set('LIVE_STATUS', { idle: 'Listening', speaking: 'Speaking — just talk to interrupt', dormant: 'Asleep — say Netra or tap to wake me' });
    set('_inertMade', []); set('_inertTabs', []); set('_inertFreed', false);
    set('_speakingNow', false); set('_fillerChainActive', false); set('currentFillerAudio', null); set('currentFillerUtter', null);
    set('ignoreFinalsUntil', 0); set('recLastActivityAt', Date.now()); set('_micGainNode', null); set('contRec', null);
    set('_earQueue', []); set('_earSeg', []); set('_earRing', []); set('_earInSpeech', false); set('_ctrlDestroyed', false);
    c.events = []; c.stats = {}; c.micHealth = {}; c.heard = [];
    c.alert = true; c.state = 'idle'; c.interim = ''; c.recRunning = true; c.permission = 'granted'; c.hasSR = true;
    c.app = { canInstall: false, standalone: false, ios: false, showHelp: false, installed: false, fromApp: false };
    c.micGain = 1; c.micOff = false; c.ended = false;
    return { c: c, f: cl.fn, get: cl.get, set: set, rec: rec };
}

// the live page: the portal's skip link, header (with links), footer, and Netra
function portal() {
    var d = DOC;
    var skip = d.body.appendChild(el('a', 'skip', { href: '#main' }));
    var header = d.body.appendChild(el('header', 'navbar', { 'aria-hidden': 'false' }));
    var login = header.appendChild(el('a', '', { href: '/login' }));
    var menu = header.appendChild(el('button', '', { tabindex: '0' }));
    var wrap = d.body.appendChild(el('div', 'page'));
    var root = wrap.appendChild(el('div', 'netra-root'));
    root.appendChild(el('div', 'netra-stage'));
    var footer = wrap.appendChild(el('footer', '', { 'aria-hidden': 'true' }));   // the portal's own setting
    var modal = d.body.appendChild(el('div', 'modal', { inert: '', 'aria-hidden': 'true' }));   // the portal's own inert
    return { skip: skip, header: header, login: login, menu: menu, footer: footer, modal: modal };
}

// ---- 1. leaving Netra gives the portal back -----------------------------------

T.test('leaving the live page undoes inert and aria-hidden on the portal, and keeps the portal\'s own settings', function () {
    var p = page(); p.c.liveMode = true;
    var e = portal();
    p.f._inertChrome(); p.f._inertChrome();   // the 0.5 s and the 4 s runs
    [e.skip, e.header, e.footer].forEach(function (x) { T.ok(x.hasAttribute('inert') && x.getAttribute('aria-hidden') === 'true', x.tagName + ' quieted'); });
    p.f._uninertChrome();
    T.ok(!e.skip.hasAttribute('inert') && !e.skip.hasAttribute('aria-hidden'), 'skip link reachable again');
    T.ok(!e.header.hasAttribute('inert'), 'header reachable again');
    T.eq(e.header.getAttribute('aria-hidden'), 'false', 'header aria-hidden back to what the portal had');
    T.ok(!e.footer.hasAttribute('inert'), 'footer not left inert');
    T.eq(e.footer.getAttribute('aria-hidden'), 'true', 'the portal\'s own aria-hidden is kept');
    T.ok(e.modal.hasAttribute('inert') && e.modal.getAttribute('aria-hidden') === 'true', 'the portal\'s own inert is kept');
    p.f._inertChrome();
    T.ok(!e.header.hasAttribute('inert'), 'a late timer does not quiet it again');
    T.match(SRC, /\$scope\.\$on\('\$destroy', _uninertChrome\)/, 'undone when the portal moves to another page');
});

T.test('an older browser without inert: the tabindex taken away is given back', function () {
    var p = page(); p.c.liveMode = true;
    makeDoc(false);
    var e = portal();
    p.f._inertChrome();
    T.eq(e.login.getAttribute('tabindex'), '-1'); T.eq(e.menu.getAttribute('tabindex'), '-1');
    p.f._uninertChrome();
    T.eq(e.login.getAttribute('tabindex'), null, 'no tabindex it did not have');
    T.eq(e.menu.getAttribute('tabindex'), '0', 'its own tabindex back');
});

T.test('End for a signed-in desktop user gives the portal back before going back', function () {
    var p = page(), c = p.c; c.liveMode = true; c.data = { is_guest: false };
    var e = portal();
    p.f._inertChrome();
    var inertWhenLeft = null;
    p.set('$window', { history: { length: 3, back: function () { inertWhenLeft = e.header.hasAttribute('inert'); } }, location: { assign: function () {} } });
    p.f._liveExit();
    T.eq(inertWhenLeft, false, 'the header is reachable on the page we go back to');
});

// ---- 2. Escape still silences her ----------------------------------------------

T.test('Escape in a sheet or the typing box closes only that; with nothing open it stops her talking', function () {
    var p = page(), c = p.c, handler = null;
    p.set('$window', { innerWidth: 1024, addEventListener: function (k, f) { if (k === 'keydown') handler = f; } });
    p.f.bindHotkeys();
    T.ok(handler, 'the page listens for keys');
    c.liveMode = true; c.gate = { open: true };
    // the sheet's own ng-keydown first, then the page, unless it was stopped
    function press(own, target) {
        var stopped = false;
        var ev = { key: 'Escape', target: target || DOC.body, preventDefault: function () {}, stopPropagation: function () { stopped = true; } };
        if (own) own(ev);
        if (!stopped) handler(ev);
    }
    p.f._setupToggle();
    press(p.f._sheetKey);
    T.eq(c.setupOn, false, 'Settings closed');
    T.eq(p.rec.stops, [], 'Escape there closes the sheet, it does not also cut her off');
    p.f._sheetOpen('log', '.netra-ctl-log');
    press(null);   // the focus fell to the page: the page's Escape closes the open sheet first
    T.eq(c.sheet, null, 'Transcript closed');
    T.eq(p.rec.stops, []);
    p.f._typeToggle(true);
    press(null);
    T.eq(c.typeOn, false, 'the typing box closed first');
    T.eq(p.rec.stops, []);
    press(null);
    T.eq(p.rec.stops, ['Escape key'], 'nothing open: she stops talking');
});

// ---- 3. the on-device ear while muted ---------------------------------------------

T.test('muted: what the on-device ear hears is not a barge-in, not a command and not on screen', function () {
    var p = page(), c = p.c;
    c.ear.on = true;
    p.set('_earInSpeech', true); p.set('_earSeg', [new Float32Array(4)]); p.set('_earSegMs', 900); p.set('_earVoiceMs', 700);
    p.set('_earRing', [new Float32Array(4)]); p.set('_earRingMs', 300); p.set('_earQueue', [{ audio: new Float32Array(4), meta: null }]);
    p.set('setState', function (s) { c.state = s; });
    p.f._micMute();
    T.eq(p.get('_earInSpeech'), false, 'the segment in progress is dropped');
    T.eq(p.get('_earSeg').length, 0); T.eq(p.get('_earRing').length, 0, 'no pre-roll from before Mute');
    T.eq(p.get('_earQueue').length, 0, 'nothing waiting to be worked out');
    // a segment that was already in the worker comes back while she says "Mic off"
    p.set('_speakingNow', true);
    p.f._earDeliver('turn it down a bit', { overlap: false });
    p.f._earDeliver('stop', null);
    T.eq(p.rec.barge.length, 0, 'her "Mic off" is not cut off');
    T.eq(p.rec.enq.length, 0, 'nothing goes on to be a command');
    T.eq(p.rec.heard, ['ignored: mic muted', 'ignored: mic muted']);
    p.set('_earInSpeech', true);
    p.f._earOnMessage({ data: { text: 'turn it down', partial: true, ms: 200 } });
    T.eq(c.interim, '', 'no words on screen while muted');
});

// ---- 4. the browser recognizer while muted -----------------------------------------

T.test('muted: the browser recognizer is stopped and nothing starts it again until Unmute', function () {
    var p = page(), c = p.c, aborted = 0, made = 0;
    p.set('contRec', { abort: function () { aborted++; }, stop: function () {} });
    p.set('SR', function () { made++; this.start = function () {}; });
    p.set('setState', function (s) { c.state = s; });
    p.f._micMute(true);
    T.eq(aborted, 1, 'no more audio to the cloud recognizer');
    T.eq(c.recRunning, false);
    p.f.startContinuous();
    T.eq(made, 0, 'onend, the watchdogs and a tab coming back do not restart it');
    // the listening watchdog: three ticks with the recognizer down
    var tick = null;
    p.set('$timeout', function (fn) { tick = fn; return 0; });
    ['currentAudio', 'TTS', '_speakingText'].forEach(function (n) { p.set(n, null); });
    p.set('_deafCheck', function () {});
    var restarts = 0; p.set('startContinuous', function () { restarts++; });
    p.f.startListeningWatchdog();
    for (var i = 0; i < 4; i++) tick();
    T.eq(restarts, 0, 'the watchdog leaves a muted recognizer alone');
    p.set('$timeout', function (fn) { fn(); return 0; });
    p.f._micUnmute();
    T.eq(restarts, 1, 'Unmute starts it again');
    T.eq(c.micOff, false);
});

// ---- 5. the status while muted or ended ------------------------------------------------

T.test('while muted or ended her status never says "talk to interrupt", and nothing is announced around her line; ended stays ended while she speaks', function () {
    var p = page(), c = p.c;
    c.micOff = true; c.hasTTS = true;
    p.f.setState('dormant');
    T.eq([c.liveStatus, c.liveHint, c.liveKind], ['Mic off', 'Press Mute or tap Netra to turn it on', 'muted']);
    var said = [], val = c.srSay;
    Object.defineProperty(c, 'srSay', { configurable: true, get: function () { return val; }, set: function (v) { said.push(v); val = v; } });
    p.f.setState('speaking');
    T.eq([c.liveStatus, c.liveHint], ['Speaking', 'Mic off'], 'her "Mic off." line: speaking, the mic still off');
    p.f.setState('dormant');
    T.eq(said, [], 'no second announcement around her line: her voice says it');
    c.ended = true;
    p.f.setState('speaking');
    T.eq([c.liveStatus, c.liveHint, c.liveKind], ['Ended', 'The mic is off', 'ended'], 'her goodbye does not flip it');
    c.micOff = false; c.ended = false;
    p.f.setState('speaking');
    T.eq([c.liveStatus, c.liveHint], ['Speaking', 'Talk or tap to interrupt'], 'listening as usual: talking does interrupt');
});

// ---- 6. the Lab sheet above the round controls -------------------------------------------

function block(src, media) {
    var at = src.indexOf(media);
    T.ok(at >= 0, 'found ' + media);
    var depth = 0, i = src.indexOf('{', at), start = i;
    for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
    return src.slice(start, i + 1);
}
function px(text, re) { var m = text.match(re); T.ok(m, 'found ' + re); return +m[1]; }

T.test('the Lab sheet on a phone clears the control bar and its focus rings at every width up to 600 px', function () {
    var bar = CSS.slice(CSS.indexOf('R28 - THE CONTROL BAR'));
    var top = px(rule(bar, '.netra-stage-controls'), /padding: (\d+)px/);
    var home = px(TPL, /\.netra-stage \.netra-stage-controls \{ padding-bottom: max\((\d+)px/);
    var ctl = px(rule(bar, '.netra-ctl'), /min-height: (\d+)px/);
    var ring = px(bar, /\.netra-ctl:focus-visible \.netra-ctl-ico \{ outline: (\d+)px/) + px(bar, /\.netra-ctl:focus-visible \.netra-ctl-ico \{[^}]*outline-offset: (\d+)px/);
    T.ok(ring <= top, 'the ring over the circles stays inside the bar (' + ring + ' of ' + top + ' px)');
    var phone = block(TPL, '@media (max-width: 600px)');
    var lab = px(phone.slice(phone.indexOf('.netra-stage .netra-lab {')), /bottom: calc\((\d+)px/);
    T.ok(lab >= home + ctl + top, 'up to 600 px: the Lab at ' + lab + ' px, the bar reaches ' + (home + ctl + top));
    T.notMatch(TPL, /480 px and less: the controls sit/, 'one bar height at every phone width');
});

function rule(src, sel) {
    var at = src.indexOf(sel + ' {');
    T.ok(at >= 0, 'found the rule ' + sel);
    return src.slice(at, src.indexOf('}', at) + 1);
}

T.run(__filename);
