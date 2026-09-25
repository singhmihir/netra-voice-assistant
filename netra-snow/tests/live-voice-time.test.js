/* The Live stage with the keyboard up, the voice picked in Settings, and
 * how a time is written.
 *
 * - With the on-screen keyboard up (data-kbd) the stage has no orb row, a
 *   compact bar whose words stay as the controls' names, and a caption that
 *   is a whole line or none (the layout itself is measured in Chromium by
 *   live-stage.test.js).
 * - On the browser voice, Settings lists this device's own voices and the
 *   pick is the voice that speaks; "Hear this voice" names the voice that
 *   really plays and never calls a Guest "Guest".
 * - A time is written "3:05 PM" for the caption, the Transcript, a screen
 *   reader and braille, and the voices get the same text. */
'use strict';
var T = require('./lib/t'), N = require('./lib/netra');
var fs = require('fs'), path = require('path');
var TPL = fs.readFileSync(path.join(N.SRC, 'widget', 'template.html'), 'utf8');
var CSS = fs.readFileSync(path.join(N.SRC, 'widget', 'stylesheet.scss'), 'utf8');
var SRC = fs.readFileSync(path.join(N.SRC, 'widget', 'client.js'), 'utf8');

var store = {};
global.localStorage = { getItem: function (k) { return store.hasOwnProperty(k) ? store[k] : null; }, setItem: function (k, v) { store[k] = String(v); }, removeItem: function (k) { delete store[k]; } };
global.window = global.window || {};
global.document = { querySelector: function () { return null; }, querySelectorAll: function () { return []; }, activeElement: null };
function noop() {}

// the controller with its outside world stubbed; what she says is recorded
function page() {
    store = {};
    var cl = N.loadClient(), c = cl.c, set = cl.set, spoken = [];
    var now = function (fn) { if (typeof fn === 'function') fn(); return 0; };
    now.cancel = noop;
    set('$timeout', now);
    set('$scope', { $applyAsync: noop, $on: noop });
    set('$window', {});
    set('speak', function (text, done) { spoken.push(String(text)); if (done) done(); });
    set('logEvent', noop);
    set('forcedVoiceName', ''); set('_edgeBrowser', false); set('_speakSessionId', 1);
    c.data = {}; c.events = []; c.hasTTS = true; c.ttsEngine = 'browser'; c.recLang = 'en-US'; c.voicePick = '';
    c.speechRate = 1.0; c.edgeVoice = 'en-US-AvaMultilingualNeural';
    return { c: c, f: cl.fn, get: cl.get, set: set, spoken: spoken };
}
// a device's voices, as a browser lists them
var VOICES = [
    { name: 'Microsoft David - English (United States)', lang: 'en-US', localService: true },
    { name: 'Google Deutsch', lang: 'de-DE', localService: false },
    { name: 'Microsoft Aria Online (Natural) - English (United States)', lang: 'en-US', localService: false },
    { name: 'Google हिन्दी', lang: 'hi-IN', localService: false },
    { name: 'Samantha', lang: 'en_US', localService: true }
];
function tts(p, played) {
    p.set('TTS', { speaking: false, pending: false, cancel: noop, getVoices: function () { return VOICES; }, speak: function (u) { if (played) played.push(u); } });
}
function rule(src, sel) {
    var at = src.indexOf(sel + ' {');
    T.ok(at >= 0, 'found the rule ' + sel);
    return src.slice(at, src.indexOf('}', at) + 1);
}

// ---- Y1. the keyboard up ----------------------------------------------------------

T.test('Y1: keyboard up - no orb row, the hint gives way, the middle wraps a caption with no room out of sight', function () {
    T.match(CSS, /\.netra-stage\[data-kbd\] \.netra-stage-orbit,\n\.netra-stage\[data-kbd\] \.netra-stage-blob-wrap \{ display: none; \}/);
    var st = rule(CSS, '.netra-stage[data-kbd]');
    T.match(st, /grid-template-columns: minmax\(0, 1fr\);/, 'no orb column');
    T.match(st, /grid-template-areas: 'head' 'mid' 'aux' 'bar';/, 'no orb row');
    var mid = rule(CSS, '.netra-stage[data-kbd] .netra-stage-center');
    T.match(mid, /grid-area: mid;/); T.match(mid, /flex-flow: column wrap;/); T.match(mid, /overflow: hidden;/);
    T.match(rule(CSS, '.netra-stage[data-kbd] .netra-status-hint'), /display: none;/);
    // the caption is whole lines: its height and the mask at its top are both whole lines
    var cap = rule(CSS, '.netra-stage[data-kbd] .netra-cap');
    T.match(cap, /flex: none;/); T.match(cap, /height: calc\(14px \+ var\(--kbd-lines\) \* 1\.45em\);/); T.match(cap, /padding: 6px 14px;/);
    T.match(rule(CSS, '.netra-stage[data-kbd] .netra-cap .netra-cap-line'), /mask-image: linear-gradient\(to top, #000 calc\(var\(--kbd-lines\) \* 1\.45em\), transparent calc\(var\(--kbd-lines\) \* 1\.45em\)\);/);
    // sideways: the header shares its row with the status and the caption
    var side = CSS.slice(CSS.indexOf('/* sideways the header shares its row'));
    T.match(side, /grid-template-columns: auto minmax\(0, 1fr\);\n\s+grid-template-rows: 48px minmax\(0, 1fr\) auto auto;\n\s+grid-template-areas: 'head mid' '\. mid' 'aux aux' 'bar bar';/);
});

T.test('Y1: keyboard up - a compact bar keeps each control\'s word as its name (hidden from sight, not from screen readers)', function () {
    var lab = rule(CSS, '.netra-stage[data-kbd] .netra-ctl-label');
    // the .netra-sr-only pattern: still in the accessibility tree
    T.match(lab, /position: absolute !important;/); T.match(lab, /clip: rect\(0,0,0,0\);/); T.match(lab, /width: 1px;/);
    T.notMatch(lab, /display: none|visibility: hidden|aria-hidden/, 'never removed');
    T.match(rule(CSS, '.netra-stage[data-kbd] .netra-ctl-ico'), /width: 44px; height: 44px;/);
    T.match(rule(CSS, '.netra-stage[data-kbd] .netra-ctl'), /min-height: 44px;/, 'still a 44 px target');
    ['Mute', 'Type', 'Transcript', 'End'].forEach(function (w) { T.match(TPL, new RegExp('<span class="netra-ctl-label">' + w + '</span>')); });
});

// ---- Y2. the voice picked in Settings ---------------------------------------------

T.test('Y2: on the browser voice Settings lists this device\'s voices - her language, then English, then the rest - by plain names', function () {
    var p = page(), c = p.c; tts(p);
    T.eq(p.f._neuralVoices(), false, 'the browser engine');
    c.ttsEngine = 'edge';
    T.eq(p.f._neuralVoices(), false, 'the Edge engine outside Microsoft Edge plays the browser voice too');
    c.ttsEngine = 'browser';
    var list = p.f._deviceVoices();
    T.eq(list.map(function (v) { return v.label; }), ['The best voice on this device', 'David, English (United States)',
        'Aria, English (United States)', 'Samantha, English (United States)', 'Google Deutsch, German (Germany)', 'Google हिन्दी, Hindi (India)']);
    T.eq(list[2].name, 'Microsoft Aria Online (Natural) - English (United States)', 'the value is the real voice');
    T.eq(list[0].name, '', 'the automatic choice');
    T.ok(p.f._deviceVoices() === list, 'the same array every digest');
    c.recLang = 'hi-IN';
    T.eq(p.f._deviceVoices()[1].label, 'Google हिन्दी, Hindi (India)', 'the language she listens for comes first');
    T.eq(p.f._deviceVoiceLabel({ name: 'Google US English', lang: 'en-US' }), 'Google US English', 'no language said twice');
    // a pick this device does not have now is named, not a blank
    c.recLang = 'en-US'; c.voicePick = 'Karen';
    T.eq(p.f._deviceVoices().pop(), { name: 'Karen', label: 'Karen (not on this device now)' });
    // the Settings markup: the neural list only where it plays
    var set = TPL.slice(TPL.indexOf('<label class="netra-set-label" for="netra-set-voice">'), TPL.indexOf('Hear this voice'));
    T.match(set, /<select id="netra-set-voice" class="netra-set-select" ng-if="c\.neuralVoices\(\)" ng-model="c\.edgeVoice" ng-change="c\.devSetEdgeVoice\(\)"/);
    T.match(set, /<select id="netra-set-voice" class="netra-set-select" ng-if="!c\.neuralVoices\(\)" ng-model="c\.voicePick" ng-change="c\.setDeviceVoice\(\)"\s+ng-options="v\.name as v\.label for v in c\.deviceVoices\(\)"><\/select>/);
});

T.test('Y2: the voice picked is the voice that speaks, and it is kept for next time', function () {
    var p = page(), c = p.c, played = [];
    tts(p, played);
    ['_markSpeaking', '_silenceCurrentAudio', '_clearSpeaking', '_resumeAudio', '_gateUpdate'].forEach(function (n) { p.set(n, noop); });
    global.SpeechSynthesisUtterance = function (t) { this.text = t; };
    try {
        T.eq(p.f.chooseVoice().name, 'Samantha', 'before: the device\'s own pick');
        c.voicePick = 'Microsoft Aria Online (Natural) - English (United States)';
        p.f._setDeviceVoice(c.voicePick);
        T.eq(p.f.chooseVoice().name, c.voicePick, 'the picked voice, not the device default');
        T.eq(store.netra_voicePick, c.voicePick, 'kept on this device');
        p.f.speakBrowser('Hello there.', noop);
        T.eq(played.length, 1); T.eq(played[0].voice.name, c.voicePick, 'and it is the one that plays');
        T.eq(played[0].lang, 'en-US');
        c.voicePick = ''; p.f._setDeviceVoice(c.voicePick);
        T.eq(p.f.chooseVoice().name, 'Samantha', 'back to the best on this device');
        T.ok(!store.hasOwnProperty('netra_voicePick'), 'and nothing kept');
    } finally { delete global.SpeechSynthesisUtterance; }
    T.match(SRC, /c\.setDeviceVoice = function \(\) \{ _setDeviceVoice\(c\.voicePick\); \};/);
    T.match(SRC, /c\.deviceVoices = function \(\) \{ return _deviceVoices\(\); \};/);
    T.match(SRC, /c\.neuralVoices = function \(\) \{ return _neuralVoices\(\); \};/);
    // the pick comes back on the next visit
    T.match(SRC, /try \{ forcedVoiceName = c\.voicePick = String\(localStorage\.getItem\('netra_voicePick'\) \|\| ''\); \} catch \(eFv\) \{\}/);
});

T.test('Y2: "Hear this voice" names the voice that really plays, and calls no Guest or reviewer "Guest"', function () {
    var p = page(), c = p.c; tts(p);
    T.match(SRC, /c\.devPreviewVoice = function \(\) \{ _previewVoice\(\); \};/, 'Settings and the Lab both');
    c.data = { user_name: 'Mihir Singh' };
    c.voicePick = 'Microsoft Aria Online (Natural) - English (United States)'; p.f._setDeviceVoice(c.voicePick);
    p.f._previewVoice();
    T.eq(p.spoken.pop(), 'Hi Mihir. This is the Aria voice, at a normal pace.');
    c.speechRate = 1.2; p.f._previewVoice();
    T.eq(p.spoken.pop(), 'Hi Mihir. This is the Aria voice, a bit faster than normal.');
    c.speechRate = 1.0;
    // the automatic choice is named by what it picks
    c.voicePick = ''; p.f._setDeviceVoice(c.voicePick); p.f._previewVoice();
    T.eq(p.spoken.pop(), 'Hi Mihir. This is the Samantha voice, at a normal pace.');
    // no name for a Guest (with or without the flag) or a read-only reviewer
    [{ is_guest: true, user_name: 'Guest' }, { user_name: 'Guest' }, { read_only: true, user_name: 'Review Er' }].forEach(function (d) {
        c.data = d; p.f._previewVoice();
        T.eq(p.spoken.pop(), 'Hi. This is the Samantha voice, at a normal pace.', JSON.stringify(d));
    });
    // no voice at all on this device: no name made up
    p.set('TTS', { getVoices: function () { return []; } });
    c.data = {}; p.f._previewVoice();
    T.eq(p.spoken.pop(), 'Hi. This is my voice, at a normal pace.');
});

T.test('Y2: in Microsoft Edge the neural voices are listed and the preview says the neural voice\'s plain name', function () {
    var p = page(), c = p.c; tts(p);
    var hadWS = global.WebSocket;
    global.WebSocket = function () {};
    try {
        p.set('_edgeBrowser', true); c.ttsEngine = 'edge';
        p.set('_edgeCircuitOpen', function () { return false; });   // the read-aloud socket is up
        T.eq(p.f._neuralVoices(), true);
        c.edgeVoice = 'en-US-EmmaMultilingualNeural'; c.data = { user_name: 'Mihir Singh' };
        p.f._previewVoice();
        T.eq(p.spoken.pop(), 'Hi Mihir. This is the Emma voice, at a normal pace.', 'never "EmmaMultilingual"');
        c.edgeVoice = 'en-IN-NeerjaNeural'; c.data = { is_guest: true, user_name: 'Guest' }; p.f._previewVoice();
        T.eq(p.spoken.pop(), 'Hi. This is the Neerja voice, at a normal pace.');
        // the select shows the same plain names
        T.eq(p.f._voiceName('en-US-AvaMultilingualNeural'), 'Ava (US English)');
        // the read-aloud socket tripped (a network that blocks it): the device
        // voice plays, so the preview names that one, not Neerja
        p.set('_edgeCircuitOpen', function () { return true; });
        c.data = {}; p.f._previewVoice();
        T.notMatch(p.spoken.pop(), /Neerja|Emma/);
    } finally { if (hadWS === undefined) delete global.WebSocket; else global.WebSocket = hadWS; }
});

T.test('Y2: a voice kept from Settings is the one the loading card names on the next visit', function () {
    // the verifier's case: David kept, the card said Aria (the automatic pick)
    var p = page(), c = p.c; tts(p);
    p.set('forcedVoiceName', 'Microsoft David - English (United States)');
    c.voiceName = '(picking...)'; c.gate = { voice: true };
    p.f.populateVoices();
    T.eq(c.voiceName, 'Microsoft David - English (United States)');
    T.eq(p.f.chooseVoice().name, c.voiceName, 'and it is the voice that speaks');
    // a kept voice this device no longer has: the automatic pick is named
    var p2 = page(), c2 = p2.c; tts(p2);
    p2.set('forcedVoiceName', 'Microsoft Zira - English (United States)');
    c2.voiceName = '(picking...)'; c2.gate = { voice: true };
    p2.f.populateVoices();
    T.ok(c2.voiceName !== '(picking...)' && c2.voiceName !== 'Microsoft Zira - English (United States)', c2.voiceName);
});

// ---- Y3. how a time is written ----------------------------------------------------

T.test('Y3: a time is written as people write it - "3:05 PM" - never "3 oh 5 P M"', function () {
    var f = page().f;
    T.eq(f._clock(15, 5), '3:05 PM'); T.eq(f._clock(0, 0), '12:00 AM'); T.eq(f._clock(12, 30), '12:30 PM'); T.eq(f._clock(9, 45), '9:45 AM');
    var at = Date.UTC(2026, 8, 25, 3, 25);   // 12:25 in Tokyo
    T.match(f._placeTime('tokyo', at), /^In Tokyo it is 12:25 PM(, on \w+day)?\.$/);
    var Real = Date;
    global.Date = function () { return arguments.length ? new (Function.prototype.bind.apply(Real, [null].concat([].slice.call(arguments))))() : new Real(2026, 8, 25, 15, 5); };
    global.Date.now = function () { return new Real(2026, 8, 25, 15, 5).getTime(); };
    try { T.eq(f.matchLocal('what time is it').reply, 'The time is 3:05 PM.'); } finally { global.Date = Real; }
    T.notMatch(SRC.slice(SRC.indexOf('function _placeTime'), SRC.indexOf('// small talk')), /'oh '|'A M'|'P M'/, 'no spoken-only form left');
});

T.test('Y3: the voices get the same "12:25 PM" - no step of the speech path rewrites it', function () {
    var p = page(), played = [];
    var line = 'In Tokyo it is 12:25 PM, on Friday.';
    // the caption, and what the echo check hears her say ("it is" becomes "it's")
    p.set('_CONTRACTION_PAIRS', [['it is', "it's", true]]);
    T.eq(p.f._humanizeReply(line), 'In Tokyo it\'s 12:25 PM, on Friday.');
    // the neural voice: one prosody round the plain text
    T.match(p.f._buildHumanSSML(line, 'en-US-AvaMultilingualNeural'), /<prosody [^>]+>In Tokyo it is 12:25 PM, on Friday\.<\/prosody>/);
    T.eq(p.f._splitSentenceGroups('The time is 3:05 PM. Anything else?', 200), ['The time is 3:05 PM. Anything else?']);
    // the browser voice
    tts(p, played);
    ['_markSpeaking', '_silenceCurrentAudio', '_clearSpeaking', '_resumeAudio', '_gateUpdate'].forEach(function (n) { p.set(n, noop); });
    global.SpeechSynthesisUtterance = function (t) { this.text = t; };
    try { p.f.speakBrowser('The time is 3:05 PM.', noop); } finally { delete global.SpeechSynthesisUtterance; }
    T.eq(played[0].text, 'The time is 3:05 PM.');
});

T.run(__filename);
