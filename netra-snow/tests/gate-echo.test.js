/* The loading screen and the ear, from the listener's side.
 *
 * The on-device ear hears the room after the echo canceller, and a segment is
 * transcribed a second or two after it was heard: by then Netra has usually
 * stopped talking, so "is she speaking now" can not tell her own voice from
 * the user's. The loading screen must never stick (an ear that fails, a
 * recognizer that hears), must ask for the one key press a browser needs
 * before any voice plays, and must let "stop" and "stop listening" through. */
var T = require('./lib/t'), N = require('./lib/netra');

function page() {
    var cl = N.loadClient(), c = cl.c;
    c.events = []; c.heard = []; c.micHealth = {}; c.stats = {}; c.convo = []; c.alert = true; c.hasSR = true; c.permission = 'granted'; c.recLang = 'en-IN';
    ['logEvent', 'cue', '_convoPush'].forEach(function (n) { cl.set(n, function () {}); });
    cl.set('$scope', { $applyAsync: function () {}, $on: function () {} });
    cl.set('$timeout', Object.assign(function () { return {}; }, { cancel: function () {} }));
    cl.set('_speakingNow', false); cl.set('_speakingSince', 0); cl.set('_calibActive', false);
    cl.set('_lastInterimAt', 0); cl.set('_lastFinalAt', 0); cl.set('ignoreFinalsUntil', 0); cl.set('recLastActivityAt', 0);
    cl.set('_earWorker', null); cl.set('_earBusy', false); cl.set('_earQueue', []); cl.set('_earRing', []); cl.set('_earRingMs', 0); cl.set('_earSeg', []); cl.set('_earSegMs', 0);
    cl.set('_earInSpeech', false); cl.set('_earSilenceMs', 0); cl.set('_earVoiceMs', 0); cl.set('_earSaid', false); cl.set('_earNativeSeen', 0);
    cl.set('_herVoiceLastOnAt', 0); cl.set('_earSegHerMs', 0); cl.set('_earSegSpoken', []); cl.set('_earJobSeq', 0); cl.set('_earJobMeta', {});
    cl.set('_speakingText', ''); cl.set('_fillerEchoText', ''); cl.set('currentFillerAudio', null); cl.set('currentFillerUtter', null);
    cl.set('_fillerChainActive', false); cl.set('_lastBargeText', '');
    cl.set('_activated', false); cl.set('_voiceBlocked', false); cl.set('_gateNudged', false); cl.set('_gateNudgedAt', 0);
    cl.set('_nativeVerdict', 'unknown'); cl.set('_nativeHeardWords', false); cl.set('_voiceCheckStart', Date.now());
    cl.set('applyAliases', function (t) { return t; });
    return cl;
}
function frame(level, n) { var f = new Float32Array(n || 4096), amp = level / 360; for (var i = 0; i < f.length; i++) f[i] = (Math.floor(i / 8) % 2 ? amp : -amp); return f; }
// one segment through the ear on a clock that moves with the audio (85 ms a
// frame): speech frames, then the silence that closes it. herFrames: how many
// of the speech frames she was still talking over (true = all of them).
// Returns the job id posted to the worker.
function segment(cl, herFrames) {
    var f = cl.fn, posted = [], rate = 48000, i, real = Date.now, t = real.call(Date) + 60000;
    if (herFrames === true) herFrames = 12;
    cl.set('_earWorker', { postMessage: function (m) { posted.push(m); } });
    cl.set('_earBusy', false); cl.set('_earPartialOk', false);
    Date.now = function () { return t; };
    try {
        for (i = 0; i < 12; i++) { cl.set('_speakingNow', i < (herFrames || 0)); f._earFeed(frame(50), rate); t += 85; }
        cl.set('_speakingNow', false);
        for (i = 0; i < 12; i++) { f._earFeed(frame(2), rate); t += 85; }
    } finally { Date.now = real; }
    cl.set('_herVoiceLastOnAt', 0);
    var runs = posted.filter(function (m) { return m.cmd === 'run' && !m.partial; });
    return runs.length ? runs[runs.length - 1].id : undefined;
}

T.test('her own words, transcribed after she stopped, are dropped - the user\'s words over her voice are kept', function () {
    var cl = page(), f = cl.fn, c = cl.c, queued = [];
    cl.set('_enqueueFinalTranscript', function (t) { queued.push(t); });
    c.ear.on = true; c.ear.status = 'on';
    cl.set('_speakingText', 'Your ticket INC0010013 is in progress with the network team.');
    var id = segment(cl, true);
    T.ok(id !== undefined, 'the segment went to the worker');
    T.eq(cl.get('_speakingNow'), false, 'she has finished by the time the words come back');
    f._earOnMessage({ data: { id: id, text: ' is in progress with the network team', ms: 1400 } });
    T.eq(queued, [], 'never sent as a command');
    T.match(c.heard[c.heard.length - 1].fate, /my own voice/);
    // the user, talking over her: kept
    id = segment(cl, true);
    f._earOnMessage({ data: { id: id, text: ' What is the status of INC0010014?', ms: 1500 } });
    T.eq(queued, ['What is the status of INC0010014?']);
    // her words, then theirs, in one segment: her part is stripped
    id = segment(cl, true);
    f._earOnMessage({ data: { id: id, text: ' with the network team. What about the printer ticket', ms: 1500 } });
    T.eq(queued[1], 'What about the printer ticket');
    // a later line of hers does not change what this segment is scored against
    id = segment(cl, true);
    cl.set('_speakingText', 'I am ready again - just speak.');
    f._earOnMessage({ data: { id: id, text: ' in progress with the network team', ms: 1500 } });
    T.eq(queued.length, 2, 'scored against what she was saying when it was heard');
    // a segment in a quiet room is never echo-scored
    id = segment(cl, false);
    f._earOnMessage({ data: { id: id, text: ' the network team is great', ms: 900 } });
    T.eq(queued[2], 'the network team is great');
});

T.test('a short answer right after her question still counts; a stray word over her voice does not', function () {
    var cl = page(), f = cl.fn, c = cl.c, queued = [];
    cl.set('_enqueueFinalTranscript', function (t) { queued.push(t); });
    c.ear.on = true; c.ear.status = 'on';
    cl.set('_speakingText', 'I will raise it with priority three. Shall I go ahead?');
    // the yes starts as her question ends: only its first frame overlaps her
    var id = segment(cl, 1);
    f._earOnMessage({ data: { id: id, text: ' Yes.', ms: 700 } });
    T.eq(queued, ['Yes.'], 'a yes is an answer, not noise');
    // all over her voice: an echoed "yes" must never confirm a write, so a
    // short utterance there is dropped - the user says it again after her
    id = segment(cl, true);
    f._earOnMessage({ data: { id: id, text: ' Hmm okay', ms: 700 } });
    T.eq(queued.length, 1, 'two stray words, all over her voice: dropped');
    T.match(c.heard[c.heard.length - 1].fate, /too weak over my voice/);
    id = segment(cl, true);
    f._earOnMessage({ data: { id: id, text: ' Stop.', ms: 600 } });
    T.eq(queued.length, 2, '"stop" over her voice always counts');
});

T.test('the loading screen never sticks: a failed ear lets a working recognizer count, first words count at once', function () {
    var cl = page(), f = cl.fn, c = cl.c, said = [];
    cl.set('speak', function (t) { said.push(t); });
    c.hasTTS = false; c.state = 'idle';
    c.gate = { open: false, everOpen: false, hearing: false, voice: false, brain: true, hearingText: '', voiceText: '', brainText: 'ready' };
    c.ear.status = 'loading';
    global.Worker = global.Worker || function () {};   // a browser that can run the ear
    cl.set('_nativeVerdict', 'ok');
    f._readyUpdate();
    T.eq(c.gate.open, true, 'a clean start is enough: no waiting for an ear that is still downloading');
    f._earFail('network: model would not download');
    T.eq(c.ready, true, 'a failed ear changes nothing for a recognizer that works');
    T.eq(c.gate.open, true);
    // words from the recognizer count the moment they arrive
    var cl2 = page(), f2 = cl2.fn, c2 = cl2.c;
    cl2.set('speak', function () {});
    c2.hasTTS = false; c2.ear.status = 'loading';
    c2.gate = { open: false, everOpen: false, hearing: false, voice: false, brain: true, hearingText: '', voiceText: '', brainText: 'ready' };
    cl2.set('_nativeVerdict', 'ok');
    cl2.set('_nativeHeardWords', true);   // what contRec.onresult sets on the first words
    f2._readyUpdate();
    T.eq(c2.gate.open, true);
    // a browser that can neither listen nor load the ear says so, and typing still works once answers are ready
    var cl3 = page(), f3 = cl3.fn, c3 = cl3.c;
    cl3.set('speak', function () {});
    cl3.set('unlockAudio', function () {});
    c3.hasSR = false; c3.hasTTS = false; c3.ear.status = 'error'; c3.ear.error = 'no workers in this browser';
    delete global.Worker;
    c3.gate = { open: false, everOpen: false, hearing: false, voice: false, brain: true, hearingText: '', voiceText: '', brainText: 'ready' };
    f3._readyUpdate();
    T.eq(c3.gate.open, false);
    T.match(c3.gate.hearingText, /this browser can not listen.*type to me/);
    T.eq(f3._typedRefused('who founded servicenow'), false, 'typed questions need answers, not ears');
    c3.gate.brain = false;
    T.eq(f3._typedRefused('who founded servicenow'), true, 'but they do need answers');
});

T.test('no voice plays before a key press or tap: the loading screen asks for one, and it opens the gate', function () {
    var cl = page(), f = cl.fn, c = cl.c, said = [];
    cl.set('speak', function (t, done) { said.push(t); if (done) done(); });
    cl.set('unlockAudio', function () {});
    cl.set('setState', function () {});
    cl.set('$window', { navigator: { userActivation: { hasBeenActive: false } }, document: { addEventListener: function () {} } });
    c.hasTTS = false; c.state = 'idle'; c.ready = true; c.data = { is_guest: true };
    c.gate = { open: false, everOpen: false, hearing: true, voice: false, brain: true, hearingText: '', voiceText: '', brainText: 'ready' };
    f._gateUpdate();
    T.eq(c.gate.open, false); T.eq(c.gate.needsTap, true);
    T.match(c.gate.voiceText, /press Enter or tap Start/);
    T.eq(said, [], 'nothing said into a browser that would refuse it');
    f._onPageActivated({ type: 'keydown', key: 'Shift' });
    T.eq(c.gate.open, false, 'a modifier key is no activation');
    f._onPageActivated({ type: 'button' });   // what the Start button's c.gateActivate() does
    T.eq(c.gate.open, true); T.eq(c.gate.needsTap, false);
    T.match(said[0], /I am Netra, and I am ready/);
    // the browser voice refused later: the loading screen comes back until the next press
    cl.set('_voiceBlocked', true); f._gateUpdate();
    T.eq(c.gate.open, false);
    f._onPageActivated({ type: 'pointerdown' });
    T.eq(c.gate.open, true);
});

T.test('while the gate is shut: stop and stop listening work, asleep stays silent, noise gets no speech, one explanation per spell', function () {
    var cl = page(), f = cl.fn, c = cl.c, said = [], sent = [];
    cl.set('speak', function (t, done) { said.push(t); if (done) done(); });
    cl.set('handleHeard', function (t) { sent.push(t); });
    ['setState', '_calibConsume', 'learnFromTranscript', '_pushConfidence', 'closeConversation', '_cancelPlanContinue', 'openConversation'].forEach(function (n) { cl.set(n, function () { return false; }); });
    c.alert = true; c.conversationOpen = true; c.hasTTS = false; c.ready = true; c.data = {};
    c.gate = { open: false, everOpen: true, hearing: true, voice: true, brain: false, hearingText: '', voiceText: '', brainText: 'busy' };
    f.processFinalTranscript('stop', 0.9);
    T.eq(said, [], '"stop" is not refused: nothing was playing, a tone at most');
    f.processFinalTranscript('uh', 0.9);
    T.eq(said, [], 'a single word of noise: no speech');
    f.processFinalTranscript('what is the weather in london', 0.3);
    T.eq(said, [], 'a low-confidence guess: no speech');
    f.processFinalTranscript('what is the weather in london', 0.92);
    T.eq(said.length, 1); T.match(said[0], /still getting ready, my answers are not ready yet - busy\. I will tell you/);
    f.processFinalTranscript('hello are you there', 0.92);
    T.eq(said.length, 1, 'said once for this spell');
    f.processFinalTranscript('stop listening', 0.95);
    T.eq(c.alert, false, 'stop listening works through a shut gate');
    T.match(said[said.length - 1], /Going to sleep/);
    var n = said.length;
    cl.set('_gateNudged', false); cl.set('_gateNudgedAt', 0);   // would explain again if it were for her
    f.processFinalTranscript('what time is it', 0.95);
    T.eq(said.length, n, 'asleep: no "still getting ready" for talk that was not for her');
    T.eq(sent, []);
    // the next closed spell gets its own explanation
    cl.set('_gateHeld', null);
    c.alert = true; c.gate.brain = true; f._gateUpdate();
    T.eq(c.gate.open, true);
    c.gate.brain = false; f._gateUpdate();
    f.processFinalTranscript('what is the weather in paris', 0.92);
    T.match(said[said.length - 1], /still getting ready/);
});

T.test('a question held through a long outage is asked again; one held past ten minutes is never dropped without a word', function () {
    var cl = page(), f = cl.fn, c = cl.c, said = [], sent = [];
    cl.set('speak', function (t, done) { said.push(t); if (done) done(); });
    cl.set('handleHeard', function (t) { sent.push(t); });
    cl.set('setState', function () {});
    c.alert = true; c.hasTTS = false; c.ready = true; c.data = {};
    c.gate = { open: false, everOpen: true, hearing: true, voice: true, brain: true, hearingText: '', voiceText: '', brainText: '' };
    cl.set('_gateHeld', { text: 'what is Docker?', at: Date.now() - 5 * 60000 });
    f._gateUpdate();
    T.eq(sent, ['what is Docker?'], 'a five-minute outage: still answered');
    T.eq(said[0], 'Back now. You asked: what is Docker.');
    c.gate.brain = false; f._gateUpdate();
    cl.set('_gateHeld', { text: 'what is Kubernetes', at: Date.now() - 11 * 60000 });
    c.gate.brain = true; f._gateUpdate();
    T.eq(sent.length, 1, 'too old to answer unasked');
    T.eq(said[said.length - 1], 'I am ready again. I could not answer "what is Kubernetes" in time - please ask me again.');
});

T.test('answers from the web during a long outage: the gate opens, the greeting says so, and it looks again later', function () {
    var cl = page(), f = cl.fn, c = cl.c, said = [], timers = [];
    cl.set('speak', function (t, done) { said.push(t); if (done) done(); });
    cl.set('setState', function () {});
    cl.set('$timeout', Object.assign(function (fn, ms) { timers.push(ms); return {}; }, { cancel: function () {} }));
    c.hasTTS = false; c.ready = true; c.data = { is_guest: true };
    c.gate = { open: false, everOpen: false, hearing: true, voice: true, brain: false, hearingText: '', voiceText: '', brainText: '' };
    c.server = { get: function () { return { then: function (ok) { ok({ data: { ready: { ready: true, mode: 'web', wait_ms: 120000, say: "answers from the web only - my reasoning models are out of today's free quota until about 12:30 PM" } } }); } }; } };
    f._brainProbe('boot');
    T.eq(c.gate.open, true);
    T.eq(c.gate.brainText, "answers from the web only - my reasoning models are out of today's free quota until about 12:30 PM");
    T.match(said[0], /I am ready - just speak\. My reasoning is resting right now, so I will answer from the web until it is back\.$/);
    T.ok(timers.indexOf(120000) >= 0, 'probes again in two minutes: ' + timers.join(','));
});

T.test('a Guest\'s training stays in the tab: nothing is sent to the shared row, and a browser\'s own copy is not wiped', function () {
    var cl = page(), f = cl.fn, c = cl.c, sent = [];
    cl.set('_refreshTrainingViews', function () {});
    cl.set('$timeout', Object.assign(function (fn) { fn(); return {}; }, { cancel: function () {} }));
    c.server = { update: function () { sent.push(c.data.action); return { then: function () {} }; } };
    c.data = { is_guest: true }; c.personalVocab = { dentist: 2 }; c.aliases = { no: 'yes' };
    f.saveTrainingData();
    T.eq(sent, [], 'a Guest\'s words never reach the server');
    c.data = { is_guest: false }; cl.set('_saveInflight', false);
    f.saveTrainingData();
    T.eq(sent, ['save_training'], 'a signed-in user\'s are saved');
});

T.test('the ear is announced only once it really listens, mid-visit, and a failed ear nobody needed stays quiet', function () {
    var cl = page(), f = cl.fn, c = cl.c, said = [];
    cl.set('speak', function (t) { said.push(t); });
    cl.set('_earTapAttach', function () {}); cl.set('_readyUpdate', function () {});
    cl.set('_chatInFlight', false); cl.set('_earAnnounce', ''); cl.set('_earEngageOnLoad', false);
    global.Worker = global.Worker || function () {}; global.Blob = global.Blob || function () {};
    c.gate = { open: false, everOpen: false, hearing: false, voice: true, brain: true };
    c.ear.status = 'loading'; cl.set('_earWorker', { postMessage: function () {} });
    f._earStart('the browser can not reach its speech service');
    T.eq(said, [], 'nothing claimed while the ear is still downloading');
    f._earReady();
    T.eq(said, [], 'first boot: the greeting comes next, no second line');
    // mid-visit: the browser recognizer dies, the ear takes over
    c.ear.on = false; c.ear.status = 'loading'; c.gate.everOpen = true; cl.set('_earSaid', false);
    f._earStart('the browser can not reach its speech service');
    T.eq(said, []);
    f._earReady();
    T.eq(said, ['The browser can not reach its speech service, so I am listening on this device now - please say that again.']);
    // a standby ear that fails while the browser recognizer hears: quiet
    said.length = 0;
    c.ear.on = false; cl.set('_earEngageOnLoad', false); cl.set('_nativeHeardWords', true);
    f._earFail('network: model would not download');
    T.eq(said, [], 'nobody needed it, and it never cuts off an answer');
    cl.set('_nativeHeardWords', false); cl.set('_earEngageOnLoad', true);
    f._earFail('network: model would not download');
    T.match(said[0] || '', /could not load my on-device listening/);
});

T.test('after the ear hands back, the browser\'s copy of the words the ear already delivered is dropped', function () {
    var cl = page(), f = cl.fn;
    var now = Date.now();
    cl.set('_earLastSaid', { text: 'What is the capital of Australia?', at: now });
    cl.set('_earHandbackAt', now);
    T.eq(f._handbackRepeat('what is the capital of australia'), true);
    T.eq(f._handbackRepeat('capital of australia'), true, 'a split fragment of the same words');
    T.eq(f._handbackRepeat('who wrote hamlet'), false, 'new words are kept');
    cl.set('_earHandbackAt', now - 5000);
    T.eq(f._handbackRepeat('what is the capital of australia'), false, 'a real repeat later is kept');
});

T.test('a browser with no speech recognizer still boots: the ear, the answers probe, the loading screen', function () {
    var cl = page(), f = cl.fn, c = cl.c, calls = [];
    ['unlockAudio', 'populateVoices', 'startContinuous', '_earLoad', '_readyUpdate', 'startListeningWatchdog', 'startVisibilityRecovery',
     'startNotificationPolling', 'setState', 'openConversation', 'speak'].forEach(function (n) { cl.set(n, function () { calls.push(n); }); });
    cl.set('_brainProbe', function (why) { calls.push('_brainProbe:' + why); });
    cl.set('booted', false); cl.set('_ctrlDestroyed', false);
    global.Worker = global.Worker || function () {}; global.Blob = global.Blob || function () {};
    c.hasSR = false; c.data = { has_api_key: true }; c.ear.mode = 'auto';
    f.tryBoot(false);
    T.ok(calls.indexOf('startContinuous') >= 0, 'the ear starts from startContinuous');
    T.ok(calls.indexOf('_brainProbe:boot') >= 0, 'answers are probed');
    T.eq(cl.get('booted'), true);
    T.eq(calls.indexOf('speak'), -1, 'no "your browser does not support voice" dead end');
});

T.run(__filename);
