/*
 * Ticket helpers say what is true: real overdue rules, the right greeting,
 * the person the user chose, a cancel state the table has, SLAs that can
 * still be saved, true totals, and a focus that is current.
 */
'use strict';
var T = require('./lib/t'), S = require('./lib/session'), N = require('./lib/netra'), gem = S.gem, g = S.g;
var H = 3600000;
function fns() { return N.loadServer({ input: { action: 'chat' } }).fn; }
function lastResult(s) { return JSON.stringify(s.gemini.generate[s.gemini.generate.length - 1].contents.slice(-1)); }

T.test('overdue follows the stated rules (P1 > 4 hours, P2 > 1 day, P3+ > 3 days)', function () {
    new S.Session();
    var at = function (h) { return g.fmtUtc(g.P.now - h * H); };
    [['INC0030001', '1', 5], ['INC0030002', '1', 2], ['INC0030003', '3', 96], ['INC0030004', '2', 30], ['INC0030005', '4', 24]].forEach(function (x) {
        g.put('incident', { number: x[0], priority: x[1], opened_at: at(x[2]), assigned_to: 'u_admin', active: 'true', state: '2', short_description: x[0] });
    });
    var r = fns()._listOverdue();
    T.eq(r.overdue.map(function (o) { return o.number; }).join(','), 'INC0030001,INC0030004,INC0030003');
    T.eq(r.total, 3);
    T.match(r.overdue[0].opened, /about 5 hours ago/, 'spoken age, not a raw UTC stamp');
});

T.test('the briefing greets by the user\'s local hour, not a 12-hour display string', function () {
    new S.Session();   // 20:00 in the user's timezone
    T.eq(fns()._dailyBriefing().greeting, 'Good evening');
});

T.test('a draft keeps the caller the user chose, and state is not a draft field', function () {
    var s = new S.Session();
    s.model(gem.calls([['start_record_draft', { record_type: 'incident', initial_short_description: 'Laptop will not boot' }],
                       ['set_record_field', { field: 'caller_id', value: 'u_beth' }],
                       ['set_record_field', { field: 'state', value: '6' }]]), gem.text('Shall I create it for Beth?'));
    s.say('log an incident for Beth Anglin, her laptop will not boot');
    T.match(lastResult(s), /I can not set \\"state\\" on a new record by voice/);
    s.model(gem.call('confirm_and_create', {}), gem.text('Created.'));
    s.say('yes create it');
    T.match(lastResult(s), /Created INC\d+ for Beth Anglin - I read it back/);
    var made = g.find('incident', 'short_description', 'Laptop will not boot');
    T.eq(made.caller_id, 'u_beth');
    T.ok(made.state !== '6', 'no resolved-on-arrival record');
});

T.test('undoing a created change cancels it with the change\'s own cancel state, read back', function () {
    var s = new S.Session();
    g.put('change_request', { sys_id: 'chg9', number: 'CHG0030009', state: '-5', active: 'true', short_description: 'x' });
    g.GlideRecord.refuseDelete.change_request = true;
    s.setBlob({ last_action: { kind: 'created', number: 'CHG0030009', table: 'change_request' } });
    s.model(gem.call('undo_last_action', {}), gem.text('Cancelled.'));
    T.match(s.say('undo creating that change').message, /That would delete \*\*change ending 0 0 9\*\* that I created.*Shall I\?/);
    T.match(s.say('yes').message, /CHG0030009 is cancelled and closed instead\. I read it back/);
    T.eq(g.find('change_request', 'number', 'CHG0030009').state, '4');
    g.GlideRecord.refuseDelete.problem = true;
    g.put('problem', { sys_id: 'prb9', number: 'PRB0040009', state: '101', active: 'true', short_description: 'y' });
    s.setBlob({ last_action: { kind: 'created', number: 'PRB0040009', table: 'problem' } });
    s.model(gem.call('undo_last_action', {}), gem.text('Could not.'));
    s.say('undo creating that problem');
    T.match(s.say('yes').message, /has no cancelled state I can set - it is still open/);
    delete g.GlideRecord.refuseDelete.change_request; delete g.GlideRecord.refuseDelete.problem;
});

T.test('undo with ticket writes switched off changes nothing', function () {
    var s = new S.Session();
    g.P.PROPS['x_196061_netra_v1.ticket_writes'] = 'false';
    s.setBlob({ last_action: { kind: 'field', number: 'INC0010013', table: 'incident', field: 'assignment_group', old: 'g_db', old_display: 'Database' } });
    var r = fns()._undoLastAction();
    T.match(r.error, /switched off by the administrator/);
    T.eq(s.inc('INC0010013').assignment_group, 'g_net');
});

T.test('SLA radar: the user\'s own SLAs that can still be saved, not long-breached ones elsewhere', function () {
    new S.Session();
    g.put('sys_user_grmember', { user: 'u_admin', group: 'g_net' });
    g.put('contract_sla', { sys_id: 'sla_p3', name: 'P3 resolution' });
    g.put('incident', { sys_id: 'inc77', number: 'INC0010077', assignment_group: 'g_sw', state: '2', active: 'true', short_description: 'other team' });
    g.put('task_sla', { task: 'inc13', sla: 'sla_p3', percentage: '92', active: 'true', has_breached: 'false', stage: 'in_progress' });
    g.put('task_sla', { task: 'inc14', sla: 'sla_p3', percentage: '250', active: 'true', has_breached: 'true', stage: 'in_progress' });
    g.put('task_sla', { task: 'inc77', sla: 'sla_p3', percentage: '85', active: 'true', has_breached: 'false', stage: 'in_progress' });
    var r = fns()._slaRadar();
    T.eq(r.at_risk.length, 1);
    T.eq(r.at_risk[0].number, 'INC0010013');
    T.eq(r.at_risk[0].sla, 'P3 resolution');
    g.find('task_sla', 'task', 'inc13').percentage = '30';
    T.match(fns()._slaRadar().message, /running on your work, and none is past 60 percent/, 'SLAs running is not "no SLAs here"');
});

T.test('watchlist speaks the true total, and a focus expires after 12 hours', function () {
    new S.Session();
    for (var i = 0; i < 20; i++) g.put('x_196061_netra_v1_watchlist', { user: 'u_admin', record_number: 'INC00200' + (10 + i), record_table: 'incident' });
    T.match(fns()._listWatchlist().message, /^Watching 20 tickets; the newest 15 are listed\.$/);
    var f = fns();
    T.eq(f._recallFocus().focus, null, 'no focus is no focus, not an empty one');
    f._setFocusTicket('INC0010013');
    T.eq(fns()._recallFocus().focus.number, 'INC0010013');
    g.P.now += 13 * H;
    T.eq(fns()._recallFocus().focus, null, 'yesterday\'s focus is not "this ticket"');
});

T.test('batch update refuses a state code the table does not have', function () {
    var s = new S.Session();
    g.put('change_request', { sys_id: 'chg8', number: 'CHG0030008', state: '-5', active: 'true', short_description: 'z' });
    [['incident', '6'], ['incident', '2'], ['change_request', '-5'], ['change_request', '3']].forEach(function (c) { g.put('sys_choice', { name: c[0], element: 'state', value: c[1], inactive: 'false' }); });
    s.model(gem.call('batch_update_tickets', { ticket_numbers: ['INC0010013', 'CHG0030008'], state: '6' }), gem.text('Done.'));
    s.say('resolve 13 and the change 8');
    var r = s.say('yes').message;
    T.match(r, /I updated 1 of 2 tickets/);
    T.match(r, /state 6 does not exist on a change request/);
    T.eq(g.find('change_request', 'number', 'CHG0030008').state, '-5');
    T.eq(s.inc('INC0010013').state, '6');
});

T.test('undoing a plan: the user\'s permissions, each table\'s own cancel state, read back', function () {
    var s = new S.Session();
    g.put('change_request', { sys_id: 'chg7', number: 'CHG0030007', state: '-5', active: 'true', short_description: 'c' });
    s.setBlob({ plan: { id: 'P9', steps: [], cursor: 2, confirmed: true, finished: true, results: [],
                        undo: [{ kind: 'created', number: 'CHG0030007' },
                               { kind: 'fields', table: 'incident', sys_id: 'inc13', number: 'INC0010013', before: { assignment_group: 'g_db' }, after: { assignment_group: 'g_net' } }] } });
    g.P.ACL = function (table, op, rec) { return !(table === 'incident' && op === 'write'); };
    var r = fns()._undoPlan();
    T.eq(g.find('change_request', 'number', 'CHG0030007').state, '4', 'a change is cancelled with state 4');
    T.eq(s.inc('INC0010013').assignment_group, 'g_net', 'no write the user could not make');
    T.match(JSON.stringify(r), /you do not have permission to change INC0010013/);
});

T.run(__filename);
