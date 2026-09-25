/*
 * What Netra says about time and the web, and how the page treats what it
 * hears: clock times in the user's own timezone, a real web search that
 * costs no model call, her own words stripped from a barge-in, and no
 * guard swallowing the user's interruption.
 */
'use strict';
var T = require('./lib/t'), S = require('./lib/session'), N = require('./lib/netra'), g = S.g;

function fns(input) { return N.loadServer({ input: input || { action: 'chat' } }).fn; }
var UTC_0030 = Date.UTC(2026, 8, 24, 0, 30, 0);

T.test('clock times follow the browser\'s clock when the page sends it', function () {
    new S.Session();
    T.eq(fns({ action: 'chat' })._clockAt(UTC_0030), '12:30 AM', 'profile timezone (UTC in tests) without the page');
    T.eq(fns({ action: 'chat', tz_offset_min: 330 })._clockAt(UTC_0030), '6:00 AM', 'Bengaluru');
    T.eq(fns({ action: 'chat', tz_offset_min: '-420' })._clockAt(UTC_0030), '5:30 PM', 'Pacific, sent as a string');
    T.eq(fns({ action: 'chat', tz_offset_min: 99999 })._clockAt(UTC_0030), '12:30 AM', 'nonsense is ignored');
    g.P.now = UTC_0030;
    T.eq(fns({ action: 'chat', tz_offset_min: 330 })._dayClock(UTC_0030 - 7 * 3600000), 'yesterday at 11:00 PM', 'the day boundary moves with the timezone');
    T.eq(fns({ action: 'chat', tz_offset_min: 330 })._dailyBriefing().greeting, 'Good morning', 'greeting by the user\'s clock, 6 AM in Bengaluru');
});

function webWorld() {
    var s = new S.Session();
    g.P.HTTP = function (req) {
        var u = req.endpoint;
        // Bing's own order puts a thin hit first and an off-topic one last: the
        // answer must be the row about the question, and the off-topic row unread
        if (/bing\.com\/search/.test(u)) return { status: 200, body: '<rss><channel><item><title>Nvidia leadership</title><link>https://nvidia.com/leadership</link><description>Our leadership team.</description></item><item><title>Jensen Huang - Wikipedia</title><link>https://en.wikipedia.org/wiki/Jensen_Huang</link><description>Jensen Huang is the president, co-founder and &lt;b&gt;CEO of Nvidia&lt;/b&gt;.</description></item><item><title>Home - Founded</title><link>https://founded.example</link><description>Welcome to our site.</description></item></channel></rss>' };
        if (/wikipedia\.org\/w\/api\.php/.test(u)) return { status: 200, body: JSON.stringify({ query: { search: [{ title: 'Kubernetes', snippet: 'Kubernetes is an <span>open-source</span> container orchestration system' }] } }) };
        if (/wikipedia\.org\/api\/rest_v1\/page\/summary/.test(u)) return { status: 200, body: JSON.stringify({ extract: 'Kubernetes is an open-source container orchestration system for automating software deployment, scaling, and management.' }) };
        return { status: 404, body: '' };
    };
    return s;
}

T.test('"search the web for X" is answered from real results, with the source, at no model cost', function () {
    var s = webWorld();
    var r = s.say('search the web for who is the ceo of nvidia');
    T.eq(s.gemini.generate.length, 0);
    T.match(r.message, /^From Bing, "Jensen Huang - Wikipedia": Jensen Huang is the president, co-founder and CEO of Nvidia\. Other results: Nvidia leadership\./);
    T.notMatch(r.message, /https?:/, 'no URL is read aloud');
});

T.test('an encyclopaedic question goes to Wikipedia first; unrelated hits are not read as answers', function () {
    webWorld();
    var f = fns();
    var r = f._searchWeb('what is kubernetes');
    T.eq(r.source, 'Wikipedia');
    T.match(r.answer, /^Kubernetes is an open-source container orchestration system/);
    var r2 = f._searchWeb('what is a carina engine');
    T.eq(r2.ok, false, 'no hit shares a word with the question: refused, not read out');
    T.match(f._saySearch(r2, 'what is a carina engine'), /found nothing clear/);
});

T.test('in basic mode a general question is still answered from the web', function () {
    var s = webWorld();
    g.P.PROPS['x_196061_netra_v1.brain_offline'] = 'true';
    var r = s.say('who is the ceo of nvidia');
    T.eq(s.gemini.generate.length, 0);
    T.match(r.message, /basic mode/);
    T.match(r.message, /From Bing, "Jensen Huang - Wikipedia"/);
    var r2 = s.say('what is the status of my vpn ticket');
    T.notMatch(r2.message, /From Bing/, 'ticket questions never go to the web');
});

/* ---- the page ---- */
function page() {
    var cl = N.loadClient(), c = cl.c;
    c.events = []; c.heard = []; c.micHealth = { networkErrors: 0 }; c.stats = { barges: 0 }; c.convo = []; cl.set('_convoPush', function () {});
    cl.set('_speakingText', ''); cl.set('_fillerEchoText', '');
    cl.set('$scope', { $applyAsync: function () {} });
    return cl;
}

T.test('her own words at the edges of a barge-in are stripped; the user\'s words stay', function () {
    var cl = page(), f = cl.fn;
    cl.set('_speakingText', 'You have six open tickets. The newest three: incident ending 0 2 0, VPN disconnects; shall I read the rest?');
    T.eq(f._stripEchoEdges('the newest three what is the status of incident ten thirteen'), 'what is the status of incident ten thirteen');
    T.eq(f._stripEchoEdges('what is the status of incident ten thirteen shall I read'), 'what is the status of incident ten thirteen');
    T.eq(f._stripEchoEdges('read me the newest three tickets'), 'read me the newest three tickets', 'nothing stripped from the middle');
    T.eq(f._stripEchoEdges('you have six'), 'you have six', 'a fragment that is all her words is left for the echo scorer');
    T.eq(f._stripEchoEdges('read the newest three tickets to me please'), 'read the newest three tickets to me please', 'a command that shares words with her line is the user\'s');
    T.eq(f._stripEchoEdges('open the newest ticket for me'), 'open the newest ticket for me', 'one shared verb is no echo');
    T.eq(f._stripEchoEdges('read the rest to me'), 'read the rest to me');
    T.eq(f._stripEchoEdges('shall I read the rest what time is it'), 'what time is it', 'her run in her order is stripped');
});

T.test('stopping for the user\'s barge-in never guards away their words', function () {
    var cl = page(), f = cl.fn;
    ['currentAudio', 'TTS', '_edgeLiveWs', 'currentFillerAudio', 'currentFillerUtter', '_planContinueTimer', '_duckRestoreTimer'].forEach(function (k) { cl.set(k, null); });
    cl.set('_calibActive', false); cl.set('_fillerChainActive', false); cl.set('_speakSessionId', 0); cl.set('_turnEpoch', 0); cl.set('TTS_GUARD_MS', 350);
    cl.set('$timeout', Object.assign(function () { return {}; }, { cancel: function () {} }));
    ['stopFillerChain', 'detachOutputAnalyser', '_cancelPlanContinue', '_restoreDuck', 'logEvent'].forEach(function (n) { cl.set(n, function () {}); });
    f._clearSpeaking();
    T.ok(cl.get('ignoreFinalsUntil') > 0, 'a reply ending on its own guards the echo tail briefly');
    f.stopSpeaking('instant interim barge: "what is"');
    T.eq(cl.get('ignoreFinalsUntil'), 0, 'no guard after a barge: the user\'s final is still coming');
});

T.test('the neural voice gets only what its service serves: one prosody round plain text', function () {
    var cl = page(), f = cl.fn;
    cl.c.speechRate = 1.06;
    var ssml = f._buildHumanSSML('You have **16** open tickets... The newest: VPN drops -- since 9. Umm, shall I read the rest? Tom & Jerry <3', 'en-US-AvaMultilingualNeural');
    // <break>, <emphasis> and a nested <prosody> close the socket with "SSML is invalid" (1007)
    T.notMatch(ssml, /<break|<emphasis|<prosody[^>]*>[^<]*<prosody/, 'no tag the read-aloud service rejects');
    T.match(ssml, /^<speak version='1\.0' xml:lang='en-US'><voice name='en-US-AvaMultilingualNeural'><prosody rate='\+6%' pitch='\+0Hz'>[^<]+<\/prosody><\/voice><\/speak>$/, 'voice > prosody > text and nothing else');
    T.match(ssml, /You have 16 open tickets\.\.\. The newest: VPN drops - since 9\. Umm, shall I read the rest\? Tom &amp; Jerry &lt;3/, 'markdown dropped, pauses as punctuation, XML escaped');
});

T.test('a "stop" spoken over her voice stops her even with a tail the mic caught; a garbled barge-in is asked again', function () {
    var cl = page(), f = cl.fn, stops = [], said = [], dropped = [];
    cl.set('stopSpeaking', function (why) { stops.push(why); });
    cl.set('_dropFinalBuffer', function (why) { dropped.push(why); });
    cl.set('speak', function (t) { said.push(t); });
    cl.set('$timeout', function (fn) { fn(); return {}; });
    cl.set('setState', function () {});
    cl.set('logEvent', function () {});
    cl.set('_looksLikeEcho', function () { return false; });
    cl.set('_isNoAnswer', function () { return false; });
    cl.set('_speakingText', 'Well, according to Wikipedia, ServiceNow was founded in 2003 by Fred Luddy.');
    T.eq(f._handleFinalWhileSpeaking('stop a way', 0.60), true, 'handled here, nothing goes to the server');
    T.eq(stops.length, 1, 'she stopped');
    T.eq(dropped, ['reflex interrupt']);
    T.eq(cl.c.heard[0].fate, 'stop - yielded');
    // a real command after the stop rides on as the next command
    T.eq(f._handleFinalWhileSpeaking('netra stop, what time is it now', 0.9), false);
    T.eq(cl.get('_lastBargeText'), 'what time is it now');
    // "health and cute" for "Netra stop": stop her, ask again, never a command
    T.eq(f._handleFinalWhileSpeaking('health and cute', 0.62), true);
    T.eq(stops.length, 3);
    T.eq(said, ['Sorry, say that again?']);
    T.match(cl.c.heard[0].fate, /asked to repeat/);
    // a confident barge-in is the next command
    T.eq(f._handleFinalWhileSpeaking('how many tickets do i have', 0.9), false, 'a clear barge-in flows on as the command');
    T.eq(said.length, 1);
});

T.test('the "stop" that already yielded through the live transcript is not a command, and a stop with a command after it runs the command', function () {
    var cl = page(), f = cl.fn, sent = [], cues = [];
    cl.c.alert = true; cl.c.conversationOpen = true; cl.c.state = 'idle';
    cl.set('logEvent', function () {}); cl.set('cue', function (k) { cues.push(k); });
    cl.set('_calibConsume', function () { return false; }); cl.set('learnFromTranscript', function () {}); cl.set('_pushConfidence', function () {});
    cl.set('_speakingNow', false); cl.set('MIN_CONFIDENCE', 0.35);
    cl.set('handleHeard', function (t) { sent.push(t); });
    cl.set('_bargeStoppedAt', Date.now() - 800);
    f.processFinalTranscript('stop a way', 0.82);
    T.eq(cl.c.heard[0].fate, 'stop - yielded');
    f.processFinalTranscript('nada stop', 0.93);
    T.eq(cl.c.heard[0].fate, 'stop - yielded', 'her name in any spelling, then stop');
    T.eq(sent, [], 'nothing went to the server');
    cl.set('_bargeStoppedAt', 0);
    f.processFinalTranscript('netra stop', 0.9);
    T.eq(cl.c.heard[0].fate, 'stop - nothing was playing');
    T.eq(cues, ['pause']);
    f.processFinalTranscript('stop it', 0.9);
    T.eq(cl.c.heard[0].fate, 'stop - nothing was playing');
    T.eq(sent, [], 'still nothing to the server');
    // a command that begins with a stop word is a command
    cl.set('speak', function () {});
    f.processFinalTranscript('netra stop, list my tickets', 0.9);
    T.eq(sent, ['list my tickets'], 'a real command after the stop runs the command');
    sent.length = 0;
    f.processFinalTranscript('stop watching INC0010013', 0.9);
    T.match(sent[0] || '', /^stop watching/, 'the whole command goes, verb included');
    sent.length = 0;
    f.processFinalTranscript('pause the mission', 0.9);
    T.eq(sent, ['pause the mission']);
    sent.length = 0;
    f.processFinalTranscript('wait for the approval', 0.9);
    T.eq(sent, ['wait for the approval']);
    sent.length = 0;
    // even right after a live-transcript stop
    cl.set('_bargeStoppedAt', Date.now() - 900);
    f.processFinalTranscript('netra stop, list my tickets', 0.9);
    T.eq(sent, ['list my tickets'], 'right after a live-transcript stop, the three-word tail is the command, not echo');
    sent.length = 0;
    f.processFinalTranscript('stop watching INC0010013', 0.9);
    T.match(sent[0] || '', /^stop watching/);
    sent.length = 0;
    f.processFinalTranscript('stop a way', 0.9);
    T.eq(cl.c.heard[0].fate, 'stop - yielded');
    T.eq(sent, []);
});

T.test('over her voice, "stop watching INC0010013" stops her and is the whole command', function () {
    var cl = page(), f = cl.fn, stops = [];
    cl.set('stopSpeaking', function (why) { stops.push(why); });
    cl.set('_dropFinalBuffer', function () {});
    cl.set('logEvent', function () {});
    cl.set('_looksLikeEcho', function () { return false; });
    cl.set('_isNoAnswer', function () { return false; });
    cl.set('_speakingText', 'Incident ending 0 1 3 is on the watchlist.');
    T.eq(f._handleFinalWhileSpeaking('stop watching INC0010013', 0.9), false, 'flows on as the next command');
    T.eq(cl.get('_lastBargeText'), '', 'untouched: the verb is part of it');
    T.eq(f._handleFinalWhileSpeaking('stop, list my tickets', 0.9), false);
    T.eq(cl.get('_lastBargeText'), 'list my tickets');
    T.eq(stops.length, 2);
});

T.test('an outage that refuses every client version does not pin the session on the oldest one', function () {
    var cl = page(), f = cl.fn;
    cl.set('logEvent', function () {});
    var store = {};
    cl.set('_store', { getItem: function (k) { return store[k] || null; }, setItem: function (k, v) { store[k] = String(v); }, removeItem: function (k) { delete store[k]; } });
    cl.set('EDGE_GEC_VERSIONS', ['1-143', '1-140', '1-130']);
    cl.set('_edgeVerIdx', -1); cl.set('_edgeVerTried', 0); cl.set('_edgeVerOpenedAt', 0); cl.set('_edgeVerOpenedVer', ''); cl.set('_gecCache', { win: 0, val: '' });
    T.eq(f._edgeVersion(), '1-143');
    T.eq(f._edgeVersionRotate('1-143'), true); T.eq(f._edgeVersion(), '1-140');
    T.eq(f._edgeVersionRotate('1-140'), true); T.eq(f._edgeVersion(), '1-130');
    T.eq(f._edgeVersionRotate('1-130'), false, 'this line still falls back');
    T.eq(f._edgeVersion(), '1-143', 'but the next attempt starts from the newest version, not the refused oldest one');
    // a request that played proves its own version, not whatever a parallel lane rotated to
    f._edgeVersionRotate('1-143');
    T.eq(f._edgeVersion(), '1-140');
    f._edgeVersionWorked('1-143');
    T.eq(f._edgeVersion(), '1-143');
    T.eq(store.netra_edgeVer, '1-143');
    // a refusal right after this version opened a socket is a passing one
    f._edgeVersionOpened('1-143');
    T.eq(f._edgeVersionRotate('1-143'), false);
    T.eq(f._edgeVersion(), '1-143');
});

T.test('streamed playback: a socket that dies after opening is a blip, a refused handshake rotates, a hang does not, only a MediaSource fault latches the buffered path', function () {
    var cl = page(), f = cl.fn, noop = function () {};
    var sockets = [], msrcs = [], timers = [], buffered = [], fallbacks = [];
    global.WebSocket = function (url) { this.url = url; this.close = noop; this.send = noop; sockets.push(this); };
    global.MediaSource = function () {
        var m = this; m.readyState = 'open'; m._l = {}; msrcs.push(m);
        m.addEventListener = function (n, fn) { m._l[n] = fn; };
        m.addSourceBuffer = function () { if (global.MediaSource._throw) throw new Error('boom'); return { updating: false, addEventListener: noop, appendBuffer: noop }; };
        m.endOfStream = noop;
    };
    global.MediaSource.isTypeSupported = function () { return true; };
    global.URL = { createObjectURL: function () { return 'blob:x'; }, revokeObjectURL: noop };
    global.Audio = function () { var a = this; a.play = function () { return { catch: function (fn) { a._reject = fn; } }; }; a.pause = noop; };
    var $t = function (fn, ms) { var h = { fn: fn, ms: ms }; timers.push(h); return h; }; $t.cancel = noop;
    cl.set('$timeout', $t);
    ['logEvent', 'setState', 'attachOutputAnalyser', 'detachOutputAnalyser', '_markSpeaking', '_clearSpeaking'].forEach(function (n) { cl.set(n, noop); });
    cl.set('_edgeCircuitOpen', function () { return false; });
    cl.set('_edgeWssUrl', function (cb) { cb('wss://edge.test/tts', 'req1'); });
    cl.set('speakEdgeTTS', function (t) { buffered.push(t); });
    cl.set('speakEdgePipelined', function (t) { buffered.push(t); });
    cl.set('_edgeFallback', function (t, d, v, refused) { fallbacks.push(refused); });
    cl.set('_edgeLiveBroken', false); cl.set('_speakSessionId', 0); cl.set('currentAudio', null); cl.set('TTS', null); cl.set('_duckedForBarge', false);
    cl.set('_edgeLiveWs', null); cl.set('EDGE_AUDIO_FORMAT', 'audio-24khz-48kbitrate-mono-mp3'); cl.set('EDGE_GEC_VERSIONS', ['1-143']); cl.set('_edgeVerIdx', 0); cl.set('_edgeVerTried', 0);
    cl.c.edgeVoice = 'en-US-AvaMultilingualNeural'; cl.c.speechRate = 1.06;
    // 1. opened, then died: this reply goes out buffered, nothing is latched
    f.speakEdgeLive('Done. Incident ending 0 1 3 is resolved.', noop);
    var ws = sockets[0]; ws.onopen(); ws.onerror();
    T.eq(buffered.length, 1, 'said through the buffered neural voice');
    T.eq(cl.get('_edgeLiveBroken'), false, 'a blip does not switch the session off streaming');
    T.eq(fallbacks, [], 'and is no strike against the neural voice');
    // 2. refused before opening: a handshake refusal, the client version may rotate
    f.speakEdgeLive('Your oldest ticket is INC0010013.', noop);
    ws = sockets[1]; ws.onerror(); if (ws.onclose) ws.onclose();
    T.eq(fallbacks, [true]);
    // 3. a hung handshake: the watchdog is not a refusal
    f.speakEdgeLive('There are 2 approvals waiting on you.', noop);
    var wd = timers.filter(function (h) { return h.ms === 6000; }).pop(); wd.fn();
    T.eq(fallbacks, [true, false], 'a hang falls back without burning a client version');
    // 4. closed before any audio: said now, not after 6 seconds
    f.speakEdgeLive('The time is 9 12 A M.', noop);
    ws = sockets[3]; ws.onopen(); ws.onclose();
    T.eq(buffered.length, 2);
    T.eq(cl.get('_edgeLiveBroken'), false);
    // 5. the MediaSource itself fails: streamed playback is off for the session
    global.MediaSource._throw = true;
    f.speakEdgeLive('You have 16 open tickets.', noop);
    var m = msrcs[msrcs.length - 1]; m._l.sourceopen();
    T.eq(buffered.length, 3);
    T.eq(cl.get('_edgeLiveBroken'), true, 'a real playback fault switches to the buffered neural voice');
    delete global.MediaSource._throw;
    f.speakEdgeLive('Anything else?', noop);
    T.eq(buffered.length, 4, 'and stays there for the session');
    T.eq(sockets.length, 5, 'without opening another live socket');
});

T.test('a problem report or a ServiceNow question is never a web search; an explicit search still is', function () {
    var s = webWorld();
    g.P.PROPS['x_196061_netra_v1.brain_offline'] = 'true';
    ['google chrome is not working', 'check the internet connection', 'find the incident online for INC0010012', 'check the web portal ticket'].forEach(function (u) {
        var r = s.say(u);
        T.notMatch(r.message, /^From Bing|^According to Wikipedia|found nothing clear/, u + ' is not a search: ' + r.message.substring(0, 60));
    });
    T.match(s.say('check the internet for the latest nvidia news').message, /^From Bing/, 'an explicit search still searches');
    T.match(s.say('google it: who is the ceo of nvidia').message, /^From Bing, "Jensen Huang/);
    T.eq(s.gemini.generate.length, 0);
});

T.test('basic mode reads the company\'s own article before asking the web, and never posts its own things to a search engine', function () {
    var s = webWorld(), asked = [], base = g.P.HTTP;
    g.P.HTTP = function (req) { asked.push(req.endpoint); return base(req); };
    g.P.PROPS['x_196061_netra_v1.brain_offline'] = 'true';
    g.put('kb_knowledge', { number: 'KB0010050', short_description: 'How to connect to the VPN', text: 'Open the VPN client and sign in with your badge.', workflow_state: 'published', active: 'true', sys_updated_on: '2026-06-01 00:00:00' });
    var r = s.say('how do i connect to the vpn');
    T.match(r.message, /How to connect to the VPN/, 'the company article: ' + r.message.substring(0, 90));
    ['what is a p1', 'how do i reset the password', 'where is the printer on floor 3'].forEach(function (u) {
        T.notMatch(s.say(u).message, /^From Bing|^According to Wikipedia/, u + ' stays inside');
    });
    T.ok(!asked.some(function (u) { return /bing|duckduckgo|wikipedia/.test(u); }), 'nothing of ours went to a search engine');
    T.eq(s.gemini.generate.length, 0);
});

T.test('a hit sharing exactly a third of the question\'s words is still read out', function () {
    var s = webWorld();
    g.P.HTTP = function (req) {
        if (/bing\.com\/search/.test(req.endpoint)) return { status: 200, body: '<rss><channel><item><title>How to Fix a Leaky Faucet</title><link>https://diy.example/faucet</link><description>Turn off the water and replace the washer.</description></item></channel></rss>' };
        return { status: 404, body: '' };
    };
    T.match(s.say('search the web for how to fix a leaking tap').message, /^From Bing, "How to Fix a Leaky Faucet"/);
});

T.test('the platform\'s DST-aware clock is used whenever the page is in the profile\'s zone', function () {
    new S.Session();
    T.eq(fns({ action: 'chat', tz_name: 'UTC', tz_offset_min: 0 })._pageIsProfileZone(0), true, 'same zone by name');
    T.eq(fns({ action: 'chat', tz_offset_min: 0 })._pageIsProfileZone(0), true, 'same offset right now');
    T.eq(fns({ action: 'chat', tz_name: 'Asia/Kolkata', tz_offset_min: 330 })._pageIsProfileZone(330 * 60000), false, 'another zone: the page\'s own offset');
    T.eq(fns({ action: 'chat', tz_name: 'UTC', tz_offset_min: 0 })._clockAt(UTC_0030), '12:30 AM');
    T.eq(fns({ action: 'chat', tz_name: 'Asia/Kolkata', tz_offset_min: 330 })._clockAt(UTC_0030), '6:00 AM');
});

T.test('"Nada" and "Nadra" are names: they strip a leading name while awake but never wake her from sleep', function () {
    var cl = page(), f = cl.fn;
    T.eq(f.matchesWake('nada stop'), 'stop', 'awake: her name in that spelling');
    T.eq(f.matchesWake('Nada, can you send me the report', true), null, 'asleep: a colleague called Nada');
    T.eq(f.matchesWake('nada más, gracias', true), null);
    T.eq(f.matchesWake('netra, what time is it', true), 'what time is it', 'asleep: her real name still wakes her');
    // "wake up" is explicit whatever the recognizer made of her name in front of it
    ['wake up', 'netra wake up', 'nada wake up', 'row wake up', 'hey nadra, wake up'].forEach(function (u) { T.eq(f.matchExplicitWakeUp(u), true, u); });
    ['the server must wake up', 'wake up the scanner', 'nada, can you send me the report'].forEach(function (u) { T.eq(f.matchExplicitWakeUp(u), false, u); });
});

T.run(__filename);
