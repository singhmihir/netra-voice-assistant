/*
 * Fast-lane audit fixes: undo only reverses the user's latest write and never
 * clobbers a later human edit; the debrief speaks every report; spoken ticket
 * numbers parse exactly; investigations respect ACLs; partial answers name
 * every write; plans, "pardon" and "read the rest" keep a yes answerable;
 * timing facts are true.
 */
'use strict';
var T = require('./lib/t'), S = require('./lib/session'), N = require('./lib/netra'), gem = S.gem, g = S.g;
var H = 3600000, MIN = 60000;
function fns() { return N.loadServer({ input: { action: 'chat' } }).fn; }
function scanner() { N.loadScriptIncludes(); return new NetraTaskRunner().run(); }
var BETH = { sys_id: 'u_beth', name: 'Beth Anglin', user_name: 'beth.anglin' };

/* ---- undo: the latest write, its age, and nobody's later edit ---------- */

T.test('undo after an update_field write reverses that write, not an older breadcrumb', function () {
    var s = new S.Session();
    s.model(gem.call('assign_ticket_to_group', { ticket_number: 'INC0010014', group_name: 'Database' }), gem.text('Done.'));
    s.say('assign INC0010014 to Database');
    T.eq(s.inc('INC0010014').assignment_group, 'g_db');
    s.model(gem.call('update_field', { ticket_number: 'INC0010016', field: 'assignee', value: 'Beth Anglin' }), gem.text('Done.'));
    s.say('give INC0010016 to Beth');
    T.eq(s.inc('INC0010016').assigned_to, 'u_beth');
    var r = s.say('undo that');
    T.match(r.message, /That would put assigned to on \*\*incident ending 0 1 6\*\* back to/);
    T.notMatch(r.message, /0 1 4/);
    var y = s.say('yes');
    T.match(y.message, /Undone/);
    T.eq(s.inc('INC0010016').assigned_to || '', '', '016 put back');
    T.eq(s.inc('INC0010014').assignment_group, 'g_db', '014 left alone');
});

T.test('undo refuses when someone changed the field after Netra did', function () {
    var s = new S.Session();
    s.model(gem.call('assign_ticket_to_group', { ticket_number: 'INC0010014', group_name: 'Database' }), gem.text('Done.'));
    s.say('assign INC0010014 to Database');
    s.inc('INC0010014').assignment_group = 'g_sw';          // a human re-routed it
    var r = s.say('undo that');
    // said at once - no read-back and yes for an undo that can not happen
    T.match(r.message, /someone has changed assignment group on \*\*incident ending 0 1 4\*\* since I set it/i);
    T.ok(!s.blob().flDraft, 'nothing parked');
    s.say('yes');
    T.eq(s.inc('INC0010014').assignment_group, 'g_sw', 'the human edit stands');
});

T.test('an old breadcrumb is read back with its age, never as "just created"', function () {
    var s = new S.Session();
    s.setBlob({ last_action: { kind: 'created', number: 'INC0010018', table: 'incident', at: g.fmtUtc(g.P.now - 3 * 24 * H) } });
    var r = s.say('undo that');
    T.notMatch(r.message, /just created/);
    T.match(r.message, /delete \*\*incident ending 0 1 8\*\* that I created\. That was 3 days ago\. Shall I\?/);
    s.setBlob({ last_action: { kind: 'created', number: 'INC0010018', table: 'incident', at_ms: g.P.now - 2 * MIN } });
    T.match(s.say('undo that').message, /that I just created\. Shall I\?/, 'a fresh one still says "just"');
});

T.test('undo will not delete a ticket someone else has since worked on', function () {
    var s = new S.Session();
    s.setBlob({ last_action: { kind: 'created', number: 'INC0010018', table: 'incident', at_ms: g.P.now - 5 * MIN } });
    s.inc('INC0010018').sys_updated_by = 'beth.anglin';
    s.say('undo that');
    var y = s.say('yes');
    T.match(y.message, /someone else has worked on INC0010018/);
    T.ok(s.inc('INC0010018'), 'still there');
    T.eq(s.inc('INC0010018').state, '2', 'not cancelled either');
});

T.test('a comment, note or approval replaces the breadcrumb: undo says it can not take it back', function () {
    var s = new S.Session();
    s.model(gem.call('assign_ticket_to_group', { ticket_number: 'INC0010014', group_name: 'Database' }), gem.text('Done.'));
    s.say('assign INC0010014 to Database');
    s.model(gem.call('update_ticket', { ticket_number: 'INC0010013', comment: 'We are on it' }), gem.text('Done.'));
    // a comment the caller sees is read back first, and sent on the yes
    T.match(s.say('tell the caller on 13 we are on it').message, /add a comment the caller will see on \*\*incident ending 0 1 3\*\* saying "We are on it"\. Shall I\?/);
    s.say('yes');
    var r = s.say('undo that');
    T.match(r.message, /My last change was a comment on \*\*incident ending 0 1 3\*\*, and that can not be undone/);
    T.ok(!s.blob().flDraft, 'nothing parked for a yes');
    s.say('yes');
    T.eq(s.inc('INC0010014').assignment_group, 'g_db', 'the older write is not reached');
    s.model(gem.call('add_work_note', { ticket_number: 'INC0010015', note: 'checked cabling' }), gem.text('Done.'));
    s.say('note on 15 that I checked the cabling');
    s.say('yes');
    T.match(s.say('undo that').message, /a work note on \*\*incident ending 0 1 5\*\*/);
});

T.test('update_field priority through the matrix is undone through impact and urgency', function () {
    var s = new S.Session();
    s.model(gem.call('update_field', { ticket_number: 'INC0010017', field: 'priority', value: '2' }), gem.text('Done.'));
    s.say('set 17 to priority 2');
    T.eq(s.inc('INC0010017').priority, '2');
    T.match(s.say('undo that').message, /\*\*incident ending 0 1 7\*\* back to priority 3/);
    s.say('yes');
    var inc = s.inc('INC0010017');
    T.eq([inc.priority, inc.impact, inc.urgency], ['3', '2', '2']);
});

/* ---- the debrief speaks every report ------------------------------------ */

T.test('a notify-only watch that fired is in the debrief, not "no standing orders fired"', function () {
    var s = new S.Session();
    s.model(gem.call('create_standing_order', { kind: 'watch_ticket', ticket_number: 'INC0010015', state_equals: '6', action: 'notify_only', authorized_utterance: 'x' }),
            gem.text('I will tell you when incident ending 0 1 5 is resolved. Shall I?'));
    s.say('watch INC0010015 and tell me when it is resolved');
    var armed = s.say('yes');
    T.notMatch(armed.message, /five minutes/, 'no false promise about how often it checks');
    T.match(armed.message, /about every half hour/);
    s.inc('INC0010015').state = '6';
    g.P.now += 1 * H;
    T.eq(scanner(), 1);
    g.P.now += 1 * H;
    var d = s.say('what did you do while i was away', { auto: true });
    T.notMatch(d.message, /Nothing happened/);
    T.match(d.message, /watch condition met on INC0010015|INC0010015 met your watch condition/);
    T.eq((d.message.match(/INC0010015/g) || []).length, 1, 'the log entry and its notification are one item');
});

T.test('a colleague\'s nudge is heard in the debrief, and can not be "undone" as some other task', function () {
    var s = new S.Session();
    g.put('x_196061_netra_v1_notification', { user: 'u_admin', kind: 'task_report', delivered: 'false', ticket_number: 'INC0010013',
                                              message: 'Beth asked me to nudge you about INC0010013 - it has been quiet for a while.' });
    var d = s.say('debrief me');
    T.match(d.message, /While you were away I did 1 thing\. one: .*Beth asked me to nudge you about INC0010013/);
    var u = s.say('undo number one');
    T.notMatch(u.message, /task 1/);
    T.match(u.message, /nothing (?:of yours for me )?to undo/);
    T.ok(!s.blob().flDraft, 'nothing parked');
});

T.test('debrief items from an earlier day say which day', function () {
    var s = new S.Session();
    g.put('x_196061_netra_v1_task', { user: 'u_admin', nt_number: 'NT0001', kind: 'watch_ticket', state: 'fired', undo_json: '',
                                      action_log: JSON.stringify([{ at: g.fmtUtc(g.P.now - 26 * H), at_ms: g.P.now - 26 * H, what: 'escalated INC0010015 priority 3 -> 2' }]) });
    var d = s.say('debrief me');
    T.match(d.message, /one: yesterday at 6:00 PM, escalated INC0010015/);
});

/* ---- spoken ticket numbers ---------------------------------------------- */

T.test('ticket numbers: short forms stop at the number, punctuation and possessives do not hide a ticket', function () {
    new S.Session();
    var f = fns();
    T.eq(f._normSpoken('dig into incident 13 one more time'), 'dig into INC0000013 one more time');
    T.eq(f._findNums(f._normSpoken('incident 10013 one more thing')), ['INC0010013']);
    T.eq(f._findNums(f._normSpoken('status of incident 10013 oh')), ['INC0010013']);
    T.eq(f._findNums(f._normSpoken('investigate incident one zero zero one three.')), ['INC0010013']);
    T.eq(f._findNums(f._normSpoken("INC0010013's status")), ['INC0010013']);
    T.eq(f._findNums(f._normSpoken('i n c zero zero one zero zero one five')), ['INC0010015'], 'spelled form still works');
    T.eq(f._findNums('see inc0010013'), ['INC0010013'], 'case-insensitive');
    T.eq(f._normSpoken("what's up"), "what's up", 'other words untouched');
});

T.test('"What\'s the status of INC0010013?" is answered free', function () {
    var s = new S.Session();
    var r = s.say("What's the status of INC0010013?");
    T.eq(s.gemini.generate.length, 0);
    T.match(r.message, /incident ending 0 1 3\*\*: VPN drops every few minutes/);
});

/* ---- investigations respect the user's access ---------------------------- */

T.test('investigating a ticket the user can not read tells them nothing about it', function () {
    var s = new S.Session();
    g.P.PROPS['x_196061_netra_v1.investigate_llm'] = 'false';
    g.P.user = BETH;
    g.P.ACL = function (table, op, rec) { return !(table === 'incident' && rec.number === 'INC0010013'); };
    var r = s.say('investigate INC0010013');
    T.notMatch(r.message, /VPN drops/);
    T.match(r.message, /could not find a ticket .*INC0010013|not found, or you can not see it/);
    T.ok(!s.blob().investigation, 'nothing stored to write up later');
    var c = s.say('what changed on INC0010013');
    T.notMatch(c.message, /VPN drops|configuration item set/);
});

T.test('a caller investigating their own ticket gets no work notes in the evidence', function () {
    var s = new S.Session();
    g.P.PROPS['x_196061_netra_v1.investigate_llm'] = 'false';
    s.inc('INC0010015').caller_id = 'u_beth';
    g.put('sys_journal_field', { element_id: 'inc15', element: 'work_notes', value: 'internal: escalate quietly', sys_created_by: 'admin', sys_created_on: g.fmtUtc(g.P.now - 60000) });
    g.put('sys_journal_field', { element_id: 'inc15', element: 'comments', value: 'We are looking at the printer now', sys_created_by: 'admin', sys_created_on: g.fmtUtc(g.P.now - 30000) });
    g.P.user = BETH;
    g.P.ACL = function (table, op, rec, field) {
        if (table !== 'incident') return true;
        if (field === 'work_notes') return false;
        return op === 'read' && rec.caller_id === 'u_beth';
    };
    s.say('investigate INC0010015');
    var inv = s.blob().investigation;
    T.ok(inv, 'investigated');
    var ev = JSON.stringify(inv.items);
    T.match(ev, /We are looking at the printer now/);
    T.notMatch(ev, /escalate quietly/, 'work notes are not evidence for someone who may not read them');
});

/* ---- partial answers name every write ----------------------------------- */

T.test('brain stops after a create: the partial answer says what was raised and does not invite a repeat', function () {
    var s = new S.Session();
    g.GlideRecord.onInsert.incident = function (r) { if (!r.number) r.number = 'INC0010040'; };
    s.model(gem.call('create_ticket', { short_description: 'Scanner offline on floor 2' }), gem.http(503, { error: { code: 503, message: 'overloaded' } }),
            gem.http(503, { error: { code: 503, message: 'overloaded' } }), gem.http(503, { error: { code: 503, message: 'overloaded' } }),
            gem.http(503, { error: { code: 503, message: 'overloaded' } }));
    var r = s.say('raise a ticket, the scanner on floor 2 is offline, yes go ahead');
    T.match(r.message, /I raised \*\*incident ending 0 4 0\*\*/);
    T.notMatch(r.message, /Ask me again/);
    T.match(r.message, /Those changes are already made/);
});

T.test('a write after six reads is still reported', function () {
    var s = new S.Session();
    // reads that carry no text from other people, so the write is not held
    // back by the untrusted-text gate
    var reads = [];
    for (var i = 0; i < 6; i++) reads.push(['lookup_user', { query: i % 2 ? 'beth' : 'bert' }]);
    s.model(gem.calls(reads), gem.call('assign_ticket_to_group', { ticket_number: 'INC0010013', group_name: 'Database' }),
            gem.quota429('day'), gem.quota429('day'), gem.quota429('day'), gem.quota429('day'));
    var r = s.say('look up beth and bert and give 13 to Database');
    T.match(r.message, /\*\*incident ending 0 1 3\*\* assigned to Database/);
    T.match(r.message, /I also did 2 more lookups\./);
});

T.test('status reads in a partial answer say the state, not "I ran"', function () {
    var s = new S.Session();
    var reads = [];
    for (var i = 0; i < 3; i++) reads.push(['get_ticket_status', { ticket_number: 'INC00100' + (13 + i) }]);
    s.model(gem.calls(reads), gem.quota429('day'), gem.quota429('day'), gem.quota429('day'), gem.quota429('day'));
    var r = s.say('check tickets 13 14 and 15');
    T.match(r.message, /incident ending 0 1 3\*\* is in progress/);
    T.notMatch(r.message, /I ran get ticket status/);
});

/* ---- plans on the work board ------------------------------------------- */

T.test('the work board reads an unconfirmed plan back, and "go ahead" runs it', function () {
    var s = new S.Session();
    s.model(gem.call('make_plan', { steps: [{ tool: 'assign_ticket_to_group', args: { ticket_number: 'INC0010014', group_name: 'Database' } }] }),
            gem.text('Plan: route 14 to Database. Shall I run it?'));
    s.say('reassign INC0010014 to Database');
    var b = s.say('what are you working on');
    T.match(b.message, /a plan waiting for your go-ahead: 1\. assign \*\*incident ending 0 1 4\*\* to the group Database\. Shall I run it\?$/);
    T.ok(b.awaiting_confirm, 'the page knows a yes is awaited');
    var r = s.say('go ahead');
    T.match(r.message, /Plan complete/);
    T.eq(s.inc('INC0010014').assignment_group, 'g_db');
});

T.test('a halted plan is reported as stopped, not in progress', function () {
    var s = new S.Session();
    s.setBlob({ plan: { id: 'P1', steps: [{ tool: 'add_work_note', args: { ticket_number: 'INC0010013', note: 'a' } },
                                          { tool: 'add_work_note', args: { ticket_number: 'INC0099999', note: 'b' } },
                                          { tool: 'add_work_note', args: { ticket_number: 'INC0010013', note: 'c' } }],
                        cursor: 1, hops: 1, confirmed: true, halted: true, turn: 0, at: g.P.now, undo: [], results: [] } });
    var r = s.say('what are you working on');
    T.match(r.message, /a plan that stopped at step 2, with 1 of 3 steps done/);
});

T.test('a yes with only a stale plan on file reads the plan back instead of "Anything else"', function () {
    var s = new S.Session();
    s.model(gem.call('make_plan', { steps: [{ tool: 'assign_ticket_to_group', args: { ticket_number: 'INC0010014', group_name: 'Database' } }] }),
            gem.text('Shall I run it?'));
    s.say('reassign INC0010014 to Database');
    s.say('my approvals');                               // ends with a statement, not a question
    var r = s.say('go ahead');
    T.match(r.message, /That plan was read back a while ago, so here it is again: 1\. assign \*\*incident ending 0 1 4\*\* to the group Database\. Shall I run it\?/);
    T.eq(s.inc('INC0010014').assignment_group, 'g_net', 'not run on the stale yes');
    T.match(s.say('yes').message, /Plan complete/);
});

/* ---- "pardon" keeps a read-back answerable -------------------------------- */

T.test('"pardon" replays a read-back and the next yes still confirms it', function () {
    var s = new S.Session({ key: '' });
    g.GlideRecord.onInsert.incident = function (r) { if (!r.number) r.number = 'INC0010041'; };
    var rb = s.say('raise a ticket for the vpn dropping every hour');
    T.match(rb.message, /Shall I\?$/);
    var p = s.say('pardon');
    T.eq(p.message, rb.message);
    T.ok(p.awaiting_confirm, 'still waiting for a yes');
    var y = s.say('yes');
    T.match(y.message, /Raised \*\*incident ending 0 4 1\*\*/);
});

/* ---- "Shall I read the rest?" is answerable for free ---------------------- */

T.test('"read the rest" pages the ticket list with zero model calls, in basic mode too', function () {
    var s = new S.Session({ key: '' });
    var r = s.say('my tickets');
    T.match(r.message, /Shall I read the rest\?$/);
    var more = s.say('yes');
    T.eq(s.gemini.generate.length, 0);
    T.notMatch(more.message, /reasoning models/);
    T.match(more.message, /^Next: \*\*incident ending/);
    T.match(more.message, /That is all of them\.$/);
});

T.test('approvals page with "go on"', function () {
    var s = new S.Session();
    for (var i = 0; i < 5; i++) {
        g.put('change_request', { sys_id: 'cr' + i, number: 'CHG003000' + i, short_description: 'Change ' + i });
        g.put('sysapproval_approver', { approver: 'u_admin', state: 'requested', sysapproval: 'cr' + i, source_table: 'change_request', sys_created_on: g.fmtUtc(g.P.now - i * MIN) });
    }
    var r = s.say('my approvals');
    T.match(r.message, /Shall I go on\?$/);
    var more = s.say('go on');
    T.eq(s.gemini.generate.length, 0);
    T.match(more.message, /^Next: \*\*change ending 0 0 3\*\*, Change 3; \*\*change ending 0 0 4\*\*, Change 4\. That is all of them\.$/);
    T.match(s.say('no').message, /^Okay\.$/, 'a no after the last page is just an ack');
});

/* ---- true timing facts --------------------------------------------------- */

T.test('the briefing greets once, by the local clock, not a 12-hour display value', function () {
    var s = new S.Session();
    var r = s.say('give me my daily briefing');                      // 8 PM, 12-hour user format
    T.match(r.message, /^Good evening, System\./);
    T.eq((r.message.match(/Good (morning|afternoon|evening)/g) || []).length, 1);
});

T.run(__filename);
