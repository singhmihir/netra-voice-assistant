/*
 * Which utterances the zero-call fast lane answers, and which it must leave
 * to the model. A wrong capture is a dead end for a user who cannot see why.
 */
'use strict';
var T = require('./lib/t'), S = require('./lib/session');

function fast(s, text) {
    var before = s.gemini.generate.length;
    s.model(S.gem.text('(model answered)'));
    var r = s.say(text);
    return { r: r, model: s.gemini.generate.length > 0, text: r.message };
}

T.test('quota questions are answered free, in many phrasings', function () {
    var s = new S.Session();
    ['quota status', "how's your brain", 'how much brain do you have left', 'how many calls do you have left', 'are you running low'].forEach(function (u) {
        var x = fast(s, u);
        T.ok(!x.model, u + ' should not reach the model');
        T.match(x.text, /reasoning models are available|out of today/, u);
    });
});

T.test('help requests and compound commands go to the model', function () {
    var s = new S.Session();
    ["what's wrong with my laptop", 'why is my vpn not working', "what's going on with my tickets",
     'investigate INC0010013 and assign it to the network team', 'check again', 'what happened', 'what did you do',
     'what have you done', 'investigate INC0010013 and INC0010014'].forEach(function (u) {
        T.ok(fast(s, u).model, u + ' should go to the model');
    });
});

T.test('ticket and debrief phrasings the fast lane owns', function () {
    var s = new S.Session();
    var t = fast(s, 'status of i n c zero zero one zero zero one five');
    T.ok(!t.model);
    T.match(t.text, /incident ending 0 1 5\*\*: Printer jammed on floor 3\. It is in progress, priority moderate/);
    T.ok(!fast(s, 'what did you do while i was away').model, 'qualified debrief is free');
    T.ok(!fast(s, 'debrief me').model);
    T.ok(!fast(s, 'my tickets').model);
});

T.test('pronouns mean the ticket in focus, not an older investigation', function () {
    var s = new S.Session();
    S.g.P.PROPS['x_196061_netra_v1.investigate_llm'] = 'false';
    fast(s, 'status of INC0010013');
    var a = fast(s, 'investigate that incident');
    T.ok(!a.model);
    T.match(a.text, /incident ending 0 1 3/);
    fast(s, 'status of INC0010016');
    var b = fast(s, 'investigate this ticket');
    T.match(b.text, /incident ending 0 1 6/, 'focus moved to 016');
});

T.test('bare "why" is only about an investigation right after it', function () {
    var s = new S.Session();
    S.g.P.PROPS['x_196061_netra_v1.investigate_llm'] = 'false';
    fast(s, 'investigate INC0010013');
    fast(s, 'my tickets');
    T.ok(fast(s, 'why').model, 'two turns later "why" goes to the model');
});

T.test('"undo number two" means debrief item two only while the debrief is fresh', function () {
    var s = new S.Session();
    s.setBlob({ awayMap: { items: { '1': 'NT0007', '2': 'NT0009' }, what: { '1': 'noted INC0010013', '2': 'escalated INC0010014 from 3 to 2' }, turn: 0, at: S.g.P.now } });
    var r = fast(s, 'undo number two');
    T.match(r.text, /reverse item 2 - escalated INC0010014 from 3 to 2 - which was task 9\. Shall I\?/);
    T.match(fast(s, 'undo task two').text, /what task 2 changed/, 'explicit task number is a task');
    S.g.P.now += 45 * 60000;
    T.match(fast(s, 'undo number two').text, /what task 2 changed/, 'an old debrief no longer maps numbers');
});

T.test('mission numbers resolve strictly - never fall back to the live mission', function () {
    var s = new S.Session();
    var r = fast(s, 'cancel mission banana');
    T.ok(!r.model);
    T.match(r.text, /did not catch which mission/);
    T.match(fast(s, 'stop the mission now').text, /There is no mission to stop/, '"now" is filler, not a number');
});

T.test('"apply them" with nothing parked reaches the mission intent, not a bare ack', function () {
    var s = new S.Session();
    var r = fast(s, 'apply them');
    T.notMatch(r.text, /Anything else I can do/);
    T.match(r.text, /no mission to apply/i);
});

T.test('counts are true totals, not the length of a capped list', function () {
    var s = new S.Session();
    for (var i = 0; i < 12; i++) S.g.put('incident', { number: 'INC00200' + (10 + i), caller_id: 'u_admin', state: i < 3 ? '6' : '2', active: 'true', short_description: 'x' + i });
    T.match(fast(s, 'my tickets').text, /You have 15 open tickets and 3 resolved, waiting to close/);
    for (var j = 0; j < 14; j++) S.g.put('sysapproval_approver', { approver: 'u_admin', state: 'requested', sysapproval: '', source_table: '' });
    T.match(fast(s, 'my approvals').text, /^14 approvals are waiting on you - the newest three/);
});

T.test('no API key: the free answers still work (never goes dark)', function () {
    var s = new S.Session({ key: '' });
    var r = s.say('my tickets');
    T.match(r.message, /You have 6 open tickets/);
    var r2 = s.say('reassign INC0010013 to Database');
    T.match(r2.message, /Gemini key is not set up yet, so I am in basic mode/);
    T.match(r2.message, /once an admin sets the x_196061_netra_v1\.gemini_api_key property/);
    T.eq(S.g.find('incident', 'number', 'INC0010013').assignment_group, 'g_net', 'no write in basic mode');
    T.eq(s.gemini.generate.length, 0);
});

T.test('"undo item two" with no debrief says so instead of undoing task two', function () {
    var s = new S.Session();
    var r = fast(s, 'undo item two');
    T.match(r.text, /I have no debrief to number from - say "undo task" and its number/);
    T.ok(!s.blob().flDraft, 'nothing parked');
});

T.test('undo read-back for a priority set through impact and urgency', function () {
    var s = new S.Session();
    s.setBlob({ last_action: { kind: 'fields', number: 'INC0010013', table: 'incident', fields: { impact: '2', urgency: '2' }, old_display: 'priority 3' } });
    T.match(fast(s, 'undo that').text, /That would put \*\*incident ending 0 1 3\*\* back to priority 3\. Shall I\?/);
});

T.test('"current mission" means the live one; an unknown name never does', function () {
    var f = require('./lib/netra').loadServer({ input: { action: 'chat' } }).fn;
    ['current', 'the current mission', 'latest', 'now', ''].forEach(function (x) { T.eq(f._missionPick(x).named, false, x); });
    T.eq(f._missionPick('eleven').nt, '11');
    T.ok(f._missionPick('banana').bad, 'unknown names are refused, not guessed');
});

T.run(__filename);
