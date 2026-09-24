/*
 * Audit slice client-C: the page's voice. A notification or a reminder never
 * talks over the user or into a read-back still waiting for its yes; a stop
 * before the audio starts is never followed by the stale reply through a
 * fallback voice; a long reply is not cut off while it is still being
 * heard; TTS never rides the mic's audio context; a page SP took away stops
 * listening, polling and speaking.
 */
'use strict';
var T = require('./lib/t'), N = require('./lib/netra'), S = require('./lib/session');

var store = {};
global.localStorage = {
    getItem: function (k) { return store.hasOwnProperty(k) ? store[k] : null; },
    setItem: function (k, v) { store[k] = String(v); },
    removeItem: function (k) { delete store[k]; }
};
global.window = {};
global.requestAnimationFrame = function () { return 1; };
global.cancelAnimationFrame = function () {};

function noop() {}

// a $timeout whose callbacks run only when the test says so
function clock() {
    var q = [];
    var t = function (fn, ms) { var h = { fn: fn, ms: ms || 0, off: false }; q.push(h); return h; };
    t.cancel = function (h) { if (h) h.off = true; };
    t.pending = function (ms) { return q.filter(function (h) { return !h.off && (ms === undefined || h.ms === ms); }); };
    t.run = function (ms) {
        var due = t.pending(ms);
        due.forEach(function (h) { q.splice(q.indexOf(h), 1); });
        due.forEach(function (h) { h.fn(); });
        return due.length;
    };
    return t;
}

// the controller with its real speech engines; the network, audio elements
// and sockets are fakes the test drives by hand
function engine() {
    var cl = N.loadClient(), c = cl.c, set = cl.set, tmo = clock();
    var e = { c: c, f: cl.fn, get: cl.get, set: set, tmo: tmo, audios: [], sockets: [], browser: [], stream: [], edge: [] };
    set('$timeout', tmo);
    ['logEvent', 'cue', 'tone', 'openConversation', 'closeConversation', '_convoPush', 'stopFillerChain', '_setOrbPulse',
     '_ssSet', 'attachGrammar', 'populateVoices'].forEach(function (n) { set(n, noop); });
    set('setState', function (st) { c.state = st; });
    set('_edgeCircuitOpen', function () { return false; });
    set('_edgeWssUrl', function (cb) { cb('wss://edge.test/tts', 'req1'); });
    set('_CONTRACTION_PAIRS', []);
    set('REMOTE_FAIL_LIMIT', 2); set('_streamFails', 0); set('_edgeFails', 0); set('REMOTE_TTS_VOICE', 'Raveena');
    set('EDGE_GEC_VERSIONS', ['1-143.0.3650.75', '1-140.0.3485.14']); set('_edgeVerIdx', 0); set('_edgeVerTried', 0); set('_edgeVerOpenedAt', 0); set('_edgeLiveBroken', false);
    set('BARGE_GUARD_MS', 450); set('TTS_GUARD_MS', 350);
    set('_speakSessionId', 0); set('_turnEpoch', 0); set('_speakingNow', false); set('_speakingText', '');
    set('_calibActive', false); set('_localReminderTimers', {}); set('_ackIds', []); set('seenIds', {});
    c.stats = {}; c.data = {}; c.alert = true; c.conversationOpen = true; c.state = 'idle'; c.micHealth = {};
    global.Audio = function (src) {
        var a = this;
        a.src = src || ''; a.paused = true; a.ended = false; a.currentTime = 0; a.volume = 1; a.plays = 0;
        a.play = function () {
            a.plays++; a.paused = false;
            var p = { then: function (ok, bad) { a._reject = bad || a._reject; return p; }, catch: function (bad) { a._reject = bad; return p; } };
            return p;
        };
        a.pause = function () { a.paused = true; };
        e.audios.push(a);
    };
    global.WebSocket = function (url) {
        var w = this;
        w.url = url; w.sent = []; w.closed = false;
        w.send = function (m) { w.sent.push(m); };
        w.close = function () { w.closed = true; };
        e.sockets.push(w);
    };
    e.spy = function (name, into) { set(name, function (text) { into.push(String(text)); }); };
    return e;
}

// one audio frame the way the Edge socket sends it, then the end of the turn
var FRAME = { data: new Uint8Array([0, 2, 65, 66, 1, 2, 3, 4]).buffer };
var TURN_END = { data: 'X-RequestId:req1\r\nPath:turn.end\r\n\r\n{}' };

// the page's controller for conversation-level checks: what it would say and
// send is recorded instead of played or posted
function page(tmo, holdDone) {
    var cl = N.loadClient(), c = cl.c, set = cl.set, rec = { spoken: [], sent: [], done: [] };
    var now = function (fn) { if (typeof fn === 'function') fn(); return 0; };
    now.cancel = noop;
    set('$timeout', tmo || now);
    set('speak', function (text, done) {
        rec.spoken.push(String(text));
        if (holdDone) rec.done.push(done || noop); else if (done) done();
    });
    set('handleHeard', function (text) { rec.sent.push(String(text)); });
    set('setState', function (st) { c.state = st; });
    ['logEvent', 'cue', 'tone', 'openConversation', 'closeConversation', '_convoPush', 'saveTrainingData', 'attachGrammar',
     'learnFromTranscript', '_pushConfidence', 'stopFillerChain', 'unlockAudio', 'populateVoices', 'startContinuous',
     'startListeningWatchdog', 'startVisibilityRecovery', 'startNotificationPolling', '_firstRunCheck', '_memPersist']
        .forEach(function (n) { set(n, noop); });
    set('WAKE_WORDS', ['netra']); set('SALUTATION_PREFIXES', ['hey', 'ok', 'okay']);
    set('MIN_LENGTH', 3); set('MIN_CONFIDENCE', 0.35); set('ALWAYS_LISTEN', true); set('REPROMPT_AFTER_MS', 9000);
    set('_calibActive', false); set('_calibSession', 0); set('_calibListenStart', 0);
    set('_labNlpArm', false); set('_labNlpPrevMute', false); set('_labNlpSent', '');
    set('geminiHistory', []); set('seenIds', {}); set('_ackIds', []); set('_recentReminderTexts', {}); set('_localReminderTimers', {});
    set('_speakingNow', false); set('_chatInFlight', false); set('_queuedUtterance', null); set('booted', false);
    set('_lastInterimAt', 0); set('_fillerChainActive', false); set('currentFillerAudio', null); set('currentFillerUtter', null);
    c.events = []; c.stats = {}; c.aliases = {}; c.personalVocab = {}; c.data = {}; c.micHealth = {};
    c.alert = true; c.conversationOpen = true; c.state = 'idle'; c.lastHeard = ''; c.lastAnswer = ''; c.labMute = false;
    c.labCalib = { stage: 'idle', heard: '', score: null, verdict: '' };
    return { c: c, f: cl.fn, get: cl.get, set: set, rec: rec,
             hear: function (u) { cl.fn.processFinalTranscript(u, 0.9); return rec; } };
}

// the page takes a server reply the way the chat callback does
function heard(p, r) {
    p.c._awaitingConfirm = !!r.awaiting_confirm; p.c._awaitingConfirmAt = Date.now();
    p.c.lastAnswer = String(r.message || ''); p.c.lastAnswerAt = Date.now();
}

/* ---- 6. notifications wait for the floor ---------------------------------- */

T.test('a notification never talks over the user, the mic check, a queued turn, or a read-back waiting for its yes', function () {
    var p = page(), note = { id: 'n1', kind: 'assignment', message: 'Heads up. Incident INC0010019 has been assigned to you.' };
    function poll() { p.f._onPolledNotification(note); }

    p.c.interim = 'yes go';                    // mid-sentence: the state is still idle
    poll();
    p.c.interim = '';
    p.set('_lastInterimAt', Date.now() - 400); // a word only just ended
    poll();
    p.set('_lastInterimAt', 0);
    p.c.labCalib.stage = 'listening';          // reading the calibration sentence aloud
    poll();
    p.c.labCalib.stage = 'idle';
    p.set('_queuedUtterance', 'list my tickets');
    poll();
    p.set('_queuedUtterance', null);
    T.eq(p.rec.spoken, [], 'nothing spoken over the user');
    T.eq(p.get('_ackIds'), [], 'and nothing acked, so the next poll brings it back');

    var s = new S.Session({ key: '' });
    var r1 = s.say('raise a ticket for vpn drops every morning');
    T.match(r1.message, /Shall I\?/);
    heard(p, r1);
    poll();
    T.eq(p.rec.spoken, [], 'nothing between the read-back and its answer');
    T.eq(p.get('_ackIds'), []);

    p.hear('yes');
    T.eq(p.rec.sent, ['yes'], 'the yes answers the read-back it followed');
    var r2 = s.say(p.rec.sent[0]);
    heard(p, r2);
    T.ok(Object.keys(S.g.P.STORE.incident).some(function (k) {
        return /vpn drops every morning/.test(String(S.g.P.STORE.incident[k].short_description));
    }), 'the heard read-back was confirmed');
    poll();
    T.eq(p.rec.spoken.length, 1, 'once the question is answered the notification is spoken');
    T.match(p.rec.spoken[0], /INC0010019 has been assigned to you/);
    T.eq(p.get('_ackIds'), ['n1'], 'and acked once said');
});

/* ---- 8. a local reminder waits for the floor and counts only once heard ---- */

T.test('a reminder never cuts into a read-back or a turn, and counts as said only once it was heard', function () {
    var tmo = clock(), p = page(tmo, true), f = p.f, text = 'Reminder: call Beth.';
    p.c._awaitingConfirm = true; p.c._awaitingConfirmAt = Date.now();
    p.c.lastAnswer = 'I will escalate incident ending 0 2 3 to priority 1. Shall I?'; p.c.lastAnswerAt = Date.now();
    f._scheduleLocalReminder(60000, text, 'r1');
    tmo.run();
    T.eq(p.rec.spoken, [], 'the read-back is not cut off');
    T.eq(tmo.pending().length, 1, 'the reminder tries again shortly');
    T.ok(!f._reminderAlreadySpoken(text), 'and does not count as said');

    p.c._awaitingConfirm = false; p.c.lastAnswer = 'Done.';
    p.set('_chatInFlight', true); p.c.state = 'thinking';
    tmo.run();
    T.eq(p.rec.spoken, [], 'not over a turn in flight either');
    p.set('_chatInFlight', false); p.c.state = 'idle';
    tmo.run();
    T.eq(p.rec.spoken, [text], 'spoken once the floor is free');
    T.ok(!f._reminderAlreadySpoken(text), 'not yet heard: the scanner copy must still be allowed through');
    p.rec.done[0]();
    T.ok(f._reminderAlreadySpoken(text), 'heard: the scanner copy is skipped');
    f._onPolledNotification({ id: 'n9', kind: 'reminder', message: text });
    T.eq(p.rec.spoken, [text], 'no second copy');
    T.eq(p.get('_ackIds'), ['n9']);

    // the polled copy got there first: the page timer stays quiet
    var q = page(clock(), false), qt = q.get('$timeout');
    q.f._scheduleLocalReminder(60000, text, 'r2');
    q.f._onPolledNotification({ id: 'n10', kind: 'reminder', message: text });
    qt.run();
    T.eq(q.rec.spoken, [text], 'said once, not twice');
});

/* ---- 5. a stop before the audio starts stays a stop ------------------------ */

T.test('StreamElements: a stop before playback does not bring the stale reply back in the browser voice', function () {
    var e = engine(), done = 0;
    e.spy('speakBrowser', e.browser);
    e.f.speakStreamElements('There are 4 priority-1 incidents open.', function () { done++; });
    var a = e.audios[0];
    T.ok(a && a._reject, 'playback requested');
    e.f.stopSpeaking('user barge-in');
    a._reject(new Error('The play() request was interrupted by a call to pause()'));
    e.tmo.run();
    T.eq(e.browser, [], 'the old answer is not spoken over the new question');
    T.eq(e.get('_streamFails'), 0, 'a stop is not a stream failure');
    T.eq(done, 0);
});

T.test('Edge (no MediaSource): a stop during synthesis is never followed by the whole reply', function () {
    var e = engine(), c = e.c;
    e.spy('speakStreamElements', e.stream);
    e.f.speakEdgeTTS('There are 4 priority-1 incidents open.', noop);
    var ws = e.sockets[0];
    e.f.stopSpeaking('reflex "stop"');
    ws.onopen();
    T.eq(ws.sent.length, 0, 'nothing is synthesized after the stop');
    T.ok(c.state !== 'speaking', 'the page does not claim to be speaking');
    ws.onmessage(FRAME);
    ws.onmessage(TURN_END);
    if (ws.onclose) ws.onclose();
    e.tmo.run();
    T.eq(e.audios.length, 0, 'the stale reply never plays');
    T.eq(e.stream, [], 'and is not re-spoken by a fallback');

    // a newer line replaces an older one still synthesizing
    var n = engine();
    n.spy('speakStreamElements', n.stream);
    n.f.speakEdgeTTS('Your oldest ticket is INC0010013.', noop);
    var old = n.sockets[0];
    old.onopen();
    n.c.ttsEngine = 'stream';
    n.f.speak('There are 2 approvals waiting on you.');
    old.onmessage(FRAME);
    old.onmessage(TURN_END);
    T.eq(n.audios.length, 0, 'the older line does not play over the newer one');
    T.eq(n.stream, ['There are 2 approvals waiting on you.']);
});

T.test('Edge (no MediaSource): the socket closing after its audio arrived is not a failure that speaks it twice', function () {
    var e = engine();
    e.spy('speakStreamElements', e.stream);
    e.f.speakEdgeTTS('Done. Incident ending 0 1 3 is resolved.', noop);
    var ws = e.sockets[0];
    ws.onopen();
    ws.onmessage(FRAME);
    ws.onmessage(TURN_END);
    T.eq(e.audios.length, 1, 'the reply plays');
    if (ws.onclose) ws.onclose();   // the browser fires close after ws.close()
    T.eq(e.stream, [], 'not spoken again through StreamElements');
    T.eq(e.get('_edgeFails'), 0, 'and Edge is not counted as failing');
});

T.test('Gemini voice: a stop while the server synthesizes stays silent', function () {
    var e = engine(), c = e.c, call = null;
    e.spy('speakEdgeTTS', e.edge);
    c.server = { update: function () { return { then: function (ok, bad) { call = { ok: ok, bad: bad }; } }; } };
    e.f.speakGemini('There are 4 priority-1 incidents open.', noop);
    e.f.stopSpeaking('reflex "stop"');
    c.data.gemini_tts = { ok: true, b64: 'AAAAAAAA', mime: 'audio/L16;rate=24000', voice: 'Kore' };
    call.ok();
    e.tmo.run();
    T.eq(e.audios.length, 0, 'the synthesized reply is not played');
    T.eq(e.edge, [], 'nor re-spoken by Edge');

    var w = engine(), wcall = null;
    w.spy('speakEdgeTTS', w.edge);
    w.c.server = { update: function () { return { then: function (ok, bad) { wcall = { ok: ok, bad: bad }; } }; } };
    w.f.speakGemini('There are 4 priority-1 incidents open.', noop);
    w.f.stopSpeaking('reflex "stop"');
    w.tmo.run(12000);   // no answer from the server in 12 seconds
    T.eq(w.edge, [], 'the watchdog does not speak a stopped reply');
});

/* ---- 4. a long reply is not "stuck" while it is being heard ---------------- */

T.test('the stuck-speaking watchdog lets a long reply finish, and still frees a floor whose audio stopped', function () {
    var realNow = Date.now, t = realNow.call(Date);
    Date.now = function () { return t; };
    try {
        var e = engine(), c = e.c, stops = [];
        e.set('stopSpeaking', function (why) { stops.push(why); });
        var audio = { paused: false, ended: false, currentTime: 0 };
        e.set('currentAudio', audio);
        e.set('_speakingNow', true); e.set('_speakingSince', t); e.set('_edgeLiveWs', null); e.set('_lastInterimAt', 0);
        e.set('watchdogLastSpeakingStart', 0); e.set('watchdogLastPlayedTo', -1); e.set('watchdogStrikes', 0);
        e.set('_floorStuckStrikes', 0); e.set('_permProbeCounter', 0); e.set('MIN_LENGTH', 3);
        e.set('recLastStartTime', t); e.set('recLastActivityAt', t); e.set('ignoreFinalsUntil', 0);
        c.state = 'speaking'; c.permission = 'granted'; c.recRunning = true;
        e.f.startListeningWatchdog();
        for (var i = 0; i < 9; i++) { t += 10000; audio.currentTime += 9.8; e.tmo.run(10000); }
        T.eq(stops, [], 'a 90-second debrief that is still playing is not cut off');
        for (var j = 0; j < 4; j++) { t += 10000; e.tmo.run(10000); }
        T.eq(stops, ['watchdog stuck-speaking'], 'audio that stopped advancing is released after 30s');

        // browser TTS has no clock: it gets the time its text needs, then is freed
        var b = engine(), bstops = [];
        b.set('stopSpeaking', function (why) { bstops.push(why); });
        b.set('currentAudio', null); b.set('TTS', { speaking: true, pending: false });
        b.set('_speakingText', new Array(301).join('a'));   // 300 chars, about 25 s of speech
        b.set('_speakingNow', true); b.set('_speakingSince', t); b.set('_edgeLiveWs', null); b.set('_lastInterimAt', 0);
        b.set('watchdogLastSpeakingStart', 0); b.set('watchdogLastPlayedTo', -1); b.set('watchdogStrikes', 0);
        b.set('_floorStuckStrikes', 0); b.set('_permProbeCounter', 0); b.set('MIN_LENGTH', 3);
        b.set('recLastStartTime', t); b.set('recLastActivityAt', t); b.set('ignoreFinalsUntil', 0);
        b.c.state = 'speaking'; b.c.permission = 'granted'; b.c.recRunning = true;
        b.f.startListeningWatchdog();
        for (var k = 0; k < 6; k++) { t += 10000; b.tmo.run(10000); }
        T.eq(bstops, [], 'a long browser-voice reply is not cut at 40 seconds');
        for (var m = 0; m < 3; m++) { t += 10000; b.tmo.run(10000); }
        T.eq(bstops, ['watchdog stuck-speaking'], 'a browser voice that hangs is still freed');
    } finally {
        Date.now = realNow;
    }
});

/* ---- 7. TTS is not routed through the mic's audio context ------------------ */

T.test('the voice rides the long-lived output context, so a mic recycle can not silence a read-back', function () {
    function ctx(state) {
        var x = { state: state, sources: 0, closed: false, resumed: false, destination: {},
            createMediaElementSource: function () { x.sources++; return { connect: noop, disconnect: noop }; },
            createAnalyser: function () { return { frequencyBinCount: 512, connect: noop, disconnect: noop, getByteFrequencyData: noop }; },
            close: function () { x.closed = true; x.state = 'closed'; },
            resume: function () { x.resumed = true; } };
        return x;
    }
    global.window = { AudioContext: function () {} };
    try {
        var e = engine(), out = ctx('running'), mic = ctx('running');
        e.set('audioCtx', out); e.set('_micCtx', mic);
        e.f.attachOutputAnalyser({ paused: true, ended: false });
        T.eq(mic.sources, 0, 'the read-back is not routed through the mic context');
        T.eq(out.sources, 1, 'it rides the page-long output context');
        e.f.stopMicLevelMeter();   // a headset plugged in mid-sentence
        T.ok(mic.closed, 'the mic context is rebuilt');
        T.ok(!out.closed, 'the voice keeps its context');

        var s = engine(), sleepy = ctx('suspended');
        s.set('audioCtx', sleepy); s.set('_micCtx', ctx('running'));
        s.f.attachOutputAnalyser({ paused: true, ended: false });
        T.eq(sleepy.sources, 0, 'a suspended context never swallows the audio: the element plays directly');
        T.ok(sleepy.resumed, 'and the context is asked to resume for next time');
    } finally {
        global.window = {};
    }
});

/* ---- 3. a page SP took away is really gone -------------------------------- */

function listenerHost() {
    var h = { on: {} };
    h.addEventListener = function (t, fn) { (h.on[t] = h.on[t] || []).push(fn); };
    h.removeEventListener = function (t, fn) { h.on[t] = (h.on[t] || []).filter(function (x) { return x !== fn; }); };
    h.count = function (t) { return (h.on[t] || []).length; };
    return h;
}

T.test('a destroyed controller stops listening, polling, speaking and answering hotkeys', function () {
    var e = engine(), c = e.c, f = e.f, made = 0, polls = 0, inflight = null;
    function FakeSR() { made++; var r = this; r.start = noop; r.stop = noop; r.abort = function () { r.aborted = true; }; }
    e.set('SR', FakeSR); c.hasSR = true; c.permission = 'granted'; e.set('recRunningDebounceTimer', null);
    var win = listenerHost(); win.document = listenerHost();
    e.set('$window', win);
    c.server = { update: function () {
        polls++;
        return { then: function (ok) { inflight = ok; return { finally: function (fin) { inflight = { ok: ok, fin: fin }; } }; } };
    } };
    f.bindHotkeys();
    f.startVisibilityRecovery();
    f.startContinuous();
    f.startListeningWatchdog();
    f.startNotificationPolling();
    e.tmo.run(3000);   // a poll is on the wire when the user navigates away
    T.eq(polls, 1);
    var reminded = 0;
    e.get('_localReminderTimers').r1 = e.tmo(function () { reminded++; }, 60000);
    var rec = e.get('contRec'), onend = rec.onend;
    e.spy('speakBrowser', e.browser); c.ttsEngine = 'browser';

    f._destroyController();
    T.eq(win.count('keydown'), 0, 'Alt+N no longer reaches the old page');
    T.eq(win.document.count('visibilitychange'), 0, 'nor does coming back to the tab');
    T.ok(rec.aborted, 'recognition is aborted');
    onend();                              // the end event that was already queued
    c.data.notifications = [];
    inflight.ok(); inflight.fin();        // the poll in flight lands
    f._afterTTS();
    f.startContinuous();
    for (var i = 0; i < 3; i++) e.tmo.run();
    T.eq(made, 1, 'no new recognizer is started');
    T.eq(polls, 1, 'no further polls');
    T.eq(e.tmo.pending().length, 0, 'no watchdog or poll timer is left running');
    T.eq(reminded, 0, 'a pending reminder is cancelled');
    f.speak('Here is the answer to the question you asked on the last page.');
    T.eq(e.browser, [], 'a reply landing after navigation is not spoken');
});

T.test('one Netra per page: a new controller retires the one SP left behind', function () {
    var win = listenerHost(); win.document = listenerHost();
    var a = engine(), b = engine();
    a.set('$window', win); b.set('$window', win);
    a.f.bindHotkeys();
    a.f._claimPage();
    b.f._claimPage();
    T.ok(a.get('_ctrlDestroyed'), 'the old controller is torn down');
    T.eq(win.count('keydown'), 0, 'so a hotkey is handled once, not by two controllers');
    T.ok(!b.get('_ctrlDestroyed'), 'the new one lives');
    b.f._destroyController();
    T.eq(win.__netraDestroy, null, 'and releases the page when it goes');
});

T.run(__filename);
