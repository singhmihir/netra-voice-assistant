/* Hearing, accuracy first (v7.8): the on-device ear and the audio path.
 *
 * The user asked for the most accurate hearing, whatever it costs in time.
 * A desktop's ear is the most accurate model its hardware runs (small on a
 * GPU, base on a CPU), a chosen size wins and the loading card says what is
 * fetched and that Best is slow; a GPU that fails falls back to base, never
 * tiny; the background copy is the very model the ear will use. The mic
 * graph asks for 16 kHz so the browser resamples properly, and where it
 * refuses a windowed-sinc decimator replaces the aliasing block average.
 * Segments keep more pre-roll, wait longer for a pause, and run longer.
 * Settings has a Hearing select, and the worker asks Whisper not to stutter. */
var T = require('./lib/t'), N = require('./lib/netra');
var fs = require('fs'), path = require('path'), vm = require('vm');
var CLIENT_SRC = fs.readFileSync(path.join(N.SRC, 'widget', 'client.js'), 'utf8');
var TEMPLATE = fs.readFileSync(path.join(N.SRC, 'widget', 'template.html'), 'utf8');

function noop() {}
var DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';
var PHONE = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36';
function page(ua, gpu) {
    var cl = N.loadClient(), c = cl.c;
    c.events = []; c.heard = []; c.micHealth = {}; c.stats = {}; c.convo = []; c.alert = true; c.hasSR = true; c.hasTTS = false;
    c.permission = 'granted'; c.recLang = 'en-US'; c.data = {};
    ['logEvent', 'cue', '_convoPush', 'unlockAudio', 'speak', '_earTapAttach', '_earTapDetach'].forEach(function (n) { cl.set(n, noop); });
    cl.set('$scope', { $applyAsync: noop, $on: noop });
    cl.set('$timeout', Object.assign(function () { return {}; }, { cancel: noop }));
    var nav = { userAgent: ua || DESKTOP }; if (gpu) nav.gpu = {};
    cl.set('$window', { navigator: nav, document: { addEventListener: noop } });
    cl.set('_activated', true); cl.set('_voiceBlocked', false); cl.set('_speechUnlocked', false); cl.set('_speakingNow', false);
    cl.set('_nativeVerdict', 'unknown'); cl.set('_nativeHeardWords', false); cl.set('_voiceCheckStart', Date.now());
    cl.set('_earWorker', null); cl.set('_earEngageOnLoad', false); cl.set('_earBusy', false); cl.set('_earQueue', []); cl.set('_earNativeSeen', 0);
    cl.set('_earFir', null); cl.set('_earFirRate', 0);
    c.ear = { mode: 'auto', size: 'auto', on: false, status: 'off', progress: 0, prepared: false, model: 'onnx-community/whisper-tiny.en', device: 'wasm', error: '', heard: 0, why: '' };
    c.gate = { open: false, everOpen: false, hearing: false, voice: false, brain: true, hearingText: '', voiceText: '', brainText: 'ready' };
    return cl;
}
function tone(hz, rate, secs, amp) { var n = Math.round(rate * secs), s = new Float32Array(n); for (var i = 0; i < n; i++) s[i] = amp * Math.sin(2 * Math.PI * hz * i / rate); return s; }
function rms(x, from, to) { var acc = 0, n = 0; for (var i = from || 0; i < (to || x.length); i++) { acc += x[i] * x[i]; n++; } return Math.sqrt(acc / n); }
function db(a, b) { return 20 * Math.log10(a / b); }

/* ---- E1. the model ladder ---- */

T.test('a chosen size wins on a desktop, even the slow one on a CPU, and the card says the size and that it is slow', function () {
    var cl = page(DESKTOP, false), f = cl.fn, c = cl.c;
    c.ear.size = 'small';
    f._earPickModel();
    T.eq([c.ear.model, c.ear.device, f._earSizeMb()], ['onnx-community/whisper-small.en', 'wasm', 250], 'small on WebAssembly: allowed, slow, the most accurate');
    global.Worker = function () {};
    cl.set('_nativeVerdict', 'blocked');
    c.ear.status = 'loading'; c.ear.progress = 12;
    f._readyUpdate();
    T.eq(c.gate.hearingText, 'The browser can\'t reach its speech service - downloading speech recognition, one time (best, about 250 MB, the most accurate and slower on this device)');
    T.match(c.gate.status, /Downloading speech recognition, the best model, about 250 MB, one time\. This can take a few minutes\. It is the most accurate, and slower on this device\.$/, 'what a blind user hears');
    // the quick one, chosen on a desktop GPU, is honoured too
    c.ear.size = 'tiny'; cl.set('$window', { navigator: { userAgent: DESKTOP, gpu: {} } });
    f._earPickModel();
    T.eq([c.ear.model, c.ear.device, f._earSizeMb()], ['onnx-community/whisper-tiny.en', 'webgpu', 60]);
    // balanced by name
    c.ear.size = 'base'; f._earPickModel();
    T.eq([c.ear.model, f._earSizeMb()], ['onnx-community/whisper-base.en', 200]);
    delete global.Worker;
});

T.test('a GPU that fails falls back to base on a desktop (never tiny), and to the size the user chose', function () {
    var cl = page(DESKTOP, true), f = cl.fn, c = cl.c, spawned = [];
    cl.set('_earSpawn', function () { spawned.push(c.ear.model + ' on ' + c.ear.device); cl.set('_earWorker', { terminate: noop }); });
    f._earPickModel();
    T.eq(c.ear.model + ' on ' + c.ear.device, 'onnx-community/whisper-small.en on webgpu');
    c.ear.status = 'loading'; cl.set('_earWorker', { terminate: noop });
    f._earLoadFailed('webgpu adapter lost');
    T.eq(spawned, ['onnx-community/whisper-base.en on wasm'], 'auto: base on the CPU, not tiny');
    T.eq(c.ear.status, 'loading');
    // a chosen size stays what was chosen
    c.ear.size = 'small'; f._earPickModel(); c.ear.status = 'loading';
    f._earLoadFailed('out of memory');
    T.eq(spawned[1], 'onnx-community/whisper-small.en on wasm');
    c.ear.size = 'tiny'; f._earPickModel(); c.ear.status = 'loading';
    f._earLoadFailed('out of memory');
    T.eq(spawned[2], 'onnx-community/whisper-tiny.en on wasm');
    // a second failure on the CPU is a real failure
    f._earLoadFailed('wasm failed too');
    T.eq(c.ear.status, 'error'); T.eq(spawned.length, 3);
});

T.test('the standby copy is the balanced model on any desktop (a GPU desktop gets small only when the ear is needed), a phone tiny', function () {
    var cl = page(DESKTOP, false), f = cl.fn, c = cl.c, spawned = [];
    global.Worker = function () {}; global.Blob = global.Blob || function () {};
    cl.set('_earSpawn', function () { spawned.push(c.ear.model + ' on ' + c.ear.device); cl.set('_earWorker', {}); });
    cl.set('_nativeVerdict', 'ok');
    f._earLoad(true);
    T.eq(spawned, ['onnx-community/whisper-base.en on wasm'], 'no 40 MB stand-in that would be thrown away at the switch');
    f._earOnMessage({ data: { loaded: true } });
    T.eq(c.ear.status, 'standby');
    T.eq(f._earSummary(), 'browser recognizer (en-US); on-device Whisper (base, balanced) ready in standby', 'the Settings hint says what is loaded');
    // a GPU desktop: the standby copy is still the 80 MB one; a chosen size is honoured
    var clG = page(DESKTOP, true), spawnedG = [], cG = clG.c;
    clG.set('_earSpawn', function () { spawnedG.push(cG.ear.model + ' on ' + cG.ear.device); clG.set('_earWorker', {}); });
    clG.set('_nativeVerdict', 'ok');
    clG.fn._earLoad(true);
    T.eq(spawnedG, ['onnx-community/whisper-base.en on wasm'], 'not 590 MB in the background for every visitor with a GPU');
    var clB = page(DESKTOP, true), spawnedB = [], cB = clB.c;
    clB.set('_earSpawn', function () { spawnedB.push(cB.ear.model + ' on ' + cB.ear.device); clB.set('_earWorker', {}); });
    cB.ear.size = 'small';
    clB.fn._earLoad(true);
    T.eq(spawnedB, ['onnx-community/whisper-small.en on webgpu'], 'Best was chosen: that is what stands by');
    var cl2 = page(PHONE, true), spawned2 = [], c2 = cl2.c;
    cl2.set('_earSpawn', function () { spawned2.push(c2.ear.model + ' on ' + c2.ear.device); cl2.set('_earWorker', {}); });
    c2.ear.size = 'small';
    cl2.fn._earLoad(true);
    T.eq(spawned2, ['onnx-community/whisper-tiny.en on wasm'], 'a phone: tiny, whatever is set');
    delete global.Worker;
});

/* ---- E2. the audio path ---- */

T.test('the mic graph asks for a 16 kHz context, and takes the browser\'s default when it refuses', function () {
    var cl = page(), f = cl.fn, calls = [];
    global.window = global.window || {};
    var Ctx = function (opts) { calls.push(opts); this.sampleRate = opts && opts.sampleRate || 48000; };
    global.window.AudioContext = Ctx; delete global.window.webkitAudioContext;
    var ctx = f._newMicContext();
    T.eq(calls, [{ sampleRate: 16000 }]);
    T.eq(ctx.sampleRate, 16000, 'the browser resamples the mic with its own filter');
    calls.length = 0;
    global.window.AudioContext = function (opts) { calls.push(opts); if (opts) throw new Error('NotSupportedError'); this.sampleRate = 44100; };
    ctx = f._newMicContext();
    T.eq(calls, [{ sampleRate: 16000 }, undefined], 'asked, refused, the default taken');
    T.eq(ctx.sampleRate, 44100);
    // one that gave the 16 kHz context but will not feed a 48 kHz mic into it: the default rate, the mic graph still runs
    var closed = 0, onState = function () {}, stream = { id: 's' };
    var sixteen = { sampleRate: 16000, onstatechange: onState, close: function () { closed++; }, createMediaStreamSource: function () { throw new Error('NotSupportedError: sample rate mismatch'); } };
    cl.set('_micCtx', sixteen); cl.set('logEvent', noop);
    global.window.AudioContext = function (opts) { calls.push(opts); this.sampleRate = 48000; this.createMediaStreamSource = function (s) { return { on: s, ctx: this }; }; };
    calls.length = 0;
    var src = f._micSourceFor(stream);
    T.eq(calls, [undefined], 'a default-rate context');
    T.eq(closed, 1, 'the refused one is closed');
    T.eq(src.on, stream); T.eq(cl.get('_micCtx').sampleRate, 48000); T.eq(cl.get('_micCtx').onstatechange, onState, 'the state watcher carried over');
    // a default-rate context that fails is a real failure, as before
    cl.set('_micCtx', { sampleRate: 48000, createMediaStreamSource: function () { throw new Error('no'); } });
    var threw = ''; try { f._micSourceFor(stream); } catch (e) { threw = e.message; }
    T.eq(threw, 'no');
    delete global.window.AudioContext;
});

T.test('resampling keeps a 1 kHz tone whole and removes a 19 kHz one (the block average left it as a 3 kHz alias)', function () {
    var cl = page(), f = cl.fn;
    var inRms = rms(tone(1000, 48000, 1, 0.5));
    var low = f._earTo16k([tone(1000, 48000, 1, 0.5)], 48000);
    T.eq(low.length, 16000, 'one second at 16 kHz');
    T.ok(Math.abs(db(rms(low, 200, 15800), inRms)) < 0.2, '1 kHz kept within 0.2 dB: ' + db(rms(low, 200, 15800), inRms).toFixed(2) + ' dB');
    var high = f._earTo16k([tone(19000, 48000, 1, 0.5)], 48000);
    var drop = db(rms(high, 200, 15800), inRms);
    T.ok(drop <= -20, '19 kHz down at least 20 dB, not folded onto the speech: ' + drop.toFixed(1) + ' dB');
    // just under Whisper's band is kept, and the frames are joined as before
    var mid = f._earTo16k([tone(4000, 48000, 0.5, 0.5), tone(4000, 48000, 0.5, 0.5)], 48000);
    T.eq(mid.length, 16000);
    T.ok(Math.abs(db(rms(mid, 200, 15800), inRms)) < 0.5, '4 kHz kept: ' + db(rms(mid, 200, 15800), inRms).toFixed(2) + ' dB');
    // a rate that is not a whole multiple (44.1 kHz), and the pass-through
    var odd = f._earTo16k([tone(1000, 44100, 1, 0.5)], 44100);
    T.eq(odd.length, 16000);
    T.ok(Math.abs(db(rms(odd, 200, 15800), inRms)) < 0.3, '44.1 kHz -> 16 kHz keeps 1 kHz: ' + db(rms(odd, 200, 15800), inRms).toFixed(2) + ' dB');
    var same = f._earTo16k([tone(1000, 16000, 0.25, 0.5)], 16000);
    T.eq(same.length, 4000);
    // a whole 20 s segment at 48 kHz is quick enough for a page (a few tens of ms)
    var t0 = Date.now(); f._earTo16k([tone(440, 48000, 20, 0.3)], 48000);
    T.ok(Date.now() - t0 < 2000, 'twenty seconds resampled in ' + (Date.now() - t0) + ' ms');
});

/* ---- E3. timing for accuracy ---- */

T.test('segments keep 600 ms before the rise, wait 900 ms of silence, run up to 20 s; a click is still 300 ms', function () {
    var cl = page(), f = cl.fn, c = cl.c;
    T.eq([cl.get('EAR_PREROLL_MS'), cl.get('EAR_SILENCE_MS'), cl.get('EAR_MAX_MS'), cl.get('EAR_MIN_SPEECH_MS')], [600, 900, 20000, 300]);
    T.eq(cl.get('EAR_RATE'), 16000);
    // the longer wait for silence must not dilute "all of it was over her voice":
    // her share is of the voiced part, so the echo guard still fires
    ['_earRing', '_earSeg', '_earSegSpoken'].forEach(function (n) { cl.set(n, []); });
    ['_earRingMs', '_earSegMs', '_earVoiceMs', '_earSilenceMs', '_earSegHerMs', '_herVoiceLastOnAt', '_earLastPartialAt', '_earJobSeq'].forEach(function (n) { cl.set(n, 0); });
    cl.set('_earInSpeech', false); cl.set('_earPartialOk', false); cl.set('_earJobMeta', {});
    cl.set('_speakingText', ''); cl.set('_fillerEchoText', ''); cl.set('currentFillerAudio', null); cl.set('currentFillerUtter', null); cl.set('_fillerChainActive', false);
    c.ear.on = true; c.ear.status = 'on';
    var posted = [], rate = 48000, i, real = Date.now, t = real.call(Date) + 60000;
    function frame(level) { var fr = new Float32Array(4096), amp = level / 360; for (var k = 0; k < fr.length; k++) fr[k] = (Math.floor(k / 8) % 2 ? amp : -amp); return fr; }
    cl.set('_earWorker', { postMessage: function (m) { posted.push(m); } });
    Date.now = function () { return t; };
    try {
        for (i = 0; i < 12; i++) { cl.set('_speakingNow', true); f._earFeed(frame(50), rate); t += 85; }
        cl.set('_speakingNow', false);
        for (i = 0; i < 12; i++) { f._earFeed(frame(2), rate); t += 85; }
    } finally { Date.now = real; }
    T.eq(posted.length, 1);
    T.eq(cl.get('_earJobMeta')[posted[0].id].herShare, 1, 'every voiced frame was over her voice: a full share, whatever the silence wait');
});

/* ---- E4. Settings > How Netra listens > Hearing ---- */

T.test('Settings has a Hearing select on the ear\'s size, labelled and described, with the four sizes in plain words', function () {
    var listen = TEMPLATE.slice(TEMPLATE.indexOf('<h3 id="netra-set-listen">'), TEMPLATE.indexOf('<h3 id="netra-set-speak">'));
    T.match(listen, /<label class="netra-set-label" for="netra-set-ear">Hearing<\/label>/);
    T.match(listen, /<select id="netra-set-ear" class="netra-set-select" ng-model="c\.ear\.size" ng-change="c\.setEarSize\(\)" aria-describedby="netra-set-ear-hint"\s+ng-options="s as c\.earSizeLabel\(s\) for s in c\.earSizes"><\/select>/);
    T.match(listen, /<p class="netra-set-hint" id="netra-set-ear-hint">[^<]*browser's recognizer is blocked[^<]*\{\{c\.earSummary\(\)\}\}<\/p>/, 'when the ear is used, and what is loaded now');
    var f = page().fn;
    T.eq(['auto', 'tiny', 'base', 'small'].map(f._earSizeLabel), ['Auto (best for this device)', 'Quick (tiny, 40 MB)', 'Balanced (base, 80 MB)', 'Best (small, about 250 MB on CPU, slower)']);
    // the Lab's own select reuses the same labels and setter
    T.match(TEMPLATE, /<select ng-model="c\.ear\.size" ng-change="c\.labSetEarSize\(\)" ng-options="m as c\.earSizeLabel\(m\) for m in c\.earSizes"/);
    T.match(CLIENT_SRC, /c\.labSetEarSize = function \(\) \{ _setEarSize\(c\.ear\.size\); \};\n\s+c\.setEarSize = c\.labSetEarSize;/, 'one setter behind both');
    T.match(CLIENT_SRC, /c\.earSizes = \['auto', 'tiny', 'base', 'small'\];/);
});

T.test('a 16 kHz mic graph keeps its frames short, so a one-word "yes" is not lost to the click check', function () {
    // found in review: at 16 kHz a 4096-sample frame is 256 ms, the frame the
    // meter rises in is pre-roll (not voiced), and a 400 ms word fell under
    // EAR_MIN_SPEECH_MS at most starting offsets
    var f = page(DESKTOP, false).fn;
    T.eq([f._earFrameSize(16000), f._earFrameSize(24000), f._earFrameSize(44100), f._earFrameSize(48000)], [1024, 2048, 4096, 4096]);
    T.match(CLIENT_SRC, /createScriptProcessor\(_earFrameSize\(_earRate\), 1, 1\)/, 'the tap uses it');
    // a word of wordMs starting offsetMs into a frame, through the real _earFeed
    function trial(rate, frameN, wordMs, offsetMs) {
        var cl = page(DESKTOP, false), fn = cl.fn, posted = [], c = cl.c;
        c.ear.on = true; c.ear.status = 'on';
        cl.set('_earWorker', { postMessage: function (m) { posted.push(m); } });
        ['_earRing', '_earSeg', '_earSegSpoken'].forEach(function (n) { cl.set(n, []); });
        ['_earRingMs', '_earSegMs', '_earVoiceMs', '_earSilenceMs', '_earSegHerMs', '_herVoiceLastOnAt', '_earLastPartialAt', '_earJobSeq'].forEach(function (n) { cl.set(n, 0); });
        cl.set('_earInSpeech', false); cl.set('_earPartialOk', false); cl.set('_earJobMeta', {});
        cl.set('_speakingText', ''); cl.set('_fillerEchoText', ''); cl.set('currentFillerAudio', null); cl.set('currentFillerUtter', null); cl.set('_fillerChainActive', false);
        var total = 3000 + wordMs, sample = 0, start = Math.round(rate * (0.5 + offsetMs / 1000)), end = start + Math.round(rate * wordMs / 1000);
        while (sample < rate * total / 1000) {
            var fr = new Float32Array(frameN);
            for (var k = 0; k < frameN; k++, sample++) { var amp = (sample >= start && sample < end) ? 50 / 360 : 2 / 360; fr[k] = (Math.floor(k / 8) % 2 ? amp : -amp); }
            fn._earFeed(fr, rate);
        }
        return posted.length;
    }
    var frameN = f._earFrameSize(16000), kept = 0, n = 0;
    for (var off = 0; off < frameN / 16; off += 16) { n++; kept += trial(16000, frameN, 400, off); }
    T.eq(kept, n, 'a 400 ms word is sent at every offset with the frame the tap uses (' + kept + '/' + n + ')');
    var lost = 0, m = 0;
    for (var off2 = 0; off2 < 256; off2 += 32) { m++; if (!trial(16000, 4096, 400, off2)) lost++; }
    T.ok(lost > 0, 'and with a 4096 frame it was lost at ' + lost + ' of ' + m + ' offsets - the defect');
});

T.test('a size chosen after a failed load loads it: engaged when the ear was needed, in standby otherwise', function () {
    var cl = page(DESKTOP, false), f = cl.fn, c = cl.c, spawned = [], stored = {};
    global.Worker = function () {}; global.Blob = global.Blob || function () {};
    global.localStorage = { setItem: function (k, v) { stored[k] = v; }, getItem: function (k) { return stored[k]; } };
    cl.set('_earSpawn', function () { spawned.push(c.ear.model + ' on ' + c.ear.device); cl.set('_earWorker', { terminate: noop }); });
    // the big model would not load (refused download, no memory): status error, no worker
    c.ear.status = 'error'; c.ear.error = 'out of memory'; c.ear.model = 'onnx-community/whisper-small.en'; c.ear.why = 'the browser can not reach its speech service';
    cl.set('_earWorker', null);
    f._setEarSize('base');
    T.eq(spawned, ['onnx-community/whisper-base.en on wasm']);
    T.eq(c.ear.status, 'loading'); T.eq(c.ear.error, '');
    T.eq(cl.get('_earEngageOnLoad'), true, 'the ear was needed: it takes the mic when loaded');
    // the same after a failed standby copy: a quiet reload in the background
    var cl2 = page(DESKTOP, true), f2 = cl2.fn, c2 = cl2.c, spawned2 = [];
    cl2.set('_earSpawn', function () { spawned2.push(c2.ear.model + ' on ' + c2.ear.device); cl2.set('_earWorker', { terminate: noop }); });
    cl2.set('_nativeVerdict', 'ok');
    c2.ear.status = 'error'; c2.ear.why = ''; cl2.set('_earWorker', null);
    f2._setEarSize('tiny');
    T.eq(spawned2, ['onnx-community/whisper-tiny.en on webgpu']);
    T.eq(c2.ear.background, true); T.eq(cl2.get('_earEngageOnLoad'), false);
});

T.test('a new size is kept and reloads a loaded ear - engaged or in standby - and a phone that stays tiny reloads nothing', function () {
    var cl = page(DESKTOP, false), f = cl.fn, c = cl.c, spawned = [], stored = {};
    global.Worker = function () {}; global.Blob = global.Blob || function () {};
    global.localStorage = { setItem: function (k, v) { stored[k] = v; }, getItem: function (k) { return stored[k]; } };
    cl.set('_earSpawn', function () { spawned.push(c.ear.model + ' on ' + c.ear.device); cl.set('_earWorker', { terminate: noop }); });
    // nothing loaded: only kept
    f._setEarSize('small');
    T.eq(stored.netra_ear_size, 'small'); T.eq(c.ear.size, 'small'); T.eq(spawned, []);
    f._setEarSize('huge');
    T.eq(c.ear.size, 'small', 'an unknown size is Best');
    // engaged: reloaded at the new size, still engaged
    c.ear.on = true; c.ear.status = 'on'; c.ear.why = 'the browser can not reach its speech service'; c.ear.model = 'onnx-community/whisper-base.en'; c.ear.device = 'wasm';
    cl.set('_earWorker', { terminate: noop });
    f._setEarSize('small');
    T.eq(spawned, ['onnx-community/whisper-small.en on wasm']);
    T.eq(cl.get('_earEngageOnLoad'), true, 'it takes the mic again once loaded');
    T.eq(c.ear.why, 'the browser can not reach its speech service');
    // in standby: reloaded in the background
    c.ear.on = false; c.ear.status = 'standby'; c.ear.model = 'onnx-community/whisper-small.en'; cl.set('_earEngageOnLoad', false);
    f._setEarSize('base');
    T.eq(spawned[1], 'onnx-community/whisper-base.en on wasm');
    T.eq(c.ear.background, true); T.eq(c.ear.status, 'loading');
    // the same model again: no reload
    spawned.length = 0; c.ear.status = 'standby';
    f._setEarSize('base');
    T.eq(spawned, []);
    // a phone: whatever the size, tiny, so nothing reloads
    var cl2 = page(PHONE, true), c2 = cl2.c, spawned2 = [];
    cl2.set('_earSpawn', function () { spawned2.push(c2.ear.model); });
    c2.ear.on = true; c2.ear.status = 'on'; cl2.set('_earWorker', { terminate: noop });
    cl2.fn._setEarSize('small');
    T.eq(spawned2, []); T.eq(c2.ear.on, true); T.eq(c2.ear.size, 'small');
    delete global.Worker; delete global.localStorage;
});

/* ---- E5. the worker's decode options ---- */

T.test('the worker asks Whisper not to repeat a three-word run, and only that: no beams, no prompt', function () {
    var at = CLIENT_SRC.indexOf('var EAR_WORKER_SRC ='), end = CLIENT_SRC.indexOf('    c.earSummary', at);
    var expr = CLIENT_SRC.substring(at + 'var EAR_WORKER_SRC ='.length, end).replace(/;\s*$/, '');
    var src = vm.runInNewContext('(' + expr + ')', { EAR_LIB: 'lib' }).replace(/^import[^\n]*\n/, '');
    var posted = [], runs = [], self = { postMessage: function (m) { posted.push(m); } };
    var pipeline = function () { return Promise.resolve(function (audio, opts) { runs.push([audio.length, opts]); return Promise.resolve({ text: ' tell me a joke' }); }); };
    new Function('self', 'pipeline', 'env', src)(self, pipeline, {});
    return self.onmessage({ data: { cmd: 'load', model: 'm', device: 'wasm' } }).then(function () {
        T.eq(runs.length, 1, 'the warm-up run'); T.eq(runs[0][0], 16000);
        return self.onmessage({ data: { cmd: 'run', id: 7, audio: new Float32Array(32000) } });
    }).then(function () {
        T.eq(runs[1][0], 32000);
        T.eq(runs[1][1], undefined, 'no decode options: an n-gram ban forced a repeated digit run wrong ("zero zero one zero zero zero one")');
        T.eq(posted[posted.length - 1].text, ' tell me a joke');
        T.eq(posted[posted.length - 1].id, 7);
        T.notMatch(src, /num_beams|initial_prompt|prompt_ids/, 'not supported by the pipeline: never passed');
    });
});

T.run(__filename);
