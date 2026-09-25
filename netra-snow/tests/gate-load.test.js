/* The loading screen, from a first visit on a phone, an iPhone and a screen reader.
 *
 * The gate must open as soon as the browser's own recognizer works - the
 * on-device ear (a 40-200 MB download) is only for a recognizer that fails.
 * On iPhone the Start button's own click is what unlocks her voice. For a
 * screen reader the card is a modal dialog with one quiet status line, not
 * a stream of download percentages. A browser that can not hear can still
 * be typed to, a question said while answers are down is never replaced by
 * the next one, and web answers stay on through a whole outage. */
var T = require('./lib/t'), N = require('./lib/netra'), S = require('./lib/session'), g = S.g, gem = S.gem;
var fs = require('fs'), path = require('path'), vm = require('vm');
var CLIENT_SRC = fs.readFileSync(path.join(N.SRC, 'widget', 'client.js'), 'utf8');
var TEMPLATE = fs.readFileSync(path.join(N.SRC, 'widget', 'template.html'), 'utf8');
var STYLES = fs.readFileSync(path.join(N.SRC, 'widget', 'stylesheet.scss'), 'utf8');

function noop() {}
function page() {
    var cl = N.loadClient(), c = cl.c;
    c.events = []; c.heard = []; c.micHealth = {}; c.stats = {}; c.convo = []; c.alert = true; c.hasSR = true; c.hasTTS = false;
    c.permission = 'granted'; c.recLang = 'en-US'; c.data = {};
    ['logEvent', 'cue', '_convoPush', 'unlockAudio'].forEach(function (n) { cl.set(n, noop); });
    cl.set('$scope', { $applyAsync: noop, $on: noop });
    cl.set('$timeout', Object.assign(function () { return {}; }, { cancel: noop }));
    cl.set('_activated', true); cl.set('_voiceBlocked', false); cl.set('_speechUnlocked', false); cl.set('_speakingNow', false);
    cl.set('_nativeVerdict', 'unknown'); cl.set('_nativeHeardWords', false); cl.set('_voiceCheckStart', Date.now());
    cl.set('_earWorker', null); cl.set('_earEngageOnLoad', false); cl.set('_chatInFlight', false);
    cl.set('_gateInert', []); cl.set('_gateHeld', null); cl.set('_gateAskAfter', []); cl.set('_queuedUtterance', null);
    c.ear = { mode: 'auto', size: 'auto', on: false, status: 'off', progress: 0, prepared: false, model: 'onnx-community/whisper-tiny.en', device: 'wasm', error: '', heard: 0, why: '' };
    c.gate = { open: false, everOpen: false, hearing: false, voice: false, brain: true, hearingText: '', voiceText: '', brainText: 'ready' };
    return cl;
}

/* ---- 1. the gate waits for a working recognizer, never for a download ---- */

T.test('a recognizer that started cleanly opens the gate at once, even where the ear could run', function () {
    var cl = page(), f = cl.fn, c = cl.c, said = [];
    cl.set('speak', function (t) { said.push(t); });
    global.Worker = function () {};   // a browser that could run the on-device ear
    cl.set('_nativeVerdict', 'ok');   // started, no network error while it settled
    f._readyUpdate();
    T.eq(c.ready, true, 'no wait for words or for the ear');
    T.eq(c.gate.open, true);
    T.eq(c.ear.status, 'off', 'and nothing was downloaded');
    T.match(said[0] || '', /I'm Netra, and I'm listening\./);
    T.eq(cl.get('NATIVE_SETTLE_MS') <= 3000, true, 'a short settle time');
    delete global.Worker;
});

T.test('boot never holds the gate for the ear; a desktop loads the small ear later in the background, a phone never', function () {
    var cl = page(), f = cl.fn, c = cl.c, calls = [], later = [];
    cl.set('$timeout', Object.assign(function (fn, ms) { later.push({ fn: fn, ms: ms }); return {}; }, { cancel: noop }));
    cl.set('$window', { navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0' }, document: { addEventListener: noop } });
    ['unlockAudio', 'populateVoices', 'startContinuous', '_readyUpdate', 'startListeningWatchdog', 'startVisibilityRecovery',
     'startNotificationPolling', 'setState', 'openConversation', 'speak'].forEach(function (n) { cl.set(n, function () { calls.push(n); }); });
    cl.set('_earLoad', function () { calls.push('_earLoad'); });
    cl.set('_earStart', function () { calls.push('_earStart'); return true; });
    cl.set('_brainProbe', function (why) { calls.push('_brainProbe:' + why); });
    cl.set('booted', false); cl.set('_ctrlDestroyed', false);
    global.Worker = function () {};
    c.hasSR = true; c.data = { has_api_key: true };
    f.tryBoot(false);
    T.ok(calls.indexOf('startContinuous') >= 0);
    T.eq(calls.indexOf('_earLoad'), -1, 'nothing downloads while the gate opens');
    T.eq(calls.indexOf('_earStart'), -1);
    var bg = later.filter(function (x) { return x.ms >= 10000; });
    T.eq(bg.length, 1, 'one later background load on a desktop');
    cl.set('_ctrlDestroyed', false); bg[0].fn();
    T.eq(calls.indexOf('_earLoad') >= 0, true, 'the small ear loads in the background');
    // a phone: nothing later either
    var cl2 = page(), later2 = [];
    ['unlockAudio', 'populateVoices', 'startContinuous', '_readyUpdate', 'startListeningWatchdog', 'startVisibilityRecovery',
     'startNotificationPolling', 'setState', 'openConversation', 'speak', '_earLoad', '_earStart', '_brainProbe'].forEach(function (n) { cl2.set(n, noop); });
    cl2.set('$timeout', Object.assign(function (fn, ms) { later2.push(ms); return {}; }, { cancel: noop }));
    cl2.set('$window', { navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) Mobile Chrome/141.0' }, document: { addEventListener: noop } });
    cl2.set('booted', false); cl2.set('_ctrlDestroyed', false);
    cl2.c.hasSR = true; cl2.c.data = { has_api_key: true };
    cl2.fn.tryBoot(false);
    T.eq(later2.filter(function (ms) { return ms >= 10000; }).length, 0, 'a phone downloads nothing up front');
    delete global.Worker;
});

T.test('a background ear waits in standby while the browser hears, and a deaf strike swaps it in at once', function () {
    var cl = page(), f = cl.fn, c = cl.c, spawned = [];
    global.Worker = function () {}; global.Blob = global.Blob || function () {};
    cl.set('$window', { navigator: { userAgent: 'Windows NT 10.0 Chrome/141.0', gpu: {} }, document: { addEventListener: noop } });
    cl.set('speak', noop); cl.set('_earTapAttach', noop);
    cl.set('_earSpawn', function () { spawned.push(c.ear.model + ' on ' + c.ear.device); cl.set('_earWorker', {}); });
    cl.set('_nativeVerdict', 'ok');
    f._earLoad(true);
    T.eq(spawned, ['onnx-community/whisper-tiny.en on wasm'], 'the small model, even with a GPU');
    f._earOnMessage({ data: { loaded: true } });
    T.eq(c.ear.status, 'standby', 'the browser recognizer keeps the mic');
    T.eq(c.ear.on, false);
    // the first strike of speech with no words: the ear takes over, no download
    T.eq(f._earStart('the browser returned no words for clear speech'), true);
    T.eq(c.ear.on, true);
    T.eq(spawned.length, 1);
    delete global.Worker;
});

T.test('a blocked speech service loads the ear, and the loading screen says why and how big', function () {
    var cl = page(), f = cl.fn, c = cl.c, spawned = [];
    global.Worker = function () {};
    cl.set('SR', function () { var r = this; r.start = noop; r.stop = noop; r.abort = noop; });
    cl.set('attachGrammar', noop); cl.set('_edgeBrowser', false); cl.set('recRunningDebounceTimer', null); cl.set('recRestartCount', 0); cl.set('RESTART_DELAY', 250);
    cl.set('_netErrStreak', 0); cl.set('_earSpawn', function () { spawned.push(c.ear.model); });
    cl.set('speak', noop);
    f.startContinuous();
    cl.get('contRec').onerror({ error: 'network' });
    T.eq(spawned, ['onnx-community/whisper-tiny.en'], 'the ear starts loading');
    T.eq(c.ready, false);
    T.eq(c.gate.hearingText, 'The browser can\'t reach its speech service - downloading speech recognition, one time (about 40 MB)');
    // a refusal that comes after the clean start still brings the ear
    var cl2 = page(), f2 = cl2.fn, c2 = cl2.c, spawned2 = [];
    cl2.set('SR', function () { var r = this; r.start = noop; r.stop = noop; r.abort = noop; });
    cl2.set('attachGrammar', noop); cl2.set('_edgeBrowser', false); cl2.set('recRunningDebounceTimer', null); cl2.set('recRestartCount', 0); cl2.set('RESTART_DELAY', 250);
    cl2.set('_netErrStreak', 0); cl2.set('_earSpawn', function () { spawned2.push(c2.ear.model); });
    cl2.set('speak', noop);
    cl2.set('_nativeVerdict', 'ok');
    f2.startContinuous();
    cl2.get('contRec').onerror({ error: 'network' });
    T.eq(cl2.get('_nativeVerdict'), 'blocked', 'started, but never heard a word: it is blocked');
    T.eq(spawned2.length, 1);
    // one that has already heard words is a blip, not a block
    var cl3 = page(), f3 = cl3.fn;
    cl3.set('SR', function () { var r = this; r.start = noop; r.stop = noop; r.abort = noop; });
    cl3.set('attachGrammar', noop); cl3.set('_edgeBrowser', false); cl3.set('recRunningDebounceTimer', null); cl3.set('recRestartCount', 0); cl3.set('RESTART_DELAY', 250);
    cl3.set('_netErrStreak', 0); cl3.set('_earSpawn', function () { throw new Error('should not load'); });
    cl3.set('_nativeVerdict', 'ok'); cl3.set('_nativeHeardWords', true);
    f3.startContinuous();
    cl3.get('contRec').onerror({ error: 'network' });
    T.eq(cl3.get('_nativeVerdict'), 'ok');
    delete global.Worker;
});

T.test('a phone never picks the big model; a desktop GPU does, and the size said matches', function () {
    var cl = page(), f = cl.fn, c = cl.c;
    cl.set('$window', { navigator: { gpu: {}, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36' } });
    f._earPickModel();
    T.eq([c.ear.model, c.ear.device, f._earSizeMb()], ['onnx-community/whisper-tiny.en', 'wasm', 40], 'Android with WebGPU: tiny');
    c.ear.size = 'base';
    f._earPickModel();
    T.eq(c.ear.model, 'onnx-community/whisper-tiny.en', 'even when base was chosen in the Lab');
    c.ear.size = 'auto';
    cl.set('$window', { navigator: { gpu: {}, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36' } });
    f._earPickModel();
    T.eq([c.ear.model, c.ear.device, f._earSizeMb()], ['onnx-community/whisper-base.en', 'webgpu', 200], 'desktop GPU: base');
    cl.set('$window', { navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
    f._earPickModel();
    T.eq([c.ear.model, c.ear.device], ['onnx-community/whisper-tiny.en', 'wasm']);
});

// the worker's own source, run with a stand-in for transformers.js
function workerProgress(events) {
    var at = CLIENT_SRC.indexOf('var EAR_WORKER_SRC ='), end = CLIENT_SRC.indexOf('    c.earSummary', at);
    var expr = CLIENT_SRC.substring(at + 'var EAR_WORKER_SRC ='.length, end).replace(/;\s*$/, '');
    var src = vm.runInNewContext('(' + expr + ')', { EAR_LIB: 'lib' }).replace(/^import[^\n]*\n/, '');
    var posted = [], self = { postMessage: function (m) { posted.push(m); } };
    var pipeline = function (task, model, opts) { events.forEach(function (p) { opts.progress_callback(p); }); return new Promise(noop); };
    new Function('self', 'pipeline', 'env', src)(self, pipeline, {});
    self.onmessage({ data: { cmd: 'load', model: 'm', device: 'wasm' } });
    return posted.filter(function (m) { return m.progress !== undefined; }).map(function (m) { return m.progress; });
}

T.test('download progress is one figure for all the files, only goes up, and "preparing" comes once', function () {
    var shown = workerProgress([
        { status: 'initiate', file: 'onnx/encoder_model_quantized.onnx' },
        { status: 'progress', file: 'onnx/encoder_model_quantized.onnx', progress: 50, loaded: 5, total: 10 },
        { status: 'progress', file: 'onnx/decoder_model_merged_quantized.onnx', progress: 0, loaded: 0, total: 30 },
        { status: 'progress', file: 'config.json', progress: 100, loaded: 1, total: 1 },
        { status: 'progress', file: 'onnx/encoder_model_quantized.onnx', progress: 100, loaded: 10, total: 10 },
        { status: 'progress', file: 'onnx/decoder_model_merged_quantized.onnx', progress: 100, loaded: 30, total: 30 }
    ]);
    T.eq(shown, [50, 12, 25, 99], 'bytes over bytes across the model files, never 100 before the download is done');
    // the page keeps the highest figure, and "preparing" is not undone
    var cl = page(), f = cl.fn, c = cl.c, texts = [], figs = [];
    global.Worker = function () {};
    cl.set('_nativeVerdict', 'blocked');
    c.ear.status = 'loading';
    shown.forEach(function (p) { f._earOnMessage({ data: { progress: p } }); texts.push(c.gate.hearingText); figs.push(c.ear.progress); });
    T.eq(figs, [50, 50, 50, 99], 'a new file does not pull the figure back (the card\'s bar shows it)');
    texts.forEach(function (t) { T.match(t, /downloading speech recognition, one time \(about 40 MB\)$/); T.notMatch(t, /%/, 'the figure is the bar, not the words'); });
    f._earOnMessage({ data: { progress: 100 } });
    T.eq(c.ear.progress, 99, 'never 100 from a file figure');
    f._earOnMessage({ data: { downloaded: true } });
    T.match(c.gate.hearingText, /setting up speech recognition/i);
    f._earOnMessage({ data: { progress: 40 } });
    T.match(c.gate.hearingText, /setting up speech recognition/i, 'no flip back to "downloading"');
    delete global.Worker;
});

/* ---- 2. iPhone: the Start button's own click unlocks her voice ---- */

T.test('the unlock runs inside click and touchend too, and the Start click always runs it', function () {
    var cl = page(), f = cl.fn, c = cl.c, spoken = [], added = [];
    f._listenForActivation({ addEventListener: function (t, fn, cap) { added.push(t + (cap ? ':capture' : '')); }, removeEventListener: noop });
    T.eq(added.slice().sort(), ['click:capture', 'keydown:capture', 'pointerdown:capture', 'touchend:capture']);
    c.app = { ios: true }; c.hasTTS = true;
    global.SpeechSynthesisUtterance = function (t) { this.text = t; };
    cl.set('TTS', { speak: function (u) { spoken.push(u); } });
    cl.set('_gateUpdate', noop); cl.set('_ctrlDestroyed', false); cl.set('_activated', false);
    f._onPageActivated({ type: 'pointerdown' });
    T.eq(spoken.length, 1, 'tried on pointerdown');
    T.eq(f._needsActivation(), true, 'but on iOS that is not the gesture yet');
    f._gateStart();   // what the Start button's c.gateActivate() does
    T.eq(spoken.length, 2, 'the Start click itself speaks the silent line');
    T.eq(spoken[1].volume, 0);
    T.eq(f._needsActivation(), false);
    f._gateStart(); f._onPageActivated({ type: 'click' });
    T.eq(spoken.length, 2, 'unlocked once in a real gesture: not again');
    // the browser refused her voice later: the next tap unlocks again
    cl.set('_voiceBlocked', true); cl.set('_speechUnlocked', false);
    f._onPageActivated({ type: 'touchend' });
    T.eq(spoken.length, 3);
    T.match(CLIENT_SRC, /c\.gateActivate = _gateStart;/);
    delete global.SpeechSynthesisUtterance;
});

/* ---- 3. a dialog, announced once, with one status line on milestones ---- */

T.test('the card is a modal dialog with one polite status line, not an assertive live region', function () {
    var card = /<div class="netra-ready"[^>]*>/.exec(TEMPLATE)[0];
    T.match(card, /role="dialog"/); T.match(card, /aria-modal="true"/); T.match(card, /aria-labelledby="netra-ready-title"/);
    T.notMatch(card, /aria-live|alertdialog/, 'the dialog itself is not a live region');
    T.match(TEMPLATE, /class="netra-ready-title" id="netra-ready-title" tabindex="-1"/);
    var block = TEMPLATE.substring(TEMPLATE.indexOf('<div class="netra-ready"'), TEMPLATE.indexOf('<div class="netra-stage-center">'));
    T.eq((block.match(/aria-live=/g) || []).length, 1, 'one live line in the card');
    T.match(block, /role="status" aria-live="polite"[^>]*>\{\{c\.gate\.status\}\}/);
    T.notMatch(block, /hearingText[^<]*role="status"/);
});

T.test('the status line changes on milestones only: a whole download is one announcement', function () {
    var cl = page(), f = cl.fn, c = cl.c, said = [];
    cl.set('speak', function (t) { said.push(t); });
    global.Worker = function () {};
    cl.set('_nativeVerdict', 'blocked');
    c.ear.status = 'loading';
    f._readyUpdate();
    var lines = [c.gate.status];
    for (var p = 1; p <= 99; p++) { f._earOnMessage({ data: { progress: p } }); if (c.gate.status !== lines[lines.length - 1]) lines.push(c.gate.status); }
    f._earOnMessage({ data: { downloaded: true } });
    if (c.gate.status !== lines[lines.length - 1]) lines.push(c.gate.status);
    T.eq(lines.length, 1, 'no percentage is ever announced: ' + JSON.stringify(lines));
    T.eq(lines[0], 'Voice and answers ready. Waiting for hearing. Downloading speech recognition, about 40 MB, one time. This can take a minute.');
    T.match(c.gate.hearingText, /setting up speech recognition/i, 'the visible row still moves');
    // a real problem is a milestone: answers go down
    c.gate.brain = false; c.gate.brainDown = true; c.gate.brainText = 'The free AI models are overloaded right now';
    f._gateUpdate();
    T.match(c.gate.status, /Voice ready\. Waiting for hearing and answers\..*Answers: The free AI models are overloaded right now\.$/);
    delete global.Worker;
});

/* ---- 4. a real modal: the page behind is inert, the focus is in the card ---- */

function fakePage() {
    var doc = { activeElement: null };
    function el(tag, cls, kids, attrs, noInert) {
        var e = { tagName: tag.toUpperCase(), attrs: {}, children: [], parentNode: null };
        if (!noInert) e.inert = false;
        if (cls) e.attrs['class'] = cls;
        Object.keys(attrs || {}).forEach(function (k) { e.attrs[k] = attrs[k]; });
        e.getAttribute = function (n) { return e.attrs.hasOwnProperty(n) ? e.attrs[n] : null; };
        e.setAttribute = function (n, v) { e.attrs[n] = String(v); };
        e.removeAttribute = function (n) { delete e.attrs[n]; };
        e.hasAttribute = function (n) { return e.attrs.hasOwnProperty(n); };
        e.contains = function (x) { for (; x; x = x.parentNode) if (x === e) return true; return false; };
        e.focus = function () { doc.activeElement = e; };
        e.querySelectorAll = function (sel) { return below(e).filter(function (d) { return matches(d, sel); }); };
        e.querySelector = function (sel) { return e.querySelectorAll(sel)[0] || null; };
        (kids || []).forEach(function (k) { k.parentNode = e; e.children.push(k); });
        return e;
    }
    function below(e) { var out = []; e.children.forEach(function (k) { out.push(k); out = out.concat(below(k)); }); return out; }
    function matches(e, sel) {
        return sel.split(',').some(function (s) {
            s = s.trim();
            if (s.charAt(0) === '.') return (' ' + (e.attrs['class'] || '') + ' ').indexOf(' ' + s.substring(1) + ' ') >= 0;
            var m = /^([a-z]*)(?:\[([a-z-]+)\])?$/.exec(s);
            return !!m && (!m[1] || e.tagName === m[1].toUpperCase()) && (!m[2] || e.attrs.hasOwnProperty(m[2]));
        });
    }
    var p = {};
    p.link = el('a', 'sp-link', [], { href: '/sp' });
    p.header = el('header', 'sp-header', [p.link], {}, true);   // a browser without inert
    p.blob = el('button', 'netra-stage-blob-wrap');
    p.center = el('div', 'netra-stage-center', [p.blob]);
    p.mute = el('button', 'netra-ctl');
    p.controls = el('footer', 'netra-stage-controls', [p.mute]);
    p.title = el('h2', 'netra-ready-title', [], { tabindex: '-1' });
    p.start = el('button', 'netra-ready-start');
    p.leave = el('button', 'netra-ready-leave');
    p.card = el('div', 'netra-ready-card', [p.title, p.start, p.leave]);
    p.dialog = el('div', 'netra-ready', [p.card]);
    p.stage = el('div', 'netra-stage', [p.center, p.controls, p.dialog]);
    p.spoken = el('div', 'netra-sr-only');
    p.dev = el('div', 'netra-dev', [], { 'aria-hidden': 'true' });
    p.orb = el('button', 'netra-orb');
    p.root = el('div', 'netra-root', [p.spoken, p.dev, p.stage, p.orb]);
    p.script = el('script');
    p.body = el('body', '', [p.header, p.root, p.script]);
    doc.body = p.body; doc.activeElement = p.body;
    doc.querySelector = function (sel) { return p.body.querySelector(sel); };
    p.doc = doc;
    return p;
}
function inert(e) { return e.hasAttribute('inert') && e.getAttribute('aria-hidden') === 'true'; }

T.test('while the gate is shut everything behind the card is inert and the focus is in it; all of it comes back', function () {
    var cl = page(), f = cl.fn, c = cl.c, p = fakePage(), timers = [];
    cl.set('$window', { document: p.doc });
    cl.set('$timeout', Object.assign(function (fn, ms) { timers.push(fn); return {}; }, { cancel: noop }));
    c.liveMode = true;
    c.gate.needsTap = true;
    // the gate's own update puts the modal on, once the card is on the page
    cl.set('_gateShut', undefined); cl.set('_activated', false);
    cl.set('$window', { document: p.doc, navigator: { userActivation: { hasBeenActive: false } } });
    f._gateUpdate();
    T.ok(timers.indexOf(f._gateModal) >= 0, 'the modal is applied after the card renders');
    f._gateModal();
    [p.header, p.center, p.controls, p.orb, p.dev, p.script].forEach(function (e, i) {
        if (e === p.script) T.ok(!e.hasAttribute('inert'), 'a script is left alone');
        else T.ok(inert(e), 'inert: ' + e.attrs['class']);
    });
    [p.stage, p.root, p.dialog, p.card, p.spoken].forEach(function (e) { T.ok(!e.hasAttribute('inert'), 'not inert: ' + e.attrs['class']); });
    T.eq(p.link.getAttribute('tabindex'), '-1', 'no inert in this browser: the portal link leaves the tab order');
    T.ok(p.doc.activeElement === p.start, 'Start has the focus');   // fake nodes are circular: compare by identity
    // Start goes (ng-if) once pressed: the focus goes to the title, not the page body
    p.card.children.splice(p.card.children.indexOf(p.start), 1); p.start.parentNode = null;
    p.doc.activeElement = p.body;
    c.gate.needsTap = false;
    f._gateModal();
    T.ok(p.doc.activeElement === p.title, 'the title has the focus');
    T.eq(cl.get('_gateInert').length, 5, 'nothing made inert twice');
    // the gate opens: the card goes, everything is given back, the blob has the focus
    c.gate.open = true;
    p.stage.children.splice(p.stage.children.indexOf(p.dialog), 1); p.dialog.parentNode = null;
    p.doc.activeElement = p.body;
    f._gateModal();
    [p.header, p.center, p.controls, p.orb].forEach(function (e) {
        T.ok(!e.hasAttribute('inert') && e.getAttribute('aria-hidden') === null, 'given back: ' + e.attrs['class']);
    });
    T.eq(p.dev.getAttribute('aria-hidden'), 'true', 'what was hidden before stays hidden');
    T.eq(p.link.getAttribute('tabindex'), null, 'the link is back in the tab order');
    T.ok(p.doc.activeElement === p.blob, 'focus on Netra\'s main button');
});

/* ---- 5. no hearing, answers ready: type instead, or leave ---- */

T.test('Type instead is offered whenever answers are ready, even while hearing still loads, and a way to leave', function () {
    var cl = page(), f = cl.fn, c = cl.c, typed = [];
    delete global.Worker;
    c.hasSR = false; c.ear.status = 'error'; c.ear.error = 'no workers in this browser'; c.state = 'idle';
    c.labOn = false;
    cl.set('_typeToggle', function (on) { typed.push(on); c.typeOn = on; });
    f._readyUpdate();
    T.eq(c.gate.cantHear, true);
    T.match(c.gate.hearingText, /^This browser can't listen.*type to Netra instead/);
    T.notMatch(c.gate.hearingText, /Lab/, 'the Lab is behind the card: not offered there');
    T.match(c.gate.status, /^Netra can't hear in this browser\. Answers are ready\. Press Type instead to type to Netra\./);
    T.eq(f._typeHint(), 'Press Type instead to type to me.');
    var block = TEMPLATE.substring(TEMPLATE.indexOf('<div class="netra-ready"'), TEMPLATE.indexOf('<div class="netra-stage-center">'));
    // not only when the browser can not hear: the moment answers are ready
    T.eq((/class="netra-ready-type" ng-if="([^"]*)"/.exec(block) || [])[1], 'c.gate.brain');
    T.match(block, /ng-click="c\.gateType\(\)">Type instead</);
    T.match(block, /ng-click="c\.liveExit\(\)"[^>]*>Leave</);
    T.match(block, /ng-if="c\.gate && !c\.gate\.open && !c\.gate\.typing( && !c\.ended)?"/);
    T.match(CLIENT_SRC, /c\.gateType = _gateTypeInstead;/);
    f._gateTypeInstead();
    T.eq(c.gate.typing, true, 'the card steps aside');
    T.eq(typed, [true], 'and the typing box above the controls opens');
    T.ok(!c.labOn, 'not the Lab');
    T.eq(c.gate.open, false, 'nothing is heard: the gate stays shut for speech');
    T.eq(c.liveStatus, 'Typing'); T.eq(c.liveHint, 'Netra can’t hear in this browser');
    T.eq(f._typedRefused('who founded servicenow'), false, 'typed questions go through');
    // the ear still downloading, answers ready: Type instead works too
    var clL = page(), fL = clL.fn, cL = clL.c, typedL = [];
    global.Worker = function () {};
    clL.set('_nativeVerdict', 'blocked');
    clL.set('_typeToggle', function (on) { typedL.push(on); cL.typeOn = on; });
    cL.ear.status = 'loading'; cL.ear.progress = 37;
    fL._readyUpdate();
    T.eq(cL.gate.cantHear, false); T.eq(cL.gate.brain, true);
    fL._gateTypeInstead();
    T.eq(cL.gate.typing, true); T.eq(typedL, [true]); T.ok(!cL.labOn);
    delete global.Worker;
    // before answers are ready the card says so, and Type instead does nothing
    var cl2 = page(), f2 = cl2.fn, c2 = cl2.c;
    c2.hasSR = false; c2.ear.status = 'error'; c2.gate.brain = false;
    f2._readyUpdate();
    T.match(c2.gate.hearingText, /type to Netra once answers are ready/);
    T.match(c2.gate.status, /You can type to Netra once answers are ready\./);
    f2._gateTypeInstead();
    T.ok(!c2.gate.typing, 'no typing into a gate with no answers');
});

/* ---- 6. a phone held sideways: the card fits ---- */

T.test('the card fits a landscape phone: safe areas, a height cap with its own scroll, compact rows', function () {
    T.match(STYLES, /\.netra-ready \{[^}]*safe-area-inset-top[^}]*safe-area-inset-bottom/);
    T.match(STYLES, /\.netra-ready-card \{[^}]*max-height: 100%;[^}]*overflow-y: auto;/);
    var re = /@media \(max-height: 520px\) and \(orientation: landscape\) \{([\s\S]*?)\n\}/g, m, found = '';
    while ((m = re.exec(STYLES))) if (/\.netra-ready-card/.test(m[1])) found = m[1];
    T.ok(found, 'a landscape block for the card');
    T.match(found, /\.netra-ready \.netra-ready-row \{ padding: 5px 0;/);
    T.match(found, /\.netra-ready-actions button \{ flex: 1 1 auto;/, 'buttons side by side');
    // 390 px tall (844x390) less the padding; title, line, three two-line rows and the buttons
    var budget = 390 - 24, used = 24 + 23 + 2 + 18 + 6 + 3 * (10 + 2 * 19) + 8 + 44;
    T.ok(used < budget, 'the card fits at 844x390 (' + used + ' of ' + budget + ' px)');
});

/* ---- 7. held questions: both kept, both asked again ---- */

T.test('a second question while answers are down is held beside the first, never sent into the shut gate, and both are asked again', function () {
    var cl = page(), f = cl.fn, c = cl.c, said = [], sent = [];
    cl.set('speak', function (t, done) { said.push(t); if (done) done(); });
    cl.set('handleHeard', function (t) { sent.push(t); });
    c.ready = true;
    c.gate = { open: false, everOpen: true, hearing: true, voice: true, brain: false, hearingText: '', voiceText: '', brainText: 'busy' };
    f._gateHold('what is Docker?');
    cl.set('_queuedUtterance', 'and what is Kubernetes');
    f._drainQueuedUtterance();
    T.eq(sent, [], 'not sent to a brain that is down');
    T.eq(cl.get('_gateHeld').map(function (q) { return q.text; }), ['what is Docker?', 'and what is Kubernetes'], 'the first is not replaced');
    T.eq(cl.get('_queuedUtterance'), null);
    f._gateHold('what is Docker?');
    T.eq(cl.get('_gateHeld').length, 2, 'the same question is held once');
    // answers are back: both, in order, the second after the first's answer
    c.gate.brain = true;
    f._gateUpdate();
    T.eq(said[said.length - 1], 'Back now. You asked: what is Docker. Then: and what is Kubernetes.');
    T.eq(sent, ['what is Docker?']);
    T.eq(cl.get('_queuedUtterance'), 'and what is Kubernetes', 'waits for the first answer');
    T.eq(cl.get('_gateReasked').texts, ['what is Docker?', 'and what is Kubernetes']);
    // the brain-down branch holds instead of replacing
    T.notMatch(CLIENT_SRC, /_gateHeld = again \? null/);
});

/* ---- 8. web answers through a whole outage ---- */

T.test('in web mode a not-ready check with every model resting keeps the gate open in web mode', function () {
    var cl = page(), f = cl.fn, c = cl.c, timers = [];
    cl.set('speak', noop);
    cl.set('$timeout', Object.assign(function (fn, ms) { timers.push(ms); return {}; }, { cancel: noop }));
    c.ready = true;
    var web = 'answers from the web only - my reasoning models are out of quota or overloaded until about 12:30 PM';
    c.gate = { open: true, everOpen: true, hearing: true, voice: true, brain: true, brainMode: 'web', hearingText: '', voiceText: '', brainText: web };
    c.server = { get: function () { return { then: function (ok) { ok({ data: { ready: { ready: false, reason: 'all_resting', wait_ms: 60000, say: 'My reasoning models are overloaded - the first is back in 4 minutes.' } } }); } }; } };
    f._brainProbe('web mode');
    T.eq(c.gate.open, true, 'no loading screen for the last minutes of an outage');
    T.eq(c.gate.brainMode, 'web');
    T.eq(c.gate.brainText, web);
    T.ok(timers.indexOf(60000) >= 0, 'looks again later: ' + timers.join(','));
    // a refused key opens web answers with that reason, not "resting"
    var cl2 = page(), f2 = cl2.fn, c2 = cl2.c, said = [];
    cl2.set('speak', function (t) { said.push(t); });
    c2.ready = true; c2.data = { is_guest: true };
    c2.gate = { open: false, everOpen: false, hearing: true, voice: true, brain: false, hearingText: '', voiceText: '', brainText: '' };
    c2.server = { get: function () { return { then: function (ok) { ok({ data: { ready: { ready: true, mode: 'web', wait_ms: 120000, say: 'answers from the web only - my Gemini key was refused' } } }); } }; } };
    f2._brainProbe('boot');
    T.eq(c2.gate.open, true);
    T.match(said[0], /Just speak, or press Type\. My Gemini key was refused, so I will answer from the web for now\.$/);
});

function webWorks(P, text) {
    var inner = P.HTTP;
    P.HTTP = function (req) {
        if (/wikipedia\.org\/api\/rest_v1\/page\/summary|wikipedia\.org\/w\/api\.php/.test(req.endpoint)) {
            return { status: 200, body: JSON.stringify({ type: 'standard', title: 'Wikipedia', extract: text || 'Wikipedia is a free online encyclopedia.', content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Wikipedia' } }, query: { search: [{ title: 'Wikipedia' }] } }) };
        }
        if (/bing\.com\/search/.test(req.endpoint)) return { status: 200, body: '<rss><channel><item><title>Kubernetes - Wikipedia</title><link>https://en.wikipedia.org/wiki/Kubernetes</link><description>' + (text || 'Kubernetes automates deploying and scaling containers.') + '</description></item></channel></rss>' };
        return inner ? inner(req) : { status: 404, body: '' };
    };
}
// every model resting for rest ms (a timeout rests two minutes, an overload thirty seconds)
function allResting(code) {
    N.loadScriptIncludes();
    var brain = new NetraBrain();
    N.loadServer({ input: { action: 'chat' } }).fn._modelChain(null).forEach(function (m) { brain.recordFail(m, code, '', g.P.now); });
    brain.flush();
}

T.test('server: a refused Gemini key opens web answers at once, saying so', function () {
    var s = new S.Session();
    var log = gem.install(s.P, [gem.http(400, { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } })]);
    webWorks(s.P);
    var d = N.request({ action: 'ready_check' }).ready;
    T.eq(log.generate.length, 1);
    T.eq(d.ready, true); T.eq(d.mode, 'web');
    T.match(d.say, /^answers from the web only - my Gemini key was refused$/);
    // every model benched for the refusal: the reason is the key, not quota
    var s2 = new S.Session();
    allResting(403);
    var log2 = gem.install(s2.P, []);
    webWorks(s2.P);
    var d2 = N.request({ action: 'ready_check' }).ready;
    T.eq(log2.generate.length, 0);
    T.eq(d2.mode, 'web');
    T.match(d2.say, /my Gemini key was refused$/);
});

T.test('server: every model out for two minutes is web answers, not the loading screen; thirty seconds still holds', function () {
    var s = new S.Session();
    allResting(0);   // timeouts: two minutes each
    var log = gem.install(s.P, []);
    webWorks(s.P);
    var d = N.request({ action: 'ready_check' }).ready;
    T.eq(log.generate.length, 0);
    T.eq(d.ready, true); T.eq(d.mode, 'web');
    // a Guest's question in that window is answered from the web, not held
    var s2 = new S.Session();
    s2.P.user = { sys_id: 'u_guest', name: 'Guest', user_name: 'guest' }; s2.P.ROLES = {};
    allResting(0);
    gem.install(s2.P, []);
    webWorks(s2.P, 'Kubernetes automates deploying, scaling and managing containers.');
    var r = s2.say('what problems does kubernetes solve');
    T.eq(r.brain_down, undefined, 'answered, not held');
    T.match(r.message, /Kubernetes automates deploying/);
    // a thirty-second overload is a short wait: hold
    var s3 = new S.Session();
    allResting(503);
    gem.install(s3.P, []);
    webWorks(s3.P);
    var d3 = N.request({ action: 'ready_check' }).ready;
    T.eq(d3.ready, false); T.eq(d3.reason, 'all_resting');
});

/* ---- 9. what a screen reader hears for the state ---- */

T.test('no wake word in the state label, "getting ready" while the gate is shut, one state region on the stage', function () {
    var cl = page(), f = cl.fn, c = cl.c;
    c.gate.open = false;
    T.eq(f._stateLabel('idle'), 'getting ready');
    c.gate.open = true;
    T.eq(f._stateLabel('idle'), 'listening - just speak');
    T.notMatch(f._stateLabel('awaiting'), /wake word|Netra/);
    // the gate's own update keeps the label in step
    c.state = 'idle'; c.ready = true; c.gate = { open: false, everOpen: true, hearing: true, voice: true, brain: false, hearingText: '', voiceText: '', brainText: '' };
    f._gateUpdate();
    T.eq(c.stateLabel, 'getting ready');
    cl.set('speak', noop);
    c.gate.brain = true; f._gateUpdate();
    T.eq(c.stateLabel, 'listening - just speak');
    T.match(TEMPLATE, /<div class="netra-sr-only" role="status" aria-live="polite" aria-atomic="true" ng-if="!c\.liveMode">\s*\{\{c\.stateLabel\}\}/);
    T.notMatch(CLIENT_SRC, /listening for "Netra"/);
    // R28 - the stage's own region says the status model's words; paused is not "asleep"
    T.match(TEMPLATE, /<div class="netra-sr-only" id="netra-say" role="status" aria-live="polite" aria-atomic="true">\{\{c\.srSay\}\}<\/div>/);
    T.eq(f._stateLabel('dormant'), 'paused - say Netra or tap to resume');
    T.eq(c.liveStatus, 'Listening'); T.eq(c.liveKind, 'listen');
});

T.run(__filename);
