/*
 * Audit client-B: the page's turn-taking. A running plan stops when the user
 * says stop, a "no" always reaches the server, corrections and names are
 * never eaten by the wake word, sleep is a safe state, an interrupted reply
 * is still said, new tabs and buttons report what really happened, and
 * spoken ticket numbers keep the words around them.
 *
 * The page runs wired to the REAL server (every chat is a real widget
 * request on the seeded instance). Replies land when the test says so,
 * speech finishes when the test says so, and timers run on a virtual clock.
 */
'use strict';
var T = require('./lib/t'), N = require('./lib/netra'), S = require('./lib/session'), gem = S.gem, g = S.g;
var fs = require('fs'), path = require('path');
var CLIENT_SRC = fs.readFileSync(path.join(N.SRC, 'widget', 'client.js'), 'utf8');

// the controller's constants: the loader stops before they are assigned
function constants(cl, names) {
    names.forEach(function (n) {
        var m = new RegExp('^    var ' + n + '\\s*=\\s*([\\s\\S]*?);[ \\t]*(//[^\\n]*)?$', 'm').exec(CLIENT_SRC);
        if (!m) throw new Error('constant ' + n + ' not found in client.js');
        cl.set(n, eval('(' + m[1] + ')'));   // eslint-disable-line no-eval
    });
}

function Page(opts) {
    opts = opts || {};
    var self = this;
    this.P = S.world();
    this.gemini = gem.install(this.P, opts.model || []);
    var cl = this.cl = N.loadClient(), c = this.c = cl.c;
    this.f = cl.fn;
    constants(cl, ['MIN_CONFIDENCE', 'MIN_LENGTH', 'BARGE_MIN_CHARS', 'BARGE_MIN_CONF', 'ECHO_OVERLAP_RATIO',
                   'HARD_INTERRUPT_RE', 'WAKE_WORDS', 'SALUTATION_PREFIXES', 'WAKE_TIMEOUT_MS']);
    // a virtual clock for $timeout
    this.now = 0; this.timers = [];
    var $t = function (fn, ms) { var h = { fn: fn, due: self.now + (ms || 0) }; self.timers.push(h); return h; };
    $t.cancel = function (h) { if (h) h.cancelled = true; };
    cl.set('$timeout', $t);
    this.win = {};
    cl.set('$window', this.win);
    var state = { _turnEpoch: 0, _chatSeq: 0, _repliesPending: 0, _chatInFlight: false, _queuedUtterance: null, geminiHistory: [],
                  _finalBuffer: [], _finalConfs: [], _finalTimer: null, _lastInterimAt: 0, _speakingNow: false, _speakingText: '',
                  _fillerEchoText: '', _speakSessionId: 0, _prosFirstAt: 0, commandMode: false, commandTimer: null,
                  conversationTimer: null, _lastYieldAt: 0, _duckedForBarge: false, _duckRestoreTimer: null, _repromptTimer: null,
                  _fillerChainActive: false, currentFillerAudio: null, currentFillerUtter: null, _edgeLiveWs: null, currentAudio: null,
                  TTS: null, lastReply: '', _localReminderTimers: {}, _lastLowConfNudgeAt: 0, contRec: null, _bargedReply: null,
                  _planContinueTimer: null };
    Object.keys(state).forEach(function (k) { cl.set(k, state[k]); });
    c.events = []; c.convo = []; c.data = {}; c.aliases = {}; c.personalVocab = {}; c.lastTrace = [];
    c.stats = { utterances: 0, toolsCalled: 0, errors: 0, barges: 0 }; c.mem = { prompts: 0, kb: 0, entries: 0 };
    c.alert = true; c.conversationOpen = true; c.state = 'idle'; c.liveMode = false;
    c.lastAnswer = ''; c._awaitingConfirm = false; c.lastHeard = '';
    // her voice: what she says is recorded; a line ends when the test says so
    this.said = []; this.speaking = null;
    var say = function (text, done) {
        self.said.push(String(text));
        cl.set('_speakingNow', true); cl.set('_speakingText', String(text));
        self.speaking = done || function () {};
    };
    cl.set('speak', say);
    cl.set('deliverServerReply', say);
    ['startFillerChain', 'stopFillerChain', 'tone', 'cue', '_memPersist', '_pushLatency', '_countTool', '_labNlpCapture',
     '_pushConfidence', 'learnFromTranscript', 'saveTrainingData', '_armReprompt'].forEach(function (n) { cl.set(n, function () {}); });
    cl.set('setState', function (s) { c.state = s; });
    // the wire: the server acts when the request arrives, the reply lands later
    this.sent = []; this.wire = [];
    c.server = { update: function () {
        var d = c.data;
        var req = { action: d.action, message: d.message, history: d.history, auto: d.auto, live_mode: d.live_mode, drop_unheard: d.drop_unheard };
        self.sent.push(req);
        var e = { res: N.request(req).response };
        self.wire.push(e);
        return { then: function (ok, bad) { e.ok = ok; e.bad = bad; } };
    } };
}
Page.prototype.model = function () { this.gemini = gem.install(this.P, Array.prototype.slice.call(arguments)); return this; };
Page.prototype.hear = function (text, conf) { this.f.processFinalTranscript(text, conf === undefined ? 0.9 : conf); };
// a final that arrives while she holds the floor (speaking or thinking)
Page.prototype.over = function (text, conf) { return this.f._handleFinalWhileSpeaking(text, conf === undefined ? 0.9 : conf); };
Page.prototype.land = function () { var e = this.wire.shift(); this.c.data.response = e.res; e.ok(); return e.res; };
Page.prototype.finish = function () {
    var d = this.speaking; this.speaking = null;
    this.cl.set('_speakingNow', false);
    if (d) d();
};
// run due timers in order (never the 18 s hung-transport release)
Page.prototype.flush = function (ms) {
    var until = this.now + (ms === undefined ? 5000 : ms), self = this;
    for (var n = 0; n < 500; n++) {
        var due = this.timers.filter(function (h) { return !h.cancelled && !h.ran && h.due <= until; })
                             .sort(function (a, b) { return a.due - b.due; })[0];
        if (!due) break;
        due.ran = true; self.now = Math.max(self.now, due.due); due.fn();
    }
    this.now = until;
};
// one whole exchange: heard, sent, landed, said (a local reply sends nothing)
Page.prototype.turn = function (text) {
    this.hear(text); this.flush(100);
    var r = this.wire.length ? this.land() : null;
    this.finish(); this.flush(100);
    return r;
};
Page.prototype.messages = function () { return this.sent.map(function (q) { return q.message; }); };
Page.prototype.inc = function (num) { return g.find('incident', 'number', num); };
Page.prototype.blob = function () {
    var ctx = g.find('x_196061_netra_v1_context', 'user', this.P.user.sys_id);
    var raw = ctx ? String(ctx.last_utterance || '') : '';
    return raw.indexOf('CTX:') === 0 ? JSON.parse(raw.substring(4)) : {};
};

var SIX = ['INC0010013', 'INC0010014', 'INC0010015', 'INC0010016', 'INC0010017', 'INC0010018'];
function planPage() {
    var p = new Page();
    p.model(gem.call('make_plan', { steps: SIX.map(function (n) { return { tool: 'assign_ticket_to_group', args: { ticket_number: n, group_name: 'Database' } }; }) }),
            gem.text('Six reassignments to Database. Shall I run it?'));
    p.turn('move 13 to 18 to Database');
    p.hear('yes'); p.flush(100);
    var hop = p.land();          // four written, two to go - she starts saying so
    T.ok(hop.continue_plan, 'the plan has steps left');
    T.eq(p.inc('INC0010016').assignment_group, 'g_db');
    T.eq(p.inc('INC0010017').assignment_group, 'g_net');
    return p;
}
function groups(p) { return SIX.map(function (n) { return p.inc(n).assignment_group; }); }

/* ---- #1 a running plan stops when the user says stop ---- */

T.test('plan: the next hop goes only after the progress line was heard', function () {
    var p = planPage();
    p.flush();
    T.eq(p.messages().indexOf('[continue plan]'), -1, 'nothing resubmitted while she is still saying the progress');
    p.finish(); p.flush();
    T.eq(p.messages()[p.messages().length - 1], '[continue plan]');
    p.land(); p.finish();
    T.eq(groups(p), ['g_db', 'g_db', 'g_db', 'g_db', 'g_db', 'g_db'], 'the plan finishes when nobody stops it');
});

T.test('plan: "stop" while she reads the progress stops the plan on the server', function () {
    var p = planPage();
    T.ok(p.over('stop'), 'consumed as the answer');
    p.flush(); p.finish(); p.flush(10000);
    T.eq(p.messages().slice(-1), ['no'], 'the server heard the stop');
    var r = p.land();
    T.match(r.message, /Stopped the plan - 4 of 6 steps were done/);
    p.finish(); p.flush(10000);
    T.eq(p.messages().indexOf('[continue plan]'), -1, 'no further hop');
    T.eq(p.inc('INC0010017').assignment_group, 'g_net', 'step 5 never ran');
    T.eq(p.inc('INC0010018').assignment_group, 'g_net', 'step 6 never ran');
    T.ok(p.blob().plan.halted, 'halted, so a later hop needs a fresh yes');
});

T.test('plan: "wait", "cancel" and a bare "no" stop it too, even as one short word', function () {
    ['wait', 'cancel', 'no'].forEach(function (w) {
        var p = planPage();
        T.ok(p.over(w), w + ' consumed');
        p.flush(); p.finish(); p.flush(10000);
        T.match(p.land().message, /Stopped the plan - 4 of 6/, w);
        p.finish(); p.flush(10000);
        T.eq(p.inc('INC0010017').assignment_group, 'g_net', w + ': step 5 never ran');
    });
});

T.test('plan: a bare "stop" after the progress line stops the plan, and does not just put Netra to sleep', function () {
    var p = planPage();
    p.finish();                  // progress heard; the next hop is 1.2 s away
    p.hear('stop');
    p.flush(10000);
    T.ok(p.c.alert, 'still awake to say what happened');
    T.eq(p.messages().slice(-1), ['no']);
    T.match(p.land().message, /Stopped the plan - 4 of 6/);
    T.eq(p.inc('INC0010017').assignment_group, 'g_net');
});

T.test('plan: going to sleep, a barge or a new request cancels the pending hop', function () {
    var p = planPage();
    p.finish();
    p.hear('stop listening');
    p.flush(10000);
    T.ok(!p.c.alert, 'asleep');
    T.eq(p.messages().indexOf('[continue plan]'), -1, 'no hop after sleep');
    T.eq(p.inc('INC0010017').assignment_group, 'g_net');

    var q = planPage();
    q.finish();
    q.f.stopSpeaking('Escape key');
    q.flush(10000);
    T.eq(q.messages().indexOf('[continue plan]'), -1, 'no hop after a barge');
    T.eq(q.inc('INC0010017').assignment_group, 'g_net');
});

T.test('plan: a hop interrupted while it was thinking is stopped, and the user hears how far it got', function () {
    var p = new Page();
    p.model(gem.call('make_plan', { steps: SIX.map(function (n) { return { tool: 'assign_ticket_to_group', args: { ticket_number: n, group_name: 'Database' } }; }) }),
            gem.text('Six reassignments to Database. Shall I run it?'));
    p.turn('move 13 to 18 to Database');
    p.hear('yes'); p.flush(100);              // the first hop runs on the server
    // before it lands, a colleague's words barge the thinking filler
    p.f.stopSpeaking('instant interim barge: "good morning"');
    T.ok(p.land().continue_plan, 'four done, two to go - but the user never heard it');
    p.flush(); p.flush();
    T.eq(p.messages().slice(-1), ['no'], 'the page stops the plan instead of leaving it half-run in silence');
    T.match(p.land().message, /Stopped the plan - 4 of 6 steps were done/);
    p.finish(); p.flush(10000);
    T.eq(p.messages().indexOf('[continue plan]'), -1);
    T.eq(p.inc('INC0010017').assignment_group, 'g_net');
});

T.test('plan: the last hop interrupted while thinking is still reported', function () {
    var p = planPage();
    p.finish(); p.flush();                    // hop 2 goes out
    T.eq(p.messages().slice(-1), ['[continue plan]']);
    p.f.stopSpeaking('instant interim barge: "good morning"');
    var r = p.land();
    T.ok(!r.continue_plan, 'the last two steps ran on the server');
    p.flush();
    T.match(p.said[p.said.length - 1], /^About your earlier request: /, 'the finished plan is still reported');
});

T.test('with no plan running and nothing to answer, a bare "stop" is a quiet acknowledgement - never sleep', function () {
    var p = new Page();
    p.hear('stop');
    T.ok(p.c.alert, 'still awake: a bare stop put her to sleep and everything after was ignored');
    T.eq(p.sent, []);
    T.eq(p.said, [], 'nothing to talk over');
    p.hear('stop listening');
    T.ok(!p.c.alert, 'the explicit phrase still means sleep');
});

/* ---- #3 "no" and "ok" are answers ---- */

function withLastAction(p) {
    var inc = p.inc('INC0010013');
    inc.impact = '1'; inc.urgency = '1'; inc.priority = '1';
    var fns = N.loadServer({ input: { action: 'chat' } }).fn;
    var b = fns._ctxReadBlob();
    b.last_action = { kind: 'field', number: 'INC0010013', table: 'incident', field: 'priority', old: '3', old_display: 'priority 3' };
    fns._ctxWriteBlob(b);
}

T.test('a bare "no" after a read-back reaches the server, and a later "okay" runs nothing', function () {
    var p = new Page(); withLastAction(p);
    var rb = p.turn('undo that');
    T.match(rb.message, /Shall I\?/);
    p.hear('no'); p.flush(100);
    T.eq(p.messages().slice(-1), ['no'], 'not dropped as too short');
    T.match(p.land().message, /dropped it\. Nothing was changed/);
    p.finish();
    p.turn('okay');
    T.eq(p.inc('INC0010013').priority, '1', 'the declined undo never ran');
});

T.test('a "no" said over the read-back stops her and declines it', function () {
    var p = new Page(); withLastAction(p);
    p.hear('undo that'); p.flush(100); p.land();   // she is reading it back
    T.ok(p.over('no'), 'consumed as the answer, not dropped as too weak');
    p.flush(100);
    T.eq(p.messages().slice(-1), ['no']);
    p.land(); p.finish();
    p.turn('okay');
    T.eq(p.inc('INC0010013').priority, '1', 'the declined undo never ran');
});

T.test('a bare "OK" is an answer too', function () {
    var p = new Page(); withLastAction(p);
    p.turn('undo that');
    p.hear('OK'); p.flush(100);
    T.eq(p.messages().slice(-1), ['OK'], 'not dropped as too short');
    T.match(p.land().message, /Undone/);
});

/* ---- #4 "no, I meant X" goes to the server ---- */

T.test('"no, I meant X" is sent on as a command, never answered "Noted" on the page', function () {
    var p = new Page();
    p.model(gem.text('Which ticket should go to Database?'), gem.text('Okay.'));
    p.turn('assign INC0010013 to the network group please');
    p.hear('no, I meant the Database group'); p.flush(100);
    T.eq(p.messages().slice(-1), ['no, I meant the Database group'], 'the correction reached the server');
    T.eq(p.said.filter(function (s) { return /^Noted/.test(s); }), [], 'no local "Noted"');
    T.eq(p.c.aliases, {}, 'a whole command is not an alias');
    p.land(); p.finish();
    // a short word swap is still learned from the utterance BEFORE the correction
    p.hear('agar'); p.flush(100); p.land(); p.finish();
    p.hear('I said Adam'); p.flush(100);
    T.eq(p.c.aliases.agar, 'Adam');
    T.eq(p.messages().slice(-1), ['Adam'], '"I said X" runs X');
});

/* ---- #5 sleep is a safe state ---- */

T.test('asleep: "hello", a colleague named Neha, or a mumbled "Netra" do not wake her', function () {
    var p = new Page();
    p.c.alert = false; p.c.conversationOpen = false;
    ['Hello?', 'hey', 'listen to this', 'Neha, please close INC0012345, it is done', 'the server is near capacity',
     'Nada, can you send me the report', 'nada más, gracias'].forEach(function (u) {
        p.hear(u);
        T.ok(!p.c.alert, u + ': still asleep');
    });
    p.hear('Netra', 0.2);
    T.ok(!p.c.alert, 'a low-confidence "Netra" is not enough');
    p.flush(1000);
    T.eq(p.sent, [], 'nothing reached the server');
    p.hear('Netra, wake up');
    T.ok(p.c.alert, 'the user can still wake her');
    T.eq(p.said.slice(-1), ['Yes, I am listening. Go ahead.']);
    ['wake up Netra', 'hey Netra', 'are you there?'].forEach(function (u) {
        p.c.alert = false;
        p.hear(u);
        T.ok(p.c.alert, u + ' wakes her');
    });
    T.eq(p.sent, [], 'and runs nothing');
});

T.test('asleep: "Netra, <command>" wakes her and runs the command', function () {
    var p = new Page();
    p.c.alert = false; p.c.conversationOpen = false;
    p.hear('Netra, what is the status of INC0010013');
    T.ok(p.c.alert);
    p.finish(); p.flush(1000);
    T.eq(p.messages(), ['what is the status of INC0010013']);
});

/* ---- #6 a name mid-sentence is part of the command ---- */

T.test('awake: a wake-word lookalike mid-sentence never cuts the command', function () {
    var p = new Page();
    p.model(gem.text('Okay.'), gem.text('Okay.'), gem.text('Okay.'));
    p.hear('assign INC0010013 to Neha Sharma'); p.flush(100); p.land(); p.finish();
    p.hear('reassign the ticket to Neeraj'); p.flush(100); p.land(); p.finish();
    p.hear('add a note saying the printer near reception is fixed'); p.flush(100);
    T.eq(p.messages(), ['assign INC0010013 to Neha Sharma', 'reassign the ticket to Neeraj', 'add a note saying the printer near reception is fixed']);
    T.eq(p.f.matchesWake('Hey Netra, list my tickets'), 'list my tickets', 'a leading "hey Netra" is still stripped');
    T.eq(p.f.matchesWake('Netra, add a note: VPN is down.'), 'add a note: VPN is down.', 'and the rest keeps its case');
    T.eq(p.f.matchesWake('send it to Meera'), null);
});

/* ---- #7 an interrupted reply is still said ---- */

T.test('a barge that asks nothing new does not swallow the reply - it is said once the floor is free', function () {
    var p = new Page(); withLastAction(p);
    p.turn('undo that');
    p.hear('yes'); p.flush(100);             // the undo runs on the server
    T.eq(p.inc('INC0010013').priority, '3', 'written');
    // a colleague's "good morning" barges the thinking filler; it is answered locally
    p.f.stopSpeaking('instant interim barge: "good morning"');
    p.hear('good morning');
    T.match(p.said[p.said.length - 1], /how may I help you today/);
    p.land();                                // stale: the epoch moved
    p.flush(1000);
    T.match(p.said[p.said.length - 1], /how may I help you today/, 'never over her current line');
    p.finish(); p.flush(1000);
    T.match(p.said[p.said.length - 1], /^About your earlier request: .*Undone/, 'the write is reported');
    T.match(p.c.lastAnswer, /Undone/, '"repeat" replays it');
    T.eq(p.f.matchLocal('repeat').reply, p.c.lastAnswer);
});

T.test('a barge that DID ask something new still drops the old reply', function () {
    var p = new Page(); withLastAction(p);
    p.turn('undo that');
    p.hear('yes'); p.flush(100);
    p.f.stopSpeaking('user barge-in');
    p.hear('what is the status of INC0010014');   // queued behind the in-flight chat
    p.land(); p.flush(100);
    T.eq(p.said.filter(function (s) { return /About your earlier request/.test(s); }), [], 'superseded');
    T.eq(p.messages().slice(-1), ['what is the status of INC0010014']);
});

/* ---- #8 new tabs and buttons say what really happened ---- */

T.test('open_url: a blocked tab is said, and the link takes focus', function () {
    var p = new Page();
    var opened = [];
    p.win.open = function (u, t, feat) { opened.push([u, t, feat]); return null; };
    p.model(gem.call('open_url', { url: 'https://www.youtube.com', title: 'YouTube' }), gem.text('Opening YouTube in a new tab.'));
    var r = p.turn('open youtube');
    T.eq(opened.length, 1, 'tried at once');
    T.ok(!/noopener/.test(String(opened[0][2] || '')), 'no "noopener": with it window.open always looks blocked');
    T.match(p.said[p.said.length - 1], /Your browser blocked the new tab, so nothing opened yet - press Enter to open it\./);
    T.eq(p.c.pendingOpenUrl, 'https://www.youtube.com');
    T.ok(r, 'reply landed');

    var q = new Page(), win = { opener: 'page' };
    q.win.open = function () { return win; };
    q.model(gem.call('open_url', { url: 'https://www.youtube.com', title: 'YouTube' }), gem.text('Opening YouTube in a new tab.'));
    q.turn('open youtube');
    T.eq(win.opener, null, 'the new tab can not reach back into ServiceNow');
    T.notMatch(q.said[q.said.length - 1], /blocked/);
    T.eq(q.c.pendingOpenUrl, undefined);
});

T.test('click: same-named buttons that do different things are never guessed at; the page, not <body>, is searched', function () {
    var cl = N.loadClient(), asked = [];
    function btn(text, ngClick) {
        return { textContent: text, disabled: false,
                 getAttribute: function (a) { return a === 'ng-click' ? (ngClick || null) : null; },
                 getBoundingClientRect: function () { return { width: 60, height: 20 }; }, closest: function () { return null; },
                 click: function () {} };
    }
    var page = [btn('Delete', 'deleteAttachment(a)'), btn('Delete', 'triggerUIAction(action)'), btn('Save', 'triggerUIAction(action)'), btn('Save', 'triggerUIAction(action)')];
    global.document = { querySelector: function (sel) { asked.push(sel); return { querySelectorAll: function () { return page; } }; } };
    var d = cl.fn._pickButton('delete');
    T.eq(d.el, null, 'an attachment\'s Delete and the record\'s Delete are two different buttons');
    T.match(d.say, /I found 2 "Delete" buttons on this page and can not tell which one you mean, so I pressed nothing\./);
    T.ok(cl.fn._pickButton('save').el, 'header and footer copies of one action are one button');
    T.eq(asked[0], 'main', 'the page content first, not the first match of a selector list (<body>)');
    delete global.document;
});

/* ---- #9 spoken ticket numbers keep the words around them ---- */

T.test('normalizeNumbers never glues the next word on, and counts are not tickets', function () {
    var f = N.loadClient().fn;
    T.eq(f.normalizeNumbers('what is the status of INC0010013 please'), 'what is the status of INC0010013 please');
    T.eq(f.normalizeNumbers('assign INC0010013 to network'), 'assign INC0010013 to network');
    T.eq(f.normalizeNumbers('resolve incident 10013 with note fixed'), 'resolve INC0010013 with note fixed');
    T.eq(f.normalizeNumbers('I N C 001 0013 to network'), 'INC0010013 to network');
    T.eq(f.normalizeNumbers('request two laptops for Priya'), 'request 2 laptops for Priya');
    T.eq(f.normalizeNumbers('log a problem one of my users has'), 'log a problem 1 of my users has');
});

T.test('"status of INC0010013 please" costs no model call', function () {
    var p = new Page();
    var r = p.turn('what is the status of INC0010013 please');
    T.eq(p.messages(), ['what is the status of INC0010013 please']);
    T.eq(p.gemini.generate.length, 0, 'answered by the fast lane');
    T.match(r.message, /0 1 3/);
});

/* ---- #10 sleep phrases only as the whole utterance ---- */

T.test('dictation containing a sleep phrase is dictation, not sleep', function () {
    var f = N.loadClient().fn;
    ['add a work note the vpn error does not go away after a reboot', 'resolve inc0010013 with note replaced the cable that\'s all',
     'set the laptop to sleep mode and add a note', 'message priya saying the alarm will not stop now',
     'the user said goodbye to the old laptop', 'add a note user was told to be quiet'].forEach(function (u) {
        T.ok(!f.matchSleep(u), u);
    });
    ['stop listening', 'Stop listening.', 'Netra, go to sleep', 'that\'s all', 'okay, that\'s all', 'thanks, goodbye Netra', 'goodbye', 'good night'].forEach(function (u) {
        T.ok(f.matchSleep(u), u);
    });
    T.ok(!f.matchSleep('stop'), 'a bare stop is an interruption, not sleep');
    var p = new Page();
    p.model(gem.text('Added.'));
    p.hear('add a work note to INC0010013 the popup does not go away after reboot'); p.flush(100);
    T.ok(p.c.alert, 'still awake');
    T.eq(p.messages(), ['add a work note to INC0010013 the popup does not go away after reboot']);
});

T.run(__filename);
