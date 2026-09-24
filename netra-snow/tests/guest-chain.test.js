/* The public page's Guest, and a model chain that always ends in time.
 *
 * Every visitor to the public page is the ONE Guest user, so nothing a Guest
 * says may be kept server-side for the next visitor, nothing may be spent on
 * a Guest's behalf that a sign-in should gate, and a general question that
 * happens to share a word with ServiceNow ("what problems does Kubernetes
 * solve") still gets an answer. The chain behind every answer ends inside the
 * page's patience, and a reply with nothing in it is not an answer. */
var T = require('./lib/t'), S = require('./lib/session'), N = require('./lib/netra'), g = S.g, gem = S.gem;
var CTX = 'x_196061_netra_v1_context', PREF = 'x_196061_netra_v1_user_pref', NOTIF = 'x_196061_netra_v1_notification';

function guest(s) { s.P.user = { sys_id: 'u_guest', name: 'Guest', user_name: 'guest' }; s.P.ROLES = {}; return s; }
function rows(table, pred) {
    var st = g.P.STORE[table] || {}, out = [];
    for (var k in st) if (st.hasOwnProperty(k) && (!pred || pred(st[k]))) out.push(st[k]);
    return out;
}
function httpLog(P) {
    var seen = [], inner = P.HTTP;
    P.HTTP = function (req) { seen.push(req.endpoint); return inner ? inner(req) : { status: 404, body: '' }; };
    return seen;
}
// the chain times itself with Date.now(): a clock the test moves
function withClock(fn) {
    var real = Date.now, t = { now: real.call(Date) };
    Date.now = function () { return t.now; };
    try { return fn(t); } finally { Date.now = real; }
}

T.test('a Guest leaves nothing behind for the next visitor: no memory row, no inbox, no preference row', function () {
    var s = guest(new S.Session());
    var sv = N.loadServer({ input: { action: 'chat' } });
    sv.fn._ctxWriteBlob({ draft: { tool: 'create_incident' }, mem: ['my manager is Sam'], vocab: { sam: 3 }, aliases: { 'netra': 'nitra' }, sentiment: null });
    T.eq(rows(CTX).length, 0, 'nothing written for the shared Guest user');
    var next = N.loadServer({ input: { action: 'chat' } }).fn._ctxReadBlobFresh();
    T.eq(next.mem, []); T.eq(next.draft, null); T.eq(next.aliases, {}, 'the next visitor starts clean');
    // a Guest row written before this fix is never read back to anyone
    g.put(CTX, { user: 'u_guest', last_utterance: 'CTX:' + JSON.stringify({ mem: ['the last visitor\'s secret'], draft: { tool: 'create_incident' } }) });
    var old = N.loadServer({ input: { action: 'chat' } }).fn._ctxReadBlobFresh();
    T.eq(old.mem, []); T.eq(old.draft, null, 'an old shared row is ignored');
    // the page load: no preference row, so the comment rule has no one to queue for
    N.loadServer({});
    T.eq(rows(PREF).length, 0, 'no notification preferences for Guest');
    // the poll: nothing read, nothing acknowledged
    var n = g.put(NOTIF, { user: 'u_guest', message: 'left over', acknowledged: 'false', kind: 'comment' });
    var d = N.request({ action: 'poll', ack_ids: [n] });
    T.eq(d.notifications, []);
    T.eq(g.P.STORE[NOTIF][n].acknowledged, 'false', 'a Guest acks nothing');
    void s;
});

T.test('a signed-in user still keeps memory across turns', function () {
    new S.Session();
    N.loadServer({ input: { action: 'chat' } }).fn._ctxWriteBlob({ draft: null, mem: ['my manager is Sam'], vocab: {}, aliases: {}, sentiment: null });
    T.eq(N.loadServer({ input: { action: 'chat' } }).fn._ctxReadBlobFresh().mem, ['my manager is Sam']);
});

T.test('what costs the key or changes shared state needs a sign-in: TTS, training, rewind', function () {
    var s = guest(new S.Session());
    var seen = httpLog(s.P);
    var d = N.request({ action: 'gemini_tts', text: 'read this aloud please', voice: 'Kore' });
    T.eq(d.guest_refused, 'gemini_tts'); T.eq(d.gemini_tts.ok, false);
    T.eq(seen.filter(function (u) { return /generativelanguage/.test(u); }), [], 'the key was not spent');
    ['save_training', 'clear_training', 'rewind_mem'].forEach(function (a) {
        T.eq(N.request({ action: a, phrase: 'x', aliases: {} }).guest_refused, a);
    });
});

T.test('the debug action is for admins and never shows any part of the key', function () {
    var s = new S.Session();
    s.P.ROLES = { itil: true };
    T.eq(N.request({ action: 'debug' }).debug, { error: 'admins only' });
    s.P.ROLES = null;   // admin
    var d = N.request({ action: 'debug' }).debug;
    T.eq(d.api_key_status, 'set');
    T.notMatch(JSON.stringify(d), /test-key|prefix|length=/);
});

T.test('a Guest: record asks get the sign-in line; general questions that share a word get the model', function () {
    var s = guest(new S.Session());
    ['my tickets', 'what is the status of INC0010013', 'create a ticket for my laptop', 'list my open incidents',
     'brief me', 'remind me to call Sam at 3', 'resolve the incident', 'close it', 'our approvals'].forEach(function (u) {
        T.match(s.say(u).message, /guest, so I can not see or change ServiceNow records/, u);
    });
    T.eq(s.gemini.generate.length, 0);
    ['what problems does kubernetes solve', 'what is an SLA', 'remind me what photosynthesis is', 'how do I raise my credit score',
     'explain change management in ITIL'].forEach(function (u) {
        var log = gem.install(s.P, [gem.text('Here is the short answer.')]);
        var r = s.say(u);
        T.eq(log.generate.length, 1, u + ' reaches the model');
        T.match(r.message, /short answer/, u);
    });
});

T.test('a Guest gets no fast-lane work intents; reindexing needs the itil role', function () {
    var s = guest(new S.Session());
    var log = gem.install(s.P, [gem.text('I can not do that as a guest.')]);
    var r = s.say('reindex');
    T.eq(log.generate.length, 1, 'not the reindex intent');
    T.notMatch(r.message, /reindex(ed|ing) \d/i);
    var u = new S.Session();
    u.P.ROLES = {};
    T.match(u.say('reindex').message, /itil role/);
});

T.test('the chain ends inside the page\'s patience: each call gets only the time that is left', function () {
    var s = new S.Session();
    var timeouts = [];
    withClock(function (clock) {
        var q = [];
        for (var i = 0; i < 12; i++) q.push(gem.http(503, { error: { code: 503, message: 'high demand' } }));
        gem.install(s.P, q);
        var inner = s.P.HTTP;
        s.P.HTTP = function (req) { timeouts.push(req.timeout); clock.now += 5000; return inner(req); };
        var r = s.say('tell me a joke about printers');
        T.eq(r.brain_down, true);
    });
    T.ok(timeouts.length >= 2 && timeouts.length <= 3, 'attempts inside 14 s at 5 s each: ' + timeouts.length);
    T.eq(timeouts[0], 12000);
    for (var k = 1; k < timeouts.length; k++) T.ok(timeouts[k] < timeouts[k - 1], 'less time for each later attempt: ' + timeouts.join(','));
});

T.test('a turn of many rounds speaks what it found once 16 s have gone, instead of reasoning on', function () {
    var s = new S.Session();
    var r = withClock(function (clock) {
        var q = [gem.call('lookup_user', { query: 'Beth' }), gem.call('lookup_user', { query: 'Bert' }), gem.text('never reached')];
        gem.install(s.P, q);
        var inner = s.P.HTTP;
        s.P.HTTP = function (req) { if (/generativelanguage/.test(req.endpoint)) clock.now += 9000; return inner(req); };
        return s.say('who are Beth and Bert and which of them is on the network team');
    });
    T.match(r.message, /taking too long to put together, so here is what I found so far/);
    T.match(r.message, /Beth Anglin/);
    T.notMatch(r.message, /never reached/);
    T.eq(r.route_reason, 'partial');
});

T.test('a reply with nothing in it is not an answer: the next model is asked, and the empty one is not called healthy', function () {
    var s = new S.Session();
    var log = gem.install(s.P, [
        { candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'MALFORMED_FUNCTION_CALL' }] },
        gem.text('Why did the printer cross the road? To jam on the other side.')
    ]);
    var r = s.say('tell me a joke about printers');
    T.eq(log.models.slice(0, 2), ['gemma-4-26b-a4b-it', 'gemini-2.5-flash-lite']);
    T.match(r.message, /printer cross the road/);
    // only thought parts: also empty
    var s2 = new S.Session();
    var log2 = gem.install(s2.P, [
        { candidates: [{ content: { role: 'model', parts: [{ text: 'thinking about it', thought: true }] }, finishReason: 'STOP' }] },
        gem.text('Here you go.')
    ]);
    T.match(s2.say('tell me something fun').message, /Here you go/);
    T.eq(log2.models.length, 2);
});

T.test('an unreadable 200 is a bad reply (a short rest), a refused key is an auth failure, not a bad request', function () {
    var s = new S.Session();
    var log = gem.install(s.P, [{ status: 200, body: '<html>upstream error</html>' }, gem.text('Fine now.')]);
    T.match(s.say('say something nice').message, /Fine now/);
    T.eq(log.models.length, 2);
    var brain = new NetraBrain();
    var info = brain.restingInfo('gemma-4-26b-a4b-it', g.P.now);
    T.eq(info.resting, true); T.eq(info.reason, 'overloaded');
    T.ok(info.until_ms - g.P.now <= 30000, 'a short rest, not a timeout bench');
    var s2 = new S.Session();
    gem.install(s2.P, [gem.http(400, { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } }), gem.text('x')]);
    s2.say('say something nice');
    var b2 = new NetraBrain();
    T.eq(b2.restingInfo('gemma-4-26b-a4b-it', g.P.now).reason, 'auth');
});

T.test('a search call with no query searches what the user asked', function () {
    var s = new S.Session();
    s.P.HTTP_WEB = true;
    var log = gem.install(s.P, [gem.call('search_web', {}), gem.text('done')]);
    var web = s.P.HTTP, asked = [];
    s.P.HTTP = function (req) {
        if (/bing\.com\/search/.test(req.endpoint)) { asked.push(decodeURIComponent(req.endpoint)); return { status: 200, body: '<rss><channel><item><title>Mount Everest - Wikipedia</title><link>https://en.wikipedia.org/wiki/Mount_Everest</link><description>Mount Everest is 8,849 metres tall.</description></item></channel></rss>' }; }
        if (/wikipedia\.org/.test(req.endpoint)) return { status: 404, body: '' };
        return web(req);
    };
    var r = s.say('how tall is mount everest');
    T.ok(asked.length >= 1 && /everest/i.test(asked[0]), 'searched: ' + asked[0]);
    T.match(r.message, /8,849/);
    void log;
});

T.test('a tool that composed its own answer is read as it is', function () {
    new S.Session();
    var f = N.loadServer({ input: { action: 'chat' } }).fn;
    T.eq(f._sayToolResult('search_web', { ok: true, final_speech: 'Wikipedia says it is 8,849 metres.' }, {}), 'Wikipedia says it is 8,849 metres.');
    T.eq(f._sayToolResult('tell_joke', { ok: true, joke: 'A joke.' }, {}), 'A joke.');
    // a draft's own read-back is still marked heard, or the "yes" that follows finds nothing
    var sv = N.loadServer({ input: { action: 'chat' } });
    var said = sv.fn._sayToolResult('investigation_followup', { ok: true, final_speech: 'I will add the write-up as a work note on incident ending 0 1 0. Shall I?' }, { action: 'write_up' });
    T.match(said, /Shall I\?$/);
    T.eq(sv.get('_brainTurn').draftHeard, true, 'the parked write-up survives to the yes');
});

function allOutForTheDay() {
    N.loadScriptIncludes();
    var brain = new NetraBrain();
    N.loadServer({ input: { action: 'chat' } }).fn._modelChain(null).forEach(function (m) {
        brain.recordFail(m, 429, JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }] } }), g.P.now);
    });
    brain.flush();
}
function webWorks(P, text) {
    var inner = P.HTTP, asked = [];
    P.HTTP = function (req) {
        if (/wikipedia\.org\/api\/rest_v1\/page\/summary|wikipedia\.org\/w\/api\.php/.test(req.endpoint)) {
            asked.push(req.endpoint);
            return { status: 200, body: JSON.stringify({ type: 'standard', title: 'Wikipedia', extract: text || 'Wikipedia is a free online encyclopedia.', content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Wikipedia' } }, query: { search: [{ title: 'Wikipedia' }] } }) };
        }
        if (/bing\.com\/search/.test(req.endpoint)) { asked.push(req.endpoint); return { status: 200, body: '<rss><channel><item><title>Kubernetes - Wikipedia</title><link>https://en.wikipedia.org/wiki/Kubernetes</link><description>' + (text || 'Kubernetes automates deploying and scaling containers.') + '</description></item></channel></rss>' }; }
        return inner ? inner(req) : { status: 404, body: '' };
    };
    return asked;
}

T.test('every model out for the day: the page opens for web answers, in the listener\'s clock, with no model call', function () {
    var s = new S.Session();
    allOutForTheDay();
    var log = gem.install(s.P, []);
    webWorks(s.P);
    var d = N.request({ action: 'ready_check', tz_offset_min: 330, tz_name: 'Asia/Kolkata' }).ready;
    T.eq(log.generate.length, 0, 'every model resting: no call');
    T.eq(d.ready, true); T.eq(d.mode, 'web');
    // P.now is 20:00 UTC; Pacific midnight is 07:00 UTC = 12:30 PM in India
    T.eq(d.say, "answers from the web only - my reasoning models are out of today's free quota until about 12:30 PM");
    T.notMatch(d.say, /\d{3,} minutes/);
});

T.test('every model out and the web down too: the loading screen stays, and says both', function () {
    var s = new S.Session();
    allOutForTheDay();
    gem.install(s.P, []);
    var d = N.request({ action: 'ready_check', tz_offset_min: 330, tz_name: 'Asia/Kolkata' }).ready;
    T.eq(d.ready, false); T.eq(d.reason, 'search_down');
    T.match(d.say, /out of today's free quota until about 12:30 PM, and the web search is not answering either/);
});

T.test('a Guest during an all-day outage: a general question is answered from the web, nothing else is attempted', function () {
    var s = guest(new S.Session());
    allOutForTheDay();
    var log = gem.install(s.P, []);
    webWorks(s.P, 'Kubernetes automates deploying, scaling and managing containers.');
    var r = s.say('what problems does kubernetes solve');
    T.eq(log.generate.length, 0);
    T.eq(r.brain_down, undefined, 'answered, not held for hours');
    T.match(r.message, /Kubernetes automates deploying/);
    T.notMatch(r.message, /basic mode|raise a ticket|approvals/, 'a Guest is not offered record work');
});

T.test('a short overload still holds the question for the loading screen; a waiting page pings one model, not three', function () {
    var s = new S.Session();
    var q = [];
    for (var i = 0; i < 12; i++) q.push(gem.http(503, { error: { code: 503, message: 'high demand' } }));
    var log = gem.install(s.P, q);
    var r = s.say('tell me a joke about printers');
    T.eq(r.brain_down, true, 'models back within seconds: hold, do not fall back');
    // one model resting, the rest untried: a waiting page pings one, not three
    var s2 = new S.Session();
    N.loadScriptIncludes();
    var brain = new NetraBrain();
    brain.recordFail('gemma-4-26b-a4b-it', 503, '{"error":{"code":503}}', g.P.now);
    brain.flush();
    var q2 = [];
    for (var k = 0; k < 6; k++) q2.push(gem.http(503, { error: { code: 503, message: 'high demand' } }));
    var log2 = gem.install(s2.P, q2);
    var d = N.request({ action: 'ready_check' }).ready;
    T.eq(d.ready, false);
    T.eq(log2.generate.length, 1, 'one ping while a model rests');
});

T.test('a model whose last word was a failure is probed again, not trusted from an older success', function () {
    new S.Session();
    N.loadScriptIncludes();
    var brain = new NetraBrain();
    var m = 'gemma-4-26b-a4b-it';
    brain.recordOk(m, 1500, g.P.now);
    brain.recordFail(m, 503, '{"error":{"code":503}}', g.P.now + 1000);
    g.P.now += 40000;   // the 30 s overloaded rest is over, the success 41 s old
    T.eq(brain.freshOk([m], g.P.now, 60000), '', 'a failure after the success: ask again');
    brain.recordOk(m, 1500, g.P.now);
    T.eq(brain.freshOk([m], g.P.now, 60000), m);
});

T.run(__filename);
