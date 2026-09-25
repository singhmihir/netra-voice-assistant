/* Netra Live: where the focus goes, and what is said over her voice.
 *
 * A screen-reader or keyboard user must never land on <body> because a
 * button they were on went away (Try again, the mic check's card, the
 * loading card after Start again), never hear a waiting state read over
 * her voice, and the keys must keep working wherever the focus is on the
 * stage. Found in the review of the v7.7 stage (X1 - X12). */
'use strict';
var T = require('./lib/t'), N = require('./lib/netra'), S = require('./lib/session'), g = S.g;
var fs = require('fs'), path = require('path');
var TPL = fs.readFileSync(path.join(N.SRC, 'widget', 'template.html'), 'utf8');
var SRC = fs.readFileSync(path.join(N.SRC, 'widget', 'client.js'), 'utf8');
var STYLE = TPL.slice(TPL.indexOf('<style>'), TPL.indexOf('</style>'));

var store = {};
function memStore() {
    store = {};
    global.localStorage = { getItem: function (k) { return store.hasOwnProperty(k) ? store[k] : null; }, setItem: function (k, v) { store[k] = String(v); }, removeItem: function (k) { delete store[k]; } };
}
memStore();
global.window = global.window || {};

// a very small DOM (as in live-stage.test.js): querySelector by tag, .class and #id
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
        var m = s.match(/^([a-z]*)(?:\[([a-z-]+)\])?$/i), cls = s.match(/^\.([\w-]+)$/), id = s.match(/^#([\w-]+)$/);
        if (cls) return (' ' + (self.attrs['class'] || '') + ' ').indexOf(' ' + cls[1] + ' ') >= 0;
        if (id) return self.attrs.id === id[1];
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
function makeDoc() {
    var d = new El('#document'); d.head = d.appendChild(new El('head')); d.body = d.appendChild(new El('body'));
    d.createElement = function (t) { return new El(t); };
    d.activeElement = d.body;
    DOC = d; global.document = d;
    return d;
}
function el(tag, cls, attrs) { var e = new El(tag, attrs); if (cls) e.attrs['class'] = cls; return e; }
function noop() {}

// the page's controller with its outside world stubbed; $timeout runs at once
function page() {
    makeDoc();
    memStore();
    var cl = N.loadClient(), c = cl.c, set = cl.set, rec = { spoken: [], cues: [], stops: [], sent: [], resumed: [] };
    var now = function (fn) { if (typeof fn === 'function') fn(); return 0; };
    now.cancel = noop;
    set('$timeout', now);
    set('$scope', { $applyAsync: noop, $on: noop });
    set('$window', { document: DOC, innerWidth: 1280, addEventListener: noop, removeEventListener: noop, matchMedia: function () { return { matches: false }; } });
    set('speak', function (text, done) { rec.spoken.push(String(text)); if (done) done(); });
    set('logEvent', noop);
    set('cue', function (k) { rec.cues.push(k); });
    set('stopSpeaking', function (why) { rec.stops.push(why); });
    set('handleHeard', function (t) { rec.sent.push(t); });
    set('_resumeAudio', function (why) { rec.resumed.push(why); return false; });
    ['tone', 'openConversation', 'closeConversation', '_convoPush', 'attachGrammar', '_pushConfidence', 'stopFillerChain', 'unlockAudio',
     'startContinuous', '_cancelPlanContinue', '_memPersist', '_heardLog', '_dropFinalBuffer', '_earForget', '_restoreDuck', '_cancelReprompt',
     '_labRestorePos', '_heardFate', '_labNlpCapture']
        .forEach(function (n) { set(n, noop); });
    set('_speakingNow', false); set('_fillerChainActive', false); set('currentFillerAudio', null); set('currentFillerUtter', null);
    set('_inertMade', []); set('_inertTabs', []); set('_inertFreed', false); set('_ctrlDestroyed', false); set('_gateInert', []);
    set('booted', true); set('_micGainNode', null); set('contRec', null); set('_annLast', null); set('_annTimer', null);
    set('_turnEpoch', 1); set('_waitLadder', null); set('_keptSaid', ''); set('_calibActive', false); set('_calibTimer', null); set('_calibSession', 0);
    c.events = []; c.stats = {}; c.micHealth = {}; c.data = {}; c.heard = []; c.convo = [];
    c.alert = true; c.state = 'idle'; c.lastHeard = ''; c.spoken = ''; c.interim = ''; c.recRunning = true; c.hasTTS = true;
    c.labCalib = { stage: 'idle' }; c.gate = { open: true };
    c.app = { canInstall: false, standalone: false, ios: false, showHelp: false, installed: false, fromApp: false };
    c.micOff = false; c.ended = false; c.captionKeep = false; c.liveKind = 'listen'; c.srSay = ''; c.srAlert = '';
    c.bargeOn = true; c.sounds = 'on'; c.typeOn = false; c.sheet = null; c.setupOn = false; c.labOn = false; c.liveMode = true;
    return { c: c, f: cl.fn, get: cl.get, set: set, rec: rec };
}
// timers that run when the fake clock reaches them
function clock(p) {
    var real = Date.now, t = 1e12, q = [];
    var fake = function (fn, ms) { var x = { fn: fn, due: t + (ms || 0), off: false, ran: false }; q.push(x); return x; };
    fake.cancel = function (x) { if (x) x.off = true; };
    p.set('$timeout', fake);
    Date.now = function () { return t; };
    return {
        advance: function (ms) {
            var end = t + ms;
            for (;;) {
                var next = null;
                q.forEach(function (x) { if (!x.off && !x.ran && x.due <= end && (!next || x.due < next.due)) next = x; });
                if (!next) break;
                t = next.due; next.ran = true; next.fn();
            }
            t = end;
        },
        restore: function () { Date.now = real; }
    };
}
// every value written to c[k]
function writes(c, k) {
    var log = [], val = c[k];
    Object.defineProperty(c, k, { configurable: true, get: function () { return val; }, set: function (v) { log.push(v); val = v; } });
    return log;
}
function key(k, extra) {
    var e = { key: k, prevented: 0, stopped: 0, preventDefault: function () { e.prevented++; }, stopPropagation: function () { e.stopped++; } };
    for (var x in (extra || {})) e[x] = extra[x];
    return e;
}
// the stage, its orb and the Try again row
function stage() {
    var st = DOC.body.appendChild(el('div', 'netra-stage'));
    var orb = st.appendChild(el('button', 'netra-stage-blob-wrap'));
    var row = st.appendChild(el('div', 'netra-retry-row'));
    return { stage: st, orb: orb, row: row, tryBtn: row.appendChild(el('button', 'netra-retry')), typeBtn: row.appendChild(el('button', 'netra-retry netra-retry-type')) };
}

// ---- X1. a waiting state is never read over her voice ------------------------------

T.test('X1: "Couldn’t get an answer" or "Thinking…" still waiting its 500 ms is dropped when she starts speaking', function () {
    var p = page(), c = p.c, f = p.f, k = clock(p), said = writes(c, 'srSay');
    try {
        c.state = 'thinking'; c.liveKind = 'work';
        f.setState('error');      // a failed turn...
        k.advance(200);
        f.setState('speaking');   // ...and at once her apology
        k.advance(2000);
        T.eq(said, [], 'nothing written over her voice');
        f.setState('idle');
        k.advance(2000);
        c.liveKind = 'listen'; said.length = 0;
        f.setState('thinking');
        k.advance(100);
        f.setState('speaking');   // a quick answer
        k.advance(2000);
        T.eq(said, [], 'no "Thinking…" over her answer');
        // captions only (no voice): the state is the only way it is said
        c.hasTTS = false; c.liveKind = 'work'; c.state = 'thinking';
        f.setState('error');
        k.advance(600);
        T.eq(said, ['Couldn’t get an answer']);
    } finally { k.restore(); }
});

T.test('X1: speak() hushes a state not yet said, even before the engine sets the speaking state', function () {
    var p = page(), c = p.c, f = p.f, k = clock(p), said = writes(c, 'srSay'), played = [];
    try {
        p.set('speak', f.speak);   // the real one, with its engines stubbed
        ['_markSpeaking', '_afterTTS'].forEach(function (n) { p.set(n, noop); });
        p.set('speakBrowser', function (t) { played.push(t); });
        p.set('_humanizeReply', function (t) { return t; });
        p.set('_speakSessionId', 0);
        c.ttsEngine = 'browser';
        c.state = 'thinking'; c.liveKind = 'work';
        f.setState('error');
        k.advance(100);
        f.speak('Sorry, I could not reach the server.');
        k.advance(2000);
        T.eq(played.length, 1, 'her voice plays');
        T.eq(said, [], 'the error state is not read over it');
    } finally { k.restore(); }
});

// ---- X2. the Try again row never takes the focus with it -------------------------

T.test('X2: focus on Try again moves to the orb when a reply takes the row away, or a new question does', function () {
    var p = page(), c = p.c, f = p.f, s = stage();
    // the 20 s wait put Try again up; the reply arrives
    c.state = 'thinking'; c.liveKind = 'work'; c.canRetry = true;
    s.tryBtn.focus();
    f.setState('speaking');
    T.eq(c.canRetry, false);
    T.ok(DOC.activeElement === s.orb, 'the reply: focus on the orb, not <body>');
    // after a failed turn a new question ends it
    ['matchLocal', 'normalizeNumbers'].forEach(function (n) { p.set(n, function (t) { return n === 'matchLocal' ? null : t; }); });
    p.set('matchSleep', function () { return false; });
    c.state = 'idle'; c.liveKind = 'listen'; c.lastFailed = true;
    s.typeBtn.focus();
    f.processCommand('what are my open tickets', 1);
    T.eq(c.lastFailed, false);
    T.ok(DOC.activeElement === s.orb, 'a new question: focus on the orb');
    // the row that stays (the turn failed) keeps the focus where it is
    c.state = 'thinking'; c.liveKind = 'work'; c.canRetry = true;
    s.tryBtn.focus();
    f._turnFailed({ text: 'x' });
    T.eq(c.liveKind, 'error');
    T.ok(DOC.activeElement === s.tryBtn, 'still on Try again');
    f.setState('speaking');
    T.ok(DOC.activeElement === s.tryBtn, 'through her apology too');
    // focus elsewhere is left alone
    var head = DOC.body.appendChild(el('button', 'netra-head-settings'));
    head.focus();
    c.lastFailed = false; f.setState('idle');
    T.ok(DOC.activeElement === head);
});

// ---- X3. the orb on an iPhone that needs a tap -----------------------------------

T.test('X3: while the mic needs a tap the orb is named for it and a (VoiceOver) tap wakes the audio, never pauses', function () {
    var p = page(), c = p.c, f = p.f;
    c.micNeedsTap = true; c.alert = true; c.state = 'idle';
    T.eq([f._orbAction(), f._orbLabel()], ['wake', 'Tap so Netra can hear you']);
    f._tapOrb();
    T.eq(p.rec.resumed, ['tap'], 'the audio is resumed');
    T.eq([c.state, c.alert], ['idle', true], 'not paused');
    T.notMatch(p.rec.spoken.join(' '), /Paused/);
    // she talks: a tap still stops her; paused: a tap still resumes
    c.state = 'speaking';
    T.eq(f._orbAction(), 'stop');
    c.state = 'dormant'; c.alert = false;
    T.eq(f._orbAction(), 'resume');
    c.micNeedsTap = false; c.state = 'idle'; c.alert = true;
    T.eq(f._orbAction(), 'pause', 'without it, as before');
});

// ---- X4. the mic check's card -------------------------------------------------------

function card() {
    var s = stage(), cd = s.stage.appendChild(el('div', 'netra-calib-card'));
    s.skip = cd.appendChild(el('button', 'netra-calib-skip'));
    s.retry = cd.appendChild(el('button', 'netra-calib-retry'));
    s.close = cd.appendChild(el('button', 'netra-calib-close'));
    return s;
}
T.test('X4: Skip, Close and the card going hand the focus to the orb', function () {
    var p = page(), c = p.c, f = p.f, s = card();
    p.set('_calibActive', true); c.labCalib = { stage: 'listening' };
    s.skip.focus();
    f._calibSkip();
    T.eq(c.labCalib.stage, 'skipped');
    T.ok(DOC.activeElement === s.orb, 'Skip: the orb');
    c.labCalib = { stage: 'done' };
    s.close.focus();
    f._calibDismiss();
    T.ok(DOC.activeElement === s.orb, 'Close: the orb');
    // Escape while she reads the prompt ends the check too
    p.set('stopSpeaking', f.stopSpeaking);
    ['_clearSpeaking', 'detachOutputAnalyser', 'stopFillerChain'].forEach(function (n) { p.set(n, noop); });
    p.set('_speakSessionId', 0); p.set('_edgeLiveWs', null); p.set('currentAudio', null); p.set('TTS', null);
    p.set('_calibActive', true); c.labCalib = { stage: 'prompt' };
    s.skip.focus();
    f.stopSpeaking('Escape key');
    T.eq(c.labCalib.stage, 'skipped');
    T.ok(DOC.activeElement === s.orb, 'Escape: the orb');
    // the focus somewhere else is left there
    var head = DOC.body.appendChild(el('button', 'netra-head-settings'));
    head.focus();
    c.labCalib = { stage: 'done' };
    f._calibDismiss();
    T.ok(DOC.activeElement === head);
    T.match(SRC, /c\.calibSkip = function \(\) \{ _calibSkip\(\); \};/);
    T.match(TPL, /<button class="netra-calib-retry" ng-show="c\.labCalib\.stage === 'done' \|\| c\.labCalib\.stage === 'timeout'" ng-click="c\.calibRetry\(\)">Try again<\/button>/);
    T.match(TPL, /<button class="netra-calib-close" ng-show="c\.labCalib\.stage === 'done' \|\| c\.labCalib\.stage === 'timeout'" ng-click="c\.calibDismiss\(\)">Close<\/button>/);
});

T.test('X4: Run mic check, then Try again, a result and nothing heard: the focus follows the card\'s buttons', function () {
    var p = page(), c = p.c, f = p.f, s = card(), k = clock(p);
    try {
        // a re-run from the result: Try again goes, Skip comes
        c.labCalib = { stage: 'timeout' };
        s.retry.focus();
        f._calibRetry();
        k.advance(60);
        T.eq(c.labCalib.stage, 'listening');
        T.ok(DOC.activeElement === s.skip, 'the re-run: Skip');
        // 25 s and nothing heard: Try again
        k.advance(25000);
        T.eq(c.labCalib.stage, 'timeout');
        k.advance(60);
        T.ok(DOC.activeElement === s.retry, 'nothing heard: Try again');
        // the sentence read back: the result, and Close
        f._calibRetry();
        k.advance(60);
        T.ok(DOC.activeElement === s.skip);
        p.set('_calibListenStart', 0);
        T.eq(f._calibConsume('The quick brown fox jumps over the lazy dog near the big green screen'), true);
        T.eq(c.labCalib.stage, 'done');
        k.advance(60);
        T.ok(DOC.activeElement === s.close, 'a result: Close');
    } finally { k.restore(); }
});

// ---- X5. Try again sends the question that failed ----------------------------------

T.test('X5: Try again sends the failed question, not a later "stop"; an automatic turn goes again as one', function () {
    var p = page(), c = p.c, f = p.f;
    f._turnFailed({ text: 'create an incident for the VPN', auto: false });
    c.lastHeard = 'stop';   // "stop" was heard after it and never reached processCommand
    f._retryTurn();
    T.eq(p.rec.sent, ['create an incident for the VPN']);
    T.eq(c.lastFailed, false);
    // the morning briefing (auto) failed: it is retried as an automatic turn
    f._turnFailed({ text: 'give me my daily briefing', auto: true });
    c.lastHeard = 'what are my open tickets';
    f._retryTurn();
    T.eq(p.rec.sent[1], 'give me my daily briefing');
    T.eq(c._nextTurnAuto, 'give me my daily briefing', 'marked automatic again');
    // a plan hop
    f._turnFailed({ text: '[continue plan]', auto: false });
    f._retryTurn();
    T.eq(p.rec.sent[2], '[continue plan]');
    // pressed again with nothing failed: nothing is sent
    c.state = 'error'; c.lastFailed = true;
    f._retryTurn();
    T.eq(p.rec.sent.length, 3);
    T.eq(c.state, 'idle');
    // Try again at the 20 s wait (the turn has not failed): the one on the wire
    p.set('_sentAsk', { text: 'what is on my approvals', auto: false });
    c.canRetry = true; c.lastFailed = false;
    f._retryTurn();
    T.eq(p.rec.sent[3], 'what is on my approvals');
});

T.test('X5: the question a turn sent is what a transport error keeps for Try again', function () {
    var p = page(), c = p.c, f = p.f, fail = null;
    p.set('handleHeard', f.handleHeard);
    ['_drainQueuedUtterance', 'startFillerChain', '_countTool', '_pushLatency'].forEach(function (n) { p.set(n, noop); });
    p.set('_chatInFlight', false); p.set('_queuedUtterance', null); p.set('_bargedReply', null); p.set('_repliesPending', 0);
    p.set('_chatSeq', 0); p.set('geminiHistory', []); p.set('_prosFirstAt', 0); p.set('_fillerStartTimer', null);
    p.set('$timeout', (function () { var t = function () { return {}; }; t.cancel = noop; return t; })());
    c.mem = { prompts: 0, kb: 0 }; c.stats = { utterances: 0, errors: 0 };
    c.server = { update: function () { return { then: function (ok, bad) { fail = bad; } }; } };
    c._nextTurnAuto = 'what did you do while i was away';
    f.handleHeard('what did you do while i was away');
    fail(new Error('offline'));
    T.eq(p.get('_failedAsk'), { text: 'what did you do while i was away', auto: true });
    T.eq(c.lastFailed, true);
    c.lastHeard = 'stop';
    p.set('handleHeard', function (t) { p.rec.sent.push(t); });
    f._retryTurn();
    T.eq(p.rec.sent, ['what did you do while i was away']);
});

// ---- X6. a shared reviewer account is not greeted by name --------------------------

T.test('X6: the greeting does not name a read-only reviewer account; a person is still greeted by name', function () {
    var p = page(), c = p.c, f = p.f;
    c.data = { user_name: 'Netra Reviewer', read_only: true };
    var say = f._greeting();
    T.notMatch(say, /(morning|afternoon|evening), Netra|Reviewer/, 'no name');
    T.match(say, /^Good (morning|afternoon|evening)\. I'm Netra, and I'm listening\./);
    c.data = { user_name: 'Beth Anglin' };
    T.match(f._greeting(), /^Good (morning|afternoon|evening), Beth\. I'm Netra/);
});

T.test('X6: the page load tells the client a read-only reviewer account; never a Guest or a person', function () {
    var s = new S.Session();
    s.P.user = { sys_id: 'u_rev', name: 'Netra Reviewer', user_name: 'netra.reviewer' };
    s.P.ROLES = { itil: true, snc_read_only: true };
    g.put('sys_user_role', { sys_id: 'r_ro', name: 'snc_read_only' });
    g.put('sys_user_has_role', { sys_id: 'uhr1', user: 'u_rev', role: 'r_ro' });
    T.eq(N.loadServer({ route: true }).data.read_only, true, 'the reviewer');
    new S.Session();
    T.eq(N.loadServer({ route: true }).data.read_only, false, 'a signed-in person');
    var gs = new S.Session(); gs.P.user = { sys_id: 'u_guest', name: 'Guest', user_name: 'guest' }; gs.P.ROLES = {};
    var d = N.loadServer({ route: true }).data;
    T.eq([d.is_guest, d.read_only], [true, false], 'a Guest');
    // only on the page load, next to is_guest
    T.eq(N.request({ action: 'poll' }).read_only, undefined, 'not on every call');
});

// ---- X7. Alt+D over an open sheet, and on a Mac --------------------------------------

T.test('X7: Alt+D (Option+D on a Mac types ∂) closes an open sheet before it opens the Lab', function () {
    var p = page(), c = p.c, f = p.f, handler = null;
    var x = DOC.body.appendChild(el('button', 'netra-lab-x'));
    p.set('$window', { document: DOC, innerWidth: 1280, addEventListener: function (k, fn) { if (k === 'keydown') handler = fn; } });
    f.bindHotkeys();
    f._setupToggle();
    T.eq([c.setupOn, c.sheet], [true, 'settings']);
    var e = key('∂', { altKey: true, code: 'KeyD', target: DOC.body });
    handler(e);
    T.eq(c.labOn, true, 'the Lab opens from the key\'s place');
    T.eq([c.setupOn, c.sheet], [false, null], 'the sheet stepped aside');
    T.ok(DOC.activeElement === x, 'focus on the Lab, not behind a scrim');
    T.eq(e.prevented, 1);
    handler(key('∂', { altKey: true, code: 'KeyD', target: DOC.body }));
    T.eq(c.labOn, false, 'and closes it');
    // a keyboard with no code still works by the letter
    handler(key('d', { altKey: true, target: DOC.body }));
    T.eq(c.labOn, true);
});

// ---- X8. Start again after Leave on the loading card -------------------------------

T.test('X8: Start again after Leave on the loading card: the card is a modal again with the focus in it, and no "I\'m listening"', function () {
    var p = page(), c = p.c, f = p.f;
    var st = DOC.body.appendChild(el('div', 'netra-stage'));
    var orb = st.appendChild(el('button', 'netra-stage-blob-wrap'));
    var ready = st.appendChild(el('div', 'netra-ready'));
    var title = ready.appendChild(el('h2', 'netra-ready-title', { id: 'netra-ready-title', tabindex: '-1' }));
    st.appendChild(el('div', 'netra-stage-controls')).appendChild(el('button', 'netra-ctl netra-ctl-mic'));
    p.set('_voiceReady', function () { return true; });
    c.ear = { status: 'loading' }; c.ready = false; c.readyText = 'Getting ready';
    c.gate = { open: false, typing: false, everOpen: false, hearing: false, voice: true, brain: true, hearingText: '', voiceText: '', brainText: '' };
    // Leave on the card (a Guest): ended here, the card went and gave back what it made inert
    p.set('_gateShut', true);
    c.ended = true; c.micOff = true; c.state = 'dormant'; c.liveKind = 'ended';
    orb.focus();
    f._liveRestart();
    T.eq([c.ended, c.micOff], [false, false]);
    T.ok(DOC.activeElement === title, 'focus in the card');
    T.ok(p.get('_gateInert').length > 0, 'what is behind it is inert again');
    T.notMatch(p.rec.spoken.join(' '), /listening/i, 'she can not hear yet');
    // with the gate open, as before
    var q = page(), orb2 = DOC.body.appendChild(el('button', 'netra-stage-blob-wrap'));
    q.c.ended = true; q.c.micOff = true;
    q.f._liveRestart();
    T.match(q.rec.spoken.join(' '), /Hi again — I’m listening\./);
    T.ok(DOC.activeElement === orb2);
});

// ---- X9. keys after a click on the stage's background -----------------------------

T.test('X9: M, T and / still work when the focus is on <body> or the portal\'s scroller round the stage', function () {
    var p = page(), c = p.c, f = p.f, handler = null, mutes = 0;
    p.set('$window', { document: DOC, innerWidth: 1280, addEventListener: function (k, fn) { if (k === 'keydown') handler = fn; } });
    f.bindHotkeys();
    c.toggleMic = function () { mutes++; };
    var scroller = DOC.body.appendChild(el('section', 'page sp-scroll'));
    var st = scroller.appendChild(el('div', 'netra-stage'));
    st.appendChild(el('button', 'netra-stage-blob-wrap'));
    var e = key('m', { target: scroller });
    handler(e);
    T.eq([mutes, e.prevented], [1, 1], 'the scroller the click left the focus on');
    handler(key('m', { target: DOC.body }));
    T.eq(mutes, 2, '<body>');
    handler(key('t', { target: st }));
    T.eq(c.sheet, 'log', 'the stage itself (a click on its background)');
    f._sheetClose();
    // off the Live page the portal is the portal
    c.liveMode = false;
    T.eq(f._stageKey(key('m', { target: scroller })), false);
    // a click on the stage's background keeps the focus on the stage
    T.match(TPL, /<div class="netra-stage" ng-if="c\.liveMode" tabindex="-1" ng-class=/);
    T.match(STYLE, /\.netra-root \.netra-stage:focus \{ outline: none; \}/);
});

// ---- X10. the Lab's own keys -----------------------------------------------------------

T.test('X10: Escape outside the Lab closes it before it stops her; on a phone Tab stays in the Lab', function () {
    var p = page(), c = p.c, f = p.f, handler = null;
    T.eq(f._stageKeyAction('Escape', 'BUTTON', false, false, null, false, true, true, true), 'close-lab');
    T.eq(f._stageKeyAction('Escape', 'BUTTON', false, false, 'settings', false, true, true, true), 'close-sheet', 'a sheet first');
    T.eq(f._stageKeyAction('Escape', 'BUTTON', false, false, null, true, true, true, false), 'close-type');
    var win = { document: DOC, innerWidth: 1280, addEventListener: function (k, fn) { if (k === 'keydown') handler = fn; } };
    p.set('$window', win);
    f.bindHotkeys();
    var st = DOC.body.appendChild(el('div', 'netra-stage')), orb = st.appendChild(el('button', 'netra-stage-blob-wrap'));
    var lab = st.appendChild(el('aside', 'netra-lab'));
    var x = lab.appendChild(el('button', 'netra-lab-x')), send = lab.appendChild(el('button')), copy = lab.appendChild(el('button', 'netra-lab-diag'));
    c.labOn = true; c.state = 'speaking';
    handler(key('Escape', { target: orb }));
    T.eq(c.labOn, false, 'the Lab closed');
    T.eq(p.rec.stops, [], 'she was not stopped');
    handler(key('Escape', { target: orb }));
    T.eq(p.rec.stops, ['Escape key'], 'the next Escape stops her');
    // a desktop: the Lab is a window beside the stage, Tab moves on
    c.labOn = true;
    copy.focus();
    var t1 = key('Tab');
    f._labKey(t1);
    T.eq(t1.prevented, 0);
    T.eq(f._labModal(), false);
    // a phone: it covers the stage, Tab wraps inside it (Copy diagnostics is in it)
    win.innerWidth = 390;
    T.eq(f._labModal(), true);
    var t2 = key('Tab');
    f._labKey(t2);
    T.ok(DOC.activeElement === x && t2.prevented === 1, 'from Copy diagnostics to Close');
    var t3 = key('Tab', { shiftKey: true });
    f._labKey(t3);
    T.ok(DOC.activeElement === copy, 'and back');
    send.focus();
    var t4 = key('Tab');
    f._labKey(t4);
    T.eq(t4.prevented, 0, 'in between, Tab is the browser\'s');
    T.match(TPL, /<aside class="netra-lab"[^>]*ng-attr-aria-modal="\{\{c\.labOn && c\.labCovers \? 'true' : undefined\}\}"/);
    T.match(SRC, /c\.labModal = function \(\) \{ return _labModal\(\); \};/);
});

T.test('X10: the Lab is a modal wherever it lies over the stage, measured - a phone held sideways, a tablet - and not where it sits beside it', function () {
    // the review measured the Lab over the status and the typing row at
    // 667-915 px sideways and over the orb on a 768 px tablet, while a
    // 600 px width rule called it a window there
    var p = page(), c = p.c, f = p.f;
    function box(e, l, t, r, b) { e.getBoundingClientRect = function () { return { left: l, top: t, right: r, bottom: b, width: r - l, height: b - t }; }; return e; }
    var st = DOC.body.appendChild(el('div', 'netra-stage'));
    var orb = box(st.appendChild(el('button', 'netra-stage-blob-wrap')), 57, 51, 297, 291);
    var status = box(st.appendChild(el('div', 'netra-status')), 354, 48, 844, 79);
    var lab = box(st.appendChild(el('aside', 'netra-lab')), 436, 56, 836, 330);
    p.set('$window', { document: DOC, innerWidth: 844 });
    c.labOn = true;
    T.eq(f._labModal(), true, '844 x 390 sideways: it covers the status');
    T.eq(c.labCovers, true, 'kept for the template');
    box(lab, 900, 56, 1260, 600); box(orb, 458, 56, 822, 420); box(status, 0, 420, 1280, 482);
    p.set('$window', { document: DOC, innerWidth: 1280 });
    box(status, 0, 420, 880, 482);
    T.eq(f._labModal(), false, 'a desktop with the Lab beside the stage: a window');
    box(lab, 300, 100, 700, 500);
    T.eq(f._labModal(), true, 'the same desktop with the Lab dragged over the orb');
    c.labOn = false;
    T.eq(f._labModal(), false); T.eq(c.labCovers, false);
});

T.test('X7: a sheet opening while the Lab is up closes the Lab, so closing the Lab never leaves the focus behind the sheet', function () {
    var p = page(), c = p.c, f = p.f;
    DOC.body.appendChild(el('h2', '', { id: 'netra-log-h', tabindex: '-1' }));
    c.labOn = true; c.labCovers = true;
    f._sheetOpen('log', '.netra-ctl-log');
    T.eq(c.labOn, false); T.eq(c.labCovers, false);
    T.eq(c.sheet, 'log');
    T.ok(DOC.activeElement === DOC.querySelector('#netra-log-h'), 'the sheet has the focus');
});

T.test('X4: "mic check" said again after a result moves the focus from the card\'s Close to its Skip', function () {
    // the verdict says 'say mic check' to run it again: that road goes
    // straight to startCalibration, not through Try again
    var p = page(), c = p.c, f = p.f, s = card();
    c.labCalib = { stage: 'done', verdict: 'Say "mic check" to run it again.' };
    s.close.focus();
    p.set('_calibActive', false);
    p.set('speak', function () {});   // the prompt is still being read
    f.startCalibration(false);
    T.eq(c.labCalib.stage, 'prompt');
    T.ok(DOC.activeElement === s.skip, 'Skip, the one button the card shows now');
    // with the focus elsewhere it stays there
    var p2 = page(), s2 = card(), head = DOC.body.appendChild(el('button', 'netra-head-settings'));
    head.focus();
    p2.set('_calibActive', false); p2.set('speak', function () {});
    p2.f.startCalibration(false);
    T.ok(DOC.activeElement === head);
});

// ---- X11. a starter chip reached by Tab shows whole -----------------------------------

T.test('X11: a chip focused by Tab scrolls whole into its row, ring and the faded edge included', function () {
    var p = page(), f = p.f;
    T.eq(f._chipScroll(0, 300, 280, 400), 125, 'partly shown at the right: its right edge, the ring and the fade');
    T.eq(f._chipScroll(0, 300, -50, 60), -55, 'at the left: its ring too');
    T.eq(f._chipScroll(0, 300, 50, 150), 0, 'shown: left alone');
    T.eq(f._chipScroll(0, 100, 150, 400), 145, 'wider than the row: its start shows');
    var row = DOC.body.appendChild(el('div', 'netra-try'));
    row.scrollLeft = 10;
    row.getBoundingClientRect = function () { return { left: 16, right: 374 }; };
    var chip = row.appendChild(el('button', 'netra-try-chip'));
    chip.getBoundingClientRect = function () { return { left: 330, right: 470 }; };
    p.c.chipFocus = null;
    f._chipInView(chip);
    T.eq(row.scrollLeft, 10 + 470 + 25 - 374);
    T.match(TPL, /class="netra-try-chip" ng-repeat="s in c\.starters\(\) track by \$index" ng-click="c\.tryStarter\(s\)" ng-focus="c\.chipFocus\(\$event\)"/);
    T.match(SRC, /c\.chipFocus = function \(ev\) \{ _chipInView\(ev && ev\.target\); \};/);
});

// ---- X12. Tab goes down the screen -------------------------------------------------

T.test('X12: the starters and the typing box come before the bar in the page, as they do on screen', function () {
    var at = function (s) { var i = TPL.indexOf(s); T.ok(i > 0, 'found ' + s); return i; };
    var center = at('<div class="netra-stage-center">'), type = at('<form class="netra-type" id="netra-type"'),
        tryRow = at('<div class="netra-try" role="group"'), bar = at('<div class="netra-stage-controls" role="group"'),
        lab = at('<aside class="netra-lab"');
    T.ok(center < type && type < bar, 'the typing box before the bar');
    T.ok(center < tryRow && tryRow < bar, 'the starters before the bar');
    T.ok(bar < lab, 'all on the stage');
});

T.run(__filename);
