/* The lean brain, the readiness probe and the Guest.
 *
 * On a free key the Gemini models run out (20 calls a day each), answer 503
 * "high demand" or time out; Netra's full request (~20k tokens) also shut out
 * Gemma 4, whose free tier allows 16k input tokens a minute. These tests hold
 * the fix: a lean request for a Guest and for Gemma, thought parts never
 * spoken, one call for a web question, a "brain busy" signal instead of a
 * basic-mode stand-in, the page's readiness probe, and a Guest told the truth. */
var T = require('./lib/t'), S = require('./lib/session'), N = require('./lib/netra'), g = S.g, gem = S.gem;

function fns(input) { return N.loadServer({ input: input || { action: 'chat' } }).fn; }
function guest(s) { s.P.user = { sys_id: 'u_guest', name: 'Guest', user_name: 'guest' }; s.P.ROLES = {}; return s; }
function names(body) { return ((body.tools && body.tools[0] && body.tools[0].functionDeclarations) || []).map(function (d) { return d.name; }).sort(); }
function sysText(body) { return (body.systemInstruction && body.systemInstruction.parts && body.systemInstruction.parts[0].text) || ''; }

T.test('Gemma comes first in the chain, and the chain is wide', function () {
    new S.Session();
    var chain = fns()._modelChain(null);
    T.eq(chain[0], 'gemma-4-26b-a4b-it');
    T.ok(chain.length >= 8, 'every free model has its own allowance: ' + chain.join(','));
    T.ok(chain.indexOf('gemma-4-31b-it') < 0, 'the 31B model answers in ~30 s: not for a voice');
});

T.test('a Guest is told the truth about tickets, at no model cost', function () {
    var s = guest(new S.Session());
    ['my tickets', 'what is the status of INC0010013', 'list my approvals', 'create a ticket my laptop is slow', 'give me my daily briefing'].forEach(function (u) {
        var r = s.say(u);
        T.match(r.message, /guest, so I can not see or change ServiceNow records/, u);
    });
    T.eq(s.gemini.generate.length, 0);
    T.eq(N.request({ action: 'chat', message: 'hello' }).is_guest, true, 'the page learns it is a guest');
});

T.test('a Guest general question: the lean request, three tools, one call, the source named', function () {
    var s = guest(new S.Session());
    s.P.HTTP_WEB = true;
    var log = gem.install(s.P, [gem.call('search_web', { query: 'who founded ServiceNow' })]);
    var web = s.P.HTTP;
    s.P.HTTP = function (req) {
        if (/bing\.com\/search/.test(req.endpoint)) return { status: 200, body: '<rss><channel><item><title>ServiceNow - Wikipedia</title><link>https://en.wikipedia.org/wiki/ServiceNow</link><description>ServiceNow was founded by Fred Luddy in 2003.</description></item></channel></rss>' };
        if (/wikipedia\.org/.test(req.endpoint)) return { status: 404, body: '' };
        return web(req);
    };
    var r = s.say('who founded servicenow please');
    T.eq(log.generate.length, 1, 'the search result is spoken as it is: one model call, not two');
    T.eq(log.models[0], 'gemma-4-26b-a4b-it');
    T.eq(names(log.generate[0]), ['list_capabilities', 'search_web', 'tell_joke']);
    T.match(sysText(log.generate[0]), /GUEST on a public page/);
    T.ok(JSON.stringify(log.generate[0]).length < 12000, 'a small request: ' + JSON.stringify(log.generate[0]).length + ' bytes');
    T.match(r.message, /Fred Luddy/);
    T.eq(log.generate[0].generationConfig.thinkingConfig, { thinkingLevel: 'minimal' }, "Gemma's own thinking knob");
});

T.test('a signed-in user: Gemma gets the lean request with the routed tools; a Gemini fallback gets the full one', function () {
    var s = new S.Session();
    var log = gem.install(s.P, [gem.http(503, { error: { code: 503, message: 'high demand' } }), gem.text('Nothing is open on the VPN side.')]);
    s.say('any vulnerabilities on the vpn gateway assets');
    T.eq(log.models, ['gemma-4-26b-a4b-it', 'gemini-2.5-flash-lite'], 'Gemma first, then the next model');
    var lean = names(log.generate[0]), full = names(log.generate[1]);
    T.ok(lean.indexOf('get_ticket_status') >= 0 && lean.indexOf('search_web') >= 0, 'the core set');
    T.ok(lean.indexOf('list_vulnerable_items') >= 0, 'the group the words point at');
    T.ok(lean.indexOf('create_standing_order') < 0 && lean.indexOf('narrate_script') < 0, 'not the rest');
    T.ok(full.length > lean.length * 2, 'the Gemini model gets the full toolset (' + full.length + ' vs ' + lean.length + ')');
    T.ok(sysText(log.generate[0]).length < 4000 && sysText(log.generate[1]).length > 20000, 'the short prompt and the full one');
});

T.test('a request too big for Gemma\'s per-minute allowance skips it for free', function () {
    var s = new S.Session();
    var big = [];
    for (var i = 0; i < 40; i++) {
        big.push({ role: 'user', parts: [{ text: 'tell me about ticket ' + i + ' ' + new Array(400).join('word ') }] });
        big.push({ role: 'model', parts: [{ text: 'It is fine ' + new Array(300).join('word ') }] });
    }
    s.history = big;
    s.P.PROPS['x_196061_netra_v1.lean_prompt'] = 'never';
    var log = gem.install(s.P, [gem.text('Hello.')]);
    s.say('hello there, how are things');
    T.ok(log.models.length >= 1);
    T.ok(log.models[0] !== 'gemma-4-26b-a4b-it' || JSON.stringify(log.generate[0]).length / 3.6 <= 12000,
         'Gemma is only sent what fits its allowance (sent ' + log.models.join(',') + ')');
});

T.test('thought parts are never spoken and never echoed back', function () {
    var s = new S.Session();
    var log = gem.install(s.P, [
        { candidates: [{ content: { role: 'model', parts: [{ text: 'The user wants the status. I should call the tool.', thought: true }, { functionCall: { name: 'get_ticket_status', args: { ticket_number: 'INC0010013' } } }] }, finishReason: 'STOP' }] },
        { candidates: [{ content: { role: 'model', parts: [{ text: 'Now summarise.', thought: true }, { text: 'It is new and unassigned.' }] }, finishReason: 'STOP' }] }
    ]);
    g.put('incident', { number: 'INC0010013', short_description: 'Printer jam', state: '1', priority: '4', active: 'true' });
    var r = s.say('what is the status of INC0010013 and should I worry');
    T.notMatch(r.message, /The user wants|I should call|Now summarise/, 'no private reasoning in the reply');
    var echoed = JSON.stringify(log.generate.slice(1));
    T.notMatch(echoed, /The user wants the status/, 'no thought part sent back to the model');
});

T.test('the brain down: a busy signal the page acts on, never a basic-mode stand-in', function () {
    var s = new S.Session();
    var q = [];
    for (var i = 0; i < 12; i++) q.push(gem.http(503, { error: { code: 503, message: 'high demand' } }));
    gem.install(s.P, q);
    var r = s.say('tell me a joke about printers');
    T.eq(r.ok, false); T.eq(r.brain_down, true);
    T.notMatch(r.message, /basic mode|can not work that one out/);
    T.match(r.message, /busy right now. I will answer that as soon as it is back/);
});

T.test('the readiness probe: no call when a model answered a minute ago, a tiny ping otherwise, honest when all rest', function () {
    var s = new S.Session();
    var log = gem.install(s.P, [gem.text('OK')]);
    var d = N.request({ action: 'ready_check' });
    T.eq(d.ready.ready, true); T.eq(d.ready.model, 'gemma-4-26b-a4b-it');
    T.eq(log.generate.length, 1);
    T.eq(log.generate[0].tools, undefined, 'the ping carries no tools');
    T.eq(log.generate[0].toolConfig, undefined);
    T.ok(JSON.stringify(log.generate[0]).length < 1500, 'the ping is tiny');
    d = N.request({ action: 'ready_check' });
    T.eq(d.ready.ready, true); T.eq(d.ready.cached, true);
    T.eq(log.generate.length, 1, 'answered a minute ago: no call at all');
    // every model resting for the day
    var s2 = new S.Session();
    var q = [];
    for (var i = 0; i < 12; i++) q.push(gem.quota429('day'));
    gem.install(s2.P, q);
    N.request({ action: 'ready_check' });
    var d2 = N.request({ action: 'ready_check' });
    T.eq(d2.ready.ready, false);
    T.match(d2.ready.say || '', /busy|out of quota|overloaded/);
    T.ok(d2.ready.wait_ms >= 5000);
});
T.run(__filename);
