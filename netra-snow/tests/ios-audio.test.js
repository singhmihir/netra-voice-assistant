/* iPhone audio: the mic's own audio context must be running, or it hears silence.
 *
 * WebKit starts an audio context "suspended" unless it was made inside a
 * tap, and turns it "interrupted" while speech plays. The mic meter and the
 * on-device ear run on their own context (_micCtx), so a phone showed the
 * stream live at level 0 and heard nothing. Both contexts are resumed on
 * every tap, when the mic starts and after she speaks; if iOS still refuses,
 * the status asks for one tap. WebKit can also leave speechSynthesis.speaking
 * set after a line has ended, so on iPhone the text's own time releases a
 * stuck "speaking". And a developer who can not hold the phone gets a
 * diagnostics report to paste. */
var T = require('./lib/t'), N = require('./lib/netra');

function noop() {}
global.window = global.window || {};   // setState writes window.__netraState
function page() {
    var cl = N.loadClient(), c = cl.c;
    c.events = []; c.micHealth = {}; c.data = {}; c.state = 'idle'; c.alert = true; c.app = { ios: true };
    c.ear = { mode: 'auto', size: 'auto', on: false, status: 'off', progress: 0, model: 'onnx-community/whisper-tiny.en', device: 'wasm', error: '', heard: 0 };
    ['cue', '_convoPush'].forEach(function (n) { cl.set(n, noop); });
    cl.set('$scope', { $applyAsync: noop, $on: noop });
    cl.set('$timeout', Object.assign(function () { return {}; }, { cancel: noop }));
    return cl;
}
function ctx(state) {
    var x = { state: state, resumed: 0, sampleRate: 48000 };
    x.resume = function () { x.resumed++; x.state = 'running'; return { then: function (ok) { ok(); } }; };
    return x;
}

T.test('both audio contexts are resumed when WebKit has them suspended or interrupted, and left alone when running', function () {
    var cl = page(), f = cl.fn;
    var mic = ctx('interrupted'), out = ctx('suspended');
    cl.set('_micCtx', mic); cl.set('audioCtx', out);
    T.eq(f._resumeAudio('test'), true);
    T.eq(mic.resumed, 1, 'the mic\'s context');
    T.eq(out.resumed, 1, 'the playback context');
    var run = ctx('running'), closed = ctx('closed');
    cl.set('_micCtx', run); cl.set('audioCtx', closed);
    T.eq(f._resumeAudio('test'), false);
    T.eq(run.resumed + closed.resumed, 0);
});

T.test('every tap resumes the mic\'s context too, not only the playback one', function () {
    var cl = page(), f = cl.fn, mic = ctx('suspended');
    cl.set('_micCtx', mic); cl.set('audioCtx', ctx('running'));
    cl.set('_speechUnlocked', true); cl.set('_speakingNow', false);
    f._speechUnlock({ type: 'touchend' });
    T.eq(mic.resumed, 1);
});

T.test('a mic context iOS keeps suspended makes the status ask for one tap; running again clears it', function () {
    var cl = page(), f = cl.fn, c = cl.c;
    cl.set('setState', function (st) { c.state = st; c.liveStatus = 'Listening'; });
    var mic = { state: 'suspended', resume: function () { return { then: function (ok) { ok(); } }; } };   // iOS says no
    cl.set('_micCtx', mic); cl.set('audioCtx', null);
    f._resumeAudio('mic started');
    T.eq(c.micNeedsTap, true);
    T.eq(c.liveStatus, 'Tap anywhere so I can hear you');
    mic.state = 'running';
    f._micTapCheck();
    T.eq(c.micNeedsTap, false);
    T.notMatch(String(c.liveStatus || ''), /Tap anywhere/);
});

T.test('iPhone: a line whose end WebKit never reported is released by the text\'s own time, not after 30 s', function () {
    function run(ios, afterMs) {
        var cl = page(), c = cl.c, stopped = [], ticks = [];
        c.app = { ios: ios }; c.state = 'speaking'; c.recRunning = true; c.interim = '';
        cl.set('$timeout', Object.assign(function (fn, ms) { ticks.push(fn); return {}; }, { cancel: noop }));
        cl.set('TTS', { speaking: true, pending: false });
        cl.set('_speakingText', 'Good morning. I am Netra, and I am ready.');   // 41 characters
        cl.set('currentAudio', null); cl.set('watchdogLastPlayedTo', -1); cl.set('watchdogLastSpeakingStart', 0);
        cl.set('_speakingNow', true); cl.set('_speakingSince', 0); cl.set('_floorStuckStrikes', 0); cl.set('_edgeLiveWs', null);
        cl.set('ignoreFinalsUntil', 0); cl.set('watchdogStrikes', 0); cl.set('_ctrlDestroyed', false);
        ['_deafCheck', 'stopFillerChain', '_clearSpeaking', 'startContinuous', 'logEvent'].forEach(function (n) { cl.set(n, noop); });
        cl.set('stopSpeaking', function (why) { stopped.push(why); });
        var real = Date.now, t = 1e12;
        Date.now = function () { return t; };
        try {
            cl.fn.startListeningWatchdog();
            ticks.shift()();            // the first look starts the clock
            t += afterMs;
            ticks.shift()();
        } finally { Date.now = real; }
        return stopped.length;
    }
    T.eq(run(true, 11000), 1, 'iPhone: 6 s + 41 x 90 ms has passed - released');
    T.eq(run(false, 11000), 0, 'desktop: the engine is trusted for 30 s and more');
});

T.test('the diagnostics report says what this device sees, and carries no secret', function () {
    var cl = page(), f = cl.fn, c = cl.c;
    cl.set('$window', { navigator: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) CriOS/141.0' } });
    cl.set('_micCtx', ctx('interrupted')); cl.set('audioCtx', ctx('running'));
    cl.set('_micStream', { getAudioTracks: function () { return [{ readyState: 'live', muted: true, enabled: true, label: 'iPhone Microphone' }]; } });
    cl.set('_nativeVerdict', 'ok'); cl.set('_nativeHeardWords', false); cl.set('_speakingNow', false);
    cl.set('TTS', { speaking: false, pending: false, getVoices: function () { return [1, 2]; } });
    c.hasSR = true; c.recRunning = true; c.recLang = 'en-US'; c.micStreamActive = true; c.micLevel = 0; c.micLevelPeak = 7; c.hasTTS = true;
    c.gate = { open: true, hearingText: 'browser recognizer', voiceText: 'ready', brainText: 'ready' };
    c.events = [{ t: '06:41:02', l: 'mic', m: 'mic audio interrupted' }];
    var r = f._diagReport();
    T.match(r, /iPhone OS 18_6/);
    T.match(r, /recognizer: hasSR=true running=true lang=en-US verdict=ok/);
    T.match(r, /tracks=\[live muted "iPhone Microphone"\] micCtx=interrupted @48000 audioCtx=running @48000 level=0 peak=7/);
    T.match(r, /voices=2/);
    T.match(r, /06:41:02 mic mic audio interrupted/);
    T.notMatch(r, /api_key|password|AIza/i);
});

T.run(__filename);
