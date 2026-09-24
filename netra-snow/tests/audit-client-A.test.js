/*
 * Audit slice client-A: the page itself. A correction said while a read-back
 * waits reaches the server; the Lab's NLP test says it is live and never
 * leaves speech muted; ticket numbers keep their spacing; "speak slower" and
 * "quiet" do what they claim; no key still boots into basic mode; the boot
 * mic check lets a command or a skip through; clock and date read naturally.
 */
'use strict';
var T = require('./lib/t'), N = require('./lib/netra'), S = require('./lib/session'), gem = S.gem;
var fs = require('fs'), path = require('path');

var CALIB = 'The quick brown fox jumps over the lazy dog near the big green screen';
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
     'learnFromTranscript', '_pushConfidence', 'stopFillerChain', 'unlockAudio', 'populateVoices', 'startContinuous',
     'startListeningWatchdog', 'startVisibilityRecovery', 'startNotificationPolling', '_firstRunCheck', '_memPersist']
        .forEach(function (n) { set(n, noop); });
    set('WAKE_WORDS', ['netra']); set('SALUTATION_PREFIXES', ['hey', 'ok', 'okay']);
    set('MIN_LENGTH', 3); set('MIN_CONFIDENCE', 0.35); set('ALWAYS_LISTEN', true); set('REPROMPT_AFTER_MS', 9000);
    set('CALIB_SENTENCE', CALIB); set('_calibActive', false); set('_calibSession', 0); set('_calibListenStart', 0);
    set('_labNlpArm', false); set('_labNlpPrevMute', false); set('_labNlpSent', '');
    set('geminiHistory', []); set('seenIds', {}); set('_ackIds', []); set('_recentReminderTexts', {});
    set('_speakingNow', false); set('_chatInFlight', false); set('_queuedUtterance', null); set('booted', false);
    c.events = []; c.stats = {}; c.aliases = {}; c.personalVocab = {}; c.data = {}; c.micHealth = {};
    c.alert = true; c.conversationOpen = true; c.state = 'idle'; c.lastHeard = ''; c.lastAnswer = ''; c.labMute = false;
    c.labCalib = { stage: 'idle', heard: '', score: null, verdict: '' };
    c.speechRate = 1.06;
    store = {};
    return { c: c, f: cl.fn, get: cl.get, set: set, rec: rec,
             hear: function (u) { cl.fn.processFinalTranscript(u, 0.9); return rec; } };
}

// the page takes what the server said, the way deliverServerReply leaves it
function heard(p, r) { p.c.lastAnswer = r.message; p.c._awaitingConfirm = !!r.awaiting_confirm; }

T.test('"no, I said X" while a read-back waits goes to the server, so the next "okay" can not raise the old draft', function () {
    var s = new S.Session({ key: '' }), p = page();
    var r1 = s.say('raise a ticket for vpn drops every morning');
    T.match(r1.message, /An incident for "vpn drops every morning"\. Shall I\?/);
    heard(p, r1);
    p.hear('no, I said the printer on floor three');
    T.eq(p.rec.sent, ['no, I said the printer on floor 3'], 'the server hears the correction');
    T.eq(p.rec.spoken, [], 'no local "Noted" in place of the answer');
    heard(p, s.say(p.rec.sent[0]));
    p.hear('okay');
    s.say(p.rec.sent[1]);
    var made = Object.keys(S.g.P.STORE.incident || {}).filter(function (k) {
        return /vpn drops every morning/i.test(String(S.g.P.STORE.incident[k].short_description || ''));
    });
    T.eq(made, [], 'the rejected incident was never created');
});

T.test('"I said X" with nothing awaited runs X, and learns the alias from the previous transcript', function () {
    var p = page();
    p.hear('lift my tickets');
    p.hear('I said list my tickets');
    T.eq(p.rec.sent, ['lift my tickets', 'list my tickets'], 'the corrected request is run, not just noted');
    T.eq(p.c.aliases['lift my tickets'], 'list my tickets');
    T.ok(!p.c.aliases['i said list my tickets'], 'no alias learned from the correction itself');
    T.eq(p.rec.spoken, []);

    var q = page();
    q.hear('status of INC0010013');
    q.hear('I meant INC0010014');
    T.eq(q.rec.sent[1], 'INC0010014', 'a changed ticket number is a new request');
    T.eq(Object.keys(q.c.aliases), [], 'and never an alias that would rewrite the old number later');

    var w = page();
    w.hear('assign it to bath anglin');
    w.hear('the word is Anglin');
    T.eq(w.rec.sent, ['assign it to bath anglin'], '"the word is" teaches a word, it runs nothing');
    T.match(w.rec.spoken[0], /Noted .*"Anglin"/);
    T.ok(w.c.personalVocab.anglin && w.c.personalVocab.anglin.count >= 3, 'the word is learned');
});

T.test('the Lab NLP test says it is live, and never leaves speech muted after a local answer or sleep', function () {
    var tpl = fs.readFileSync(path.join(N.SRC, 'widget', 'template.html'), 'utf8');
    var title = /NLP TEST \(([^)]*)\)/.exec(tpl);
    T.ok(title, 'NLP test section found');
    T.notMatch(title[1], /dry run/i, 'it runs real writes, so it must not claim a dry run');
    T.match(title[1], /live/i);

    ['what time is it', 'go to sleep', 'hello'].forEach(function (u) {
        var p = page();
        p.set('_labNlpArm', true); p.set('_labNlpPrevMute', false); p.set('_labNlpSent', u);
        p.c.labMute = true;
        p.f.processCommand(u, 1.0);
        T.eq(p.c.labMute, false, u + ': mute released');
        T.eq(p.get('_labNlpArm'), false, u + ': the test is finished');
        T.ok(p.c.labNlp && p.c.labNlp.sent === u && p.c.labNlp.reply.length > 0, u + ': result shown in the Lab');
    });
});

T.test('ticket numbers keep the space to the next word, so the fast lane still finds them', function () {
    var f = page().f;
    T.eq(f.normalizeNumbers('resolve INC0010013 please'), 'resolve INC0010013 please');
    T.eq(f.normalizeNumbers('status of incident 10013 please'), 'status of INC0010013 please');
    T.eq(f.normalizeNumbers('I N C zero zero one zero zero one three please'), 'INC0010013 please');
    T.eq(f.normalizeNumbers('INC 1 0 0 1 3 now'), 'INC0010013 now');
    T.eq(f.normalizeNumbers('INC0010013 10 users'), 'INC0010013 10 users');
    T.eq(f.normalizeNumbers('investigate INC0010013 and INC0010014'), 'investigate INC0010013 and INC0010014');
    T.eq(f.normalizeNumbers('KB 12 is wrong'), 'KB12 is wrong');

    // what the page sends, through the real router
    var p = page(), s = new S.Session();
    p.f.processCommand('status of incident 10015 please', 1.0);
    s.model(gem.text('(model answered)'));
    var r = s.say(p.rec.sent[0]);
    T.eq(s.gemini.generate.length, 0, 'the zero-call fast lane answers it');
    T.match(r.message, /incident ending 0 1 5\*\*: Printer jammed on floor 3/);

    p.f.processCommand('investigate INC0010013 and INC0010014', 1.0);
    s.model(gem.text('(model answered)'));
    var r2 = s.say(p.rec.sent[1]);
    T.ok(s.gemini.generate.length > 0, 'a compound request goes to the model');
    T.notMatch(r2.message, /incident ending 0 1 4/, 'not a fast-lane look at the second ticket only');

    var b = new S.Session({ key: '' });
    p.f.processCommand('read INC0010015 please', 1.0);
    T.match(b.say(p.rec.sent[2]).message, /Printer jammed on floor 3/, 'basic mode still reads the ticket');
});

T.test('"speak slower" and "speak faster" really change the pace, within the slider range', function () {
    var p = page();
    p.hear('speak slower');
    T.eq(p.c.speechRate, 0.98);
    T.eq(store.netra_speechRate, '0.98', 'kept like the setup slider keeps it');
    T.eq(p.rec.spoken[0], 'I will slow down a touch.');
    p.hear('speak faster');
    p.hear('speak faster');
    T.eq(p.c.speechRate, 1.14);
    p.c.speechRate = 1.3;
    p.hear('speak faster');
    T.eq(p.c.speechRate, 1.3);
    T.match(p.rec.spoken[p.rec.spoken.length - 1], /already my fastest/, 'no claim of a change that did not happen');
});

T.test('"quiet" holds notifications, nudges and the auto briefing until the user speaks again', function () {
    var p = page(), f = p.f;
    p.hear('hush');
    T.ok(p.c._hushed, 'hushed');
    T.match(p.rec.spoken[0], /stay silent until you speak to me again/);
    var n = p.rec.spoken.length;
    f._onPolledNotification({ id: 'n1', kind: 'sla', message: 'SLA breach coming on INC0010013.' });
    f._armReprompt('Which group should I use?');
    p.c.liveMode = true; p.c.prefBrief = true;
    f._maybeAutoBrief(0);
    T.eq(p.rec.spoken.length, n, 'nothing spoken while hushed');
    T.eq(p.rec.sent, [], 'no automatic briefing sent');
    T.eq(p.get('_ackIds'), [], 'the notification stays unacked, so the next poll brings it back');
    f._onPolledNotification({ id: 'n2', kind: 'reminder', message: 'Reminder: call Beth.' });
    T.eq(p.rec.spoken[p.rec.spoken.length - 1], 'Reminder: call Beth.', 'a reminder the user set still speaks, as promised');

    p.hear('list my tickets');
    T.ok(!p.c._hushed, 'speaking again ends the hush');
    f._onPolledNotification({ id: 'n1', kind: 'sla', message: 'SLA breach coming on INC0010013.' });
    T.eq(p.rec.spoken[p.rec.spoken.length - 1], 'SLA breach coming on INC0010013.');
});

T.test('no Gemini key: the page boots, says nothing it can not stand behind, and the loading screen says why', function () {
    var p = page();
    p.c.hasSR = true;
    p.c.data = { has_api_key: false, user_name: 'Beth Anglin' };
    p.c.gate = { open: false, everOpen: false, hearing: false, voice: false, brain: false, hearingText: '', voiceText: '', brainText: '' };
    p.c.server = { get: function () { return { then: function (ok) { ok({ data: { ready: { ready: false, reason: 'no_key', say: 'My Gemini key is not set up yet.', wait_ms: 60000 } } }); } }; },
                   update: function () { return { then: function () {} }; } };
    p.f.tryBoot(true);
    T.ok(p.get('booted'), 'the mic starts');
    T.notMatch(p.rec.spoken.join(' '), /has not been configured|basic mode/, 'no basic-mode speech');
    T.eq(p.c.gate.open, false, 'nothing is accepted without a brain');
    T.eq(p.c.gate.brainText, 'My Gemini key is not set up yet.', 'the loading screen says why');

    var k = page();
    k.c.hasSR = true;
    k.c.data = { has_api_key: true, user_name: 'Beth Anglin' };
    k.f.tryBoot(true);
    T.ok(k.get('booted'));
    T.notMatch(k.rec.spoken.join(' '), /basic mode/, 'no basic-mode note when the key is set');
});

T.test('boot mic check: ways of saying skip skip it, a command runs, and a cut-off prompt does not stick', function () {
    function listening(p) {
        p.set('_calibActive', true); p.set('_calibListenStart', 0);
        p.c.labCalib = { stage: 'listening', heard: '', score: null, verdict: '' };
        p.skipped = 0;
        p.c.calibSkip = function () { p.skipped++; p.set('_calibActive', false); p.c.labCalib.stage = 'skipped'; };
        return p;
    }
    ['skip', 'skip it', 'skip please', 'please skip', 'skip this', 'skip calibration', 'skip the mic check', 'stop',
     'Netra skip', 'not now', 'no thanks', 'cancel that', 'later'].forEach(function (u) {
        var p = listening(page());
        T.ok(p.f._calibConsume(u), u + ': consumed');
        T.eq(p.skipped, 1, u + ': skipped');
        T.eq(store.netra_calib, undefined, u + ': no score saved');
    });

    var p = listening(page());
    p.hear('list my tickets');
    T.eq(p.rec.sent, ['list my tickets'], 'the command runs');
    T.notMatch(p.rec.spoken.join(' '), /Word accuracy|Poor/, 'no false mic diagnosis');
    T.eq(store.netra_calib, undefined, 'no score saved');
    T.eq(p.get('_calibActive'), false);
    T.eq(p.c.labCalib.stage, 'skipped');

    var m = listening(page());
    m.hear('cancel my last ticket');
    T.eq(m.rec.sent, ['cancel my last ticket'], 'a command that starts like a skip is still the command');
    T.eq(m.skipped, 0);

    var z = listening(page());
    z.hear('stop listening');
    T.eq(z.c.alert, false, '"stop listening" still puts her to sleep');
    T.eq(z.skipped, 0);

    var r = listening(page());
    r.hear('the quick brown fox jumps over the lazy dog near the big green screen');
    T.eq(r.c.labCalib.stage, 'done', 'a real read-back is still scored');
    T.eq(r.c.labCalib.score, 100);
    T.eq(JSON.parse(store.netra_calib).score, 100);

    var q = page();
    q.set('_calibActive', true);
    q.c.labCalib = { stage: 'prompt', heard: '', score: null, verdict: '' };
    q.f.stopSpeaking('user barge-in');
    T.eq(q.get('_calibActive'), false, 'the check ends with its prompt');
    T.eq(q.c.labCalib.stage, 'skipped', 'so the briefing and "Run mic check" are not blocked forever');
});

T.test('clock and date read naturally: o\'clock on the hour, real ordinals', function () {
    var Real = Date;
    function at(d, u) {
        global.Date = function () { return arguments.length ? new (Function.prototype.bind.apply(Real, [null].concat([].slice.call(arguments))))() : new Real(d.getTime()); };
        global.Date.now = function () { return d.getTime(); };
        try { return page().f.matchLocal(u).reply; } finally { global.Date = Real; }
    }
    T.eq(at(new Real(2026, 8, 23, 15, 0), 'what time is it'), "The time is 3 o'clock P M.");
    T.eq(at(new Real(2026, 8, 23, 9, 5), 'what time is it'), 'The time is 9 oh 5 A M.');
    T.eq(at(new Real(2026, 8, 23, 12, 30), 'what time is it'), 'The time is 12 30 P M.');
    T.eq(at(new Real(2026, 8, 23, 10, 0), 'what is the date'), 'Today is Wednesday, the 23rd of September.');
    T.eq(at(new Real(2026, 8, 1, 10, 0), 'what is the date'), 'Today is Tuesday, the 1st of September.');
    T.eq(at(new Real(2026, 8, 22, 10, 0), 'what is the date'), 'Today is Tuesday, the 22nd of September.');
    T.eq(at(new Real(2026, 8, 12, 10, 0), 'what is the date'), 'Today is Saturday, the 12th of September.');
    T.eq(at(new Real(2026, 8, 11, 10, 0), 'what is the date'), 'Today is Friday, the 11th of September.');
});

T.run(__filename);
