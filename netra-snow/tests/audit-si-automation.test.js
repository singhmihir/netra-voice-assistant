/*
 * The background automation tells the truth and only does what was
 * authorised: standing orders never lower a priority, never leave a failed
 * lever half-pulled, never act on closed work, chase the owner's own
 * approvals, stay out of quiet hours without starving; work notes reach
 * fulfillers only; the outage radar and assignment alerts speak true facts.
 */
'use strict';
var T = require('./lib/t'), S = require('./lib/session'), N = require('./lib/netra'), gem = S.gem, g = S.g;
var fs = require('fs'), path = require('path'), vm = require('vm');
var H = 3600000;
var NOTIF = 'x_196061_netra_v1_notification', TASK = 'x_196061_netra_v1_task', PREF = 'x_196061_netra_v1_user_pref';

function runner() { N.loadScriptIncludes(); return new NetraTaskRunner(); }
function scanner() { N.loadScriptIncludes(); return new NetraScanner(); }
function rows(table, pred) {
    var st = g.P.STORE[table] || {}, out = [];
    for (var k in st) if (st.hasOwnProperty(k) && (!pred || pred(st[k]))) out.push(st[k]);
    return out;
}
function reports(uid) { return rows(NOTIF, function (n) { return n.kind === 'task_report' && n.user === (uid || 'u_admin'); }).map(function (n) { return n.message; }); }
function order(o) {
    return g.put(TASK, { user: 'u_admin', nt_number: o.nt || 'NT0001', kind: o.kind || 'watch_ticket', state: 'active',
                         action: o.action || 'notify_only', action_params: JSON.stringify(o.params || {}),
                         condition_json: JSON.stringify(o.cond || {}), target_table: o.table || 'incident',
                         target_sys_id: o.sys_id || '', target_number: o.number || '',
                         next_check_at: g.fmtUtc(g.P.now - 60000), expires_at: g.fmtUtc(g.P.now + (o.expires_h || 72) * H),
                         fire_count: '0', max_fires: '1', action_log: '[]', undo_json: '' });
}
function task(id) { return g.P.STORE[TASK][id]; }
function id32(s) { while (s.length < 32) s += '0'; return s; }
function role(uid, name) {
    var r = g.find('sys_user_role', 'name', name) || g.rec('sys_user_role', g.put('sys_user_role', { name: name }));
    g.put('sys_user_has_role', { user: uid, role: r.sys_id });
}
function pref(uid, extra) {
    var p = { user: uid, active: 'true', watch_assignments: 'true', watch_comments: 'true', watch_approvals: 'true', last_scan_time: g.fmtUtc(g.P.now - 3 * 60000) };
    for (var k in extra || {}) p[k] = extra[k];
    return g.put(PREF, p);
}

/* ---- #1 escalate_priority never lowers a more urgent ticket ---- */

T.test('escalate to 2 on a ticket someone already made P1 leaves it alone and says so', function () {
    var s = new S.Session();
    var inc = s.inc('INC0010013');
    inc.impact = '1'; inc.urgency = '1'; inc.priority = '1';          // the service desk made it critical
    var t = order({ action: 'escalate_priority', params: { priority: '2' }, cond: { still_unassigned: true }, sys_id: 'inc13', number: 'INC0010013' });
    runner().run();
    inc = s.inc('INC0010013');
    T.eq([inc.priority, inc.impact, inc.urgency], ['1', '1', '1'], 'not downgraded');
    T.eq(inc._work_notes, undefined, 'no "Priority raised 1 -> 2" note');
    var said = reports().join(' | ');
    T.match(said, /INC0010013 is already at priority 1, more urgent than the 2 you asked for - I left it alone/);
    T.notMatch(said, /I escalated/);
    T.eq(task(t).undo_json, '', 'nothing to undo');
});

T.test('an escalation target that is not a priority fails closed', function () {
    var s = new S.Session();
    var t = order({ action: 'escalate_priority', params: { priority: 'urgent-ish 12' }, cond: { still_unassigned: true }, sys_id: 'inc14', number: 'INC0010014' });
    runner().run();
    T.eq(s.inc('INC0010014').priority, '3');
    T.eq(task(t).state, 'error');
});

/* ---- #2 a failed priority lever is put back, or reported as it is ---- */

function customLookup(pin) {
    // a customised priority lookup: impact 1 x urgency 2 is P1 here
    var MAP = { '1,1': '1', '1,2': '1', '2,1': '2', '2,2': '3', '1,3': '3', '3,1': '3', '2,3': '4', '3,2': '4', '3,3': '5' };
    g.GlideRecord.onUpdate.incident = function (next, old) {
        if (pin && old.impact === '1' && next.impact !== '1') next.impact = '1';   // a rule that will not let impact drop
        next.priority = MAP[next.impact + ',' + next.urgency] || next.priority;
    };
}

T.test('the matrix misses the target: impact and urgency go back, and "nothing changed" is true', function () {
    var s = new S.Session(); customLookup(false);
    var t = order({ action: 'escalate_priority', params: { priority: '2' }, cond: { due_at_ms: g.P.now - 1 }, sys_id: 'inc14', number: 'INC0010014' });
    runner().run();
    var inc = s.inc('INC0010014');
    T.eq([inc.priority, inc.impact, inc.urgency], ['3', '2', '2'], 'not left at P1');
    T.eq(task(t).state, 'error');
    T.match(reports().join(' '), /could not move INC0010014 to priority 2 \(wrote impact 1 urgency 2 but priority read back 1, so I put impact and urgency back\)\. Nothing was changed\./);
});

T.test('when the put-back does not hold, the user hears what is on the ticket and can undo it', function () {
    var s = new S.Session(); customLookup(true);
    var t = order({ action: 'escalate_priority', params: { priority: '2' }, cond: { due_at_ms: g.P.now - 1 }, sys_id: 'inc14', number: 'INC0010014' });
    runner().run();
    var inc = s.inc('INC0010014');
    T.eq([inc.priority, inc.impact, inc.urgency], ['1', '1', '2']);
    var said = reports().join(' ');
    T.notMatch(said, /Nothing was changed/);
    T.match(said, /It is now priority 1, impact 1, urgency 2, and I could not put it back - say undo task 1 to try again\./);
    var u = JSON.parse(task(t).undo_json);
    T.eq([u.restore, u.target_was], [{ impact: '2', urgency: '2' }, '1']);
    T.match(JSON.parse(task(t).action_log).pop().what, /It is now priority 1/, 'the debrief reads the same truth');
    customLookup(false);                                   // the blocking rule is gone
    var r = runner().undoTask('NT0001', 'u_admin');
    T.ok(r.ok, JSON.stringify(r));
    inc = s.inc('INC0010014');
    T.eq([inc.priority, inc.impact, inc.urgency], ['3', '2', '2']);
});

/* ---- #3 work notes reach fulfillers only; radar goes to fulfillers ---- */

var CALLER = id32('caller'), FUL = id32('fulfiller'), WATCHER = id32('watcher'), AUTHOR = id32('author');
var BR = fs.readFileSync(path.join(N.SRC, 'business_rule', 'netra_notify_on_comment.js'), 'utf8').replace(/__NETRA_SCOPE__/g, 'x_196061_netra_v1');
function brWorld() {
    new S.Session();
    N.loadScriptIncludes();
    g.put('sys_user', { sys_id: CALLER, user_name: 'end.user', name: 'End User', active: 'true' });
    g.put('sys_user', { sys_id: FUL, user_name: 'fixer', name: 'Fixer', active: 'true' });
    g.put('sys_user', { sys_id: WATCHER, user_name: 'watcher', name: 'Watcher', active: 'true' });
    g.put('sys_user', { sys_id: AUTHOR, user_name: 'beth.x', name: 'Beth X', first_name: 'Beth', last_name: 'X', active: 'true' });
    role(FUL, 'itil');
    pref(CALLER); pref(FUL);                                // the watcher never opened Netra
    var inc = g.find('incident', 'number', 'INC0010013');
    inc.caller_id = CALLER; inc.assigned_to = FUL; inc.watch_list = WATCHER;
}
function journal(element, text) {
    var jid = g.put('sys_journal_field', { name: 'incident', element_id: 'inc13', element: element, value: text, sys_created_by: 'beth.x' });
    var cur = new g.GlideRecord('sys_journal_field'); cur.get(jid);
    global.current = cur; global.previous = null;
    vm.runInThisContext(BR, { filename: 'netra_notify_on_comment.js' });
}
function heard(uid) { return rows(NOTIF, function (n) { return n.user === uid; }); }

T.test('a work note is never queued for the caller or a watcher, only for the fulfiller', function () {
    brWorld();
    journal('work_notes', 'Caller is on the PIP list, HR asked us to deprioritise');
    T.eq(heard(CALLER).length, 0, 'the caller hears nothing');
    T.eq(heard(WATCHER).length, 0, 'no Netra pref, nothing queued');
    T.eq(heard(FUL).map(function (n) { return n.kind; }), ['work_note']);
});

T.test('comments reach Netra users who want them, and nobody else', function () {
    brWorld();
    journal('comments', 'We are rebooting the VPN');
    T.eq(heard(CALLER).map(function (n) { return n.kind; }), ['comment']);
    T.eq(heard(FUL).length, 1);
    T.eq(heard(WATCHER).length, 0);
    g.find(PREF, 'user', FUL).watch_comments = 'false';
    journal('comments', 'Second update');
    T.eq(heard(FUL).length, 1, 'comment alerts off: nothing new');
    T.eq(heard(CALLER).length, 2);
});

T.test('the shared Guest user of the public page never gets an inbox, even with an old preference row', function () {
    brWorld();
    var GUEST = id32('guest');
    g.put('sys_user', { sys_id: GUEST, user_name: 'guest', name: 'Guest', active: 'true' });
    pref(GUEST);                                            // written by a page load before the fix
    g.find('incident', 'number', 'INC0010013').caller_id = GUEST;
    journal('comments', 'Your laptop is ready for pickup');
    T.eq(heard(GUEST).length, 0, 'every public visitor would read it');
});

function ciCluster(name) {
    var ci = g.put('cmdb_ci', { name: name });
    g.P.DISPLAY[ci] = name;
    for (var i = 0; i < 3; i++) g.put('incident', { number: 'INC00200' + (10 + i), active: 'true', state: '1', cmdb_ci: ci, short_description: 'down' });
}

T.test('outage radar: a long CI name still gets a fresh announcement for a new flare-up, and only fulfillers hear it', function () {
    new S.Session();
    role('u_admin', 'itil');
    pref('u_admin'); pref('u_bert');                        // Bert is an end user
    ciCluster('SAP Sales and Distribution');
    T.eq(scanner().detectMajorIncidentClusters(), 1, 'announced once');
    T.eq(scanner().detectMajorIncidentClusters(), 0, 'not repeated within the hour');
    g.P.now += 3 * 24 * H;                                  // it breaks again on Thursday
    T.eq(scanner().detectMajorIncidentClusters(), 1, 'the new flare-up is announced');
    var mic = rows(NOTIF, function (n) { return n.kind === 'major_incident'; });
    T.eq(mic.map(function (n) { return n.user; }), ['u_admin', 'u_admin'], 'the end user hears none of it');
    T.ok(mic[0].ticket_sys_id.length <= 32 && mic[0].ticket_sys_id !== mic[1].ticket_sys_id, JSON.stringify(mic.map(function (n) { return n.ticket_sys_id; })));
    T.match(mic[1].ticket_sys_id, /^mic_2026092620_[0-9a-f]{8}$/);
});

/* ---- #4 chasing "my approvals" finds the owner's, however busy the instance ---- */

function approval(chgExtra, approver, when) {
    var c = { number: 'CHG00' + (39000 + (g.P.guid + 1)), approval: 'requested', state: '-3', requested_by: 'u_bert' };
    for (var k in chgExtra || {}) c[k] = chgExtra[k];
    var chg = g.put('change_request', c);
    g.put('sysapproval_approver', { sysapproval: chg, source_table: 'change_request', approver: approver || 'u_bert', state: 'requested', sys_created_on: when || g.fmtUtc(g.P.now - H) });
    return chg;
}

T.test('chase my approvals with 25 other pending approvals on the instance still finds mine', function () {
    new S.Session();
    g.P.now = Date.UTC(2026, 8, 24, 10, 0, 0);            // mid-morning, not quiet hours
    for (var i = 0; i < 25; i++) approval({}, 'u_admin');   // other people's changes
    approval({ number: 'CHG0039999', requested_by: 'u_admin' }, 'u_beth');
    var t = order({ kind: 'chase_approvals', cond: {} });
    runner().run();
    T.notMatch(reports().join(' '), /nothing is waiting on approval/);
    T.eq(task(t).state, 'active', 'still chasing');
    T.match(reports('u_beth').join(' '), /CHG0039999 is still waiting on your approval/);
    T.match(reports().join(' '), /I sent 1 approval reminder\. 1 still pending\./);
});

T.test('chasing a named change the owner opened (requested by left empty) is not a false all-clear', function () {
    new S.Session();
    g.P.now = Date.UTC(2026, 8, 24, 10, 0, 0);
    var chg = approval({ number: 'CHG0031111', requested_by: '', opened_by: 'u_admin' }, 'u_beth');
    var t = order({ kind: 'chase_approvals', cond: { source_sys_id: chg }, number: 'CHG0031111' });
    runner().run();
    T.eq(task(t).state, 'active');
    T.eq(reports('u_beth').length, 1, 'Beth reminded');
});

/* ---- #5 closed tickets end the watch; refused writes are not reported as done ---- */

T.test('a watch on a ticket that was closed ends without touching it', function () {
    var s = new S.Session();
    var inc = s.inc('INC0010015');
    inc.state = '7'; inc.active = 'false'; inc.sys_updated_on = g.fmtUtc(g.P.now - 5 * H);
    var t = order({ action: 'add_comment', params: { comment: 'Any news?' }, cond: { no_movement_hours: 4 }, sys_id: 'inc15', number: 'INC0010015' });
    runner().run();
    T.eq(s.inc('INC0010015')._comments, undefined, 'no customer-visible comment on closed work');
    T.eq(task(t).state, 'expired');
    var said = reports().join(' ');
    T.match(said, /INC0010015 was resolved or closed before your condition came true - I did nothing\./);
    T.notMatch(said, /I added your comment/);
});

T.test('"tell me when it is resolved" still fires on the resolved ticket', function () {
    var s = new S.Session();
    var inc = s.inc('INC0010016');
    inc.state = '6';
    var t = order({ action: 'notify_only', cond: { state_equals: '6' }, sys_id: 'inc16', number: 'INC0010016' });
    runner().run();
    T.eq(task(t).state, 'fired');
    T.match(reports().join(' '), /INC0010016 met your watch condition/);
});

T.test('a nudge or comment the platform refuses is a failure, not "I nudged"', function () {
    var s = new S.Session();
    g.P.now = Date.UTC(2026, 8, 24, 10, 0, 0);
    s.inc('INC0010017').assigned_to = 'u_beth';
    s.inc('INC0010017').sys_updated_on = g.fmtUtc(g.P.now - 5 * H);
    s.inc('INC0010018').sys_updated_on = g.fmtUtc(g.P.now - 5 * H);
    var a = order({ nt: 'NT0001', action: 'nudge_assignee', cond: { no_movement_hours: 4 }, sys_id: 'inc17', number: 'INC0010017' });
    var b = order({ nt: 'NT0002', action: 'add_comment', params: { comment: 'Any news?' }, cond: { no_movement_hours: 4 }, sys_id: 'inc18', number: 'INC0010018' });
    g.GlideRecord.refuseUpdate.incident = true;
    runner().run();
    T.eq([task(a).state, task(b).state], ['error', 'error']);
    var said = reports().join(' ');
    T.notMatch(said, /I nudged|I added your comment/);
    T.eq(reports('u_beth').length, 0, 'Beth is not pinged about a note that never landed');
});

/* ---- #6 the kill switch covers undo; the installer keeps an admin's switch ---- */

T.test('with ticket writes off, "undo task 1" then yes changes nothing', function () {
    var s = new S.Session();
    s.model(gem.call('create_standing_order', { kind: 'watch_ticket', ticket_number: 'INC0010015', no_movement_hours: 2, action: 'escalate_priority', priority: '2', authorized_utterance: 'x' }),
            gem.text('Shall I?'));
    s.say('watch 15');
    s.say('yes');
    g.P.now += 3 * H;
    runner().run();
    T.eq(s.inc('INC0010015').priority, '2', 'the order fired');
    g.P.PROPS['x_196061_netra_v1.ticket_writes'] = 'false';
    s.say('undo task 1');
    var r = s.say('yes');
    T.match(r.message, /Ticket writes are switched off/);
    T.notMatch(r.message, /^Done/);
    T.eq(s.inc('INC0010015').priority, '2', 'not reverted while the switch is off');
    var f = N.loadServer({ input: { action: 'chat' } }).fn;
    T.ok(f._runTool('undo_task_action', { nt_number: '1' }).read_only, 'the model path is refused too');
    T.eq(s.inc('INC0010015').priority, '2');
});

T.test('re-running the installer keeps property values an admin set, and provisions the kill switch', function () {
    new S.Session();
    var inst = fs.readFileSync(path.join(N.SRC, 'fix_script', 'netra-install.js'), 'utf8');
    var body = inst.slice(inst.indexOf('    function upsertProp('), inst.indexOf("    upsertProp('gemini_api_key'"));
    var upsertProp = new Function('scope', 'scopeSysId', 'say', 'GlideRecord', body + '\nreturn upsertProp;')('x_196061_netra_v1', 'app1', function () {}, g.GlideRecord);
    g.put('sys_properties', { name: 'x_196061_netra_v1.ticket_writes', value: 'false' });
    g.put('sys_properties', { name: 'x_196061_netra_v1.brain_offline', value: 'true' });
    upsertProp('ticket_writes', 'true', 'kill switch');
    upsertProp('brain_offline', 'false', 'test switch');
    upsertProp('fast_lane', 'true', 'fast lane');
    T.eq(g.find('sys_properties', 'name', 'x_196061_netra_v1.ticket_writes').value, 'false', 'a freeze survives a re-run');
    T.eq(g.find('sys_properties', 'name', 'x_196061_netra_v1.brain_offline').value, 'true');
    T.eq(g.find('sys_properties', 'name', 'x_196061_netra_v1.fast_lane').value, 'true', 'new ones are created with the default');
    T.match(inst, /upsertProp\('ticket_writes', 'true'/);
});

/* ---- #8 quiet hours delay a chase, they do not starve it ---- */

T.test('a chase armed at 19:30 waits for the morning instead of looping through quiet hours', function () {
    new S.Session();
    g.P.now = Date.UTC(2026, 8, 24, 19, 30, 0);
    var chg = approval({ number: 'CHG0032222', requested_by: 'u_admin' }, 'u_beth');
    var t = order({ kind: 'chase_approvals', cond: { source_sys_id: chg }, number: 'CHG0032222' });
    runner().run();
    T.eq(reports('u_beth').length, 0, 'nobody pinged at night');
    T.eq(task(t).next_check_at, g.fmtUtc(Date.UTC(2026, 8, 25, 8, 30, 0)), 'next look is at the end of quiet hours');
    g.P.now = Date.UTC(2026, 8, 25, 8, 32, 0);
    runner().run();
    T.eq(reports('u_beth').length, 1, 'reminded in the morning');
});

T.test('quiet hours are read in local time once, not shifted twice', function () {
    new S.Session();
    g.P.tzOffsetMs = -7 * H;                                // Pacific
    g.P.now = Date.UTC(2026, 8, 24, 16, 0, 0);            // 09:00 local
    var chg = approval({ number: 'CHG0033333', requested_by: 'u_admin' }, 'u_beth');
    order({ kind: 'chase_approvals', cond: { source_sys_id: chg }, number: 'CHG0033333' });
    runner().run();
    T.eq(reports('u_beth').length, 1, '9am is working hours');
});

T.test('an expired chase says how many reminders it sent, not "the condition never came true"', function () {
    new S.Session();
    var t = order({ kind: 'chase_approvals', cond: {}, number: 'CHG0034444', expires_h: -1 });
    runner().run();
    T.eq(task(t).state, 'expired');
    var said = reports().join(' ');
    T.match(said, /NT0001: my chase of approvals on CHG0034444 expired\. I did not send any reminders\./);
    T.notMatch(said, /condition ever coming true/);
});

/* ---- #10 "assigned to you" only for a real assignment ---- */

function scanUser(prefId) {
    var s = scanner(), p = new g.GlideRecord(PREF);
    p.get(prefId);
    return s.scanForUser(p);
}
function assigned() { return rows(NOTIF, function (n) { return n.kind === 'incident_assigned'; }); }

T.test('a comment on a ticket held for a month is not "assigned to you"; a real reassignment back is', function () {
    var s = new S.Session();
    var p = pref('u_admin');
    var inc = s.inc('INC0010013');
    inc.assigned_to = 'u_admin'; inc.sys_created_on = g.fmtUtc(g.P.now - 30 * 24 * H);
    inc.sys_updated_on = g.fmtUtc(g.P.now);                 // a colleague just commented
    scanUser(p);
    T.eq(assigned().length, 0, 'no false "has been assigned to you"');
    // announced once long ago (the old dedupe keyed on the ticket), moved away, and now back
    g.put(NOTIF, { user: 'u_admin', ticket_sys_id: 'inc13', kind: 'incident_assigned', message: 'old', delivered: 'true' });
    g.P.now += 5 * 60000;
    g.put('sys_audit', { tablename: 'incident', documentkey: 'inc13', fieldname: 'assigned_to', oldvalue: 'u_beth', newvalue: 'u_admin' });
    inc.sys_updated_on = g.fmtUtc(g.P.now);
    scanUser(p);
    var a = assigned().filter(function (n) { return n.message !== 'old'; });
    T.eq(a.length, 1, 'the reassignment back is announced');
    T.match(a[0].message, /Incident I N C zero zero one zero zero one three has been assigned to you/);
});

T.test('a bulk reassignment of 25 is announced in full across scans, none skipped for good', function () {
    new S.Session();
    var p = pref('u_admin');
    var base = g.P.now - 2 * 60000;
    for (var i = 0; i < 25; i++) {
        var at = g.fmtUtc(base + i * 1000);
        var id = g.put('incident', { number: 'INC00300' + (10 + i), active: 'true', state: '2', assigned_to: 'u_admin', short_description: 'moved',
                                     sys_created_on: g.fmtUtc(g.P.now - 10 * 24 * H), sys_updated_on: at });
        g.put('sys_audit', { tablename: 'incident', documentkey: id, fieldname: 'assigned_to', newvalue: 'u_admin', sys_created_on: at });
    }
    T.eq(scanUser(p), 20, 'first scan reads its limit');
    g.P.now += 3 * 60000;
    T.eq(scanUser(p), 5, 'the rest come on the next scan');
    T.eq(assigned().length, 25);
});

T.test('25 approvals landing at once are all announced across scans', function () {
    new S.Session();
    var p = pref('u_admin');
    var base = g.P.now - 2 * 60000;
    for (var i = 0; i < 25; i++) g.put('sysapproval_approver', { approver: 'u_admin', state: 'requested', sysapproval: 'inc13', sys_updated_on: g.fmtUtc(base + i * 1000) });
    T.eq(scanUser(p), 20);
    g.P.now += 3 * 60000;
    T.eq(scanUser(p), 5);
});

T.run(__filename);
