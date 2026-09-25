/* The Live stage core (package A): one state model, one announcer, an
 * anchored grid, a labelled caption box, an orb that does what its name
 * says, a look per state, a named wait with Try again, and a portal that
 * stays out of the Tab order.
 *
 * A screen reader hears each thing once: the status row is never a live
 * region, #netra-say and the stage's alert are written only through
 * _announce, and her words reach them only when no voice plays. */
'use strict';
var T = require('./lib/t'), N = require('./lib/netra'), contrast = require('./lib/contrast').contrast;
var fs = require('fs'), path = require('path');
var TPL = fs.readFileSync(path.join(N.SRC, 'widget', 'template.html'), 'utf8');
var CSS = fs.readFileSync(path.join(N.SRC, 'widget', 'stylesheet.scss'), 'utf8');
var SRC = fs.readFileSync(path.join(N.SRC, 'widget', 'client.js'), 'utf8');
// the stage markup up to the Lab, and the stage section of the stylesheet
var STAGE = TPL.slice(TPL.indexOf('<div class="netra-stage" ng-if="c.liveMode"'), TPL.indexOf('<aside class="netra-lab"'));
var STAGE_CSS = CSS.slice(CSS.indexOf('R8 / R28 - NETRA LIVE STAGE'), CSS.indexOf('/* R21 - the loading screen */'));
var STYLE = TPL.slice(TPL.indexOf('<style>'), TPL.indexOf('</style>'));

var store = {};
function memStore() {
    store = {};
    global.localStorage = { getItem: function (k) { return store.hasOwnProperty(k) ? store[k] : null; }, setItem: function (k, v) { store[k] = String(v); }, removeItem: function (k) { delete store[k]; } };
}
memStore();
global.window = global.window || {};

// a very small DOM: querySelector by tag[attr="v"], tag[attr*="v"], .class and #id
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
        var m = s.match(/^([a-z]*)(?:\[([a-z-]+)(?:(\*|~)?="([^"]*)")?\])?$/i), cls = s.match(/^\.([\w-]+)$/), id = s.match(/^#([\w-]+)$/);
        if (cls) return (' ' + (self.attrs['class'] || '') + ' ').indexOf(' ' + cls[1] + ' ') >= 0;
        if (id) return self.attrs.id === id[1];
        if (!m) return false;
        if (m[1] && self.tagName !== m[1].toUpperCase()) return false;
        if (m[2] && !self.hasAttribute(m[2])) return false;
        if (m[2] && m[4] !== undefined) {
            if (m[3] === '*') return String(self.attrs[m[2]]).indexOf(m[4]) >= 0;
            return (' ' + self.attrs[m[2]] + ' ').indexOf(' ' + m[4] + ' ') >= 0;
        }
        return true;
    });
};
El.prototype.querySelectorAll = function (sel) { return this.all().filter(function (el) { return el.matches(sel); }); };
El.prototype.querySelector = function (sel) { return this.querySelectorAll(sel)[0] || null; };
El.prototype.closest = function (sel) { for (var el = this; el; el = el.parentNode) if (el.matches && el.matches(sel)) return el; return null; };
var DOC = null;
function makeDoc() {
    var d = new El('#document'); d.head = d.appendChild(new El('head')); d.body = d.appendChild(new El('body'));
    d.body.inert = false;   // a browser with inert
    d.createElement = function (t) { return new El(t); };
    d.activeElement = d.body;
    DOC = d; global.document = d;
    return d;
}
function el(tag, cls, attrs) { var e = new El(tag, attrs); if (cls) e.attrs['class'] = cls; return e; }

function noop() {}
// the page's controller with its outside world stubbed (as in phone-ui.test.js)
function page() {
    makeDoc();
    memStore();
    var cl = N.loadClient(), c = cl.c, set = cl.set, rec = { spoken: [], cues: [], stops: [] };
    var now = function (fn) { if (typeof fn === 'function') fn(); return 0; };
    now.cancel = noop;
    set('$timeout', now);
    set('$scope', { $applyAsync: noop, $on: noop });
    set('$window', { document: DOC, addEventListener: noop, removeEventListener: noop, matchMedia: function () { return { matches: false }; } });
    set('speak', function (text, done) { rec.spoken.push(String(text)); if (done) done(); });
    set('logEvent', noop);
    set('cue', function (k) { rec.cues.push(k); });
    set('stopSpeaking', function (why) { rec.stops.push(why); });
    ['tone', 'openConversation', 'closeConversation', '_convoPush', 'attachGrammar', '_pushConfidence', 'stopFillerChain', 'unlockAudio',
     'startContinuous', '_cancelPlanContinue', '_memPersist', '_heardLog', '_dropFinalBuffer', '_earForget', '_restoreDuck', '_cancelReprompt']
        .forEach(function (n) { set(n, noop); });
    set('_speakingNow', false); set('_fillerChainActive', false); set('currentFillerAudio', null); set('currentFillerUtter', null);
    set('_inertMade', []); set('_inertTabs', []); set('_inertFreed', false); set('_ctrlDestroyed', false); set('_gateInert', []);
    set('booted', true); set('_micGainNode', null); set('contRec', null); set('_annLast', null); set('_annTimer', null);
    set('_turnEpoch', 1); set('_waitLadder', null); set('_keptSaid', '');
    c.events = []; c.stats = {}; c.micHealth = {}; c.data = {}; c.heard = [];
    c.alert = true; c.state = 'idle'; c.lastHeard = ''; c.spoken = ''; c.interim = ''; c.recRunning = true; c.hasTTS = true;
    c.labCalib = { stage: 'idle' }; c.gate = { open: true };
    c.app = { canInstall: false, standalone: false, ios: false, showHelp: false, installed: false, fromApp: false };
    c.micOff = false; c.ended = false; c.captionKeep = false; c.liveKind = 'listen'; c.srSay = ''; c.srAlert = '';
    c.bargeOn = true; c.sounds = 'on';
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
// the text of the CSS rule for a selector, and of an @media (or any) block
function rule(src, sel) {
    var at = src.indexOf(sel + ' {');
    T.ok(at >= 0, 'found the rule ' + sel);
    return src.slice(at, src.indexOf('}', at) + 1);
}
function block(src, head) {
    var at = src.indexOf(head);
    T.ok(at >= 0, 'found ' + head);
    var depth = 0, i = src.indexOf('{', at), start = i;
    for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
    return src.slice(start, i + 1);
}

// ---- A1. one state model, one announcer, no double speech -------------------------

T.test('A1: the status model - one kind, label and hint per state, muted and ended before paused', function () {
    var p = page(), c = p.c, f = p.f;
    c.micOff = true;
    T.eq(f._liveStatusFor('dormant'), { kind: 'muted', label: 'Mic off', hint: 'Press Mute or tap Netra to turn it on' });
    T.eq(f._liveStatusFor('speaking'), { kind: 'speak', label: 'Speaking', hint: 'Mic off' });
    c.micOff = false;
    T.eq(f._liveStatusFor('dormant'), { kind: 'paused', label: 'Paused', hint: 'Say “Netra” or tap to resume' });
    c.ended = true;
    T.eq(f._liveStatusFor('dormant'), { kind: 'ended', label: 'Ended', hint: 'The mic is off' });
    c.ended = false;
    c.state = 'speaking'; c.bargeOn = false;
    T.match(f._liveStatusFor('speaking').hint, /Esc/);
    c.bargeOn = true;
    T.eq(f._liveStatusFor('speaking').hint, 'Talk or tap to interrupt');
    T.eq(f._liveStatusFor('idle'), { kind: 'listen', label: 'Listening', hint: '' });
    T.eq(f._liveStatusFor('error'), { kind: 'error', label: 'Couldn’t get an answer', hint: 'Say it again or press Try again' });
    c.activity = 'Searching the web…';
    T.eq(f._liveStatusFor('thinking'), { kind: 'work', label: 'Searching the web…', hint: '' });
    c.gate = { open: false };
    T.eq(f._liveStatusFor('idle'), { kind: 'boot', label: 'Getting ready…', hint: '' });
    c.gate = { open: false, typing: true, cantHear: true };
    T.eq(f._liveStatusFor('idle'), { kind: 'typing', label: 'Typing', hint: 'Netra can’t hear in this browser' });
    c.gate.cantHear = false;
    T.eq(f._liveStatusFor('idle').hint, 'Listening is still loading');
    T.eq(f._liveStatusFor('thinking').kind, 'work', 'a typed question while it can not hear still shows the work');
    c.gate = { open: true };
    // the iPhone mic fix is an input to the model
    c.micNeedsTap = true;
    T.eq(f._liveStatusFor('idle').label, 'Tap anywhere so I can hear you');
    c.micNeedsTap = false;
    // captions only: said once, as a hint under Listening
    c.hasTTS = false;
    T.eq(f._liveStatusFor('idle').hint, 'Replies shown as text — no voice on this device');
    ['idle', 'dormant', 'speaking', 'thinking', 'error'].forEach(function (s) {
        var st = f._liveStatusFor(s);
        T.notMatch(st.label + ' ' + st.hint, /\bshe\b|press Unmute/, s);
    });
});

T.test('A1: the announcer plan - the same text within 1.5 s is not said again, a state waits 500 ms, an alert is assertive', function () {
    var f = page().f;
    T.eq(f._announcePlan({ text: 'Listening', at: 1000 }, 'Listening', 'state', 2000).write, false);
    T.eq(f._announcePlan({ text: 'Listening', at: 1000 }, 'Listening', 'state', 2600).write, true, 'after 1.5 s it may be said again');
    T.eq(f._announcePlan(null, 'Thinking…', 'state', 0).delay, 500);
    T.eq(f._announcePlan(null, 'Hello.', 'reply', 0), { write: true, delay: 0, slot: 'srSay' });
    T.eq(f._announcePlan(null, 'Back online.', 'info', 0).delay, 0);
    T.eq(f._announcePlan(null, 'You’re offline.', 'alert', 0).slot, 'srAlert');
});

T.test('A1: a state is said 500 ms later and only the last of a quick run; the same words again are re-read', function () {
    var p = page(), c = p.c, f = p.f, k = clock(p), said = writes(c, 'srSay');
    try {
        f._announce('Thinking…', 'state');
        k.advance(200);
        f._announce('Speaking', 'state');
        k.advance(499);
        T.eq(said, [], 'nothing yet');
        k.advance(1);
        T.eq(said, ['Speaking'], 'the last call wins');
        k.advance(2000);
        f._announce('Speaking', 'reply');
        k.advance(30);
        T.eq(said, ['Speaking', '', 'Speaking'], 'emptied first, so a screen reader reads it again');
        f._announce('Microphone blocked', 'alert');
        T.eq(c.srAlert, 'Microphone blocked');
        T.eq(said.length, 3, 'an alert never touches the polite region');
    } finally { k.restore(); }
});

T.test('A1: setState says a state only when its kind changes; her turn ending is an earcon; the greeting covers boot', function () {
    var p = page(), c = p.c, f = p.f, said = writes(c, 'srSay');
    c.liveKind = 'boot';
    f.setState('idle');
    T.eq(said, [], 'boot to listening: the greeting says it');
    f.setState('thinking');
    T.eq(said, ['Thinking…']);
    f.setState('speaking');
    T.eq(said, ['Thinking…'], 'with a voice, her voice is the cue: "Speaking" is not said over it');
    f.setState('idle');
    T.eq(said, ['Thinking…'], 'not "Listening" after her reply');
    T.eq(p.rec.cues[p.rec.cues.length - 1], 'open', 'the your-turn earcon instead');
    f.setState('awaiting');
    T.eq(said.length, 1, 'idle and awaiting are one kind');
    // no voice on this device: nothing else says she has the floor
    c.hasTTS = false;
    f.setState('speaking');
    T.eq(said, ['Thinking…', 'Speaking']);
    c.hasTTS = true; f.setState('idle');
    T.eq([c.liveStatus, c.liveHint, c.liveKind], ['Listening', '', 'listen']);
    T.eq(window.__netraMode, '');
    c.micOff = true; f.setState('dormant');
    T.eq(window.__netraMode, 'muted');
    c.micOff = false; f.setState('dormant');
    T.eq(window.__netraMode, 'paused');
    c.ended = true; f.setState('dormant');
    T.eq(window.__netraMode, 'ended');
    c.ended = false; c.gate = { open: true };
    T.eq(f._stateLabel('dormant'), 'paused - say Netra or tap to resume');
});

T.test('A1: with a voice, mute, pause, resume, a reply and End are heard once - her voice, never "Speaking" or a copy over it', function () {
    var p = page(), c = p.c, f = p.f, k = clock(p), said = writes(c, 'srSay'), spoken = [];
    // a voice: speaking 200 ms after the call, done 900 ms later
    p.set('speak', function (text, done) {
        spoken.push(text);
        p.get('$timeout')(function () { f.setState('speaking'); }, 200);
        p.get('$timeout')(function () { if (c.state === 'speaking') f.setState(c.alert ? 'idle' : 'dormant'); if (done) done(); }, 1100);
    });
    try {
        c.hasTTS = true; c.labMute = false;
        f.setState('idle'); k.advance(2000); said.length = 0;
        f._micMute(false); k.advance(3000);
        T.eq(said, [], 'Mute: only her "Mic off."');
        f._micUnmute(); k.advance(3000);
        T.eq(said, [], 'Unmute: only her "Mic on."');
        c.state = 'idle'; c.alert = true;
        f._tapOrb(); k.advance(3000);
        T.eq(c.liveKind, 'paused');
        T.eq(said, [], 'Pause: only her "Paused."');
        f._tapOrb(); k.advance(3000);
        T.eq(said, [], 'Resume: only her "I’m listening."');
        f.setState('thinking'); k.advance(1500); f.setState('speaking'); k.advance(3000); f.setState('idle'); k.advance(1000);
        T.eq(said, ['Thinking…'], 'a reply: the step once, then her voice');
        said.length = 0;
        ['_gateInertRestore', '_appHelpClose'].forEach(function (n) { p.set(n, noop); });
        f._endHere(); k.advance(3000);
        T.eq(said, [], 'End: only her "Netra ended. The mic is off."');
        T.eq(spoken, ['Mic off.', 'Mic on.', 'Paused.', 'I’m listening.', 'Netra ended. The mic is off.']);
        // no voice: each change is still said once
        p = page(); c = p.c; f = p.f; k.restore(); k = clock(p); said = writes(c, 'srSay');
        c.hasTTS = false;
        f.setState('idle'); k.advance(2000); said.length = 0;
        f._micMute(false); k.advance(3000);
        T.eq(said, ['Mic off'], 'no voice: the state is said');
    } finally { k.restore(); }
});

T.test('A1: no double speech - with a voice her words never reach a live region; with none, each line once and whole', function () {
    var p = page(), c = p.c, f = p.f, engine = [];
    ['_markSpeaking', '_silenceCurrentAudio'].forEach(function (n) { p.set(n, noop); });
    p.set('_humanizeReply', function (t) { return t; });
    p.set('speakBrowser', function (t, done) { engine.push(t); });
    var said = writes(c, 'srSay'), alerts = writes(c, 'srAlert');
    c.hasTTS = true; c.labMute = false;
    f.speak('Hello there.');
    T.eq(engine, ['Hello there.'], 'the voice plays it');
    T.eq(c.srSay, ''); T.eq(said, []); T.eq(alerts, []);
    // Lab mute: no voice, so the whole line once
    c.labMute = true;
    f.speak('Hello there.');
    T.eq(said, ['Hello there.'], 'written once');
    // no voice installed: a line that errors and then ends is still said once
    var p2 = page(), c2 = p2.c;
    ['_markSpeaking', '_silenceCurrentAudio', '_clearSpeaking', '_resumeAudio', '_gateUpdate'].forEach(function (n) { p2.set(n, noop); });
    global.SpeechSynthesisUtterance = function (t) { this.text = t; };
    p2.set('TTS', { speaking: false, pending: false, cancel: noop, getVoices: function () { return []; }, speak: function (u) { u.onerror({ error: 'synthesis-failed' }); u.onend(); } });
    p2.set('_speakSessionId', 1); p2.set('forcedVoiceName', '');
    var said2 = writes(c2, 'srSay');
    c2.spoken = 'Your ticket is resolved, and the change was approved this morning.';
    p2.f.speakBrowser(c2.spoken, noop);
    T.eq(said2, ['Your ticket is resolved, and the change was approved this morning.'], 'the whole line, once');
    delete global.SpeechSynthesisUtterance;
});

T.test('A1: the markup - one polite region and one alert on the stage, a status row that is never announced, no pills', function () {
    T.match(TPL, /role="alert"[^>]*ng-if="!c\.liveMode"/);
    T.notMatch(STAGE, /netra-stage-pill/); T.notMatch(STAGE, /\{\{c\.state\}\}/);
    var outside = STAGE.replace(STAGE.slice(STAGE.indexOf('<div class="netra-ready"'), STAGE.indexOf('<div class="netra-stage-center">')), '');
    T.eq((outside.match(/aria-live="polite"/g) || []).length, 1, 'one polite region outside the loading card');
    T.eq((outside.match(/role="alert"/g) || []).length, 1, 'one alert');
    T.match(STAGE, /<div class="netra-sr-only" id="netra-say" role="status" aria-live="polite" aria-atomic="true">\{\{c\.srSay\}\}<\/div>/);
    var status = STAGE.match(/<div class="netra-status"[^>]*>/)[0];
    T.notMatch(status, /role=|aria-live/, 'browse mode reads it; it is never announced');
    T.match(STAGE, /<p class="netra-status-label">\{\{c\.liveStatus\}\}<\/p>/);
    T.match(STAGE, /<p class="netra-status-hint" ng-if="c\.liveHint">\{\{c\.liveHint\}\}<\/p>/);
    var st = rule(STAGE_CSS, '.netra-status');
    T.notMatch(st, /backdrop-filter|border-radius: 999px|animation/, 'no pill, no glass, no fade');
    T.ok(contrast('#e3e3e3', '#0e0e10') >= 7 && contrast('#c4c7c5', '#0e0e10') >= 7, 'label and hint are AAA');
});

T.test('A1: the spoken copy is short and plain', function () {
    var p = page(), c = p.c, f = p.f;
    f._micMute();
    f._micUnmute();
    c.state = 'idle'; c.alert = true;
    f._tapOrb();
    f._tapOrb();
    T.eq(p.rec.spoken, ['Mic off.', 'Mic on.', 'Paused.', 'I’m listening.']);
});

// ---- A2. an anchored grid and a calm header -----------------------------------------

T.test('A2: the stage is a grid with fixed areas and the orb in its own row; landscape puts the caption beside the orb', function () {
    var st = rule(CSS, '.netra-stage');
    T.match(st, /grid-template-areas:\s*'head' 'orb' 'status' 'cap' 'aux' 'bar'/);
    T.match(st, /var\(--vvh, 100dvh\)/);
    // the orb comes from the height the other rows leave, so it never pushes the bar
    // off - in the template's own style: the portal's compiler drops a rule with
    // min() around calc(), and it took this whole grid with it once
    var own = rule(STYLE, '\n  .netra-stage');
    T.match(own, /--orb: clamp\(96px, min\(72vw, calc\(var\(--vvh, 100dvh\) - var\(--rows-h\)\)\), 420px\);/);
    T.match(own, /--rows-h: calc\(56px \+ 62px \+ var\(--cap-row\) \+ var\(--aux-h\) \+ 112px \+ env\(safe-area-inset-top, 0px\) \+ env\(safe-area-inset-bottom, 0px\)\);/);
    T.notMatch(CSS, /--orb:|--rows-h:/, 'neither in the SCSS: a compiled rule would win over the template\'s');
    T.match(st, /--cap-h: calc\(26px \+ var\(--cap-lines, 3\) \* 1\.45 \* var\(--cap, 20px\)\)/);
    var center = rule(CSS, '.netra-stage-center');
    T.match(center, /display: contents/); T.notMatch(center, /justify-content: center/);
    T.match(rule(CSS, '.netra-stage-blob-wrap'), /width: var\(--orb\);\s*height: var\(--orb\)/);
    T.match(rule(CSS, '.netra-stage-blob-wrap'), /grid-area: orb/);
    var land = block(CSS, '@media (orientation: landscape) and (max-height: 520px)');
    T.ok(land.indexOf("'orb status'") >= 0, 'the caption sits right of the orb');
    T.match(land, /grid-template-columns: minmax\(0, 42%\) minmax\(0, 1fr\)/);
    T.match(block(CSS, '@media (min-width: 700px) {\n    .netra-stage '), /--aux-h: 64px/);
    // the other rows are grid items of the stage, never the page flow
    T.match(rule(CSS, '.netra-status'), /grid-area: status/);
    T.match(rule(CSS, '.netra-cap'), /grid-area: cap/);
    T.match(rule(CSS, '.netra-calib-card'), /grid-area: aux/);
    T.match(CSS, /\n\.netra-stage-controls \{\n    grid-area: bar;/, 'the control bar lives in the bar row');
});

T.test('A2: the SCSS survives the portal\'s compiler: no calc() inside min()/max()/clamp(), no var() or env() just before a + or -', function () {
    // found live: the stage's grid rule vanished from the compiled CSS (a
    // probe showed min(40vw, calc(...)) alone drops a whole rule), and the
    // compiler writes "var(--a) + 26px" as "var(--a)+ 26px", which calc()
    // rejects - so the caption height, and the landscape grid built on it,
    // were invalid on the page
    var bare = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    var decls = bare.split(/[;{}]/);
    T.eq(decls.filter(function (d) { return /\b(min|max|clamp)\([^;{}]*calc\(/.test(d); }).map(function (d) { return d.trim().slice(0, 80); }), [],
        'min()/max()/clamp() around calc() belongs in the template\'s inline style');
    T.eq(decls.filter(function (d) { return /calc\(/.test(d) && /\)\s+[-+]\s/.test(d.slice(d.indexOf('calc('))); }).map(function (d) { return d.trim().slice(0, 80); }), [],
        'in calc(), put the var() last (26px + var(--x)), or move the sum to the inline style');
});

T.test('A2: the stage fits - the bar and the aux row end on screen at common sizes and with the keyboard open', function () {
    // the orb row and then the caption row give way; the orb follows its row
    var st = rule(CSS, '.netra-stage');
    T.match(st, /grid-template-rows: calc\(56px \+ env\(safe-area-inset-top, 0px\)\) minmax\(0, 1fr\) minmax\(min-content, auto\) minmax\(0, var\(--cap-row\)\) minmax\(min-content, var\(--aux-h\)\) auto/);
    T.notMatch(CSS, /--orb: clamp\(120px, min\(60vw, 28dvh\)/, 'no separate short-phone orb');
    // (three classes, so it beats the compiled .v<sys_id> .netra-stage-blob-wrap)
    var fit = block(STYLE, '@supports (aspect-ratio: 1 / 1)');
    T.match(fit, /\.netra-root \.netra-stage \.netra-stage-blob-wrap \{ width: auto; height: min\(var\(--orb\), 100%\); aspect-ratio: 1 \/ 1; \}/);
    T.match(rule(CSS, '.netra-cap'), /max-height: 100%/);
    // and in a real browser, when there is one: the stage laid out at the sizes people use
    var r = require('child_process').spawnSync(process.execPath, [path.join(__dirname, 'lib', 'stage-fit.js')], { encoding: 'utf8', timeout: 120000 });
    var out = JSON.parse(String(r.stdout || '').trim().split('\n').pop() || '{"error":"no output"}');
    T.ok(!out.error, 'the layout probe ran: ' + (out.error || '') + (r.stderr || ''));
    if (out.skip) { console.log('       (layout probe skipped: ' + out.skip + ')'); return; }
    var at = {};
    out.forEach(function (m) {
        var where = m.size + ' ' + m.state, vvh = / --vvh (\d+)/.exec(m.size);
        T.eq(m.stage.h, vvh ? +vvh[1] : +m.size.split(/[x ]/)[1], where + ': the stage is the visible height');
        T.ok(m.bar.bottom <= m.stage.bottom + 1, where + ': the bar ends on screen (' + m.bar.bottom + ' > ' + m.stage.bottom + ')');
        T.ok(m.aux.bottom <= m.bar.top + 1, where + ': the aux row (the composer) is above the bar');
        T.ok(Math.abs(m.orb.w - m.orb.h) <= 1, where + ': the orb is round');
        // (a phone held sideways has the status beside the orb, not under it)
        T.ok(m.orb.bottom <= m.status.top + 1 || m.orb.right <= m.status.left + 1, where + ': the orb stays clear of the status');
        // the real typing box is open in the aux row: with the keyboard up too
        T.ok(m.status.bottom <= m.cap.top + 1 && m.cap.bottom <= m.aux.top + 1, where + ': status, caption and aux do not overlap');
        if (vvh) return;
        T.ok(m.orb.w >= 96, where + ': the orb is still a big target (' + m.orb.w + ')');
        // a new caption size or state never moves the orb (Try again may make it smaller)
        if (m.state === 'retry') return;
        var o = m.orb.top + '/' + m.orb.w;
        if (at[m.size]) T.eq(o, at[m.size], where + ': the orb stays in one place');
        else at[m.size] = o;
    });
    T.ok(out.length >= 40, 'every size and state was laid out');
});

T.test('A2: the header is Settings, Netra and (for a Guest) Sign in; the decor layers are gone; system fonts only', function () {
    T.notMatch(STAGE, /netra-mesh-blob|netra-stage-aurora|netra-stage-floor/);
    T.match(STAGE, /<button type="button" class="netra-head-settings" ng-click="c\.setupToggle\(\)" aria-haspopup="dialog"\s+aria-expanded="\{\{!!c\.setupOn\}\}" aria-controls="netra-settings">/);
    T.match(STAGE, /<h1 class="netra-stage-brand">Netra<\/h1>/);
    T.match(STAGE, /<a class="netra-head-signin" ng-if="c\.data\.is_guest" ng-href="\{\{c\.loginUrl\}\}">Sign in<\/a>/);
    var head = rule(CSS, '.netra-stage-head');
    T.match(head, /grid-area: head/); T.match(head, /grid-template-columns: minmax\(0, 1fr\) auto minmax\(0, 1fr\)/);
    var set = rule(CSS, '.netra-head-settings');
    T.match(set, /min-height: 44px/); T.match(set, /border: 1px solid #8e918f/); T.match(set, /background: #1e1f20/);
    T.ok(contrast('#8e918f', '#0e0e10') >= 3 && contrast('#e3e3e3', '#1e1f20') >= 7);
    T.notMatch(rule(CSS, '.netra-stage-brand'), /background-clip|drop-shadow|letter-spacing: 0\.08em/);
    T.ok(contrast('#a8c7fa', '#0e0e10') >= 7, 'Sign in');
    // no web fonts on the stage: mono stays inside the Lab
    T.notMatch(STAGE_CSS, /JetBrains Mono|Google Sans|'Inter'/);
    var inner = STYLE.match(/[^{}]+\{[^{}]*\}/g) || [];
    inner.filter(function (r) { return /netra-stage|netra-status|netra-cap|netra-calib|netra-head/.test(r.split('{')[0]); }).forEach(function (r) {
        T.notMatch(r, /JetBrains Mono|Google Sans|font-style: italic/, r.split('{')[0].trim());
    });
});

T.test('A2: Sign in goes to the portal\'s own login link, else the login page', function () {
    var p = page();
    T.eq(p.f._loginUrl(), '/sp?id=login', 'no link on the page');
    var root = DOC.body.appendChild(el('div', 'netra-root'));
    root.appendChild(el('a', 'netra-head-signin', { href: '/sp?id=login&ours=1' }));
    T.eq(p.f._loginUrl(), '/sp?id=login', 'never our own link');
    DOC.body.appendChild(el('a', '', { href: 'javascript:login()' }));
    T.eq(p.f._loginUrl(), '/sp?id=login', 'never a script link');
    DOC.body.appendChild(el('a', '', { href: '/csm?id=login' }));
    T.eq(p.f._loginUrl(), '/csm?id=login', 'the portal\'s own');
});

// ---- A3. a labelled caption box -----------------------------------------------------

T.test('A3: while she works the caption is the question, not the greeting; the on-device tag is not shown', function () {
    var p = page(), c = p.c, f = p.f;
    c.state = 'thinking'; c.lastHeard = 'what time is it'; c.spoken = 'Good morning. I am Netra.'; c.captionKeep = true;
    T.eq(f._captionWho(), 'you'); T.eq(f._captionText(), 'what time is it');
    c.state = 'idle'; c.interim = '(on-device) hello';
    T.eq(f._captionWho(), 'you'); T.eq(f._captionText(), 'hello');
    c.interim = ''; c.state = 'speaking'; c.spoken = 'It is nine in Tokyo.';
    T.eq([f._captionWho(), f._captionText()], ['netra', 'It is nine in Tokyo.']);
    // a typed question comes through handleHeard: it sets lastHeard before thinking
    var hh = SRC.slice(SRC.indexOf('    function handleHeard('), SRC.indexOf("        setState('thinking');\n        _waitStart();"));
    T.match(hh, /c\.lastHeard = transcript;/);
});

T.test('A3: caption size s, m, l or xl, kept in this browser; a sample line when the box is empty', function () {
    var p = page(), c = p.c, f = p.f;
    f._setCapSize('xl');
    T.eq([c.capSize, store.netra_caption_size], ['xl', 'xl']);
    T.eq([c.spoken, c.captionKeep], ['This is how captions will look.', true], 'the empty box shows a sample');
    // the sample is not "no voice": the next status still says nothing about text only
    c.hasTTS = true; c.labMute = false;
    f._setBarge(false);
    T.eq([c.liveStatus, c.liveHint], ['Listening', ''], 'a voice still plays her replies');
    f._setBarge(true);
    f._setCapSize('huge');
    T.eq(c.capSize, 'm');
    f._setCapOn(false);
    T.eq([c.capOn, store.netra_captions], [false, '0']);
    global.localStorage = { getItem: function () { throw new Error('blocked'); }, setItem: function () { throw new Error('blocked'); } };
    f._setCapSize('l');
    T.eq(c.capSize, 'l', 'a browser that blocks storage still gets the size');
    memStore();
    // read at boot, in try/catch
    T.match(SRC, /var capPref = localStorage\.getItem\('netra_caption_size'\);/);
});

T.test('A3: the caption box is solid, left-aligned, newest at the bottom, AAA, never italic and never live', function () {
    var cap = rule(CSS, '.netra-cap');
    T.match(cap, /justify-content: flex-end/); T.match(cap, /background: #1b1b1f/); T.match(cap, /text-align: left/);
    T.match(cap, /height: var\(--cap-h\)/);
    T.notMatch(cap, /italic|rgba\(/);
    var sec = STAGE.slice(STAGE.indexOf('<section class="netra-cap"'), STAGE.indexOf('</section>'));
    T.notMatch(sec, /aria-live|role=/);
    T.match(sec, /\{\{c\.captionWho\(\) === 'you' \? 'You' : 'Netra'\}\}/);
    T.ok(contrast('#f1f3f4', '#1b1b1f') >= 7, 'her words');
    T.ok(contrast('#a8c7fa', '#1b1b1f') >= 7, 'the Netra label');
    T.ok(contrast('#c4c7c5', '#1b1b1f') >= 7, 'You, and your words');
    T.match(CSS, /\.netra-cap-who\.is-netra \{ color: #a8c7fa; \}/);
    T.match(CSS, /\.netra-cap-xl \{ --cap: 32px; --cap-lines: 2; \}/);
    // the caption row keeps room for XL (two lines), so a new size never moves the orb
    T.match(rule(CSS, '.netra-stage'), /minmax\(0, 1fr\) minmax\(min-content, auto\) minmax\(0, var\(--cap-row\)\) minmax\(min-content, var\(--aux-h\)\) auto/);
    T.match(rule(CSS, '.netra-stage'), /--cap-row: calc\(2 \* 1\.45 \* 32px \+ 26px\)/);
    T.match(block(CSS, '@media (min-width: 700px) {\n    .netra-stage '), /--cap-row: calc\(2 \* 1\.45 \* 40px \+ 26px\)/);
    [[18, 3], [20, 3], [26, 2], [32, 2]].forEach(function (s) { T.ok(s[1] * 1.45 * s[0] + 26 <= 2 * 1.45 * 32 + 26 + 0.01, 'phone ' + s[0] + ' px fits the row'); });
    [[18, 3], [22, 3], [30, 2], [40, 2]].forEach(function (s) { T.ok(s[1] * 1.45 * s[0] + 26 <= 2 * 1.45 * 40 + 26 + 0.01, 'desktop ' + s[0] + ' px fits the row'); });
    T.match(block(CSS, '@media (min-width: 700px) {\n    .netra-stage '), /\.netra-cap-xl \{ --cap: 40px; \}/);
    T.match(STAGE, /ng-class="\['netra-stage-' \+ c\.state, 'netra-cap-' \+ \(c\.capSize \|\| 'm'\)/, 'the size class is on the stage root');
});

// ---- A4. the orb acts on the current state ------------------------------------------

T.test('A4: what a tap on the orb does, and what it is called, in every state', function () {
    var p = page(), c = p.c, f = p.f;
    [[{ booted: false }, 'boot', 'Netra is getting ready'],
     [{ ended: true }, 'restart', 'Start Netra again'],
     [{ micOff: true }, 'unmute', 'Turn the mic back on'],
     [{ state: 'speaking' }, 'stop', 'Stop Netra talking'],
     [{ speakingNow: true, state: 'idle' }, 'stop', 'Stop Netra talking'],
     [{ state: 'idle', alert: true }, 'pause', 'Pause Netra'],
     [{ state: 'dormant', alert: false }, 'resume', 'Resume Netra']].forEach(function (row) {
        var k = row[0];
        p.set('booted', k.booted !== false); p.set('_speakingNow', !!k.speakingNow);
        c.ended = !!k.ended; c.micOff = !!k.micOff; c.state = k.state || 'idle'; c.alert = k.alert !== false;
        T.eq([f._orbAction(), f._orbLabel()], [row[1], row[2]], JSON.stringify(k));
    });
});

T.test('A4: a tap while she talks only stops her - she goes on listening, not paused; pause shows the bars', function () {
    var p = page(), c = p.c, f = p.f;
    c.state = 'speaking'; c.alert = true;
    f._tapOrb();
    T.eq(p.rec.stops.length, 1, 'stopped once');
    T.eq([c.state, c.alert], ['idle', true]);
    T.notMatch(p.rec.spoken.join(' '), /Going to sleep|Paused/);
    f._tapOrb();
    T.eq([c.state, c.alert, c.liveKind], ['dormant', false, 'paused']);
    T.eq(f._orbLabel(), 'Resume Netra');
    T.match(STAGE, /<span class="netra-orb-glyph" ng-if="c\.liveKind === 'muted' \|\| c\.liveKind === 'paused'" aria-hidden="true">/);
    // c.tap keeps the drag guard and hands the rest to _tapOrb
    T.match(SRC, /c\.tap = function \(\) \{\s*\/\/[^\n]*\n\s*if \(booted && orbDragJustMoved\) \{ orbDragJustMoved = false; return; \}\s*_tapOrb\(\);/);
});

T.test('A4: "Talking interrupts Netra" off - a final heard over her voice is dropped; tap and Escape still stop her', function () {
    var p = page(), c = p.c, f = p.f;
    ['_looksLikeEcho', '_isNoAnswer'].forEach(function (n) { p.set(n, function () { return false; }); });
    p.set('matchLocal', function () { return null; }); p.set('_afterStop', function () { return ''; });
    p.set('_speakingNow', true);
    c.bargeOn = true;
    T.eq(f._voiceBargeOn(), true);
    f._handleFinalWhileSpeaking('stop that now', 0.9);
    T.eq(p.rec.stops.length, 1, 'switched on: talking stops her');
    f._setBarge(false);
    T.eq([f._voiceBargeOn(), store.netra_voice_barge], [false, '0']);
    T.eq(f._handleFinalWhileSpeaking('stop that now', 0.9), true, 'consumed, like her own echo');
    T.eq(p.rec.stops.length, 1, 'switched off: she keeps talking');
    f._stopTalking('Escape key');
    T.eq([p.rec.stops.length, p.rec.stops[1], c.state, c.alert], [2, 'Escape key', 'idle', true], 'Escape still stops her');
    // the instant two-word barge is off too
    T.match(SRC, /if \(floorHeld && _voiceBargeOn\(\)\) \{/);
});

T.test('A4: the orb is named for what a tap does, and its focus ring hugs the painted orb', function () {
    T.match(TPL, /aria-label="\{\{c\.orbLabel\(\)\}\}"/);
    T.notMatch(TPL, /Tap to put her to sleep/);
    T.notMatch(TPL + CSS, /blob-wrap:focus-visible[^{]*\{[^}]*outline-offset: 6px/);
    T.match(STYLE, /\.netra-stage-blob-wrap:focus-visible::after \{[^}]*inset: 13%;/);
    T.notMatch(STYLE, /\.netra-stage-blob-wrap \{\s*filter: drop-shadow/, 'no glow filter on the button itself');
});

// ---- A5. a look per state, Calm visuals ------------------------------------------------

T.test('A5: Calm visuals is kept and reaches the stage renderer; forced colours and more contrast are honoured', function () {
    var p = page(), c = p.c, f = p.f;
    f._setCalm(true);
    T.eq([window.__netraCalm, store.netra_calm, c.calm], [true, '1', true]);
    f._setCalm(false);
    T.eq([window.__netraCalm, store.netra_calm], [false, '0']);
    T.match(SRC, /matchMedia\('\(prefers-reduced-motion: reduce\)'\)\.matches\) : calmPref === '1'/, 'unset: follows the system setting');
    var fc = block(CSS, '@media (forced-colors: active)');
    T.match(fc, /\.netra-stage-3d \{ display: none; \}/); T.match(fc, /ButtonText/); T.match(fc, /Highlight/);
    var pc = block(CSS, '@media (prefers-contrast: more)');
    T.match(pc, /\.netra-cap \{ border: 2px solid #fff; background: #000; \}/);
});

T.test('A5: Calm visuals holds the page\'s own motion still too - no word ripples, no blob morph, no colour drift, no CSS motion', function () {
    var p = page(), c = p.c, f = p.f;
    El.prototype.addEventListener = noop;
    var host = DOC.body.appendChild(el('div', 'netra-stage-ripples'));
    var outer = DOC.body.appendChild(el('path', 'netra-stage-blob-outer'));
    c.liveMode = true; c.state = 'speaking';
    p.set('_rippleHost', null); p.set('_rippleLast', 0); p.set('_rippleMean', 0); p.set('_rippleCount', 0);
    // a word onset: the loudness jumps well over its mean
    p.set('_prismAmp', 0.9);
    c.calm = true;
    f._maybeRipple();
    T.eq(host.children.length, 0, 'Calm: no ring at a word onset');
    c.calm = false;
    f._maybeRipple();
    T.eq(host.children.length, 1, 'Calm off: the ring as before');
    // the 2D blob and the prism colours: two frames 3 s apart are the same
    var sin = [], cos = [], lv = [];
    for (var i = 0; i < 24; i++) { sin.push(Math.sin(i * Math.PI / 12)); cos.push(Math.cos(i * Math.PI / 12)); lv.push(38); }
    p.set('VOICE_RING_SIN', sin); p.set('VOICE_RING_COS', cos); p.set('VOICE_RING_MULTIPLIERS', lv.map(function () { return 1; }));
    p.set('_blobLevels', lv); p.set('_blobPhase', 0); p.set('_stage3dOn', false); p.set('_stageOuterEl', null);
    p.set('_prismTime', 0); p.set('_prismHue', 258); p.set('_prismAmp', 0);
    p.set('PRISM_STATE_HUE', { idle: 217, speaking: 258, thinking: 262 }); p.set('PRISM_STATE_SAT', {}); p.set('_orbRootEl', null);
    c.calm = true; c.audioLevel = 70; c.audioLevels = lv.map(function (x, j) { return j * 4; });
    for (i = 0; i < 90; i++) f._recomputeVoiceRing();
    var d = outer.getAttribute('d'), hue = p.get('_prismHue');
    for (i = 0; i < 180; i++) f._recomputeVoiceRing();   // 3 s at 60 fps, her voice still loud
    T.eq(outer.getAttribute('d'), d, 'Calm: the blob holds its shape');
    T.eq([p.get('_blobPhase'), p.get('_prismTime'), p.get('_prismHue')], [0, 0, hue], 'no wobble, no drift');
    c.calm = false;
    f._recomputeVoiceRing();
    T.ok(outer.getAttribute('d') !== d, 'Calm off: it moves with her voice again');
    // CSS: the stage carries the class, and it stops what reduced motion stops
    T.match(STAGE, /ng-class="\['netra-stage-' \+ c\.state, 'netra-cap-' \+ \(c\.capSize \|\| 'm'\), \{'netra-calm': c\.calm\}\]"/);
    T.match(STYLE, /\.netra-stage\.netra-calm \*, \.netra-stage\.netra-calm \*::before, \.netra-stage\.netra-calm \*::after \{\s*animation: none !important;\s*transition: none !important;\s*\}/);
    T.match(STYLE, /\.netra-stage\.netra-calm \.netra-ripple \{ display: none; \}/);
    delete El.prototype.addEventListener;
});

// ---- A6. say what she is doing ---------------------------------------------------------

T.test('A6: the step she is on, from what was asked (a Guest never hears a record number)', function () {
    var f = page().f;
    T.eq(f._activityLabel('is INC0012345 fixed', false), 'Looking up INC0012345…');
    T.notMatch(f._activityLabel('is INC0012345 fixed', true), /INC/);
    T.eq(f._activityLabel('search the web for news', false), 'Searching the web…');
    T.eq(f._activityLabel('what time is it in Tokyo', false), 'Checking the time…');
    T.eq(f._activityLabel('tell me a joke', true), 'Finding a joke…');
    T.eq(f._activityLabel('show my tickets', false), 'Checking your work…');
    T.eq(f._activityLabel('show my tickets', true), 'Thinking…');
    T.eq(f._waitStep(3000), null);
    T.eq(f._waitStep(9000), 'Still working on it…');
    T.eq(f._waitStep(21000), 'This is taking too long');
    var hh = SRC.slice(SRC.indexOf('    function handleHeard('), SRC.indexOf("logEvent('srv', 'sending: \"'"));
    T.match(hh, /c\.activity = _activityLabel\(transcript, !!\(c\.data && c\.data\.is_guest\)\);\s*setState\('thinking'\);\s*_waitStart\(\);/);
});

T.test('A6: the wait ladder - got it, a tick every 1.5 s, a step at 8 s, Try again at 20 s, all gone with the reply', function () {
    var p = page(), c = p.c, f = p.f, k = clock(p), said = writes(c, 'srSay');
    try {
        c.liveKind = 'work';
        f.setState('thinking');
        f._waitStart();
        T.eq(p.rec.cues, ['got']);
        k.advance(2000);
        T.eq(p.rec.cues, ['got', 'tick']);
        k.advance(6000);
        T.eq(c.liveStatus, 'Still working on it…');
        T.eq(said.filter(function (s) { return s === 'Still working on it…'; }).length, 1, 'said once');
        T.eq(c.canRetry, false);
        p.set('_fillerChainActive', true);
        var ticks = p.rec.cues.length;
        k.advance(1500);
        T.eq(p.rec.cues.length, ticks, 'no tick over a filler');
        p.set('_fillerChainActive', false);
        k.advance(10500);
        T.eq([c.liveStatus, c.liveHint, c.canRetry], ['This is taking too long', 'Press Try again or type your question', true]);
        f.setState('speaking');
        T.eq(c.canRetry, false, 'the reply takes Try again away');
        ticks = p.rec.cues.length;
        k.advance(6000);
        T.eq(p.rec.cues.length, ticks, 'and the ticks stop');
        // a newer turn (or a barge-in) ends the old ladder
        f.setState('thinking'); f._waitStart();
        p.set('_turnEpoch', 99);
        k.advance(2000);
        T.eq(p.rec.cues[p.rec.cues.length - 1], 'got', 'no tick for a stale turn');
    } finally { k.restore(); }
    T.match(STAGE, /<button type="button" class="netra-retry" ng-click="c\.retry\(\)">Try again<\/button>/);
    T.match(STAGE, /class="netra-retry netra-retry-type" ng-click="c\.retryFocus\(\); c\.typeToggle\(true\)">Type instead<\/button>/);
    T.match(STAGE, /ng-if="c\.canRetry \|\| c\.lastFailed \|\| c\.liveKind === 'error'"/);
});

T.test('A6: after a failed turn Try again stays up through her apology and after it, until something new is said', function () {
    var p = page(), c = p.c, f = p.f;
    // the row's ng-if, as the template has it
    function row() { return !!(c.canRetry || c.lastFailed || c.liveKind === 'error'); }
    f.setState('thinking');
    f._turnFailed();
    T.eq([c.liveKind, c.liveHint, row()], ['error', 'Say it again or press Try again', true]);
    f.setState('speaking');   // 'Sorry, I could not reach the server.'
    T.ok(row(), 'still there while she apologises');
    f.setState('idle');
    T.eq([c.liveStatus, c.liveHint, row()], ['Listening', 'Say it again or press Try again', true], 'and after: the hint is back');
    // captions only (no voice): there is never a speaking state, and the row stays too
    c.hasTTS = false; f.setState('idle');
    T.ok(row(), 'captions only');
    c.hasTTS = true;
    // something new heard or typed ends the failed turn
    p.set('startCalibration', noop);
    f.processCommand('mic check', 1);
    T.eq([row(), c.liveHint], [false, ''], 'a new question: no Try again');
    f._turnFailed();
    p.set('processCommand', noop); c.lastHeard = 'x';
    f._retryTurn();
    T.eq(c.lastFailed, false, 'pressed: gone');
    // every server failure branch uses it
    T.eq((SRC.match(/\n\s+_turnFailed\(\);/g) || []).length, 3, 'empty reply, server error, transport error');
});

T.test('A6: Try again and Type instead move focus to the orb before their row goes, never to the page', function () {
    var p = page(), c = p.c, f = p.f;
    var orb = DOC.body.appendChild(el('button', 'netra-stage-blob-wrap'));
    var rowEl = DOC.body.appendChild(el('div', 'netra-retry-row'));
    var tryBtn = rowEl.appendChild(el('button', 'netra-retry')), typeBtn = rowEl.appendChild(el('button', 'netra-retry netra-retry-type'));
    p.set('processCommand', noop); c.lastHeard = 'x'; c.lastFailed = true;
    tryBtn.focus();
    f._retryTurn();
    T.ok(DOC.activeElement === orb, 'Try again: focus is on the orb');
    typeBtn.focus();
    f._focusOffRetry();
    T.ok(DOC.activeElement === orb, 'Type instead: the orb first, then the text field (B)');
    // Try again said by voice, focus elsewhere: it stays where it is
    var other = DOC.body.appendChild(el('button', 'netra-head-settings'));
    other.focus();
    f._retryTurn();
    T.ok(DOC.activeElement === other, 'focus not in the row: left alone');
});

T.test('A6: earcons - one sound per event, quieter than before, and Sounds fewer or off', function () {
    memStore();
    var cl = N.loadClient(), f = cl.fn, c = cl.c, oscs = 0, peaks = [];
    cl.set('audioCtx', { state: 'running', currentTime: 0, destination: {},
        createOscillator: function () { oscs++; return { connect: noop, start: noop, stop: noop, frequency: {} }; },
        createGain: function () { return { connect: noop, gain: { setValueAtTime: noop, exponentialRampToValueAtTime: function (v) { if (v > 0.001) peaks.push(v); } } }; } });
    cl.set('_speakingNow', false);
    c.sounds = 'off';
    f.cue('got'); f.cue('error'); f.tone([440, 330], 0.07);
    T.eq(oscs, 0, 'Off: not one oscillator');
    c.sounds = 'fewer';
    T.eq(f._cueAllowed('tick'), false); T.eq(f._cueAllowed('got'), false); T.eq(f._cueAllowed('open'), false);
    T.eq(f._cueAllowed('error'), true); T.eq(f._cueAllowed('end'), true);
    c.sounds = 'on';
    f.cue('got'); f.cue('tick');
    T.eq(oscs, 2);
    T.eq(peaks, [0.06, 0.03], 'about 6 dB under the old 0.12; tick softer still');
    cl.set('_speakingNow', true);
    T.eq(f._cueAllowed('error'), false, 'never over her voice');
    f._setSounds('loud');
    T.eq(c.sounds, 'on');
    f._setSounds('fewer');
    T.eq(store.netra_sounds, 'fewer');
});

T.test('A6: cutting her off plays the falling blip only, never the your-turn chime on top of it', function () {
    var p = page(), c = p.c, f = p.f, tones = [];
    p.set('tone', function (fr) { tones.push(fr.join('-')); });
    ['_clearSpeaking', 'detachOutputAnalyser'].forEach(function (n) { p.set(n, noop); });
    p.set('_speakSessionId', 0); p.set('_calibActive', false); p.set('_edgeLiveWs', null); p.set('currentAudio', null); p.set('TTS', null);
    c.alert = true; c.conversationOpen = true;
    f.setState('speaking');
    p.rec.cues.length = 0;
    f.stopSpeaking('tap');
    T.eq(tones, ['440-330'], 'the blip');
    T.eq(c.liveKind, 'listen');
    T.eq(p.rec.cues, [], 'no "open" chime in the same instant');
    T.eq(p.get('_quietOpen'), false, 'only for that one change');
    // her turn ending on its own still has its chime
    f.setState('speaking'); f.setState('idle');
    T.eq(p.rec.cues, ['open']);
});

T.test('A6: Try again asks the last question again; a blocked mic says what to do, as an alert', function () {
    var p = page(), c = p.c, f = p.f, asked = [], started = 0;
    p.set('processCommand', function (t, conf) { asked.push([t, conf]); });
    p.set('startContinuous', function () { started++; });
    c.lastHeard = 'x';
    f._retryTurn();
    T.eq(asked, [['x', 1.0]]);
    // microphone blocked
    p.set('_notAllowedStrikes', 0);
    f._handleNotAllowed('not-allowed');
    T.eq([c.permission, c.liveKind], ['denied', 'error']);
    T.match(c.srAlert, /^I can't hear you: the microphone is blocked\. Allow the microphone for this site in your browser, then press Try again, or press Type\.$/);
    T.eq(c.liveHint, c.srAlert, 'the same words under the status');
    T.eq(p.rec.cues[p.rec.cues.length - 1], 'error');
    T.eq(c.srSay, '', 'not said twice');
    f._retryTurn();
    T.eq([started, c.permission, c.state], [1, 'prompt', 'idle'], 'Try again listens again');
    T.eq(asked.length, 1, 'and does not re-send the question');
    // offline and back, once each, removed on $destroy
    T.match(SRC, /\$window\.addEventListener\('offline', _onOffline\); \$window\.addEventListener\('online', _onOnline\);/);
    T.match(SRC, /\$window\.removeEventListener\('offline', _onOffline\); \$window\.removeEventListener\('online', _onOnline\);/);
});

// ---- A7. portal and focus hygiene --------------------------------------------------------

T.test('A7: a title the page focuses (a sheet\'s, the loading card\'s) gets no box, not even the portal\'s green one', function () {
    // found live: the portal's accessibility mode gives any focused [tabindex]
    // a green border ([accessibility] [tabindex]:not(...):focus); every
    // tabindex here is a title that focus is moved to, never a control
    T.match(STYLE, /\.netra-root \[tabindex="-1"\]:focus \{ border: 0 !important; box-shadow: none !important; \}/);
    (TPL.match(/tabindex="[^"]*"/g) || []).forEach(function (a) { T.eq(a, 'tabindex="-1"', 'only titles carry a tabindex'); });
});

T.test('A7: the portal header made inert by the loading card is quieted again when the card goes', function () {
    var p = page(), c = p.c, f = p.f;
    c.liveMode = true; c.gate = { open: false, needsTap: true };
    var header = DOC.body.appendChild(el('header', 'sp-navbar'));
    header.appendChild(el('a', '', { href: '/login' }));
    var root = DOC.body.appendChild(el('div', 'netra-root'));
    var stage = root.appendChild(el('div', 'netra-stage'));
    var dialog = stage.appendChild(el('div', 'netra-ready'));
    dialog.appendChild(el('button', 'netra-ready-start'));
    f._gateModal();
    T.ok(header.hasAttribute('inert'), 'the card made it inert');
    f._inertChrome();   // skips it: already inert
    c.gate.open = true;
    stage.children.splice(stage.children.indexOf(dialog), 1); dialog.parentNode = null;
    f._gateInertRestore();
    T.eq(header.hasAttribute('inert'), true, 'still inert after the card gives the page back');
    T.eq(header.getAttribute('aria-hidden'), 'true');
    f._uninertChrome();
    T.eq(header.hasAttribute('inert'), false, 'leaving Netra gives it back');
    T.match(SRC, /\$timeout\(_inertChrome, 500\); \$timeout\(_inertChrome, 4000\); \$timeout\(_inertChrome, 12000\);/);
});

T.test('A7: the unscoped style hides the portal chrome and gives the stage one clean focus ring', function () {
    var top = STYLE.slice(0, STYLE.indexOf('.netra-lab {'));
    T.match(top, /A7 portal \+ focus hygiene/);
    T.match(top, /body\.netra-live-body nav#responsiveNav[^{]*\{[^}]*visibility: ?hidden !important/);
    T.match(top, /body\.netra-live-body #sp-main-wrapper > header/);
    T.match(top, /\.netra-stage :focus-visible \{[^}]*outline: 3px solid #fff/);
    T.match(top, /\.netra-stage \[tabindex="-1"\]:focus-visible \{ outline: none !important; \}/);
    T.match(top, /\.netra-stage button:focus,[^{]*\{ box-shadow: none !important; outline: none; \}/);
    T.notMatch(CSS, /\.netra-live-body #sp-page/, 'the dead scoped rules are gone');
});

T.run(__filename);
