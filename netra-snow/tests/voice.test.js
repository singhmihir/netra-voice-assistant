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
        if (/bing\.com\/search/.test(u)) return { status: 200, body: '<rss><channel><item><title>Jensen Huang - Wikipedia</title><link>https://en.wikipedia.org/wiki/Jensen_Huang</link><description>Jensen Huang is the president, co-founder and &lt;b&gt;CEO of Nvidia&lt;/b&gt;.</description></item><item><title>Nvidia leadership</title><link>https://nvidia.com/leadership</link><description>Our leadership team.</description></item></channel></rss>' };
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
    T.ok(r2.source !== 'Wikipedia', 'a Wikipedia hit sharing no words with the question is not the answer');
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
});

T.run(__filename);
