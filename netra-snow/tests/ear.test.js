/* The on-device ear and the recognizer that notices it is deaf.
 *
 * The browser's recognizer sends audio to a speech service; when that service
 * returns no words the mic still shows sound and Netra hears nothing. The page
 * must notice, heal in steps, and open its own ear (Whisper in a worker, fed
 * from the mic graph) - and every word the ear hears must travel the same road
 * a browser final travels. */
var T = require('./lib/t'), N = require('./lib/netra');

function page() {
    var cl = N.loadClient(), c = cl.c;
    c.events = []; c.heard = []; c.micHealth = {}; c.stats = {}; c.convo = []; c.alert = true; c.hasSR = true; c.permission = 'granted'; c.recLang = 'en-IN';
    ['logEvent', 'cue', '_convoPush'].forEach(function (n) { cl.set(n, function () {}); });
    cl.set('$scope', { $applyAsync: function () {} });
    cl.set('_speakingNow', false); cl.set('_speakingSince', 0); cl.set('_calibActive', false);
    cl.set('_lastInterimAt', 0); cl.set('_lastFinalAt', 0); cl.set('ignoreFinalsUntil', 0); cl.set('recLastActivityAt', 0);
    cl.set('_deafStrikes', 0); cl.set('_deafWinStart', 0); cl.set('_deafLoudMs', 0); cl.set('_deafLastFrameAt', 0); cl.set('_srNoGrammar', false);
    cl.set('_earWorker', null); cl.set('_earBusy', false); cl.set('_earQueue', []); cl.set('_earRing', []); cl.set('_earRingMs', 0); cl.set('_earSeg', []); cl.set('_earSegMs', 0);
    cl.set('_earInSpeech', false); cl.set('_earSilenceMs', 0); cl.set('_earVoiceMs', 0); cl.set('_earSaid', false); cl.set('_earNativeSeen', 0);
    return cl;
}
// a frame of the given loudness on the meter's scale (rms * 360)
function frame(level, n) { var f = new Float32Array(n || 4096), amp = level / 360; for (var i = 0; i < f.length; i++) f[i] = (Math.floor(i / 8) % 2 ? amp : -amp); return f; }

T.test('speech on the meter with no words back is healed in steps: no grammar, plain en-US, then the ear', function () {
    var cl = page(), f = cl.fn, c = cl.c, recycles = [], ears = [], said = [];
    cl.set('_fullMicRecycle', function (why) { recycles.push(why); return true; });
    cl.set('_earStart', function (why) { ears.push(why); return true; });
    cl.set('speak', function (t) { said.push(t); });
    var now = 1000000;
    function loudWindow() {
        // eleven seconds of frames, three of them speech-loud, then the judgement
        for (var i = 0; i < 700; i++) { now += 16; f._deafAccumulate(i < 190 ? 40 : 3, now); }
        f._deafCheck(now + 1);
    }
    loudWindow();
    T.eq(cl.get('_deafStrikes'), 1); T.eq(recycles, []); T.eq(ears, [], 'no ear loaded yet: the browser is healed first');
    loudWindow();
    T.eq(cl.get('_deafStrikes'), 2); T.eq(recycles, ['deaf: rebuilding without the grammar']); T.eq(cl.get('_srNoGrammar'), true);
    loudWindow();
    T.eq(cl.get('_deafStrikes'), 3); T.eq(c.recLang, 'en-US'); T.eq(recycles.length, 2);
    loudWindow();
    T.eq(cl.get('_deafStrikes'), 4); T.eq(ears, ['the browser returned no words for clear speech']);
    T.eq(c.micHealth.deafStrikes, 4);
});

T.test('quiet windows, her own voice, and windows with words are never strikes', function () {
    var cl = page(), f = cl.fn, ears = [];
    cl.set('_earStart', function (why) { ears.push(why); return true; });
    cl.set('_fullMicRecycle', function () { return true; });
    var now = 1000000;
    // a quiet room
    for (var i = 0; i < 700; i++) { now += 16; f._deafAccumulate(3, now); }
    f._deafCheck(now + 1);
    T.eq(cl.get('_deafStrikes'), 0, 'nothing said, nothing to hear');
    // loud, but it is Netra talking through the speakers
    cl.set('_speakingNow', true); cl.set('_speakingSince', now);
    for (i = 0; i < 700; i++) { now += 16; f._deafAccumulate(60, now); }
    f._deafCheck(now + 1);
    T.eq(cl.get('_deafStrikes'), 0, 'her own voice is not the user going unheard');
    cl.set('_speakingNow', false);
    // loud, and the recognizer produced an interim during the window
    for (i = 0; i < 700; i++) { now += 16; f._deafAccumulate(i < 190 ? 40 : 3, now); if (i === 100) cl.set('_lastInterimAt', now); }
    f._deafCheck(now + 1);
    T.eq(cl.get('_deafStrikes'), 0, 'words came back: healthy');
    // a strike, then words: the count resets
    for (i = 0; i < 700; i++) { now += 16; f._deafAccumulate(i < 190 ? 40 : 3, now); }
    f._deafCheck(now + 1);
    T.eq(cl.get('_deafStrikes'), 1);
    for (i = 0; i < 700; i++) { now += 16; f._deafAccumulate(i < 190 ? 40 : 3, now); if (i === 300) cl.set('_lastFinalAt', now); }
    f._deafCheck(now + 1);
    T.eq(cl.get('_deafStrikes'), 0);
    T.eq(ears, []);
});

T.test('the ear cuts speech into segments with pre-roll, drops clicks, caps long turns, and sends 16 kHz audio', function () {
    var cl = page(), f = cl.fn, c = cl.c, sent = [];
    c.ear.on = true;
    // the worker answers at once, so every segment is posted rather than queued
    cl.set('_earWorker', { postMessage: function (m) { sent.push(m); cl.set('_earBusy', false); } });
    var rate = 48000, i;
    // silence, then speech, then silence: one segment, with the frames before the rise
    for (i = 0; i < 10; i++) f._earFeed(frame(2), rate);
    for (i = 0; i < 12; i++) f._earFeed(frame(50), rate);      // ~1 s of speech
    T.eq(sent.length, 0, 'still speaking');
    T.match(c.interim, /on-device/, 'the Lab shows the ear is hearing');
    for (i = 0; i < 12; i++) f._earFeed(frame(2), rate);       // ~1 s of silence closes it
    T.eq(sent.length, 1, 'one segment');
    var audio = sent[0].audio;
    T.ok(audio instanceof Float32Array);
    // 4 pre-roll frames (~340 ms) + 12 speech + ~9 silence frames, at 16 kHz
    T.ok(audio.length > 16000 * 1.5 && audio.length < 16000 * 2.6, 'about two seconds at 16 kHz: ' + audio.length);
    var peak = 0; for (var m = Math.floor(audio.length / 2); m < Math.floor(audio.length / 2) + 64; m++) peak = Math.max(peak, Math.abs(audio[m]));
    T.ok(peak > 0.05, 'the speech is in it (peak ' + peak.toFixed(3) + ')');
    // a click is not a word
    f._earFeed(frame(50), rate); for (i = 0; i < 12; i++) f._earFeed(frame(2), rate);
    T.eq(sent.length, 1, 'a single loud frame is dropped');
    // a turn that never pauses is cut at the cap
    for (i = 0; i < 200; i++) f._earFeed(frame(50), rate);
    T.eq(sent.length, 2, 'cut at the cap');
    T.ok(sent[1].audio.length <= 16000 * 15.2);
    // never more than two waiting: the oldest goes
    cl.set('_earBusy', true);
    for (var k = 0; k < 4; k++) { for (i = 0; i < 12; i++) f._earFeed(frame(50), rate); for (i = 0; i < 12; i++) f._earFeed(frame(2), rate); }
    T.ok(cl.get('_earQueue').length <= 2);
});

T.test('what the ear hears travels the same road as a browser final; silence hallucinations are dropped', function () {
    var cl = page(), f = cl.fn, c = cl.c, queued = [], overSpeech = [];
    cl.set('_enqueueFinalTranscript', function (t, conf) { queued.push([t, conf]); });
    cl.set('_handleFinalWhileSpeaking', function (t) { overSpeech.push(t); return true; });
    cl.set('applyAliases', function (t) { return t; });
    cl.set('_earQueue', []); cl.set('_earBusy', true);
    c.ear.on = true; c.ear.status = 'on';
    f._earOnMessage({ data: { text: ' My tickets. ', ms: 1800 } });
    T.eq(queued, [['My tickets.', 0.85]]);
    T.eq(c.ear.heard, 1);
    T.eq(cl.get('_earBusy'), false, 'ready for the next segment');
    [' you', ' Thank you.', ' [BLANK_AUDIO]', ' (music)', ' ...', ''].forEach(function (h) {
        f._earOnMessage({ data: { text: h, ms: 900 } });
    });
    T.eq(queued.length, 1, 'silence hallucinations never become commands');
    T.eq(c.ear.heard, 1);
    // over her own voice: the barge-in scorer decides, as for a browser final
    cl.set('_speakingNow', true);
    f._earOnMessage({ data: { text: ' stop ', ms: 500 } });
    T.eq(overSpeech, ['stop']);
    T.eq(queued.length, 1);
    cl.set('_speakingNow', false);
    // right after her own voice: dropped like a browser final would be
    cl.set('ignoreFinalsUntil', Date.now() + 5000);
    f._earOnMessage({ data: { text: ' the newest three ', ms: 500 } });
    T.eq(queued.length, 1);
    T.match(c.heard[0].fate, /right after my own voice/);
});

T.test('a browser that refuses the language falls back to en-US, then to the ear; the Lab switch is honoured', function () {
    var cl = page(), f = cl.fn, c = cl.c, ears = [], said = [];
    cl.set('_earStart', function (why) { ears.push(why); return true; });
    cl.set('speak', function (t) { said.push(t); });
    cl.set('SR', function () { var r = this; r.start = function () {}; r.stop = function () {}; r.abort = function () {}; });
    cl.set('attachGrammar', function () {}); cl.set('$timeout', Object.assign(function () { return {}; }, { cancel: function () {} }));
    cl.set('_edgeBrowser', false); cl.set('recRunningDebounceTimer', null); cl.set('recRestartCount', 0); cl.set('RESTART_DELAY', 250);
    f.startContinuous();
    var rec = cl.get('contRec');
    rec.onerror({ error: 'language-not-supported' });
    T.eq(c.recLang, 'en-US');
    T.match(said[0], /will not recognise en-IN/);
    rec.onerror({ error: 'language-not-supported' });
    T.eq(ears, ['the browser refuses the language']);
    // switched off in the Lab: the ear is never opened, the user is told where the switch is
    var cl2 = page(), f2 = cl2.fn, said2 = [], recycles2 = [];
    cl2.c.ear.mode = 'off';
    cl2.set('speak', function (t) { said2.push(t); });
    cl2.set('_fullMicRecycle', function (why) { recycles2.push(why); return true; });
    cl2.set('Worker', undefined);
    var now = 1000000;
    for (var w = 0; w < 4; w++) { for (var i = 0; i < 700; i++) { now += 16; f2._deafAccumulate(i < 190 ? 40 : 3, now); } f2._deafCheck(now + 1); }
    T.eq(cl2.c.ear.on, false);
    T.match(said2[0], /switched off in the Lab/);
});

T.test('while the ear listens the browser\'s own finals stay out; three in a row mean the recognizer healed', function () {
    var cl = page(), f = cl.fn, c = cl.c, queued = [], stops = [];
    cl.set('SR', function () { var r = this; r.start = function () {}; r.stop = function () {}; r.abort = function () {}; });
    cl.set('attachGrammar', function () {}); cl.set('$timeout', Object.assign(function () { return {}; }, { cancel: function () {} }));
    cl.set('_edgeBrowser', false); cl.set('recRunningDebounceTimer', null); cl.set('recRestartCount', 0); cl.set('RESTART_DELAY', 250);
    cl.set('_enqueueFinalTranscript', function (t) { queued.push(t); });
    cl.set('_earStop', function (why) { stops.push(why); c.ear.on = false; });
    ['pickBestAlternative', 'applyAliases', '_pushConfidence', 'learnFromTranscript', '_handleFinalWhileSpeaking'].forEach(function (n) { cl.set(n, function (x) { return n === 'applyAliases' ? x : null; }); });
    cl.set('_notAllowedStrikes', 0); cl.set('_netErrStreak', 0); cl.set('_lastInterimAt', 0); cl.set('_lastInterimText', '');
    f.startContinuous();
    var rec = cl.get('contRec');
    c.ear.on = true; c.ear.mode = 'auto';
    var fin = function (t) { var res = [{ transcript: t, confidence: 0.9 }]; res.isFinal = true; res.length = 1; var list = [res]; list.length = 1; rec.onresult({ resultIndex: 0, results: list }); };
    fin('my tickets'); fin('what time is it');
    T.eq(queued, [], 'the ear has the floor');
    T.match(c.heard[0].fate, /on-device ear is listening/);
    fin('read the newest one');
    T.eq(stops, ['the browser recognizer is hearing again']);
    T.eq(queued, ['read the newest one'], 'and the healed recognizer\'s words count from then on');
});

T.test('the words so far are live text, never a command; a final records its latency; a slow device stops asking for partials', function () {
    var cl = page(), f = cl.fn, c = cl.c, queued = [], posted = [];
    cl.set('_enqueueFinalTranscript', function (t, conf) { queued.push(t); });
    cl.set('applyAliases', function (t) { return t; });
    cl.set('_earWorker', { postMessage: function (m) { posted.push(m); } });
    cl.set('_earPartialOk', true); cl.set('_earLastPartialAt', 0);
    c.ear.on = true; c.ear.status = 'on';
    var rate = 48000, i;
    for (i = 0; i < 4; i++) f._earFeed(frame(2), rate);
    for (i = 0; i < 20; i++) f._earFeed(frame(50), rate);   // ~1.7 s of speech
    T.eq(posted.length, 1, 'one partial run asked for while the user still speaks');
    T.eq(posted[0].partial, true);
    f._earOnMessage({ data: { partial: true, text: ' my tick', ms: 400 } });
    T.match(c.interim, /^\(on-device\) my tick/, 'live words in the Lab');
    T.eq(queued, [], 'a partial is never a command');
    T.eq(cl.get('_earBusy'), false);
    for (i = 0; i < 12; i++) f._earFeed(frame(2), rate);    // silence closes the segment
    T.eq(posted.length, 2); T.ok(!posted[1].partial, 'the final run');
    f._earOnMessage({ data: { text: ' My tickets. ', ms: 900 } });
    T.eq(queued, ['My tickets.']);
    T.eq(c.ear.lastMs, 900);
    // a slow device: partials stop, finals continue
    f._earOnMessage({ data: { partial: true, text: ' x', ms: 2500 } });
    T.eq(cl.get('_earPartialOk'), false);
    posted.length = 0;
    for (i = 0; i < 20; i++) f._earFeed(frame(50), rate);
    T.eq(posted.length, 0, 'no partial asked for on a slow device');
});

T.test('an ear waiting in standby takes over on the first strike; readiness is what the stage says', function () {
    var cl = page(), f = cl.fn, c = cl.c, ears = [], said = [];
    cl.set('_earStart', function (why) { ears.push(why); c.ear.on = true; return true; });
    cl.set('_fullMicRecycle', function () { return true; });
    cl.set('speak', function (t) { said.push(t); });
    c.ear.status = 'standby'; c.ready = false; c.readyText = 'Getting ready…'; c.liveStatus = 'Getting ready…';
    var now = 1000000;
    for (var i = 0; i < 700; i++) { now += 16; f._deafAccumulate(i < 190 ? 40 : 3, now); }
    f._deafCheck(now + 1);
    T.eq(ears, ['the browser returned no words for clear speech'], 'the loaded ear takes over at once');
    // readiness: the browser recognizer counts once it answered; the ear once engaged
    var cl2 = page(), f2 = cl2.fn, c2 = cl2.c, said2 = [];
    cl2.set('$timeout', Object.assign(function (fn) { return {}; }, { cancel: function () {} }));
    cl2.set('speak', function (t) { said2.push(t); });
    c2.state = 'idle'; c2.ready = false; c2.readyText = ''; c2.hasSR = true; c2.hasTTS = false;
    c2.gate = { open: false, everOpen: false, hearing: false, voice: false, brain: true, hearingText: '', voiceText: '', brainText: 'ready' };
    cl2.set('_nativeVerdict', 'unknown');
    f2._readyUpdate();
    T.eq(c2.ready, false); T.eq(c2.liveStatus, 'Getting ready…'); T.match(c2.gate.hearingText, /checking the browser can hear/);
    f2._nativeSaw('blocked');
    T.match(c2.gate.hearingText, /can not reach its speech service/);
    c2.ear.status = 'loading'; c2.ear.progress = 40; f2._readyUpdate();
    T.match(c2.gate.hearingText, /loading my on-device ear 40%/);
    T.eq(c2.gate.open, false);
    c2.ear.on = true; c2.ear.status = 'on'; f2._readyUpdate();
    T.eq(c2.ready, true); T.eq(c2.gate.open, true, 'hearing + voice + brain: open'); T.eq(c2.liveStatus, 'Listening');
    T.match(said2[0] || '', /I am Netra, and I am ready - just speak/, 'the ready signal a blind user hears');
});

T.test('no mic check at start, no nudges, the quickest defaults', function () {
    var cl = page(), f = cl.fn, c = cl.c, said = [], calib = [];
    cl.set('speak', function (t) { said.push(t); });
    cl.set('startCalibration', function () { calib.push(1); });
    cl.set('_firstRunPending', function () { return true; });
    cl.set('_blobRafId', 1); c.micStreamActive = true;
    global.document = global.document || { querySelector: function () { return null; } };
    f._firstRunCheck();
    T.eq(calib, [], 'the mic check never runs at start');
    T.eq(said, [], 'nothing is announced');
    T.ok(/idle|saved/.test(c.labCalib.stage));
    var timers = [];
    cl.set('$timeout', Object.assign(function (fn, ms) { timers.push(ms); return {}; }, { cancel: function () {} }));
    cl.set('_repromptTimer', null); cl.set('_repromptArmed', false);
    f._armReprompt('Shall I read the rest?');
    T.eq(timers, [], 'a question does not arm a "still here" nudge');
    T.eq(cl.get('REMOTE_TTS_DEFAULT'), false, 'the browser voice by default');
    T.eq(cl.get('EAR_MODEL'), 'onnx-community/whisper-tiny.en');
});

T.test('the loading screen: nothing is accepted until Netra can hear, speak and answer', function () {
    var cl = page(), f = cl.fn, c = cl.c, said = [], sent = [];
    cl.set('speak', function (t, done) { said.push(t); if (done) done(); });
    cl.set('handleHeard', function (t) { sent.push(t); });
    cl.set('$timeout', Object.assign(function (fn) { return {}; }, { cancel: function () {} }));
    ['cue', 'setState', '_calibConsume', 'learnFromTranscript', '_pushConfidence'].forEach(function (n) { cl.set(n, function () { return false; }); });
    c.alert = true; c.conversationOpen = true; c.hasTTS = false; c.ready = true; c.data = { user_name: 'Guest', is_guest: true };
    c.gate = { open: false, everOpen: false, hearing: true, voice: true, brain: false, hearingText: '', voiceText: '', brainText: 'checking…' };
    f.processFinalTranscript('what time is it', 0.9);
    T.eq(sent, []); T.match(c.heard[0].fate, /still getting ready/);
    T.match(said[0], /still getting ready, my answers are not ready yet/, 'a blind user hears why');
    f.processFinalTranscript('hello', 0.9);
    T.eq(said.length, 1, 'the explanation is not repeated on every word');
    // the brain answers its readiness probe: the gate opens with a greeting, no name for a guest
    cl.set('c', c);
    c.server = { get: function () { return { then: function (ok) { ok({ data: { ready: { ready: true, model: 'gemma-4-26b-a4b-it' } } }); } }; } };
    f._brainProbe('test');
    T.eq(c.gate.open, true);
    T.match(said[said.length - 1], /^Good (morning|afternoon|evening)\. I am Netra, and I am ready - just speak\.$/, 'no "Guest" in the greeting');
});

T.test('the brain busy mid-visit: the question is held, asked again once when it is back, and never loops', function () {
    var cl = page(), f = cl.fn, c = cl.c, said = [], sent = [], probes = [];
    cl.set('speak', function (t, done) { said.push(t); if (done) done(); });
    cl.set('handleHeard', function (t) { sent.push(t); });
    cl.set('$timeout', Object.assign(function (fn, ms) { probes.push(ms); return {}; }, { cancel: function () {} }));
    ['cue', 'setState', 'stopFillerChain', '_drainQueuedUtterance'].forEach(function (n) { cl.set(n, function () {}); });
    c.alert = true; c.hasTTS = false; c.ready = true; c.data = {};
    c.gate = { open: true, everOpen: true, hearing: true, voice: true, brain: true, hearingText: '', voiceText: '', brainText: '' };
    var answers = [{ ready: false, say: 'busy', wait_ms: 10000 }];
    c.server = { get: function () { var a = answers.shift() || { ready: true }; return { then: function (ok) { ok({ data: { ready: a } }); } }; } };
    // the page's own brain-down branch, as the chat reply handler runs it
    cl.set('_gateHeld', { text: 'who founded servicenow', at: Date.now() });
    c.gate.brain = false; f._gateUpdate();
    T.eq(c.gate.open, false, 'the loading screen is back');
    f._brainProbe('busy');          // still busy: a retry is scheduled, nothing re-asked
    T.eq(sent, []); T.ok(probes.length >= 1);
    f._brainProbe('retry');         // back
    T.eq(c.gate.open, true);
    T.match(said[said.length - 1], /I am back/);
    T.eq(sent, ['who founded servicenow'], 'asked again, once');
    T.eq(cl.get('_gateReasked').text, 'who founded servicenow');
});

T.test('after the ear hands back to the browser recognizer, words still in its worker are dropped - never said twice', function () {
    var cl = page(), f = cl.fn, c = cl.c, queued = [];
    cl.set('_enqueueFinalTranscript', function (t) { queued.push(t); });
    cl.set('applyAliases', function (t) { return t; });
    cl.set('_earQueue', []); cl.set('_earBusy', true);
    c.ear.on = false; c.ear.status = 'standby';
    f._earOnMessage({ data: { text: ' My tickets! ', ms: 2100 } });
    T.eq(queued, [], 'the browser recognizer delivers these words itself');
    c.ear.on = true; c.ear.status = 'on';
    f._earOnMessage({ data: { text: ' My tickets! ', ms: 2100 } });
    T.eq(queued, ['My tickets!']);
});

T.run(__filename);
