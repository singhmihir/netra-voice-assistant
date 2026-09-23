/* Record intelligence tells the truth: who a message really went to, true counts, current articles, real fields. */
'use strict';
var T = require('./lib/t'), S = require('./lib/session'), N = require('./lib/netra'), g = S.g;
function fns() { return N.loadServer({ input: { action: 'chat' } }).fn; }

T.test('sidebar message: ambiguous names ask, and "sent" is claimed only after a read-back', function () {
    new S.Session();
    var f = fns();
    T.match(f._sendSidebarMessage('Anglin', '', 'server is back').error, /matches more than one person/);
    var ok = f._sendSidebarMessage('Beth Anglin', '', 'server is back');
    T.ok(ok.ok && ok.verified, JSON.stringify(ok));
    g.GlideRecord.refuseInsert.sys_sidebar_discussion_message = true;
    var bad = f._sendSidebarMessage('Beth Anglin', '', 'second message');
    T.ok(!bad.ok, 'refused insert is not reported as sent');
    T.match(bad.error, /nothing was sent/);
    T.eq(Object.keys(g.P.STORE.sys_sidebar_discussion).length, 1, 'the half-made discussion was cleaned up');
});

T.test('a KB number reads the current published version', function () {
    new S.Session();
    g.put('kb_knowledge', { number: 'KB0010023', short_description: 'VPN fix (old)', text: 'old steps', workflow_state: 'outdated', active: 'true', sys_updated_on: '2026-01-01 00:00:00' });
    g.put('kb_knowledge', { number: 'KB0010023', short_description: 'VPN fix', text: 'current steps', workflow_state: 'published', active: 'true', sys_updated_on: '2026-06-01 00:00:00' });
    var r = fns()._readKnowledgeArticle('kb 10023');
    T.ok(r.ok, JSON.stringify(r));
    T.eq(r.body, 'current steps');
    T.match(fns()._readKnowledgeArticle('KB0099999').error, /no published article KB0099999 that you can read/);
});

T.test('related records: spoken counts are totals, not the five-item samples', function () {
    new S.Session();
    for (var i = 0; i < 12; i++) g.put('sys_attachment', { table_sys_id: 'inc13', file_name: 'f' + i + '.png', size_bytes: '2048' });
    for (var j = 0; j < 8; j++) g.put('task_ci', { task: 'inc13', ci_item: 'ci' + j });
    var r = fns()._relatedRecords('INC0010013', '');
    T.match(r.message, /12 attachments, 0 SLAs, 0 child tasks, 8 affected CIs/);
    T.eq(r.attachments.length, 5, 'still a short sample to read from');
});

T.test('approvals: requested, waiting their turn and decided are told apart', function () {
    new S.Session();
    ['requested', 'requested', 'not_yet_requested', 'approved'].forEach(function (st) { g.put('sysapproval_approver', { sysapproval: 'inc13', approver: 'u_beth', state: st }); });
    var r = fns()._approvalsForRecord('INC0010013');
    T.eq([r.pending, r.waiting_their_turn, r.decided], [2, 1, 1]);
    T.match(r.message, /2 approval\(s\) still pending on INC0010013, and 1 waiting their turn/);
    T.ok(!/^\d{4}-/.test(r.approvals[0].since), 'no raw UTC timestamps for the model to misread');
});

T.test('reminders: long ones are the scanner\'s; cancelling matches the words and asks when unsure', function () {
    new S.Session();
    var f = fns();
    T.eq(f._setReminder('check the backup', 960).reminder_at_ms, 0, 'no page timer beyond 12 hours');
    T.eq(f._setReminder('call the vendor', 30).reminder_at_ms, 30 * 60000);
    var amb = f._cancelReminder('the reminder');
    T.ok(amb.ambiguous, 'two pending, "the reminder" is not enough');
    var one = f._cancelReminder('the vendor reminder');
    T.ok(one.ok && one.cancel_reminder_ids.length === 1, JSON.stringify(one));
    T.match(one.message, /Cancelled the reminder to call the vendor/);
});

T.test('field change effects: a spoken label finds the real column; unknown fields are said to be unknown', function () {
    new S.Session();
    g.put('sys_ui_policy', { table: 'incident', active: 'true', short_description: 'CI needs a service', conditions: 'cmdb_ciISNOTEMPTY' });
    var f = fns();
    var r = f._fieldChangeEffects('configuration item', 'INC0010013', '');
    T.eq(r.field, 'cmdb_ci');
    g.P.INVALID_FIELDS.incident = { flux_capacitor: true };
    T.match(f._fieldChangeEffects('flux capacitor', 'INC0010013', '').error, /could not find a field called "flux capacitor"/);
});

T.test('change summaries read comments from the journal', function () {
    new S.Session();
    g.put('change_request', { sys_id: 'chg1', number: 'CHG0030001', short_description: 'Patch', state: '-1' });
    g.put('sys_journal_field', { element_id: 'chg1', element: 'comments', value: 'Implementer: window moved to Friday', sys_created_by: 'beth.anglin', sys_created_on: g.fmtUtc(g.P.now - 3600000) });
    var r = fns()._summarizeChange('CHG0030001');
    T.eq(r.journal.length, 1);
    T.match(r.journal[0].text, /window moved to Friday/);
});

T.run(__filename);
