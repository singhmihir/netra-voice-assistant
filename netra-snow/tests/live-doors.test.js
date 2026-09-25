/* Netra Live: the ways in (package B).
 *
 * One bar of four labelled controls (Mute, Type, Transcript, End) with Start
 * again in the same row; Type as a real way in with the box above the bar;
 * a Transcript sheet that is a quiet log with real links and Copy; 'Try
 * saying' starters and an honest Guest greeting; a loading card in plain
 * words that always offers Type once answers are ready; Settings as a
 * grouped sheet with the Lab and Install under More; single keys on the
 * stage, and Escape that closes before it stops her. */
'use strict';
var T = require('./lib/t'), N = require('./lib/netra');
var fs = require('fs'), path = require('path');
var TPL = fs.readFileSync(path.join(N.SRC, 'widget', 'template.html'), 'utf8');
var CSS = fs.readFileSync(path.join(N.SRC, 'widget', 'stylesheet.scss'), 'utf8');
var SRC = fs.readFileSync(path.join(N.SRC, 'widget', 'client.js'), 'utf8');

var store = {};
global.localStorage = { getItem: function (k) { return store.hasOwnProperty(k) ? store[k] : null; }, setItem: function (k, v) { store[k] = String(v); }, removeItem: function (k) { delete store[k]; } };
global.window = global.window || {};

// a very small DOM: enough for querySelector by tag, tag[attr], .class and #id
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
        var cls = s.match(/^\.([\w-]+)$/), id = s.match(/^#([\w-]+)$/), m = s.match(/^([a-z]*)(?:\[([a-z-]+)\])?$/i);
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
    store = {};
    var cl = N.loadClient(), c = cl.c, set = cl.set, rec = { spoken: [], sent: [], stops: [], log: [], later: [] };
    var now = function (fn, ms) { rec.later.push(ms); if (typeof fn === 'function') fn(); return 0; };
    now.cancel = noop;
    set('$timeout', now);
    set('$scope', { $applyAsync: noop, $on: noop });
    set('$window', {});
    set('speak', function (text, done) { rec.spoken.push(String(text)); if (done) done(); });
    set('logEvent', function (k, m) { rec.log.push(k + ': ' + m); });
    set('processCommand', function (t, conf) { rec.sent.push([t, conf]); });
    set('stopSpeaking', function (why) { rec.stops.push(why); });
    ['cue', 'tone', 'setState', 'openConversation', 'closeConversation', '_convoPush', 'unlockAudio', '_resumeAudio', '_labRestorePos']
        .forEach(function (n) { set(n, noop); });
    set('_speakingNow', false); set('_activated', true); set('_voiceBlocked', false); set('_speechUnlocked', true);
    set('_ctrlDestroyed', false); set('_gateInert', []); set('_gateHeld', null);
    c.events = []; c.stats = {}; c.data = {}; c.convo = []; c.heard = [];
    c.alert = true; c.state = 'idle'; c.lastHeard = ''; c.spoken = ''; c.interim = '';
    c.gate = { open: true, everOpen: true, hearing: true, voice: true, brain: true, hearingText: '', voiceText: '', brainText: '' };
    c.labCalib = { stage: 'idle' }; c.app = { canInstall: false, standalone: false, ios: false, showHelp: false };
    c.micOff = false; c.ended = false; c.typeOn = false; c.sheet = null; c.setupOn = false; c.labOn = false;
    return { c: c, f: cl.fn, get: cl.get, set: set, rec: rec };
}
function key(k, extra) {
    var e = { key: k, prevented: 0, stopped: 0, preventDefault: function () { e.prevented++; }, stopPropagation: function () { e.stopped++; } };
    for (var x in (extra || {})) e[x] = extra[x];
    return e;
}

function rule(src, sel) {
    var at = src.indexOf(sel + ' {');
    T.ok(at >= 0, 'found the rule ' + sel);
    return src.slice(at, src.indexOf('}', at) + 1);
}
function lum(hex) {
    var v = [1, 3, 5].map(function (i) { var x = parseInt(hex.substr(i, 2), 16) / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); });
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}
function contrast(a, b) { var la = lum(a), lb = lum(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); }
// the template between an opening tag and the closing tag at the same indent
function slice(src, open) {
    var at = src.indexOf(open);
    T.ok(at >= 0, 'found ' + open);
    var indent = src.slice(src.lastIndexOf('\n', at) + 1, at);
    var close = src.indexOf('\n' + indent + '</', at);
    return src.slice(at, src.indexOf('>', close) + 1);
}

// ---- B1. the control bar ---------------------------------------------------------

T.test('B1: one bar of four labelled controls in order, Mute says pressed instead of flipping its name', function () {
    var bar = slice(TPL, '<div class="netra-stage-controls" role="group" aria-label="Controls" ng-if="!c.ended">');
    var at = ['netra-ctl-mic', 'netra-ctl-type', 'netra-ctl-log', 'netra-ctl-end'].map(function (k) { return bar.indexOf(k); });
    T.ok(at[0] > 0 && at[0] < at[1] && at[1] < at[2] && at[2] < at[3], 'Mute, Type, Transcript, End in that order: ' + at);
    T.match(bar, /<button type="button" class="netra-ctl netra-ctl-mic" ng-click="c\.toggleMic\(\)" aria-pressed="\{\{!!c\.micOff\}\}">/);
    T.match(bar, /class="netra-ctl netra-ctl-type" ng-click="c\.typeToggle\(\)" aria-expanded="\{\{!!c\.typeOn\}\}" aria-controls="netra-type"/);
    T.match(bar, /class="netra-ctl netra-ctl-log" ng-click="c\.logToggle\(true\)" aria-haspopup="dialog"/);
    T.match(bar, /class="netra-ctl netra-ctl-end" ng-click="c\.liveExit\(\)"/);
    ['Mute', 'Type', 'Transcript', 'End'].forEach(function (w) { T.match(bar, new RegExp('<span class="netra-ctl-label">' + w + '</span>')); });
    T.notMatch(bar.slice(bar.indexOf('>') + 1), /aria-label=/, 'the visible word is each button\'s name');
    T.notMatch(TPL, /Unmute mic/, 'the name never flips to Unmute');
    TPL.split('<button').forEach(function (b) {
        if (b.indexOf('class="netra-ctl ') < 0) return;
        T.match(b.slice(0, b.indexOf('</button>')), /netra-ctl-label/, 'every round control has its word');
    });
    T.notMatch(TPL, /netra-ctl-lab(?!el)/, 'no flask in the bar: the Lab is under Settings > More');
    var ended = slice(TPL, '<div class="netra-stage-controls netra-stage-controls-ended" ng-if="c.ended">');
    T.match(ended, /class="netra-ended-btn" ng-click="c\.liveRestart\(\)">Start Netra again</);
    T.match(ended, /class="netra-ctl netra-ctl-log"/, 'and the transcript, in the same row');
});

T.test('B1: the bar is AA and bigger than the touch minimum, End red with a light ring, 320 px fits', function () {
    T.ok(contrast('#ffffff', '#b3261e') >= 4.5, 'End icon');
    T.ok(contrast('#f2b8b5', '#0e0e10') >= 3, 'End ring on the stage');
    T.ok(contrast('#062e6f', '#a8c7fa') >= 4.5, 'Start Netra again');
    T.ok(contrast('#8e918f', '#0e0e10') >= 3, 'the circles\' edge');
    T.ok(contrast('#e3e3e3', '#0e0e10') >= 7, 'the labels');
    var ico = rule(CSS, '.netra-ctl-ico');
    T.ok(+(ico.match(/width: (\d+)px/) || [])[1] >= 56, 'circles at least 56 px');
    T.match(rule(CSS, '.netra-ctl'), /min-height: 84px/);
    T.match(rule(CSS, '.netra-ctl-end .netra-ctl-ico'), /background: #b3261e; border: 2px solid #f2b8b5/);
    T.match(rule(CSS, '.netra-ctl-mic[aria-pressed=true] .netra-ctl-ico'), /background: #e3e3e3; color: #1f1f1f/);
    T.match(rule(CSS, '.netra-ctl:focus-visible .netra-ctl-ico'), /outline: 3px solid #ffffff/, 'the ring is on the circle');
    var bar = rule(CSS, '.netra-stage-controls');
    T.match(bar, /grid-area: bar/); T.match(bar, /grid-template-columns: repeat\(4, minmax\(64px, 88px\)\)/);
    T.ok(4 * 64 + 3 * 6 + 12 + 2 * 12 <= 320, 'four 64 px controls, the gaps, End set apart and the padding fit 320 px');
    T.match(CSS, /@media \(max-width: 359px\) \{\s*\.netra-stage-controls \{ padding-left: 12px; padding-right: 12px; gap: 6px; \}/);
});

// ---- B2. Type ----------------------------------------------------------------------

T.test('B2: a typed question goes the same way as a spoken one; refused text stays in the box', function () {
    var p = page(), c = p.c;
    c.typeText = '  tell me a joke ';
    T.eq(p.f._sendTyped(c.typeText, 'type'), true);
    T.eq(p.rec.sent, [['tell me a joke', 1.0]]);
    T.eq(c.lastHeard, 'tell me a joke', 'the caption shows what was typed');
    T.eq(p.f._sendTyped('   ', 'type'), false, 'nothing to send');
    p.set('_typedRefused', function () { return true; });
    T.eq(p.f._sendTyped('what time is it', 'type'), false);
    T.eq(p.rec.sent.length, 1, 'nothing sent while answers are not ready');
    // typing over her stops her, as a spoken barge-in would
    var q = page();
    q.c.state = 'speaking';
    q.f._sendTyped('stop, what about my approvals', 'type');
    T.eq(q.rec.stops, ['typed']);
    // the Lab's box goes the same way
    T.match(SRC, /c\.labSendCmd = function \(\) \{ if \(_sendTyped\(c\.labCmd, 'lab'\)\) c\.labCmd = ''; \};/);
});

T.test('B2: Type opens the box with the caret in it and follows the on-screen keyboard; closing gives Type the focus', function () {
    var p = page(), c = p.c, listeners = {};
    var stage = DOC.body.appendChild(el('div', 'netra-stage')), props = {};
    stage.style.setProperty = function (k, v) { props[k] = v; };
    stage.style.removeProperty = function (k) { delete props[k]; };
    var btn = stage.appendChild(el('button', 'netra-ctl netra-ctl-type'));
    var input = stage.appendChild(el('input', '', { id: 'netra-type-in' }));
    var vv = { height: 420, addEventListener: function (k, f) { listeners[k] = f; }, removeEventListener: function (k, f) { if (listeners[k] === f) delete listeners[k]; } };
    p.set('$window', { visualViewport: vv });
    btn.focus();
    p.f._typeToggle(true);
    T.eq(c.typeOn, true);
    T.ok(DOC.activeElement === input, 'the caret is in the box');
    T.eq(props['--vvh'], '420px', 'the stage is as tall as what is visible');
    vv.height = 300; listeners.resize();
    T.eq(props['--vvh'], '300px', 'the keyboard came up: the stage shrinks with it');
    // the orb steps aside while the keyboard is up (its row is too small to tap)
    p.set('$window', { visualViewport: vv, innerHeight: 844 });
    listeners.resize();
    T.ok(stage.hasAttribute('data-kbd'), 'keyboard up: the orb steps aside');
    vv.scale = 2; listeners.resize();
    T.ok(!stage.hasAttribute('data-kbd'), 'a pinch-zoom is not a keyboard');
    vv.scale = 1; vv.height = 800; listeners.resize();
    T.ok(!stage.hasAttribute('data-kbd'), 'keyboard down: the orb is back');
    vv.height = 300; listeners.resize();
    T.match(CSS, /\.netra-stage\[data-kbd\] \.netra-stage-blob-wrap,\n\.netra-stage\[data-kbd\] \.netra-stage-3d \{ visibility: hidden; \}/);
    p.f._typeToggle(false);
    T.ok(!stage.hasAttribute('data-kbd'), 'closing the box brings the orb back');
    T.eq(c.typeOn, false);
    T.ok(DOC.activeElement === btn, 'focus back on Type');
    T.eq(props['--vvh'], undefined); T.ok(!listeners.resize, 'no listener left behind');
    p.f._typeToggle();
    T.eq(c.typeOn, true, 'no argument toggles');
    var form = slice(TPL, '<form class="netra-type" id="netra-type"');
    T.match(form, /ng-if="c\.typeOn && !c\.ended" ng-submit="c\.typeSend\(\)"/);
    T.match(form, /<label class="netra-sr-only" for="netra-type-in">Type to Netra<\/label>/);
    T.match(form, /enterkeyhint="send"/); T.match(form, /ng-keydown="c\.typeKey\(\$event\)"/);
    T.match(form, /aria-label="Close typing"/);
    T.ok(+(rule(CSS, '#netra-type-in').match(/font: \d+ (\d+)px/) || [])[1] >= 16, 'iOS does not zoom into the box');
    T.match(rule(CSS, '.netra-type'), /grid-area: aux/);
});

// ---- B3. the Transcript ------------------------------------------------------------

T.test('B3: links in her words are real http(s) links, trailing punctuation left out, nothing else linked', function () {
    var p = page();
    T.eq(p.f._linkParts('see https://x.com/a.'), [{ t: 'see ' }, { t: 'https://x.com/a', href: 'https://x.com/a' }, { t: '.' }]);
    T.eq(p.f._linkParts('javascript:alert(1)'), [{ t: 'javascript:alert(1)' }]);
    T.eq(p.f._linkParts('(from https://en.wikipedia.org/wiki/Netra), and http://a.b/c?d=1!').filter(function (x) { return x.href; }).map(function (x) { return x.href; }),
         ['https://en.wikipedia.org/wiki/Netra', 'http://a.b/c?d=1']);
    T.eq(p.f._linkParts(''), []);
});

T.test('B3: the transcript is what you and Netra said, stable between digests, and copies as plain text', function () {
    var p = page(), c = p.c;
    c.convo.push({ who: 'sys', text: '· reminder fired ·', t: '10:41:59' });
    c.convo.push({ who: 'you', text: 'q', t: '10:42:03' });
    c.convo.push({ who: 'netra', text: 'a', t: '10:42:05' });
    var v = p.f._convoView();
    T.eq(v.length, 2);
    T.eq(v[0].who, 'you'); T.eq(v[0].t, '10:42'); T.eq(v[1].k, 1);
    T.ok(p.f._convoView() === v, 'the same array until something is said (ng-repeat watches it)');
    T.eq(p.f._transcriptText(), 'You: q\nNetra: a');
    c.convo.push({ who: 'you', text: 'r', t: '10:43:00' });
    T.eq(p.f._convoView().length, 3, 'a new turn is shown');
    // Copy: the clipboard gets the text, and the sheet's own status line says
    // so (the sheet is modal: the stage's announcer outside it may go unread)
    var copied = null, said = [], later = [];
    p.set('$timeout', Object.assign(function (fn) { later.push(fn); return {}; }, { cancel: noop }));
    p.set('$window', { navigator: { clipboard: { writeText: function (t) { copied = t; return { then: function (ok) { ok(); } }; } } } });
    p.set('_announce', function (text, kind) { said.push([text, kind]); });
    p.f._logCopy();
    T.eq(copied, 'You: q\nNetra: a\nYou: r');
    later.forEach(function (fn) { fn(); });
    T.eq(c.logSaid, 'Transcript copied');
    T.eq(said, [], 'not through the stage announcer behind the sheet');
});

T.test('B3: the sheet takes the focus to its heading, Escape closes only it and gives Transcript the focus', function () {
    var p = page(), c = p.c;
    var btn = DOC.body.appendChild(el('button', 'netra-ctl netra-ctl-log'));
    var h = DOC.body.appendChild(el('h2', '', { id: 'netra-log-h', tabindex: '-1' }));
    btn.focus();
    p.f._sheetOpen('log', '.netra-ctl-log');
    T.eq(c.sheet, 'log');
    T.ok(DOC.activeElement === h, 'focus on the heading');
    var e = key('Escape');
    p.f._sheetKey(e);
    T.eq(c.sheet, null);
    T.ok(DOC.activeElement === btn, 'focus back on Transcript');
    T.eq(e.stopped, 1, 'Escape here does not also stop her speech');
    var sheet = slice(TPL, '<div class="netra-sheet" ng-if="c.sheet === \'log\'"');
    T.match(sheet, /role="dialog" aria-modal="true" aria-labelledby="netra-log-h"/);
    T.match(sheet, /<ol class="netra-log" role="log" aria-live="off">/, 'a log that is never read aloud by itself');
    T.match(sheet, /<li ng-repeat="m in c\.convoView\(\) track by m\.k">\s*<h3>/, 'a heading per turn');
    T.match(sheet, /ng-href="\{\{p\.href\}\}" target="_blank" rel="noopener noreferrer"/);
    T.notMatch(sheet, /ng-bind-html/, 'no HTML from a reply is ever bound');
    T.match(sheet, /ng-click="c\.logCopy\(\)"[^>]*>Copy transcript</);
    T.match(slice(TPL, '<div class="netra-stage-controls netra-stage-controls-ended"'), /Transcript<span ng-if="c\.convoView\(\)\.length"> \(\{\{c\.convoView\(\)\.length\}\}\)<\/span>/, 'after End, the count');
    T.match(rule(CSS, '.netra-sheet'), /position: fixed; inset: 0; z-index: 30;/);
    T.ok(contrast('#f1f3f4', '#1b1b1f') >= 7 && contrast('#a8c7fa', '#1b1b1f') >= 7 && contrast('#c4c7c5', '#1b1b1f') >= 7, 'AAA on the sheet');
});

// ---- B4. starters and the greeting --------------------------------------------------

T.test('B4: starters show what works, never tickets for a Guest, and go once something is asked', function () {
    var p = page(), c = p.c;
    var g = p.f._starters(true), u = p.f._starters(false);
    T.eq(g.length, 4); T.ok(!g.some(function (s) { return /ticket|approval/i.test(s); }), 'nothing a Guest can not do');
    T.ok(u.some(function (s) { return /ticket|approval/i.test(s); }), 'a signed-in user sees their work');
    c.gate = { open: true }; c.state = 'idle'; c.convo = [];
    T.eq(p.f._showStarters(), true);
    c.convo.push({ who: 'you', text: 'hi' });
    T.eq(p.f._showStarters(), false, 'gone once something was asked');
    c.convo = []; c.typeOn = true;
    T.eq(p.f._showStarters(), false, 'not under the typing box');
    c.typeOn = false; c.sheet = 'log';
    T.eq(p.f._showStarters(), false);
    c.sheet = 'settings'; c.setupOn = false;   // End closed Settings by c.setupOn alone
    T.eq(p.f._showStarters(), true, 'a sheet End closed does not hide them');
    c.sheet = null; c.gate.open = false;
    T.eq(p.f._showStarters(), false, 'not behind the loading card');
    c.gate.open = true; c.labCalib = { stage: 'listening' };
    T.eq(p.f._showStarters(), false, 'not over the mic check');
    var sent = [];
    p.set('_sendTyped', function (t, from) { sent.push([t, from]); return true; });
    var chip = DOC.body.appendChild(el('button', 'netra-try-chip')), orb = DOC.body.appendChild(el('button', 'netra-stage-blob-wrap'));
    chip.focus();
    p.f._tryStarter('Tell me a joke');
    T.eq(sent, [['Tell me a joke', 'chip']]);
    T.ok(DOC.activeElement === orb, 'the chips go: the focus goes to Netra, not the page');
    var tr = slice(TPL, '<div class="netra-try" role="group" aria-labelledby="netra-try-h" ng-if="c.showStarters()">');
    T.match(tr, /<p id="netra-try-h" class="netra-try-h">Try saying<\/p>/);
    T.match(tr, /ng-repeat="s in c\.starters\(\) track by \$index" ng-click="c\.tryStarter\(s\)"/);
});

T.test('B4: "what can you help me with" from a Guest is the local guest answer, no model call', function () {
    var cl = N.loadClient(), c = cl.c, f = cl.fn, said = [], sent = [], posts = 0;
    var now = function (fn) { if (typeof fn === 'function') fn(); return 0; };
    now.cancel = noop;
    cl.set('$timeout', now); cl.set('$scope', { $applyAsync: noop, $on: noop });
    cl.set('speak', function (t, done) { said.push(t); if (done) done(); });
    cl.set('handleHeard', function (t) { sent.push(t); });
    ['logEvent', 'cue', 'setState', 'openConversation', '_convoPush', '_heardFate', '_labNlpCapture'].forEach(function (n) { cl.set(n, noop); });
    c.data = { is_guest: true }; c.alert = true; c.lastAnswer = ''; c._awaitingConfirm = false; c.labCalib = { stage: 'idle' };
    c.server = { update: function () { posts++; }, get: function () { posts++; } };
    ['what can you help me with', 'What can you help with?', 'what can I ask you', 'how can you help me'].forEach(function (u) {
        f.processCommand(u, 1.0);
        T.match(said[said.length - 1], /^As a guest I can answer general questions/, u);
    });
    T.eq(sent, [], 'nothing went to the server'); T.eq(posts, 0);
    c.data = { is_guest: false };
    T.eq(f.matchLocal('what can you help me with'), null, 'a signed-in user still gets the full answer from the model');
});

T.test('B4: the first greeting says what a Guest can do and where Type is; signed in, just that she listens', function () {
    function opened(data, win) {
        var p = page(), c = p.c;
        c.data = data; c.gate = { open: true, everOpen: false, hearing: true, voice: true, brain: true, brainText: 'Ready' };
        if (win) p.set('$window', win);
        p.f._gateOpened();
        return p;
    }
    var g = opened({ is_guest: true, user_name: 'Guest' }).rec.spoken[0];
    T.match(g, /^Good (morning|afternoon|evening)\. I'm Netra\. As a guest, I can answer questions, search the web, and tell you the time or a joke\. Sign in to use your tickets\. Just speak, or press Type\.$/);
    T.notMatch(g, /\bshe\b|Guest,/);
    T.match(opened({ is_guest: false, user_name: 'Mihir Singh' }).rec.spoken[0], /^Good (morning|afternoon|evening), Mihir\. I'm Netra, and I'm listening\.$/);
    // a keyboard and a mouse: the shortcuts, once per browser
    var desk = { matchMedia: function (q) { return { matches: q === '(pointer: fine)' }; } };
    var p1 = opened({ is_guest: false }, desk);
    T.match(p1.rec.spoken[0], / Press question mark for shortcuts\.$/);
    T.eq(store.netra_intro_keys, '1');
    var p2 = page(); store.netra_intro_keys = '1';
    p2.set('$window', desk); p2.c.data = {}; p2.c.gate = { open: true, everOpen: false, brainText: 'Ready' };
    p2.f._gateOpened();
    T.notMatch(p2.rec.spoken[0], /question mark/, 'said once');
    T.notMatch(opened({}, { ontouchstart: null, matchMedia: desk.matchMedia }).rec.spoken[0], /question mark/, 'not on a touch screen');
    // typed while she could not hear: she was already talking to them
    var t = page();
    t.c.gate = { open: true, everOpen: false, typedFirst: true, brainText: 'Ready' };
    t.f._gateOpened();
    T.eq(t.rec.spoken, ['I can hear you now too.']);
});

// ---- B5. the loading card ----------------------------------------------------------

T.test('B5: the card speaks plain words: no model IDs, no engine names, no "can not"', function () {
    var f = page().f;
    T.eq(f._plainGateText('ready (gemma-4-26b-a4b-it)'), 'Ready');
    T.match(f._plainGateText('loading my on-device ear 37% (about 40 MB, once)'), /^Downloading speech recognition, one time \(about 40 MB\)$/);
    T.match(f._plainGateText('preparing my on-device ear (the first time can take a minute)'), /^Setting up speech recognition/);
    T.eq(f._plainGateText('press Enter or tap Start - the browser plays no voice until you do'), 'Press Start so the browser lets Netra speak');
    T.eq(f._plainGateText('captions only (this browser can not speak)'), 'No voice on this device. Replies will be shown as text.');
    ['ready (gemma-4-26b-a4b-it)', 'loading my on-device ear 37% (about 40 MB, once)', 'the browser can not reach its speech service - loading my on-device ear (about 80 MB, once)',
     'the browser can not reach its speech service, switching to my own ear', 'on-device ear', 'I can not reach the server'].forEach(function (raw) {
        var out = f._plainGateText(raw);
        T.notMatch(out, /gemma|on-device ear|can not|%/, raw);
        T.eq(f._plainGateText(out), out, 'safe to run twice: ' + raw);
    });
    T.eq(f._plainGateText('answers from the web only - my Gemini key was refused'), 'answers from the web only - my Gemini key was refused', 'the web reason is kept as said (the greeting reads it)');
    T.eq(f._plainGateText('checking…'), 'checking…');
});

T.test('B5: a real progress bar, Type whenever answers are ready, and no "she" or "can not" on the card', function () {
    var card = TPL.substring(TPL.indexOf('<div class="netra-ready"'), TPL.indexOf('<div class="netra-stage-center">'));
    T.match(card, /<div class="netra-ready-bar" role="progressbar" aria-label="Speech recognition download" aria-valuemin="0" aria-valuemax="100" aria-valuenow="\{\{c\.ear\.progress\}\}"/);
    T.notMatch(card.slice(card.indexOf('netra-ready-bar')), /^[^>]*aria-live/, 'the bar is not a live region');
    T.notMatch(card, /she can|can not|\bher\b/i);
    T.match(card, /aria-label="Start Netra\. Press Enter so the browser lets Netra speak\."/);
    T.match(card, /class="netra-ready-type" ng-if="c\.gate\.brain"/);
    T.match(card, /c\.gate\.cantHear \? "Netra can't hear in this browser, but you can type\." : \(c\.gate\.brain && !c\.gate\.hearing \? 'You can type now, or wait to talk\.' : 'Netra can take questions when all three are ready\.'\)/);
    T.match(rule(CSS, '.netra-ready-bar'), /height: 6px;[^}]*background: #3c3c43/);
});

T.test('B5: the microphone question is said before it pops up, and a hearing check that hangs says so at 45 s', function () {
    var p = page(), c = p.c, g;
    c.ready = false; c.readyText = 'Getting ready — checking the browser can hear…'; c.hasSR = true;
    c.ear = { mode: 'auto', on: false, status: 'off', progress: 0, model: 'onnx-community/whisper-tiny.en', device: 'wasm', error: '' };
    c.gate = g = { open: false, everOpen: false, hearing: false, voice: true, brain: true, hearingText: '', voiceText: '', brainText: 'ready' };
    var perm = { state: 'prompt' };
    p.set('$window', { navigator: { permissions: { query: function () { return { then: function (ok) { ok(perm); } }; } } } });
    p.f._micPermHint();
    T.eq(g.hearingText, 'Your browser will ask to use the microphone. Choose Allow.');
    T.match(g.status, /Your browser will ask to use the microphone\. Choose Allow\./);
    perm.state = 'granted'; perm.onchange();
    T.eq(g.micPrompt, false); T.match(g.hearingText, /^checking the browser can hear/);
    p.f._gateSlowCheck();
    T.eq(g.slowHear, true);
    T.eq(g.hearingText, 'Taking longer than usual. You can type while you wait.');
    T.match(g.status, /Hearing is taking longer than usual\. You can type while you wait\./);
    T.match(SRC, /if \(c\.liveMode\) \{ _micPermHint\(\); _gateSlowArm\(\); \}/);
});

T.test('B5: "taking longer" belongs to one closed spell: it clears when the gate opens and a later spell waits its own 45 s', function () {
    var p = page(), c = p.c, g, timers = [], cancelled = 0;
    var t = function (fn, ms) { var h = { fn: fn, ms: ms }; if (ms === 45000) timers.push(h); else if (typeof fn === 'function') fn(); return h; };
    t.cancel = function (h) { cancelled++; if (h) h.fn = null; };
    p.set('$timeout', t);
    c.ready = false; c.readyText = 'Getting ready — checking the browser can hear…'; c.hasSR = true; c.hasTTS = false;
    c.ear = { mode: 'auto', on: false, status: 'off', progress: 0, model: '', device: 'wasm', error: '' };
    c.gate = g = { open: false, everOpen: true, hearing: false, voice: true, brain: true, hearingText: '', voiceText: '', brainText: 'ready' };
    p.f._gateSlowArm();
    timers.shift().fn();   // the first visit hung for 45 s
    T.eq(g.slowHear, true);
    c.ready = true; p.f._gateUpdate();
    T.eq(g.open, true); T.eq(g.slowHear, false, 'cleared when the gate opens');
    // later in the visit the recognizer restarts: the card gives the real reason at once
    c.ready = false; c.readyText = 'Getting ready — restarting the microphone…';
    p.f._gateUpdate();
    T.eq(g.open, false);
    T.match(g.hearingText, /^restarting the microphone/);
    T.notMatch(g.status, /longer than usual/);
    T.eq(timers.length, 1, 'this spell has its own 45 s check'); T.eq(timers[0].ms, 45000);
    timers[0].fn();
    T.eq(g.slowHear, true, 'and says so only once that runs out');
    T.eq(g.hearingText, 'Taking longer than usual. You can type while you wait.');
    // a second spell cancels the timer of the one before it; leaving stops it
    c.ready = true; p.f._gateUpdate(); c.ready = false; p.f._gateUpdate();
    var n = cancelled;
    c.ready = true; p.f._gateUpdate(); c.ready = false; p.f._gateUpdate();
    T.eq(cancelled, n + 1, 'the earlier spell\'s timer is cancelled');
    p.f._gateHintsStop();
    T.eq(cancelled, n + 2, 'and $destroy cancels the last one');
    T.match(SRC, /\$scope\.\$on\('\$destroy', _gateHintsStop\);/);
});

T.test('B5: the microphone-question listener is taken off when the page goes, and a late answer runs nothing', function () {
    var p = page(), c = p.c, updates = 0;
    c.gate = { open: false, everOpen: false, hearing: false, voice: true, brain: true };
    var perm = { state: 'prompt' };
    p.set('$window', { navigator: { permissions: { query: function () { return { then: function (ok) { ok(perm); } }; } } } });
    p.set('_gateUpdate', function () { updates++; });
    p.f._micPermHint();
    T.eq(updates, 1); T.eq(typeof perm.onchange, 'function');
    var late = perm.onchange;
    p.f._gateHintsStop();
    T.eq(perm.onchange, null, 'the handler is removed');
    p.set('_ctrlDestroyed', true);
    perm.state = 'granted'; late();
    T.eq(updates, 1, 'a handler kept elsewhere still does nothing on a dead controller');
    T.eq(c.gate.micPrompt, true);
});

T.test('B5: Start goes once pressed: the focus moves to the card title, not the page', function () {
    var p = page(), c = p.c;
    var start = DOC.body.appendChild(el('button', 'netra-ready-start')), title = DOC.body.appendChild(el('h2', 'netra-ready-title', { id: 'netra-ready-title' }));
    c.ready = true; c.hasTTS = false;
    c.gate = { open: false, everOpen: false, hearing: true, voice: false, brain: false, needsTap: true, hearingText: '', voiceText: '', brainText: 'checking…' };
    start.focus();
    p.f._gateUpdate();   // activated: Start is no longer needed
    T.eq(c.gate.needsTap, false);
    T.ok(DOC.activeElement === title, 'focus on the title');
});

// ---- B6. Settings ------------------------------------------------------------------

T.test('B6: voices and languages in words; a browser without Intl.DisplayNames still gets the code', function () {
    var f = page().f;
    T.eq(f._voiceName('en-US-AvaMultilingualNeural'), 'Ava (US English)');
    T.eq(f._voiceName('en-IN-NeerjaNeural'), 'Neerja (Indian English)');
    T.eq(f._voiceName('xx-YY-FooNeural'), 'xx-YY-Foo');
    var name = f._langName('en-US');
    T.ok(name && name.length, 'named');
    if (typeof Intl !== 'undefined' && Intl.DisplayNames) T.eq(name, 'English (United States)');
    var real = global.Intl;
    global.Intl = { DateTimeFormat: real.DateTimeFormat };   // an older browser
    try { T.eq(page().f._langName('hi-IN'), 'hi-IN', 'the code itself, no throw'); } finally { global.Intl = real; }
    T.eq(f._paceText(1.0), 'normal'); T.eq(f._paceText(1.2), 'a bit faster'); T.eq(f._paceText(0.9), 'a bit slower');
});

T.test('B6: moving the pace speaks one sample line once the slider rests', function () {
    var p = page(), timers = [], cancelled = 0;
    var t = function (fn, ms) { var h = { fn: fn, ms: ms }; timers.push(h); return h; };
    t.cancel = function (h) { cancelled++; h.fn = null; };
    p.set('$timeout', t);
    p.f._pacePreview(); p.f._pacePreview(); p.f._pacePreview();
    T.eq(cancelled, 2);
    timers.forEach(function (h) { if (h.fn) h.fn(); });
    T.eq(p.rec.spoken, ['This is my new pace.']);
    T.eq(timers[2].ms, 600);
});

T.test('B6: Settings is a sheet opened from the header; Escape gives the Settings button the focus', function () {
    var p = page(), c = p.c;
    var head = DOC.body.appendChild(el('button', 'netra-head-settings'));
    var h = DOC.body.appendChild(el('h2', '', { id: 'netra-settings-h', tabindex: '-1' }));
    head.focus();
    p.f._setupToggle();
    T.eq(c.setupOn, true); T.eq(c.sheet, 'settings'); T.ok(DOC.activeElement === h);
    p.f._sheetKey(key('Escape'));
    T.eq(c.setupOn, false); T.ok(DOC.activeElement === head, 'focus on the Settings button');
    var set = slice(TPL, '<div class="netra-sheet netra-settings" id="netra-settings" ng-if="c.setupOn" ng-keydown="c.sheetKey($event)">');
    ['How Netra listens', 'How Netra speaks', 'What you see', 'Sounds', 'Keyboard', 'More'].forEach(function (t) { T.match(set, new RegExp('<h3 id="netra-set-[a-z]+">' + t + '</h3>')); });
    T.eq((set.match(/name="netra-capsize"/g) || []).length, 4);
    T.match(set, /ng-options="v as c\.voiceLabel\(v\) for v in c\.edgeVoices"/);
    T.match(set, /ng-options="l as c\.langName\(l\) for l in c\.recLangs"/);
    T.match(set, /aria-valuetext="\{\{c\.paceText\(\)\}\}"/);
    T.match(set, /ng-model="c\.bargeOn" ng-change="c\.setBarge\(c\.bargeOn\)"/);
    T.match(set, /ng-model="c\.shortcutsOn" ng-change="c\.setShortcuts\(\)"/);
    T.match(set, /ng-click="c\.openLab\(\)">Open diagnostics \(Lab\)</);
    T.match(set, /ng-click="c\.setMicCheck\(\)">Run mic check</);
    T.notMatch(TPL, /MAKE NETRA YOURS|Mic meter|netra-setup-tab|class="netra-setup/);
    var stage = TPL.slice(TPL.indexOf('<div class="netra-stage"'), TPL.indexOf('<div class="netra-sheet netra-settings"'));
    T.notMatch(stage, /class="netra-app-btn"/, 'no floating install button');
    T.notMatch(SRC, /c\.setupOn = true/, 'Settings never open by themselves');
    T.notMatch(rule(CSS, '.netra-set-group h3'), /mono|uppercase|letter-spacing: 0\.\d/);
    T.ok(contrast('#c4c7c5', '#1b1b1f') >= 7, 'hints');
});

T.test('B6: the Lab opens from Settings > More or Alt+D, keeps Copy diagnostics, and Escape closes it', function () {
    var p = page(), c = p.c, handler = null;
    var head = DOC.body.appendChild(el('button', 'netra-head-settings'));
    var x = DOC.body.appendChild(el('button', 'netra-lab-x'));
    p.f._setupToggle();
    p.f._labFromSettings();
    T.eq(c.setupOn, false, 'the sheet steps aside'); T.eq(c.labOn, true);
    T.ok(DOC.activeElement === x, 'focus on the Lab\'s close button');
    var e = key('Escape');
    p.f._labKey(e);
    T.eq(c.labOn, false); T.eq(e.stopped, 1);
    T.ok(DOC.activeElement === head, 'focus on the Settings button');
    // Alt+D on the stage: the Lab (an iPhone user reaches it from Settings > More)
    p.set('$window', { addEventListener: function (k, f) { if (k === 'keydown') handler = f; } });
    p.f.bindHotkeys();
    c.liveMode = true; c.toggleDev = function () { throw new Error('not the dev panel on the stage'); };
    // behind the loading card Alt+D does nothing: the Lab would sit on top of it, inert
    c.gate = { open: false, everOpen: false, typing: false, hearing: false, voice: true, brain: true };
    var e1 = key('d', { altKey: true, target: DOC.body });
    handler(e1);
    T.eq(c.labOn, false, 'not over the loading card'); T.eq(e1.prevented, 0, 'the key is left alone');
    c.gate.typing = true;   // Type instead: the card has stepped aside
    handler(key('d', { altKey: true, target: DOC.body }));
    T.eq(c.labOn, true);
    T.match(TPL, /<aside class="netra-lab" ng-show="c\.labOn" role="dialog"[^>]*ng-keydown="c\.labKey\(\$event\)">/);
    T.match(TPL, /ng-click="c\.copyDiag\(\)">\{\{c\.diagCopied \? 'Diagnostics copied' : 'Copy diagnostics'\}\}/);
});

T.test('B6: Run mic check closes the Settings sheet and gives the mic check\'s Skip the focus', function () {
    var p = page(), c = p.c, runs = 0;
    var head = DOC.body.appendChild(el('button', 'netra-head-settings'));
    var skip = DOC.body.appendChild(el('button', 'netra-calib-skip'));
    c.calibRetry = function () { runs++; c.labCalib = { stage: 'prompt' }; };
    head.focus();
    p.f._setupToggle();
    T.eq(c.setupOn, true);
    p.f._micCheckFromSettings();
    T.eq(runs, 1, 'the check runs');
    T.eq(c.setupOn, false, 'the sheet (a modal over the card) is gone'); T.eq(c.sheet, null);
    T.ok(DOC.activeElement === skip, 'focus on Skip, not back on the Settings button');
    T.match(TPL, /<button class="netra-calib-skip" ng-show="c\.labCalib\.stage === 'listening' \|\| c\.labCalib\.stage === 'prompt'" ng-click="c\.calibSkip\(\)">Skip<\/button>/);
});

T.test('B3/B6: Shift+Tab from a sheet\'s heading, or from outside it, wraps to the last control', function () {
    var p = page(), c = p.c;
    var end = DOC.body.appendChild(el('button', 'netra-ctl netra-ctl-end'));
    var card = DOC.body.appendChild(el('div', 'netra-sheet-card'));
    var h = card.appendChild(el('h2', '', { id: 'netra-log-h', tabindex: '-1' }));
    var close = card.appendChild(el('button')), link = card.appendChild(el('a', '', { href: 'https://x.test' })), copy = card.appendChild(el('button'));
    p.f._sheetOpen('log', '.netra-ctl-log');
    T.ok(DOC.activeElement === h, 'the sheet opens on its heading');
    var e = key('Tab', { shiftKey: true });
    p.f._sheetKey(e);
    T.eq(e.prevented, 1); T.ok(DOC.activeElement === copy, 'Shift+Tab from the heading: the last control, not End behind the scrim');
    h.focus(); e = key('Tab');
    p.f._sheetKey(e);
    T.ok(DOC.activeElement === close, 'Tab from the heading: the first control');
    end.focus(); e = key('Tab', { shiftKey: true });
    p.f._sheetKey(e);
    T.ok(DOC.activeElement === copy, 'focus that got outside comes back in');
    link.focus(); e = key('Tab', { shiftKey: true });
    p.f._sheetKey(e);
    T.eq(e.prevented, 0, 'in between, Shift+Tab moves normally');
    T.eq(c.sheet, 'log');
});

T.test('B3: "Transcript copied" is said on every Copy, and a reopened sheet does not say it again', function () {
    var p = page(), c = p.c, timers = [];
    var t = function (fn, ms) { if (ms === 50) timers.push(fn); else if (typeof fn === 'function') fn(); return 0; };
    t.cancel = noop;
    p.set('$timeout', t);
    p.set('$window', { navigator: { clipboard: { writeText: function () { return { then: function (ok) { ok(); } }; } } } });
    c.convo.push({ who: 'you', text: 'q', t: '10:42:03' });
    p.f._sheetOpen('log', '.netra-ctl-log');
    p.f._logCopy();
    T.eq(c.logSaid, '', 'emptied first'); timers.shift()();
    T.eq(c.logSaid, 'Transcript copied');
    p.f._logCopy();
    T.eq(c.logSaid, '', 'a second Copy empties the line, so the same words are a change again'); timers.shift()();
    T.eq(c.logSaid, 'Transcript copied');
    p.f._sheetClose();
    T.eq(c.logSaid, '');
    c.logSaid = 'Transcript copied'; p.f._sheetOpen('log', '.netra-ctl-log');
    T.eq(c.logSaid, '', 'the reopened sheet starts quiet');
});

T.test('B4: the Tokyo starter is answered at once and exactly, from the browser\'s own time zones', function () {
    // live, the model was busy and a Guest heard a web page's title read out
    var f = page().f, at = Date.UTC(2026, 8, 25, 9, 5);   // 09:05 UTC: 18:05 in Tokyo, 05:05 in New York
    T.match(f._placeTime('tokyo', at), /^In Tokyo it is 6 oh 5 P M(, on \w+day)?\.$/);
    T.match(f._placeTime('New York', at), /^In New York it is 5 oh 5 A M(, on \w+day)?\.$/);
    T.match(f._placeTime('the uk', Date.UTC(2026, 0, 5, 14, 0)), /^In UK it is 2 o'clock P M/);
    T.eq(f._placeTime('atlantis', at), null, 'a place not in the table goes on to the model');
    var real = Date.now;
    Date.now = function () { return at; };
    try {
        ['What time is it in Tokyo?', 'what\'s the time in tokyo', 'time in Tokyo now', 'what is the current time in tokyo'].forEach(function (u) {
            var r = f.matchLocal(u) || {};
            T.eq(r.intent, 'time', u); T.match(r.reply || '', /^In Tokyo it is 6 oh 5 P M/, u);
        });
        T.eq(f.matchLocal('what time is it in atlantis'), null, 'unknown: not answered locally');
        T.match(f.matchLocal('what time is it').reply, /^The time is /, 'the local time is as before');
    } finally { Date.now = real; }
    T.ok(f._starters().some(function (s) { return /time is it in Tokyo/.test(s); }), 'still a starter');
});

// ---- B7. single keys -----------------------------------------------------------------

T.test('B7: which key means what, and when a key is left alone', function () {
    var a = page().f._stageKeyAction;
    T.eq(a('m', 'BUTTON', false, false, null, false, true, true), 'mute');
    T.eq(a('M', 'DIV', false, false, null, false, true, true), 'mute');
    T.eq(a('/', 'BUTTON', false, false, null, false, true, true), 'type');
    T.eq(a('t', 'BUTTON', false, false, null, false, true, true), 'transcript');
    T.eq(a('s', 'BUTTON', false, false, null, false, true, true), 'settings');
    T.eq(a('?', 'BUTTON', false, false, null, false, true, true), 'help');
    T.eq(a('m', 'INPUT', false, false, null, false, true, true), '', 'typing an m types an m');
    T.eq(a('m', 'DIV', true, false, null, false, true, true), '', 'contenteditable');
    T.eq(a('m', 'BUTTON', false, true, null, false, true, true), '', 'Ctrl/Alt/Meta');
    T.eq(a('m', 'BUTTON', false, false, null, false, false, true), '', 'single keys off');
    T.eq(a('m', 'BUTTON', false, false, null, false, true, false), '', 'the portal page, not the stage');
    T.eq(a('Escape', 'DIV', false, false, 'log', false, false, true), 'close-sheet', 'Escape works with keys off');
    T.eq(a('Escape', 'DIV', false, false, null, true, true, true), 'close-type');
    T.eq(a('Escape', 'DIV', false, false, null, false, true, true), 'stop');
    T.eq(a('Escape', 'BODY', false, false, null, false, true, false), 'stop', 'Escape on the page still stops her');
    T.eq(a('x', 'BUTTON', false, false, null, false, true, true), '');
});

T.test('B7: on the stage M mutes, ? speaks the list, keys off leaves M alone but not Escape', function () {
    var p = page(), c = p.c, handler = null, mutes = 0;
    p.set('$window', { addEventListener: function (k, f) { if (k === 'keydown') handler = f; } });
    p.f.bindHotkeys();
    c.liveMode = true; c.shortcutsOn = true;
    c.toggleMic = function () { mutes++; };
    var stage = DOC.body.appendChild(el('div', 'netra-stage')), orb = stage.appendChild(el('button', 'netra-stage-blob-wrap'));
    var e = key('m', { target: orb });
    handler(e);
    T.eq(mutes, 1, 'M on Netra mutes'); T.eq(e.prevented, 1);
    handler(key('m', { target: DOC.body }));
    T.eq(mutes, 1, 'keys on the portal page do nothing');
    handler(key('m', { target: stage.appendChild(el('input')) }));
    T.eq(mutes, 1, 'typing in a field');
    handler(key('m', { target: stage.appendChild(el('aside', 'netra-lab')).appendChild(el('button')) }));
    T.eq(mutes, 1, 'a key in the Lab is the Lab\'s');
    handler(key('?', { target: orb }));
    T.match(p.rec.spoken[0], /^Shortcuts: M, mute\. Slash, type\. T, transcript\. S, settings\. Escape, stop Netra talking or close\./);
    c.shortcutsOn = false;
    handler(key('m', { target: orb }));
    T.eq(mutes, 1, 'single keys off');
    handler(key('Escape', { target: orb }));
    T.eq(p.rec.stops, ['Escape key'], 'Escape still stops her');
    // behind the loading card only Escape counts
    c.shortcutsOn = true; c.gate = { open: false, typing: false };
    handler(key('m', { target: orb }));
    T.eq(mutes, 1);
    // off the stage (the floating orb), Escape is as it was
    c.liveMode = false;
    handler(key('Escape', { target: DOC.body }));
    T.eq(p.rec.stops, ['Escape key', 'Escape key']);
    T.match(SRC, /c\.shortcutsOn = localStorage\.getItem\('netra_shortcuts'\) !== '0';/);
});

T.run(__filename);
