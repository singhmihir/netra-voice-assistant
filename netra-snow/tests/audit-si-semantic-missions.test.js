/*
 * Audit si-semantic-missions: a queue mission acts only for someone allowed
 * to work the queue, never lowers a priority or moves one unannounced, votes
 * on group sys_ids (names are not unique), and says out loud what failed,
 * what stayed changed and when its ticket memory was too cold to compare.
 */
'use strict';
var T = require('./lib/t'), S = require('./lib/session'), N = require('./lib/netra'), g = S.g, gem = S.gem;
var MIN = 60000;
var ITEMS = 'x_196061_netra_v1_mission_item', NOTIF = 'x_196061_netra_v1_notification', TASK = 'x_196061_netra_v1_task';
var BETH = { sys_id: 'u_beth', name: 'Beth Anglin', user_name: 'beth.anglin' };

function resolved(num, group, sd, extra) {
    var r = { number: num, state: '7', active: 'false', assignment_group: group, category: 'network', priority: '3', impact: '2', urgency: '2',
              short_description: sd, close_notes: 'Restarted the VPN concentrator', resolved_at: g.fmtUtc(g.P.now - 3 * 86400000), caller_id: 'u_bert' };
    for (var k in extra || {}) r[k] = extra[k];
    return g.put('incident', r);
}
function queued(j, sd, extra) {
    var r = { sys_id: 'q' + j, number: 'INC00500' + (10 + j), state: '1', active: 'true', assignment_group: '', assigned_to: '', impact: '2', urgency: '2',
              priority: '3', short_description: sd, caller_id: 'u_bert',
              sys_created_on: g.fmtUtc(g.P.now - (60 - j) * MIN), opened_at: g.fmtUtc(g.P.now - (60 - j) * MIN) };
    for (var k in extra || {}) r[k] = extra[k];
    return g.put('incident', r);
}
// the way an admin warms the vector cache ("reindex my tickets")
function warm() {
    var w = N.loadServer({ input: { action: 'chat' } }).fn._reindexIncidents(40);
    T.ok(w.ok, 'cache warmed: ' + JSON.stringify(w));
}
function vpnWorld(queueExtra) {
    var s = new S.Session();
    for (var i = 0; i < 6; i++) resolved('INC00400' + (10 + i), 'g_net', 'VPN tunnel keeps dropping for remote staff ' + i);
    for (var j = 0; j < 3; j++) queued(j, 'VPN disconnects every few minutes ' + j, queueExtra);
    warm();
    return s;
}
function advance(times) {
    for (var i = 0; i < times; i++) { N.loadScriptIncludes(); g.P.now += 5 * MIN; new NetraMissionRunner().advance(); }
}
function launchAndReview(s) {
    s.say('work through the unassigned queue');
    s.say('yes');
    advance(4);
}
function authorise(s) {
    T.match(s.say('apply the confident ones').message, /Shall I\?/);
    s.say('yes');
}
function notifs() {
    var st = g.P.STORE[NOTIF] || {};
    return Object.keys(st).map(function (k) { return String(st[k].message); });
}
function itemRow(num) { return g.find(ITEMS, 'target_number', num); }
function header() {
    var st = g.P.STORE[TASK] || {};
    for (var k in st) if (st[k].kind === 'mission') return st[k];
    return null;
}

/* ---- 1. priority: never lowered, never unannounced ---- */

T.test('apply never lowers a P1, and the one raise it makes is read back and reported', function () {
    var s = new S.Session();
    for (var i = 0; i < 6; i++) resolved('INC00400' + (10 + i), 'g_net', 'VPN tunnel keeps dropping for remote staff ' + i);
    queued(0, 'VPN down for the whole company', { impact: '1', urgency: '1', priority: '1' });
    queued(1, 'VPN disconnects every few minutes', { impact: '2', urgency: '3', priority: '4' });
    warm();
    launchAndReview(s);
    var rep = s.say('read the mission report').message;
    T.match(rep, /INC0050011, VPN disconnects every few minutes: send to Network, category network, priority up from 4 to 3/);
    T.notMatch(rep, /INC0050010[^.]*priority up/, 'no change announced for the P1');
    var ask = s.say('apply the confident ones');
    T.match(ask.message, /I will route 2 tickets the way the history suggests - group and category, and raise the priority on 1 of them - .*Shall I\?/);
    s.say('yes');
    advance(3);
    var p1 = s.inc('INC0050010');
    T.eq([p1.assignment_group, p1.priority, p1.impact, p1.urgency], ['g_net', '1', '1', '1'], 'P1 routed but never lowered');
    var p4 = s.inc('INC0050011');
    T.eq([p4.assignment_group, p4.priority], ['g_net', '3'], 'the announced raise happened');
    T.match(JSON.parse(itemRow('INC0050010').findings_json).applied.notes.join(' '), /left priority 1 as it was/);
    T.match(s.say('read the mission report').message, /INC0050011, VPN disconnects every few minutes: routed to Network, category network, priority raised to 3, checked and it stuck/);
});

T.test('the model\'s apply_request reads back the same thing as the fast lane, and parks only what can run', function () {
    var s = vpnWorld();
    launchAndReview(s);
    s.model(gem.call('mission', { action: 'apply_request', nt_number: '1' }), gem.text('unused'));
    var r = s.say('go ahead and put mission one into effect');
    T.match(r.message, /I will route 3 tickets the way the history suggests - group and category, priorities stay as they are - .*Shall I\?/);
    T.eq(s.blob().flDraft.kind, 'mission_apply');
    s.say('yes');
    T.eq(header().state, 'applying');
});

/* ---- 2. the requester's own rights ---- */

T.test('a caller without rights to work the queue can not start a mission', function () {
    var s = vpnWorld();
    g.P.user = BETH;
    g.P.ACL = function (table, op, rec) { return table !== 'incident' || (op === 'read' && rec.caller_id === 'u_beth'); };
    var r = s.say('work through the unassigned queue');
    T.match(r.message, /You do not have permission to work the incident queue, so I did not start a mission/);
    T.notMatch(r.message, /VPN|unassigned incidents/, 'nothing about other people\'s tickets is spoken');
    s.say('yes');
    T.eq(header(), null, 'no mission was launched');
    N.loadScriptIncludes();
    T.ok(!new NetraMissionRunner().launch('u_beth', 'x').ok, 'launch refuses too');
});

T.test('the snapshot holds only tickets the user can read; losing write rights stops report, apply and undo', function () {
    var s = new S.Session();
    for (var i = 0; i < 6; i++) resolved('INC00400' + (10 + i), 'g_net', 'VPN tunnel keeps dropping for remote staff ' + i);
    queued(0, 'VPN disconnects every few minutes 0');
    queued(1, 'VPN disconnects every few minutes 1');
    queued(2, 'VPN outage for the finance team', { caller_id: 'u_hidden' });
    g.P.ACL = function (table, op, rec) { return table !== 'incident' || rec.caller_id !== 'u_hidden'; };
    warm();
    T.match(s.say('work through the unassigned queue').message, /the 2 unassigned incidents/);
    s.say('yes');
    T.eq(Object.keys(g.P.STORE[ITEMS]).length, 2, 'the ticket they can not read is not in the snapshot');
    advance(4);
    var full = g.P.ACL;
    g.P.ACL = function (table, op) { return table !== 'incident' || op === 'read'; };
    T.match(s.say('read the mission report').message, /You do not have permission to work the incident queue, so I can not read you its report/);
    s.say('apply the confident ones');
    T.match(s.say('yes').message, /You do not have permission to work the incident queue, so I did not apply anything/);
    T.eq(header().state, 'awaiting_apply', 'nothing authorised');
    s.say('undo the mission');
    T.match(s.say('yes').message, /You do not have permission to work the incident queue, so I can not undo it/);
    g.P.ACL = full;
    authorise(s);
    T.eq(header().state, 'applying');
    T.ok(JSON.parse(header().condition_json).apply.entitled, 'the rights check is recorded with the authorisation');
});

T.test('the scanner writes nothing for an apply that carries no rights check', function () {
    var s = vpnWorld();
    launchAndReview(s);
    authorise(s);
    var h = header(), c = JSON.parse(h.condition_json);
    delete c.apply.entitled;      // authorised before the check existed
    h.condition_json = JSON.stringify(c);
    advance(2);
    T.eq(s.inc('INC0050010').assignment_group, '', 'nothing routed');
    T.eq(header().state, 'error');
    T.match(notifs().join(' '), /stopped: nothing shows the person who said apply may change incidents\. Nothing was changed\./);
});

/* ---- 3. votes by group sys_id ---- */

T.test('two groups called Network are never pooled, and the name alone is never routed blind', function () {
    var s = new S.Session();
    g.put('sys_user_group', { sys_id: 'g_net_acme', name: 'Network', active: 'true' });
    g.P.DISPLAY.g_net_acme = 'Network';
    for (var i = 0; i < 5; i++) resolved('INC00400' + (10 + i), 'g_net_acme', 'VPN tunnel keeps dropping for remote staff ' + i);
    resolved('INC0040020', 'g_net', 'VPN tunnel dropped last spring', { sys_updated_on: g.fmtUtc(g.P.now - 200 * 86400000) });
    queued(0, 'VPN disconnects every few minutes');
    warm();
    N.loadScriptIncludes();
    var tri = new NetraSemantic().triageVotes('VPN disconnects every few minutes', { excludeSysId: 'q0' });
    T.eq(tri.instance_pick.group_id, 'g_net_acme', 'the sys_id most lookalikes went to');
    T.ok(tri.same_name, 'another lookalike group has the same name');
    T.eq(tri.pick_evidence.indexOf('INC0040020'), -1, 'evidence only from the winning group');
    launchAndReview(s);
    T.match(notifs().join(' '), /finished reviewing 1 unassigned incident: 0 confident routings/);
    T.match(s.say('read the mission report').message, /INC0050010, VPN disconnects every few minutes: best guess Network, but more than one group is called Network, so I will not route it blind/);
    T.eq(s.inc('INC0050010').assignment_group, '', 'not routed');
});

/* ---- 4. a stop mid-apply tells the truth about what changed ---- */

T.test('a pass that throws mid-apply says which tickets it already changed, never "nothing was changed"', function () {
    var s = vpnWorld();
    launchAndReview(s);
    authorise(s);
    var rule = g.GlideRecord.onUpdate.incident;
    g.GlideRecord.onUpdate.incident = function (next, old) {
        if (next.sys_id === 'q2' && next.assignment_group && !old.assignment_group) throw new Error('Data Policy Exception: Caller is mandatory');
        rule(next, old);
    };
    advance(2);
    T.eq([s.inc('INC0050010').assignment_group, s.inc('INC0050011').assignment_group], ['g_net', 'g_net']);
    var stop = notifs().filter(function (m) { return /hit a problem/.test(m); })[0];
    T.match(stop, /2 tickets it already changed stay as they are - say undo mission 1 to put them back\./);
    T.notMatch(stop, /Nothing was changed/);
    T.match(s.say("how's the mission going").message, /stopped with an error at 3 of 3 reviewed\. 2 tickets it already changed stay/);
});

T.test('cancelling while a pass is applying counts what that pass already changed', function () {
    var s = vpnWorld();
    launchAndReview(s);
    authorise(s);
    N.loadScriptIncludes();
    // a pass is mid-way: it has routed one ticket but not committed its counts
    T.eq(new NetraMissionRunner()._applyItem(itemRow('INC0050010').sys_id, 'NT0001', 'System').status, 'applied');
    var r = s.say('cancel mission 1');
    T.match(r.message, /Mission 1 cancelled\. 1 ticket it already changed stays as it is - say undo mission 1 to put it back\./);
    T.match(s.say("how's the mission going").message, /was cancelled at 3 of 3 reviewed, 1 applied/);
});

/* ---- 5. failed and partial writes are spoken ---- */

T.test('routings that did not stick are spoken, with the changes of mine they kept, and undo puts those back', function () {
    var s = vpnWorld({ category: 'inquiry' });
    launchAndReview(s);
    authorise(s);
    var rule = g.GlideRecord.onUpdate.incident;
    g.GlideRecord.onUpdate.incident = function (next, old) {
        if ((next.sys_id === 'q1' || next.sys_id === 'q2') && next.assignment_group === 'g_net') next.assignment_group = '';
        rule(next, old);
    };
    advance(2);
    T.eq([s.inc('INC0050011').assignment_group, s.inc('INC0050011').category], ['', 'network'], 'the group was stomped, the category stuck');
    var done = notifs().filter(function (m) { return /applied 1 confident routing/.test(m); })[0];
    T.match(done, /2 could not be routed, but all of them kept a category or priority change of mine - say read the mission report for why\. Say undo mission 1/);
    T.match(s.say("how's the mission going").message, /Mission 1 is done: 1 routing applied\. 2 could not be routed/);
    T.match(s.say('read the mission report').message, /INC0050011[^]*Applying it failed: I set the group to Network but it read back as empty\. My category change on it stayed - undoing the mission puts it back\./);
    s.say('undo the mission');
    s.say('yes');
    T.eq([s.inc('INC0050010').assignment_group, s.inc('INC0050011').category, s.inc('INC0050012').category], ['', 'inquiry', 'inquiry'], 'undo put the kept changes back');
    N.loadScriptIncludes();
    T.match(new NetraMissionRunner().boardSentence('NT0001', 'applying', 'apply', { applied: 1, confident_pending: 1, apply_failed: 1 }, null),
            /is applying: 1 of 3 confident routings done\. 1 could not be routed/, 'failures stay in the total');
});

/* ---- 6. a cold cache is not "nothing similar" ---- */

T.test('a cold ticket memory is said to be cold, not "too thin" or "nothing similar"', function () {
    var s = new S.Session();
    for (var i = 0; i < 10; i++) resolved('INC00400' + (10 + i), 'g_net', 'VPN tunnel keeps dropping for remote staff ' + i);
    for (var k = 0; k < 20; k++) resolved('INC00410' + (10 + k), 'g_sw', 'Printer on floor ' + k + ' will not print', { category: 'hardware', close_notes: 'Cleared the spooler' });
    for (var j = 0; j < 3; j++) queued(j, 'VPN disconnects every few minutes ' + j);
    launchAndReview(s);   // nobody said "reindex" first
    var done = notifs().join(' ');
    T.match(done, /finished reviewing 3 unassigned incidents.*My ticket memory was still cold for all of them, so I compared them with only a few past tickets - say reindex my tickets, then run the mission again\./);
    var rep = s.say('read the mission report').message;
    T.match(rep, /INC0050010, VPN disconnects every few minutes 0: [^.]*I could only compare it with \d+ past tickets? - my ticket memory is still cold/);
    T.notMatch(rep, /too thin or too split|nothing similar in the history/);
    T.match(rep, /say reindex my tickets/);
});

/* ---- 7. crash recovery never adopts a person's routing ---- */

T.test('a half-finished write is not adopted when a person has since picked the ticket up', function () {
    var s = vpnWorld();
    launchAndReview(s);
    authorise(s);
    // a pass parked its undo and died before writing; Beth then took the
    // ticket to Network herself, in one update
    itemRow('INC0050010').undo_json = JSON.stringify({ t: 'incident', id: 'q0', n: 'INC0050010', restore: { assignment_group: '' },
                                                       set: { assignment_group: 'g_net' }, pending: true });
    var t = s.inc('INC0050010');
    t.assignment_group = 'g_net'; t.assigned_to = 'u_beth'; t.sys_mod_count = String(parseInt(t.sys_mod_count, 10) + 1);
    advance(2);
    T.eq(JSON.parse(itemRow('INC0050010').findings_json).applied, undefined, 'not recorded as the mission\'s write');
    T.eq(itemRow('INC0050010').undo_json, '', 'no undo that could strip Beth');
    s.say('undo the mission');
    s.say('yes');
    var t2 = s.inc('INC0050010');
    T.eq([t2.assignment_group, t2.assigned_to], ['g_net', 'u_beth'], 'Beth keeps her ticket');
    T.eq(s.inc('INC0050011').assignment_group, '', 'the mission\'s own routings were undone');
});

/* ---- 8. a quoted fix ends its sentence ---- */

T.test('a quoted fix ends its sentence, so the next ticket is heard as a new one', function () {
    var s = vpnWorld();
    launchAndReview(s);
    T.match(s.say('read the mission report').message, /was closed with: "Restarted the VPN concentrator"\. INC0050011, VPN/);
    N.loadScriptIncludes();
    var long = 'Restarted the VPN concentrator' + new Array(12).join(' and flushed the stale tunnels');
    var line = new NetraMissionRunner().reportLine({ number: 'INC1', state: 'reviewed', proposal: {}, known_fix: { number: 'INC2', close_notes: long } });
    T.match(line, /was closed with: "Restarted the VPN concentrator[a-z ]* (and|flushed|the|stale|tunnels)"\.$/, 'cut on a whole word, quoted and ended');
});

T.run(__filename);
