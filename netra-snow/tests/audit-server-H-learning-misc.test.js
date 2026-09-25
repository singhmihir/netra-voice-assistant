/*
 * Audit fixes (server-H-learning-misc): update_field writes the record the
 * user meant and can be undone, buttons are pressed only when they can be
 * told apart, script narration reads the real code (admins only), approval
 * triage names real records with true counts, build_query accepts what its
 * prompt teaches on ticket tables only, and a stopped plan needs a fresh yes.
 */
'use strict';
var T = require('./lib/t'), S = require('./lib/session'), N = require('./lib/netra'), g = S.g, gem = S.gem;
function fns() { return N.loadServer({ input: { action: 'chat' } }).fn; }
function lastToolResult(s) { return JSON.stringify(s.gemini.generate[s.gemini.generate.length - 1].contents.slice(-1)); }

/* ---------- update_field: references ---------- */

T.test('update_field: an exact group name wins, several matches ask, no match writes nothing', function () {
    var s = new S.Session();
    // "Network CAB Managers" is found first by a LIKE query
    delete g.P.STORE.sys_user_group.g_net;
    g.put('sys_user_group', { sys_id: 'g_net', name: 'Network', active: 'true' });
    s.inc('INC0010017').assignment_group = 'g_sw';
    var f = fns();
    var r = f._updateField('INC0010017', 'assignment group', 'Network');
    T.ok(r.ok, JSON.stringify(r));
    T.eq(s.inc('INC0010017').assignment_group, 'g_net', 'the exact name, not Network CAB Managers');
    T.eq(r.new_value, 'Network', 'says the group it really wrote');
    T.match(r.message, /Assignment group on INC0010017 is now Network - I read it back/);

    var amb = fns()._updateField('INC0010017', 'group', 'data');
    T.ok(!amb.ok && amb.ambiguous, JSON.stringify(amb));
    T.match(amb.error, /matches more than one group: Database, Database San Diego - which one\?/);
    T.eq(s.inc('INC0010017').assignment_group, 'g_net', 'nothing written on an ambiguous name');

    var none = fns()._updateField('INC0010017', 'assignment_group', 'Nonexistent Team');
    T.ok(!none.ok, 'no match is refused');
    T.eq(s.inc('INC0010017').assignment_group, 'g_net', 'spoken text never lands in a reference field');
});

T.test('update_field: an ambiguous person asks instead of picking one', function () {
    var s = new S.Session();
    var r = fns()._updateField('INC0010016', 'assignee', 'Anglin');
    T.ok(!r.ok && r.ambiguous, JSON.stringify(r));
    T.eq(s.inc('INC0010016').assigned_to || '', '', 'nobody assigned');
    var ok = fns()._updateField('INC0010016', 'assigned to', 'Bert Anglin');
    T.eq(s.inc('INC0010016').assigned_to, 'u_bert');
    T.eq(ok.new_value, 'Bert Anglin');
});

T.test('update_field: a configuration item is looked up, never written as raw text', function () {
    var s = new S.Session();
    g.put('cmdb_ci_linux_server', { sys_id: 'ci_web', name: 'web01' });
    g.put('cmdb_ci_linux_server', { sys_id: 'ci_webdb', name: 'web01-db' });
    g.P.DISPLAY.ci_web = 'web01';
    var r = fns()._updateField('INC0010015', 'ci', 'web01');
    T.ok(r.ok, JSON.stringify(r));
    T.eq(s.inc('INC0010015').cmdb_ci, 'ci_web', 'exact CI name');
    var amb = fns()._updateField('INC0010015', 'configuration item', 'web');
    T.ok(!amb.ok && amb.ambiguous, JSON.stringify(amb));
    T.match(amb.error, /web01, web01-db - which one\?/);
    T.ok(!fns()._updateField('INC0010015', 'cmdb_ci', 'nothing-like-this').ok);
    T.eq(s.inc('INC0010015').cmdb_ci, 'ci_web', 'unchanged');
});

/* ---------- update_field: choice scales ---------- */

T.test('update_field: urgency and impact words use their own 1-3 scale', function () {
    var s = new S.Session();
    var f = fns();
    var r = f._updateField('INC0010013', 'urgency', 'high');
    T.eq(s.inc('INC0010013').urgency, '1', '"high" urgency is 1 - High, not 2 - Medium');
    T.match(r.message, /Urgency on INC0010013 is now 1 - High - I read it back/);
    T.eq(r.new_value, '1 - High');
    fns()._updateField('INC0010013', 'impact', 'medium');
    T.eq(s.inc('INC0010013').impact, '2');
    fns()._updateField('INC0010013', 'urgency', 'low');
    T.eq(s.inc('INC0010013').urgency, '3', 'low is 3, never the invalid 4');
    var bad = fns()._updateField('INC0010013', 'urgency', 'extreme');
    T.ok(!bad.ok, 'an unknown word is refused');
    T.eq(s.inc('INC0010013').urgency, '3', 'and nothing is written');
});

T.test('update_field: a priority word goes through the priority lever and can be undone', function () {
    var s = new S.Session();
    var r = fns()._updateField('INC0010014', 'priority', 'high');
    T.ok(r.ok && r.verified, JSON.stringify(r));
    T.eq(s.inc('INC0010014').priority, '2', 'high priority is 2');
    T.eq(s.blob().last_action.kind, 'fields', 'the impact/urgency move is on record for undo');
    T.eq(s.blob().last_action.number, 'INC0010014');
    T.ok(!fns()._updateField('INC0010014', 'priority', 'whenever').ok, 'unknown priority word refused');
});

/* ---------- update_field: undo and honest journal writes ---------- */

T.test('"undo that" after update_field reverses that field, not an older action', function () {
    var s = new S.Session();
    s.setBlob({ last_action: { kind: 'resolved', number: 'INC0010013', table: 'incident', old_state: '2' } });
    s.model(gem.call('update_field', { ticket_number: 'INC0010014', field: 'urgency', value: 'high' }), gem.text('Urgency is now high.'));
    s.say('change the urgency of INC0010014 to high');
    T.eq(s.inc('INC0010014').urgency, '1');
    var rb = s.say('undo that');
    T.match(rb.message, /put urgency on \*\*incident ending 0 1 4\*\* back to 2 - Medium/);
    T.match(s.say('yes').message, /Undone/);
    T.eq(s.inc('INC0010014').urgency, '2', 'urgency restored');
    T.eq(s.inc('INC0010013').state, '2', 'the older ticket was not touched');
});

T.test('update_field journal writes: "added", never "verified", and a refused note is reported', function () {
    var s = new S.Session();
    var r = fns()._updateField('INC0010013', 'work notes', 'checked the VPN logs');
    T.ok(r.ok, JSON.stringify(r));
    // journal entries are read back from the journal before "added" is said
    T.match(r.message, /Added the work note to INC0010013 - I read it back/);
    T.eq(s.inc('INC0010013')._work_notes, ['checked the VPN logs']);
    g.P.ACL = function (table, op) { return !(table === 'incident' && op === 'write'); };
    var denied = fns()._updateField('INC0010014', 'comments', 'hello');
    T.ok(!denied.ok, 'refused write is not success: ' + JSON.stringify(denied));
    T.ok(!s.inc('INC0010014')._comments, 'nothing written with permissions the user does not have');
});

/* ---------- click_button ---------- */

T.test('click_button sends the whole label, refuses undoing forms, and never claims a click', function () {
    new S.Session();
    var f = fns();
    var r = f._clickButton('Close Incomplete');
    T.eq(r.click_button_label, 'close incomplete', 'the whole label, not "close"');
    T.notMatch(r.message, /^Clicking/);
    ['Unresolve', 'Disapprove', 'Feedback', 'Postpone', 'un-approve'].forEach(function (l) {
        var x = f._clickButton(l);
        T.ok(!x.ok && !x.click_button_label, l + ' must be refused: ' + JSON.stringify(x));
    });
    T.eq(f._clickButton('cancel change').click_button_label, 'cancel change');
    T.ok(f._ticketMutateTools().click_button, 'the kill switch covers form buttons');
    g.P.PROPS['x_196061_netra_v1.ticket_writes'] = 'false';
    T.ok(fns()._runTool('click_button', { label: 'Resolve' }).read_only, 'refused with writes switched off');
    T.ok(!fns()._toolDeclarations(false)[0].functionDeclarations.some(function (d) { return d.name === 'click_button'; }), 'not declared with writes off');
});

T.test('the page presses only a button it can tell apart, and says what happened', function () {
    var cl = N.loadClient();
    var clicked = [];
    function btn(text, aria) {
        return { textContent: text, disabled: false, getAttribute: function (a) { return a === 'aria-label' ? (aria || null) : null; },
                 getBoundingClientRect: function () { return { width: 60, height: 20 }; }, closest: function () { return null; },
                 click: function () { clicked.push(text); } };
    }
    var page = [btn('Close Complete'), btn('Close Incomplete'), btn('Update'), btn(' Update '), btn('Resolve Incident'), btn('Feedback')];
    global.document = { querySelector: function () { return { querySelectorAll: function () { return page; } }; } };
    var ex = cl.fn._pickButton('close incomplete');
    T.eq(ex.name, 'Close Incomplete', 'exact match');
    var amb = cl.fn._pickButton('close');
    T.eq(amb.el, null, 'two different Close buttons: nothing pressed');
    T.match(amb.say, /Close Complete, Close Incomplete\. I pressed nothing - which one\?/);
    T.ok(cl.fn._pickButton('update').el, 'the same button in header and footer is one button');
    T.eq(cl.fn._pickButton('resolve').name, 'Resolve Incident', 'one whole-word partial match is fine');
    var none = cl.fn._pickButton('back');
    T.eq(none.el, null, '"Feedback" is not "back"');
    T.match(none.say, /could not find a "back" button on this page, so I pressed nothing/);
    T.eq(clicked, [], 'picking never clicks by itself');
    var src = require('fs').readFileSync(require('path').join(N.SRC, 'widget', 'client.js'), 'utf8');
    T.match(src, /r\.message = String\(r\.message \|\| ''\) \+ ' ' \+ btnPick\.say;/, 'the outcome is spoken with the reply');
    delete global.document;
});

/* ---------- narrate_script / read_script ---------- */

T.test('narrate_script sends the real source to the model, with secrets masked', function () {
    var s = new S.Session();
    g.put('sys_script_include', { name: 'NetraDemo', active: 'true', description: 'demo',
                                  script: "var NetraDemo = function () { var password = 'hunter22'; return 42; };" });
    s.gemini = gem.install(g.P, [gem.text('It returns forty two.')]);
    var r = fns()._narrateScript('NetraDemo');
    T.ok(r.ok, JSON.stringify(r));
    var sent = JSON.stringify(s.gemini.generate[0]);
    T.match(sent, /return 42/, 'the model was given the code');
    T.notMatch(sent, /hunter22/, 'the literal password never leaves the instance');
    T.match(sent, /\[redacted\]/);
    g.put('sys_script_include', { name: 'EmptyOne', active: 'true', script: '' });
    var e = fns()._narrateScript('EmptyOne');
    T.ok(!e.ok, 'no code, no narration');
    T.match(e.error, /has no code to read/);
    T.eq(s.gemini.generate.length, 1, 'no model call spent on an empty script');
});

T.test('reading platform code needs the admin role', function () {
    var s = new S.Session();
    g.put('sys_script_include', { name: 'IntegrationCreds', active: 'true', script: 'var key = 1;' });
    g.P.ROLES = { itil: true };
    var f = fns();
    T.match(f._readScript('IntegrationCreds').error, /needs the admin role/);
    T.match(f._listScripts('sys_script_include', '').error, /needs the admin role/);
    T.ok(!f._narrateScript('IntegrationCreds').ok);
    T.eq(s.gemini.generate.length, 0, 'nothing sent to the model');
    var names = f._toolDeclarations(false)[0].functionDeclarations.map(function (d) { return d.name; });
    T.ok(names.indexOf('read_script') < 0 && names.indexOf('narrate_script') < 0 && names.indexOf('list_scripts') < 0, 'not offered to the model');
    g.P.ROLES = null;
    T.ok(fns()._readScript('IntegrationCreds').ok, 'an admin can still read it');
});

/* ---------- triage_approvals ---------- */

T.test('triage_approvals: a true total, and each verdict names its real record', function () {
    var s = new S.Session();
    for (var i = 1; i <= 17; i++) {
        var n = ('0' + i).slice(-2);
        g.put('sc_req_item', { sys_id: 'ritm' + n, number: 'RITM00100' + n, short_description: 'Request ' + n });
        g.put('sysapproval_approver', { approver: 'u_admin', state: 'requested', source_table: 'sc_req_item', sysapproval: 'ritm' + n,
                                        sys_created_on: g.fmtUtc(g.P.now - i * 60000) });
    }
    s.gemini = gem.install(g.P, [gem.json({ summary: 'You have 15 approvals pending.', items: [
        { index: 3, level: 'ROUTINE', rationale: 'Standard laptop.' },
        { index: 12, level: 'RISKY', rationale: 'Touches production.' },
        { index: 99, level: 'RISKY', rationale: 'Invented.' }] })]);
    var r = fns()._triageApprovals();
    T.ok(r.ok, JSON.stringify(r));
    T.eq(r.count, 17, 'the true total');
    T.eq(r.triaged, 15);
    T.eq(r.triage.length, 2, 'an index outside the list is dropped');
    T.eq([r.triage[0].number, r.triage[0].level], ['RITM0010012', 'RISKY'], 'riskiest first, with its number');
    T.eq(r.triage[1].number, 'RITM0010003');
    T.match(r.message, /I triaged the newest 15 of your 17 pending approvals\. RITM0010012 \(Request 12\) is risky: Touches production/);
    T.notMatch(r.message, /You have 15/);
});

/* ---------- build_query ---------- */

T.test('build_query accepts the helpers its prompt teaches and any operator', function () {
    new S.Session();
    var q = 'priority=1^short_descriptionLIKEVPN^opened_at>=javascript:gs.daysAgoStart(7)^assignment_groupINjavascript:gs.getUser().getMyGroups().join(",")';
    [q, 'priority=1^active=true^assigned_toISEMPTY^due_date<javascript:gs.nowDateTime()', 'stateIN1,2,3', 'assigned_toISEMPTY'].forEach(function (eq) {
        var sess = S.g.P;
        var log = gem.install(sess, [gem.json({ encoded_query: eq, explanation: 'x' })]);
        var r = fns()._buildQuery('some filter', 'incident');
        T.ok(r.ok, eq + ' should be accepted: ' + JSON.stringify(r));
        T.eq(log.generate.length, 1);
    });
});

T.test('build_query refuses script after a helper, unknown fields and non-ticket tables', function () {
    new S.Session();
    gem.install(g.P, [gem.json({ encoded_query: 'assigned_to=javascript:gs.getUserID();gs.eventQueue("x")' })]);
    T.match(fns()._buildQuery('mine', 'incident').error, /unsupported javascript: helper/);
    g.P.INVALID_FIELDS.incident = { flux: true };
    gem.install(g.P, [gem.json({ encoded_query: 'flux=1^active=true' })]);
    var bad = fns()._buildQuery('flux tickets', 'incident');
    T.ok(!bad.ok && bad.match_count === undefined, 'no count for a filter the platform would ignore: ' + JSON.stringify(bad));
    var log = gem.install(g.P, []);
    T.match(fns()._buildQuery('reset codes for alice', 'sys_email').error, /only build filters on incidents/);
    g.P.ACL = function (table, op) { return !(table === 'problem' && op === 'read'); };
    T.match(fns()._buildQuery('open problems', 'problem').error, /do not have access to problem records/);
    T.eq(log.generate.length, 0, 'refused before any quota is spent');
});

/* ---------- execute_plan: a stopped plan needs a fresh yes ---------- */

function sixStepPlan(s) {
    var steps = [13, 14, 15, 16, 17, 18].map(function (n) {
        return { tool: 'assign_ticket_to_group', args: { ticket_number: 'INC00100' + n, group_name: 'Database' } };
    });
    s.model(gem.call('make_plan', { steps: steps }), gem.text('Six reassignments. Shall I run it?'));
    s.say('move 13 to 18 to Database');
    s.say('yes');   // runs four steps, two to go
}

T.test('a stopped plan does not resume on its old yes', function () {
    var s = new S.Session();
    sixStepPlan(s);
    T.eq(s.inc('INC0010016').assignment_group, 'g_db');
    T.eq(s.inc('INC0010017').assignment_group, 'g_net', 'budget used after four');
    T.match(s.say('stop').message, /Stopped the plan - 4 of 6/);
    s.model(gem.call('execute_plan', {}), gem.text('It stopped after four of six. What is left: 17 and 18 to Database. Shall I carry on?'));
    s.say('finish the rest of that plan');
    T.eq(s.inc('INC0010017').assignment_group, 'g_net', 'not run on the old yes');
    T.eq(s.inc('INC0010018').assignment_group, 'g_net');
    T.match(lastToolResult(s), /Read the REMAINING steps back/);
    T.match(lastToolResult(s), /5\. assign \*\*incident ending 0 1 7\*\* to the group Database/);
    T.ok(!s.blob().plan.confirmed, 'waiting for a fresh yes');
    var r = s.say('yes');
    T.match(r.message, /Plan complete/);
    T.eq([s.inc('INC0010017').assignment_group, s.inc('INC0010018').assignment_group], ['g_db', 'g_db']);
});

T.test('a plan paused for a long time is read back before it carries on; "no" keeps it undoable', function () {
    var s = new S.Session();
    sixStepPlan(s);
    S.g.P.now += 20 * 60000;   // the page was closed between hops
    s.model(gem.call('execute_plan', {}), gem.text('Shall I carry on?'));
    s.say('finish the plan');
    T.eq(s.inc('INC0010017').assignment_group, 'g_net', 'not run');
    var no = s.say('no');
    T.match(no.message, /will not carry on - 4 of 6 steps were done earlier\. Say "undo the plan"/);
    T.ok(s.blob().plan && s.blob().plan.halted, 'kept, stopped');
    T.match(s.say('undo the plan').message, /put back 4 changes/);
    s.say('yes');
    T.eq(s.inc('INC0010013').assignment_group, 'g_net', 'the finished steps were put back');
});

T.run(__filename);
