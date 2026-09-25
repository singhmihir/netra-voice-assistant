/*
 * Audit fixes (server-G): standing orders arm exactly what was read back,
 * the away debrief loses nothing, plans are never silently replaced or
 * undone over someone else's change, and "nothing similar" is only said
 * when every ticket was really compared.
 */
'use strict';
var T = require('./lib/t'), S = require('./lib/session'), N = require('./lib/netra'), gem = S.gem, g = S.g;
var H = 3600000;
var TASK = 'x_196061_netra_v1_task';

function scanner() { N.loadScriptIncludes(); return new NetraTaskRunner().run(); }
function fns() { return N.loadServer({ input: { action: 'chat' } }).fn; }
function orders() { var st = g.P.STORE[TASK] || {}; return Object.keys(st).map(function (k) { return st[k]; }); }
function copy(o) { return JSON.parse(JSON.stringify(o)); }
// the newest result a tool handed the model this session
function toolResult(s, name) {
    for (var i = s.gemini.generate.length - 1; i >= 0; i--) {
        var cs = s.gemini.generate[i].contents || [];
        for (var j = cs.length - 1; j >= 0; j--) {
            var parts = cs[j].parts || [];
            for (var k = 0; k < parts.length; k++) {
                if (parts[k].functionResponse && parts[k].functionResponse.name === name) return parts[k].functionResponse.response.result;
            }
        }
    }
    return null;
}
function stateChoices() {
    [['1', 'New'], ['2', 'In Progress'], ['3', 'On Hold'], ['6', 'Resolved'], ['7', 'Closed']].forEach(function (c) {
        g.put('sys_choice', { name: 'incident', element: 'state', value: c[0], label: c[1], inactive: 'false', language: 'en' });
    });
}

/* ---- #1 chase approvals never widen past the ticket that was read back ---- */

T.test('chase approvals: a short change number is normalised and the order is scoped to that change', function () {
    var s = new S.Session();
    g.put('change_request', { sys_id: 'chg1', number: 'CHG0030001', short_description: 'Patch the web tier', requested_by: 'u_admin', state: '-4', active: 'true' });
    s.model(gem.call('create_standing_order', { kind: 'chase_approvals', ticket_number: 'CHG30001', action: 'notify_only', authorized_utterance: 'chase the approvals on change 30001' }),
            gem.text('I will chase the approvals on change ending 0 0 1. Shall I?'));
    s.say('chase the approvals on change three zero zero zero one');
    T.eq(toolResult(s, 'create_standing_order').read_back.target, 'CHG0030001', 'the read-back names the resolved change');
    T.match(s.say('yes').message, /task 1 is armed/);
    var o = orders()[0];
    T.eq(JSON.parse(o.condition_json).source_sys_id, 'chg1', 'scoped to that change, not every approval');
    T.eq(o.target_number, 'CHG0030001');
});

T.test('chase approvals: a number that is not found is refused, never widened to every approval', function () {
    var s = new S.Session();
    s.model(gem.call('create_standing_order', { kind: 'chase_approvals', ticket_number: 'CHG0099999', action: 'notify_only', authorized_utterance: 'x' }),
            gem.text('I can not find that change.'));
    s.say('chase the approvals on change 99999');
    T.match(toolResult(s, 'create_standing_order').error, /I can not find CHG0099999 - I will not chase all your approvals instead/);
    T.ok(!s.blob().pendingOrder, 'nothing parked for a yes');
    s.say('yes');
    T.eq(orders().length, 0, 'nothing armed');
});

T.test('an armed order with no ticket reports "your approvals", not an empty target', function () {
    var s = new S.Session();
    var o = { kind: 'chase_approvals', action: 'notify_only', authorized_utterance: 'keep chasing my approvals' };
    s.model(gem.call('create_standing_order', o), gem.text('I will keep chasing your approvals. Shall I?'));
    s.say('keep chasing my approvals');
    var c = copy(o); c.confirm = true;
    s.model(gem.call('create_standing_order', c), gem.text('Armed.'));
    s.say('yes arm it please');
    var r = toolResult(s, 'create_standing_order');
    T.ok(r.ok, JSON.stringify(r));
    T.eq(r.summary.target, 'your approvals');
});

/* ---- #5 a spoken state or priority is resolved before anything is parked ---- */

T.test('watch for a state: the spoken label is stored as the state value, so the watch really fires', function () {
    var s = new S.Session();
    stateChoices();
    s.model(gem.call('create_standing_order', { kind: 'watch_ticket', ticket_number: 'INC0010015', state_equals: 'resolved', action: 'notify_only', authorized_utterance: 'tell me when 15 is resolved' }),
            gem.text('I will tell you when incident ending 0 1 5 is resolved. Shall I?'));
    s.say('let me know when INC0010015 is resolved');
    T.eq(toolResult(s, 'create_standing_order').read_back.condition.state_equals, 'Resolved', 'read back as the choice label');
    T.match(s.say('yes').message, /task 1 is armed/);
    T.eq(JSON.parse(orders()[0].condition_json).state_equals, '6', 'stored as the value the runner compares');
    g.P.now += H;
    T.eq(scanner(), 0, 'not resolved yet');
    s.inc('INC0010015').state = '6';
    g.P.now += H;
    T.eq(scanner(), 1, 'resolved: the watch fires');
});

T.test('an unknown state or priority is refused before anything is parked', function () {
    var s = new S.Session();
    stateChoices();
    s.model(gem.call('create_standing_order', { kind: 'watch_ticket', ticket_number: 'INC0010015', state_equals: 'finished', action: 'notify_only', authorized_utterance: 'x' }),
            gem.text('I do not know that state.'));
    s.say('tell me when 15 is finished');
    T.match(toolResult(s, 'create_standing_order').error, /I do not know a state called "finished" on incident/);
    T.ok(!s.blob().pendingOrder, 'nothing parked');
    s.model(gem.call('create_standing_order', { kind: 'watch_ticket', ticket_number: 'INC0010015', no_movement_hours: 2, action: 'escalate_priority', priority: 'urgent', authorized_utterance: 'x' }),
            gem.text('Which priority?'));
    s.say('make 15 urgent if nobody touches it');
    T.match(toolResult(s, 'create_standing_order').error, /I do not know a priority called "urgent"/);
    T.ok(!s.blob().pendingOrder, 'nothing parked');
});

T.test('a priority word is armed as its number, so the escalation lands', function () {
    var s = new S.Session();
    s.model(gem.call('create_standing_order', { kind: 'watch_ticket', ticket_number: 'INC0010016', no_movement_hours: 2, action: 'escalate_priority', priority: 'high', authorized_utterance: 'x' }),
            gem.text('I will raise it to priority 2 if nobody touches it for 2 hours. Shall I?'));
    s.say('watch 16 and make it high if nobody touches it for 2 hours');
    T.eq(toolResult(s, 'create_standing_order').read_back.priority, '2');
    s.say('yes');
    T.eq(JSON.parse(orders()[0].action_params).priority, '2');
    g.P.now += 3 * H;
    T.eq(scanner(), 1);
    T.eq(s.inc('INC0010016').priority, '2', 'escalated for real');
});

/* ---- #6 the model path needs the same fresh yes as the fast lane ---- */

T.test('a parked order can not be armed by the model two turns later', function () {
    var s = new S.Session();
    var o = { kind: 'watch_ticket', ticket_number: 'INC0010015', no_movement_hours: 2, action: 'escalate_priority', priority: '1', authorized_utterance: 'x' };
    s.model(gem.call('create_standing_order', o), gem.text('Watch 15 and escalate it to priority 1 if quiet for two hours - shall I?'));
    s.say('watch INC0010015 and escalate it to priority 1 if quiet for two hours');
    s.model(gem.text('Okay, I will leave it for now.'));
    s.say('no, leave it for now, I will think about it');
    var c = copy(o); c.confirm = true;
    s.model(gem.call('create_standing_order', c), gem.text('Done.'));
    s.say('what is going on with the printer ticket');
    T.eq(orders().length, 0, 'the declined order was not armed');
    T.ok(toolResult(s, 'create_standing_order').needs_confirmation, 'it has to be read back again');
});

T.test('the armed order is the one read back: a confirm call can not stretch its expiry', function () {
    var s = new S.Session();
    var o = { kind: 'watch_ticket', ticket_number: 'INC0010016', no_movement_hours: 2, action: 'nudge_assignee', expires_hours: 24, authorized_utterance: 'x' };
    s.model(gem.call('create_standing_order', o), gem.text('I will nudge the assignee if it goes quiet, for the next 24 hours. Shall I?'));
    s.say('nudge whoever has 16 if it goes quiet today');
    var c = copy(o); c.confirm = true; c.expires_hours = 336;
    s.model(gem.call('create_standing_order', c), gem.text('Armed.'));
    s.say('yes arm it please');
    var armed = orders();
    T.eq(armed.length, 1);
    T.eq(armed[0].expires_at, g.fmtUtc(g.P.now + 24 * H), 'expires when the read-back said');
});

/* ---- #2 / #10 the away debrief speaks everything, and the true count ---- */

T.test('away debrief: a notify-only watch that fired is spoken, not swallowed', function () {
    var s = new S.Session();
    s.model(gem.call('create_standing_order', { kind: 'watch_ticket', ticket_number: 'INC0010015', no_movement_hours: 4, action: 'notify_only', authorized_utterance: 'tell me when 15 has been quiet for 4 hours' }),
            gem.text('Shall I?'));
    s.say('tell me when INC0010015 has been quiet for 4 hours');
    s.say('yes');
    g.P.now += 5 * H;
    T.eq(scanner(), 1);
    var d = s.say('what did i miss');
    T.notMatch(d.message, /Nothing happened/);
    T.eq((d.message.match(/INC0010015 met your watch condition/g) || []).length, 1, 'spoken once: ' + d.message);
    T.eq(g.find('x_196061_netra_v1_notification', 'kind', 'task_report').delivered, 'true', 'and the poll will not repeat it');
});

T.test('away debrief: an escalation that found nothing to do is spoken too', function () {
    var s = new S.Session();
    s.model(gem.call('create_standing_order', { kind: 'watch_ticket', ticket_number: 'INC0010017', no_movement_hours: 1, action: 'escalate_priority', priority: '3', authorized_utterance: 'x' }),
            gem.text('Shall I?'));
    s.say('watch 17 and make it priority 3 if it goes quiet');
    s.say('yes');
    g.P.now += 2 * H;
    T.eq(scanner(), 1);
    T.match(s.say('debrief me').message, /one: .*INC0010017 is already at priority 3, nothing to escalate/);
});

T.test('away debrief: a report from someone else\'s order is spoken, and "undo" of it is refused', function () {
    var s = new S.Session();
    s.say('hello');
    g.put('x_196061_netra_v1_notification', { user: 'u_admin', kind: 'task_report', ticket_number: 'INC0010014', delivered: 'false',
                                              message: 'Beth asked me to nudge you about INC0010014 - it has been quiet for a while.' });
    var d = s.say('debrief me');
    T.match(d.message, /one: .*Beth asked me to nudge you about INC0010014/);
    T.match(s.say('undo number one').message, /someone else's standing order, so there is nothing of yours/);
});

T.test('away debrief: the true count is spoken and older actions wait for the next debrief', function () {
    var s = new S.Session();
    s.say('hello');
    var log = [];
    for (var i = 0; i < 12; i++) {
        var at = g.P.now + (i + 1) * 60000;
        log.push({ at: g.fmtUtc(at), at_ms: at, what: 'nudged approver Beth about CHG00300' + (10 + i), nudged: 'u_beth' });
    }
    g.P.now += 20 * 60000;
    g.put(TASK, { user: 'u_admin', nt_number: 'NT0001', kind: 'chase_approvals', state: 'active', action: 'notify_only', action_log: JSON.stringify(log), undo_json: '' });
    var d = s.say('debrief me');
    T.match(d.message, /While you were away I did 12 things - here are the latest 8\./);
    T.match(d.message, /CHG0030021/);
    T.notMatch(d.message, /CHG0030013\b/, 'the oldest four are not in this one');
    T.match(d.message, /Say "debrief me" again for the 4 older ones\./);
    var d2 = s.say('debrief me');
    T.match(d2.message, /I did 4 things/);
    T.match(d2.message, /CHG0030010.*CHG0030013/);
    T.match(s.say('debrief me').message, /Nothing happened while you were away/);
});

/* ---- #7 plan undo never overwrites a later change ---- */

T.test('plan undo leaves alone a field someone changed after the plan ran', function () {
    var s = new S.Session();
    s.model(gem.call('make_plan', { steps: [
                { tool: 'assign_ticket_to_group', args: { ticket_number: 'INC0010014', group_name: 'Database' } },
                { tool: 'assign_ticket_to_group', args: { ticket_number: 'INC0010015', group_name: 'Database' } }] }),
            gem.text('Move 14 and 15 to Database. Shall I run it?'));
    s.say('move 14 and 15 to database');
    s.say('yes');
    T.eq(s.inc('INC0010014').assignment_group, 'g_db');
    g.P.now += 24 * H;
    s.inc('INC0010014').assignment_group = 'g_sw';   // a colleague routes it on the next day
    s.say('undo the plan');
    var u = s.say('yes');
    T.eq(s.inc('INC0010014').assignment_group, 'g_sw', 'the colleague\'s routing stands');
    T.eq(s.inc('INC0010015').assignment_group, 'g_net', 'the untouched one is put back');
    T.match(u.message, /Reversed and read back: assignment group on \*\*incident ending 0 1 5\*\*/);
    T.match(u.message, /Not reversed: assignment group on \*\*incident ending 0 1 4\*\* changed after the plan ran, so I left it alone/);
});

/* ---- #8 a plan is never silently replaced ---- */

function sixStepPlan(s) {
    var nums = ['INC0010013', 'INC0010014', 'INC0010015', 'INC0010016', 'INC0010017', 'INC0010018'];
    s.model(gem.call('make_plan', { steps: nums.map(function (n) { return { tool: 'assign_ticket_to_group', args: { ticket_number: n, group_name: 'Database' } }; }) }),
            gem.text('Six steps: move them all to Database. Shall I run it?'));
    s.say('move all six to database');
    var hop = s.say('yes');
    T.ok(hop.continue_plan, 'four done, two to go');
    T.eq(s.blob().plan.cursor, 4);
}

T.test('a new plan never replaces one still running; once stopped, its undo survives the new plan', function () {
    var s = new S.Session();
    sixStepPlan(s);
    var other = { steps: [{ tool: 'change_priority', args: { ticket_number: 'INC0010013', priority: '4' } }] };
    s.model(gem.call('make_plan', other), gem.text('A plan is still running. Say carry on or stop.'));
    s.say('also set 13 to priority 4');
    T.match(toolResult(s, 'make_plan').error, /A plan is still running \(4 of 6 steps done\)/);
    T.eq(s.blob().plan.steps.length, 6, 'the running plan is still the one on file');
    T.match(s.say('stop').message, /Stopped the plan - 4 of 6 steps were done/);

    s.model(gem.call('make_plan', other), gem.text('The earlier plan will not finish. New plan: priority 4 on 13. Shall I run it?'));
    s.say('set 13 to priority 4');
    T.match(toolResult(s, 'make_plan').earlier_plan, /The earlier plan stopped after 4 of 6 steps - its other 2 steps will not run\./);
    T.eq(s.blob().plan.undo.length, 4, 'the stopped plan\'s breadcrumbs carried over');
    T.match(s.say('no').message, /dropped the plan/);
    T.eq(s.blob().plan.steps.length, 6, 'dropping the new draft gives the stopped plan back');
    T.match(s.say('undo the plan').message, /put back 4 changes from the last plan/);
    s.say('yes');
    ['INC0010013', 'INC0010014', 'INC0010015', 'INC0010016'].forEach(function (n) { T.eq(s.inc(n).assignment_group, 'g_net', n + ' restored'); });
});

T.test('undo after a newer plan says which changes came from the earlier one', function () {
    var s = new S.Session();
    sixStepPlan(s);
    s.say('stop');
    s.model(gem.call('make_plan', { steps: [{ tool: 'change_priority', args: { ticket_number: 'INC0010017', priority: '4' } }] }), gem.text('Shall I run it?'));
    s.say('set 17 to priority 4');
    s.say('yes');
    T.eq(s.inc('INC0010017').priority, '4');
    T.match(s.say('undo the plan').message, /put back 5 changes - 1 from the last plan and 4 from the one before it/);
});

T.test('a plan stopped by the hop limit is kept, halted, with its undo', function () {
    var s = new S.Session();
    sixStepPlan(s);
    var p = s.blob().plan;
    p.hops = 5;
    s.setBlob({ plan: p });
    var r = s.say('[continue plan]');
    T.match(r.message, /Plan hop limit reached/);
    var kept = s.blob().plan;
    T.ok(kept && kept.halted, 'kept, halted');
    T.eq(kept.undo.length, 4);
    T.match(s.say('undo the plan').message, /put back 4 changes/);
});

/* ---- #9 "nothing similar" only when everything was compared ---- */

T.test('duplicate guard and resolution memory never say "nothing similar" after a partial scan', function () {
    new S.Session();
    // eight newer, unrelated tickets fill the live-embed budget; the VPN one is never compared
    for (var i = 0; i < 8; i++) {
        g.put('incident', { number: 'INC00200' + (10 + i), short_description: 'Keyboard key ' + i + ' sticks', state: '2', active: 'true',
                            sys_updated_on: g.fmtUtc(g.P.now + (i + 1) * 60000) });
    }
    var d = fns()._checkDuplicates('VPN drops every ten minutes', '');
    T.ok(d.ok && !d.clear && d.partial, JSON.stringify(d));
    T.match(d.message, /could only compare 6 of 14 open tickets, so I can not promise there is no duplicate/);
    T.notMatch(d.message, /safe to raise/);

    for (var j = 0; j < 8; j++) {
        g.put('incident', { number: 'INC00300' + (10 + j), short_description: 'Mouse ' + j + ' double clicks', state: '6', active: 'false',
                            close_notes: 'Replaced it', sys_updated_on: g.fmtUtc(g.P.now + (j + 1) * 60000) });
    }
    g.put('incident', { number: 'INC0030099', short_description: 'VPN keeps dropping', state: '6', active: 'false', close_notes: 'Updated the VPN client',
                        sys_updated_on: g.fmtUtc(g.P.now - H) });
    var r = fns()._findSimilarResolved('VPN drops every ten minutes', 3);
    T.ok(r.ok && r.partial, JSON.stringify(r));
    T.notMatch(r.message, /genuinely be new/);
    T.match(r.message, /could only compare 6 of 9 resolved tickets/);
});

T.run(__filename);
