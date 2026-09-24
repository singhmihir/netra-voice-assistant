/* Netra checks her own tools - and says exactly what is wrong and how to fix it. */
'use strict';
var T = require('./lib/t'), S = require('./lib/session'), N = require('./lib/netra'), g = S.g;
var MIN = 60000;

function healthy() {
    var s = new S.Session();
    g.put('sysauto_script', { name: 'Netra Watch', active: 'true' });
    g.put('x_196061_netra_v1_user_pref', { user: 'u_admin', active: 'true', last_scan_time: g.fmtUtc(g.P.now - 2 * MIN) });
    ['context', 'notification', 'watchlist', 'kb_embedding', 'task', 'brain', 'mission_item'].forEach(function (t) { g.P.STORE['x_196061_netra_v1_' + t] = g.P.STORE['x_196061_netra_v1_' + t] || {}; });
    g.put('sysapproval_approver', { approver: 'u_bert', state: 'approved' });
    g.put('syslog', { level: '0', message: 'some other app said hello', sys_created_on: g.fmtUtc(g.P.now - 5 * MIN) });
    N.loadServer({ input: { action: 'chat' } }).fn._reindexIncidents(40);   // memory warm
    return s;
}
function check() { N.loadScriptIncludes(); var c = new NetraSelfCheck('u_admin'); var r = c.run(); r.say = c.sentence(r); return r; }

T.test('a healthy instance: everything fine, and it costs no generate call', function () {
    var s = healthy();
    var r = check();
    T.eq(r.problems + r.warnings, 0, r.say);
    T.match(r.say, /^Self-check done: all \d+ checks are fine/);
    T.eq(s.gemini.generate.length, 0);
    T.eq(s.gemini.listed, 1, 'the key is tested against the free model list');
});

T.test('the background scanner stopped: a problem, with the fix', function () {
    healthy();
    g.find('x_196061_netra_v1_user_pref', 'user', 'u_admin').last_scan_time = g.fmtUtc(g.P.now - 3 * 60 * MIN);
    var r = check();
    T.match(r.say, /One problem: my background scanner last ran about 3 hours ago, so nothing is being watched right now - check the Netra Watch scheduled job/);
});

T.test('the job is switched off', function () {
    healthy();
    g.find('sysauto_script', 'name', 'Netra Watch').active = 'false';
    T.match(check().say, /background scanner is switched off, so standing orders, missions and alerts are not running - activate the Netra Watch scheduled job/);
});

T.test('Google rejects the key', function () {
    var s = healthy();
    s.gemini.listStatus = 400;
    T.match(check().say, /Google rejected my Gemini key \(HTTP 400\) - it may have been revoked/);
});

T.test('no key at all', function () {
    healthy();
    g.P.PROPS['x_196061_netra_v1.gemini_api_key'] = '';
    T.match(check().say, /my Gemini key is not set, so I am in basic mode/);
});

T.test('overdue standing orders and switched-off writes', function () {
    healthy();
    g.put('x_196061_netra_v1_task', { user: 'u_admin', state: 'active', nt_number: 'NT0001', next_check_at: g.fmtUtc(g.P.now - 60 * MIN) });
    g.P.PROPS['x_196061_netra_v1.ticket_writes'] = 'false';
    var r = check();
    T.match(r.say, /1 of your 1 standing order is overdue for a check/);
    T.match(r.say, /ticket writes are switched off/);
});

T.test('thin semantic memory is flagged with the fix', function () {
    healthy();
    g.P.STORE.x_196061_netra_v1_kb_embedding = {};
    T.match(check().say, /covers only 0 percent of recent incidents, so "has this happened before" will miss things - say "reindex my tickets"/);
});

T.test('recent Netra errors are reported', function () {
    healthy();
    g.put('syslog', { level: '2', message: '[NetraGemini] API error: HTTP 500', sys_created_on: g.fmtUtc(g.P.now - 30 * MIN) });
    T.match(check().say, /1 Netra error in the log in the last day, the latest: \[NetraGemini\] API error: HTTP 500/);
});

T.test('a log it cannot read is not reported as "no errors"', function () {
    healthy();
    g.P.STORE.syslog = {};
    var r = check();
    T.match(r.say, /^Self-check done: all 9 checks are fine\..* One note: I can not see the system log on this instance, so errors there are not part of this check\.$/);
    T.notMatch(r.say, /no Netra errors/, 'never claims no errors when it could not look');
});

T.test('asked in conversation, the self-check is answered free - and so is the fix it suggests', function () {
    var s = healthy();
    g.P.STORE.x_196061_netra_v1_kb_embedding = {};
    ['run a self check', 'health check', 'are you working properly'].forEach(function (u) {
        var r = s.say(u);
        T.eq(r.route_reason, 'fast_lane', u);
        T.match(r.message, /^Self-check done/, u);
    });
    T.match(s.say('run a self check').message, /say "reindex my tickets"/);
    var ri = s.say('reindex my tickets');
    T.match(ri.message, /^Indexed \d+ more tickets?/);
    T.eq(s.gemini.generate.length, 0, 'no generate calls for any of it');
});

T.run(__filename);
