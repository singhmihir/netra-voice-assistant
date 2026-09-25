/* What happens to the words once heard, and the recognizer's language.
 *
 * The user speaks, and a recognizer that hears "tickers" for "tickets" or
 * "resolved" for "resolve" used to send a guess on to the model. The page and
 * the server now forgive the common mis-hearings of Netra's own command
 * words - in speech only, never in typed text - the model is told the words
 * were heard, a final the recognizer was unsure of is read back for a yes,
 * and the browser recognizer starts in the browser's own English. */
'use strict';
var T = require('./lib/t'), N = require('./lib/netra'), S = require('./lib/session'), gem = S.gem;
var fs = require('fs'), path = require('path');

var CLIENT = fs.readFileSync(path.join(N.SRC, 'widget', 'client.js'), 'utf8');
var SERVER = fs.readFileSync(path.join(N.SRC, 'widget', 'server.js'), 'utf8');
var LANGS = ['en-IN', 'en-US', 'en-GB', 'en-AU', 'hi-IN', 'es-ES', 'fr-FR', 'de-DE', 'ja-JP'];

var store = {};
global.localStorage = {
    getItem: function (k) { return store.hasOwnProperty(k) ? store[k] : null; },
    setItem: function (k, v) { store[k] = String(v); },
    removeItem: function (k) { delete store[k]; }
};

// the page's controller as it stands after boot, with what it would say and
// send recorded instead of played or posted
function page() {
    var cl = N.loadClient(), c = cl.c, set = cl.set, rec = { spoken: [], sent: [] };
    function noop() {}
    var now = function (fn) { if (typeof fn === 'function') fn(); return 0; };
    now.cancel = noop;
    set('$timeout', now);
    set('speak', function (text, done) { rec.spoken.push(String(text)); if (done) done(); });
    set('handleHeard', function (text) { rec.sent.push(String(text)); });
    set('setState', function (st) { c.state = st; });
    ['logEvent', 'cue', 'tone', 'openConversation', 'closeConversation', '_convoPush', 'saveTrainingData', 'attachGrammar',
     'learnFromTranscript', '_pushConfidence', 'stopFillerChain', '_cancelPlanContinue', '_labNlpCapture']
        .forEach(function (n) { set(n, noop); });
    set('WAKE_WORDS', ['netra']); set('SALUTATION_PREFIXES', ['hey', 'ok', 'okay']);
    set('MIN_LENGTH', 3); set('MIN_CONFIDENCE', 0.35); set('ALWAYS_LISTEN', true);
    set('_calibActive', false); set('_speakingNow', false); set('_heardCheck', null);
    c.events = []; c.stats = {}; c.aliases = {}; c.personalVocab = {}; c.data = {}; c.micHealth = {}; c.heard = [];
    c.alert = true; c.conversationOpen = true; c.state = 'idle'; c.lastHeard = ''; c.lastAnswer = ''; c._awaitingConfirm = false;
    return { c: c, f: cl.fn, get: cl.get, set: set, rec: rec,
             hear: function (u, conf) { cl.fn.processFinalTranscript(u, conf === undefined ? 0.9 : conf); return rec; } };
}

// the mic graph as ear.test.js has it, plus a browser recognizer whose
// results a test hands in
function mic() {
    var cl = N.loadClient(), c = cl.c, queued = [];
    c.events = []; c.heard = []; c.micHealth = {}; c.stats = {}; c.convo = []; c.alert = true; c.hasSR = true; c.permission = 'granted'; c.recLang = 'en-IN';
    ['logEvent', 'cue', '_convoPush', 'attachGrammar', '_nativeSaw', '_readyUpdate'].forEach(function (n) { cl.set(n, function () {}); });
    cl.set('$scope', { $applyAsync: function () {} });
    cl.set('_speakingNow', false); cl.set('_speakingSince', 0); cl.set('_calibActive', false); cl.set('_fillerChainActive', false);
    cl.set('_lastInterimAt', 0); cl.set('_lastFinalAt', 0); cl.set('ignoreFinalsUntil', 0); cl.set('recLastActivityAt', 0); cl.set('_lastYieldAt', 0);
    cl.set('_deafStrikes', 0); cl.set('_netErrStreak', 0); cl.set('_notAllowedStrikes', 0); cl.set('_nativeHeardWords', true); cl.set('_nativeVerdict', 'ok');
    cl.set('_earWorker', null); cl.set('_earBusy', false); cl.set('_earQueue', []); cl.set('_earJobMeta', {}); cl.set('_earNativeSeen', 0);
    cl.set('_speakingText', ''); cl.set('_fillerEchoText', ''); cl.set('currentFillerAudio', null); cl.set('currentFillerUtter', null);
    cl.set('_enqueueFinalTranscript', function (t, conf) { queued.push([t, conf]); });
    cl.set('applyAliases', function (t) { return t; });
    cl.set('pickBestAlternative', function () { return null; });
    cl.set('SR', function () { var r = this; r.start = function () {}; r.stop = function () {}; r.abort = function () {}; });
    cl.set('$timeout', Object.assign(function () { return {}; }, { cancel: function () {} }));
    cl.set('_edgeBrowser', false); cl.set('recRunningDebounceTimer', null); cl.set('recRestartCount', 0); cl.set('RESTART_DELAY', 250);
    cl.queued = queued;
    return cl;
}
function finalEvent(text, conf) {
    var r = [{ transcript: text, confidence: conf }]; r.isFinal = true;
    return { resultIndex: 0, results: [r] };
}
function body(src) {
    var at = src.indexOf('    function _forgiveTable() {');
    T.ok(at > 0, 'the table is there');
    return src.slice(at, src.indexOf('\n    }\n', at));
}

/* ---- N1: the recognizer's language ---- */

T.test('everyone starts in Indian English; a stored choice still wins', function () {
    T.match(CLIENT, /c\.recLang = 'en-IN';/);
    T.match(CLIENT, /localStorage\.getItem\('netra_lang_v2'\) \|\| c\.recLang;/);
    T.notMatch(CLIENT, /_defaultRecLang/);
    T.match(CLIENT, /c\.micGain = 1\.5;/, 'the default mic sensitivity');
});

/* ---- N2: forgiving mis-heard command words ---- */

T.test('the page forgives the common mis-hearings of its command words, on word boundaries', function () {
    var f = N.loadClient().fn;
    [['list my tickers', 'list my tickets'], ["what are my ticket's", 'what are my tickets'], ['my tick its', 'my tickets'], ['my tikets', 'my tickets'],
     ['status of insident 13', 'status of incident 13'], ['instant ten', 'incident ten'], ['status of instant thirteen', 'status of incident thirteen'],
     ['incidence 13', 'incident 13'], ['what are my approval', 'what are my approvals'], ['a provals', 'approvals'], ['my approvers', 'my approvals'],
     ['resolved incident 13', 'resolve incident 13'], ['Netra, resolved it', 'Netra, resolve it'], ['results it', 'resolve it'],
     ['a sign it to beth', 'assign it to beth'], ['design this', 'assign this'], ['design 13', 'assign 13'], ['a sign to beth', 'assign to beth'],
     ['notch the assignee', 'nudge the assignee'], ['judge the assignee', 'nudge the assignee'],
     ['what did you do while I was awake', 'what did you do while I was away'],
     ['then meet a joke', 'tell me a joke'], ['tell me joke', 'tell me a joke'], ['tell me a choke', 'tell me a joke'],
     ['what can u do', 'what can you do'], ['what can you do for me', 'what can you do'],
     ['search service now docs', 'search ServiceNow docs'], ['the latest service now release', 'the latest ServiceNow release'], ['open service now', 'open service now'],
     ['ap1', 'P1'], ['a p 1', 'P1'], ['p one', 'P1'], ['make it a p two', 'make it P2'], ['p three', 'P3'], ['p 4', 'P4'],
     ['in c 10013', 'INC 10013'], ['ink 10013', 'INC 10013'], ['in c one zero zero one three', 'INC one zero zero one three'],
     ['add a work not', 'add a work note'], ['worknote', 'work note'], ['worknotes', 'work notes'],
     // the fast lane's other words
     ['status off inc 13', 'status of inc 13'], ['de brief me', 'debrief me'], ['read arrest', 'read the rest'], ['undue that', 'undo that'],
     ['and do that', 'undo that'], ['lift my tickets', 'list my tickets'], ['pardon me', 'pardon'], ['commission status', 'mission status'],
     ['wash it and nudge the assignee', 'watch it and nudge the assignee'], ['clothes it', 'close it'], ['escalade it', 'escalate it'],
     ['a signee', 'assignee'], ['try age the queue', 'triage the queue'], ['re index my tickets', 'reindex my tickets'],
     ['Then Meet A Joke.', 'tell me a joke.']]
        .forEach(function (x) { T.eq(f._forgive(x[0]), x[1], JSON.stringify(x[0])); });
    // whole words and the right neighbours only
    [['an instant reply', 'an instant reply'], ['search results', 'search results'], ['it is resolved now', 'it is resolved now'],
     ['the design of the page', 'the design of the page'], ['who assigned it', 'who assigned it'], ['assigned to me', 'assigned to me'],
     ['step one', 'step one'], ['app one', 'app one'], ['the ink is dry', 'the ink is dry'], ['the approval request for chg', 'the approval request for chg'],
     ['tell me a joke', 'tell me a joke'], ['INC0010013', 'INC0010013'], ['', ''], [null, ''],
     // ordinary English that shares a word with a command (found in review): never rewritten
     ['there is a design problem with the portal', 'there is a design problem with the portal'], ['design change request for the login page', 'design change request for the login page'],
     ['design the new form', 'design the new form'], ['close it, the email service now works again', 'close it, the email service now works again'],
     ['restart the service now', 'restart the service now'], ['reboot the servers now', 'reboot the servers now'],
     ['resolved incidents this week', 'resolved incidents this week'], ['resolved tickets from yesterday', 'resolved tickets from yesterday'], ['resolved by whom', 'resolved by whom'],
     ['remind me to wash the car at six', 'remind me to wash the car at six'], ['remind me to wash the dishes', 'remind me to wash the dishes'],
     ['read results 2 to 5', 'read results 2 to 5'], ['search results 3', 'search results 3'],
     ['what is the ticker for apple', 'what is the ticker for apple'], ['stock ticker of tesla', 'stock ticker of tesla'],
     ['the incidence rate of malaria', 'the incidence rate of malaria'], ['the printer is out of ink 3 times a week', 'the printer is out of ink 3 times a week'],
     ['list approvers for chg 12', 'list approvers for chg 12'], ['show approvers of change 12', 'show approvers of change 12'], ['I nudged them already', 'I nudged them already'],
     ['switch the status off', 'switch the status off'], ['undue delay in approval', 'undue delay in approval'],
     ['the omission of the step', 'the omission of the step'], ['emission report', 'emission report'], ['in c 13 times', 'in c 13 times']]
        .forEach(function (x) { T.eq(f._forgive(x[0]), x[1], JSON.stringify(x[0])); });
});

T.test('the server carries the same table, byte for byte', function () {
    T.eq(body(SERVER), body(CLIENT));
    var fn = N.loadServer({ input: { action: 'chat' } }).fn;
    T.eq(fn._forgiveSpoken('list my tickers and what are my approval'), 'list my tickets and what are my approvals');
});

T.test('a browser final and what the ear hears are forgiven on their way in; typed text never is', function () {
    // the browser recognizer
    var cl = mic(), f = cl.fn;
    f.startContinuous();
    var rec = cl.get('contRec');
    rec.onresult(finalEvent('list my tickers', 0.8));
    rec.onresult(finalEvent('then meet a joke', 0.7));
    T.eq(cl.queued, [['list my tickets', 0.8], ['tell me a joke', 0.7]]);
    // the on-device ear
    var cl2 = mic(), f2 = cl2.fn;
    cl2.c.ear.on = true; cl2.c.ear.status = 'on'; cl2.set('_earBusy', true);
    f2._earOnMessage({ data: { text: ' Resolved incident thirteen. ', ms: 1500 } });
    T.eq(cl2.queued, [['resolve incident thirteen.', 0.85]]);
    // the typing box: the words go as they were written, marked typed
    var p = page(), ran = [];
    p.set('processCommand', function (t, conf) { ran.push([t, conf]); });
    p.set('_typedRefused', function () { return false; });
    T.eq(p.f._sendTyped('list my tickers', 'type'), true);
    T.eq(ran, [['list my tickers', 1.0]]);
    T.eq(p.c._typedTurn, true);
    // and a spoken final after it is speech again
    p.hear('list my tickets');
    T.eq(p.c._typedTurn, false);
    T.match(CLIENT, /c\.data\.typed = !!c\._typedTurn;/, 'the server is told which turns were typed');
});

T.test('"list my tickers" and "what are my approval" take the fast lane, at no model cost, and the model keeps the raw words', function () {
    var s = new S.Session();
    s.model(gem.text('(model answered)'));
    var r = s.say('list my tickers');
    T.eq(s.gemini.generate.length, 0, 'no model call');
    T.match(r.message, /VPN drops every few minutes/, 'the ticket list');
    var mine = s.history.filter(function (h) { return h.role === 'user'; }).pop();
    T.match(JSON.stringify(mine), /list my tickers/, 'the words as heard stay in the history');
    r = s.say('what are my approval');
    T.eq(s.gemini.generate.length, 0);
    T.match(r.message, /approval/i);
    T.notMatch(r.message, /model answered/);
    r = s.say('what did you do while i was awake');
    T.eq(s.gemini.generate.length, 0, 'the debrief, free');
    // typed: nothing is rewritten, so the model gets the typo as written
    var t = new S.Session();
    t.model(gem.text('(model answered)'));
    r = t.say('list my tickers', { typed: true });
    T.eq(t.gemini.generate.length, 1, 'typed words are not forgiven: the model reads them');
    T.match(JSON.stringify(t.gemini.generate[0].contents), /list my tickers/);
});

/* ---- N3: the prompt hint ---- */

T.test('both prompts tell the model the words were heard, not typed - for a Guest and a reviewer too; a typed turn drops the line', function () {
    var f = N.loadServer({ input: { action: 'chat' } }).fn, line = /HEARD, NOT TYPED: the user's words come from speech recognition[^\n]*ticker = ticket, insident = incident, "ten thirteen" = 0013[^\n]*ask one short question rather than guessing a record\./;
    T.match(f._leanPrompt(true, false), line, 'lean');
    T.match(f._leanPrompt(true, true), line, 'lean, Guest');
    T.match(f._systemPrompt(true).parts[0].text, line, 'full');
    T.match(f._systemPrompt(false).parts[0].text, line, 'full, not live');
    // the reviewer's variants keep it beside the read-only rule
    var s = new S.Session();
    s.P.user = { sys_id: 'u_rev', name: 'Netra Reviewer', user_name: 'netra.reviewer' };
    s.P.ROLES = { itil: true, snc_read_only: true };
    S.g.put('sys_user_role', { sys_id: 'r_ro', name: 'snc_read_only' });
    S.g.put('sys_user_has_role', { sys_id: 'uhr1', user: 'u_rev', role: 'r_ro' });
    var rf = N.loadServer({ input: { action: 'chat' } }).fn;
    T.match(rf._leanPrompt(true, false), /READ-ONLY/); T.match(rf._leanPrompt(true, false), line, 'reviewer, lean');
    T.match(rf._systemPrompt(true).parts[0].text, /READ-ONLY REVIEWER ACCOUNT/); T.match(rf._systemPrompt(true).parts[0].text, line, 'reviewer, full');
    var tf = N.loadServer({ input: { action: 'chat', typed: true } }).fn;
    T.notMatch(tf._leanPrompt(true, false), /HEARD, NOT TYPED/); T.notMatch(tf._systemPrompt(true).parts[0].text, /HEARD, NOT TYPED/);
});

/* ---- N4: a final the recognizer was unsure of ---- */

T.test('a low-confidence final is read back once: a yes runs it, a no drops it, anything else is the request', function () {
    var p = page();
    p.f.processCommand('list my tickets', 0.4);
    T.eq(p.rec.spoken, ['I heard "list my tickets". Is that right?']);
    T.eq(p.rec.sent, [], 'not sent on a guess');
    T.match(p.c.heard[0] ? p.c.heard[0].fate : '', /^$|asked/, 'fate noted when there is a heard row');
    p.hear('yes');
    T.eq(p.rec.sent, ['list my tickets'], 'the yes runs what was read back');
    T.eq(p.get('_heardCheck'), null);
    // a no: dropped, the user is asked to say it again
    p.f.processCommand('resolve incident 13', 0.5);
    T.eq(p.rec.spoken.length, 2);
    p.hear('no');
    T.eq(p.rec.sent, ['list my tickets']);
    T.eq(p.rec.spoken[2], 'Okay, say it once more.');
    // something else: that is the request, said again - and it is not a
    // second question when it is clear
    p.f.processCommand('resolve incident 13', 0.5);
    p.hear('resolve incident 14');
    T.eq(p.rec.sent, ['list my tickets', 'resolve incident 14']);
    T.eq(p.rec.spoken.length, 4);
    // the yes must come within the window
    p.f.processCommand('list my tickets', 0.5);
    p.set('_heardCheck', { text: 'list my tickets', at: Date.now() - 60000 });
    p.hear('yes');
    T.eq(p.rec.sent, ['list my tickets', 'resolve incident 14', 'yes'], 'a stale yes is the server\'s to judge');
});

T.test('a confident final, a local intent, a yes or no, or a plan\'s no are never read back', function () {
    var p = page();
    p.f.processCommand('list my tickets', 0.55);
    p.f.processCommand('list my tickets', 0.9);
    T.eq(p.rec.sent, ['list my tickets', 'list my tickets']);
    T.eq(p.rec.spoken, []);
    p.f.processCommand('what time is it', 0.4);
    T.match(p.rec.spoken[0], /^The time is /, 'a local intent answers even when unsure');
    p.c._awaitingConfirm = true; p.c._awaitingConfirmAt = Date.now();
    p.f.processCommand('yes', 0.4);
    p.f.processCommand('no', 0.4);
    T.eq(p.rec.sent.slice(2), ['yes', 'no'], 'a yes or no is the server\'s answer, never a question');
    T.eq(p.rec.spoken.length, 1);
    // below the chatter line the old "say it once more" still stands
    p.f.processCommand('list my tickets', 0.2);
    T.match(p.rec.spoken[1], /did not catch that clearly/);
    T.eq(p.get('_heardCheck'), null);
    // a long dictation at low confidence is quicker sent: the model asks its one question
    var long = 'create an incident for the printer near the lift that jams every morning and needs a technician today';
    p.f.processCommand(long, 0.4);
    T.eq(p.rec.sent[p.rec.sent.length - 1], long, '13 words: sent, not read back');
    T.eq(p.rec.spoken.length, 2);
    T.eq(p.get('_heardCheck'), null);
});

T.run(__filename);
