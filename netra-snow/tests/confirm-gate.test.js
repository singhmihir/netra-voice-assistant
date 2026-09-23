/*
 * The one rule a blind user depends on most: a "yes" only ever runs the
 * thing Netra just read back, in the very next turn. Every scenario here is a
 * real multi-turn conversation through the real router.
 */
'use strict';
var T = require('./lib/t'), S = require('./lib/session'), gem = S.gem;

function withLastAction(s) {
    // Netra changed INC0010013's priority earlier; "undo that" should put it back
    var inc = s.inc('INC0010013');
    inc.impact = '1'; inc.urgency = '1'; inc.priority = '1';
    s.setBlob({ last_action: { kind: 'field', number: 'INC0010013', table: 'incident', field: 'priority', old: '3', old_display: 'priority 3' } });
}

T.test('read-back then yes runs it, and says what it did', function () {
    var s = new S.Session(); withLastAction(s);
    var r1 = s.say('undo that');
    T.match(r1.message, /That would put priority back on \*\*incident ending 0 1 3\*\*\. Shall I\?/);
    T.eq(s.inc('INC0010013').priority, '1', 'nothing changes before the yes');
    var r2 = s.say('yes');
    T.eq(r2.route_reason, 'fast_lane');
    T.eq(s.gemini.generate.length, 0, 'zero model calls');
    T.match(r2.message, /Undone/);
});

T.test('no drops the draft and changes nothing', function () {
    var s = new S.Session(); withLastAction(s);
    s.say('undo that');
    var r = s.say('no');
    T.match(r.message, /dropped it\. Nothing was changed/);
    T.eq(s.inc('INC0010013').priority, '1');
    T.eq(s.say('yes').message, 'Anything else I can do?', 'a later yes finds nothing parked');
});

T.test('a yes two turns later does not run a stale draft', function () {
    var s = new S.Session(); withLastAction(s);
    s.say('undo that');
    s.say('my tickets');
    var r = s.say('yes');
    T.notMatch(r.message, /Undone/);
    T.eq(s.inc('INC0010013').priority, '1', 'still not undone');
});

T.test('an automatic briefing between read-back and yes does not age the draft', function () {
    var s = new S.Session(); withLastAction(s);
    s.say('undo that');
    var turn = s.blob().turn;
    var auto = s.say('give me my daily briefing', { auto: true });
    T.eq(s.blob().turn, turn, 'auto turn does not bump the turn counter');
    T.ok(auto.awaiting_confirm, 'server tells the page a read-back is still waiting');
    T.match(s.say('yes').message, /Undone/);
});

T.test('the page cannot confirm a plan by itself with [continue plan]', function () {
    var s = new S.Session();
    s.model(gem.call('make_plan', { steps: [{ tool: 'assign_ticket_to_group', args: { ticket_number: 'INC0010014', group_name: 'Database' }, say: 'route it' }] }),
            gem.text('Plan: route INC0010014 to Database. Shall I run it?'));
    s.say('reassign INC0010014 to Database and add a note');
    var r = s.say('[continue plan]');
    T.eq(r.message, 'No plan is running.');
    T.eq(s.inc('INC0010014').assignment_group, 'g_net', 'not assigned');
});

T.test('model files a plan, the yes runs it, undo puts everything back', function () {
    var s = new S.Session();
    s.model(gem.call('make_plan', { steps: [
                { tool: 'reassign_ticket', args: { ticket_number: 'INC0010014', group: 'Database' }, say: 'move it' },
                { tool: 'set_priority', args: { ticket_number: 'INC0010014', priority: '4' }, say: 'lower it' }] }),
            gem.text('Here is the plan: assign it to Database and set priority 4. Shall I run it?'));
    s.say('reassign INC0010014 to Database and set it to priority 4');
    T.eq(s.gemini.generate.length, 2);
    var planned = s.blob().plan;
    T.eq(planned.steps[0].tool, 'assign_ticket_to_group', 'alias');
    T.eq(planned.steps[0].args.group_name, 'Database', 'alias carries the argument over');
    var run = s.say('yes');
    T.eq(s.gemini.generate.length, 2, 'the yes costs nothing');
    var inc = s.inc('INC0010014');
    T.eq(inc.assignment_group, 'g_db');
    T.eq(inc.priority, '4');
    T.match(run.message, /Plan complete\. 1\. \*\*incident ending 0 1 4\*\* assigned to Database; 2\. Priority of \*\*incident ending 0 1 4\*\* is now 4 - I read it back/);
    T.notMatch(run.message, /\.\.|\.;/, 'clean punctuation');
    T.match(s.say('undo the plan').message, /put back 2 changes/);
    var u = s.say('yes');
    inc = s.inc('INC0010014');
    T.eq([inc.assignment_group, inc.priority, inc.impact, inc.urgency], ['g_net', '3', '2', '2']);
    T.match(u.message, /Reversed and read back: priority on \*\*incident ending 0 1 4\*\*; assignment group on \*\*incident ending 0 1 4\*\*/);
});

T.test('a plan read back long ago is read back again, not run', function () {
    var s = new S.Session();
    s.model(gem.call('make_plan', { steps: [{ tool: 'assign_ticket_to_group', args: { ticket_number: 'INC0010014', group_name: 'Database' } }] }),
            gem.text('Plan ready. Shall I run it?'));
    s.say('reassign INC0010014 to Database');
    S.g.P.now += 12 * 60000;   // the user wandered off for 12 minutes
    s.model(gem.call('execute_plan', {}), gem.text('It has been a while - here it is again: assign to Database. Shall I run it?'));
    s.say('yes');
    T.eq(s.inc('INC0010014').assignment_group, 'g_net', 'not run on a stale yes');
    T.ok(s.blob().plan && !s.blob().plan.confirmed, 'plan re-stamped, still waiting');
    var r = s.say('yes');
    T.eq(s.inc('INC0010014').assignment_group, 'g_db', 'runs after the fresh read-back');
    T.match(r.message, /Plan complete/);
});

T.test('two drafts parked in one turn are both dropped, and the user is told', function () {
    var s = new S.Session();
    s.model(S.gem.calls([
                ['make_plan', { steps: [{ tool: 'assign_ticket_to_group', args: { ticket_number: 'INC0010014', group_name: 'Database' } }] }],
                ['create_standing_order', { kind: 'watch_ticket', ticket_number: 'INC0010015', action: 'escalate_priority', no_movement_hours: 2, priority: '2' }]]),
            gem.text('I set up both. Shall I?'));
    var r = s.say('move 14 to database and watch 15');
    T.match(r.message, /more than one change at once/);
    var b = s.blob();
    T.ok(!b.plan && !b.pendingOrder, 'nothing left waiting');
    s.say('yes');
    T.eq(s.inc('INC0010014').assignment_group, 'g_net');
});

T.test('brain dies after a plan is filed: the partial answer reads the plan back', function () {
    var s = new S.Session();
    s.model(gem.call('make_plan', { steps: [{ tool: 'assign_ticket_to_group', args: { ticket_number: 'INC0010014', group_name: 'Database' } }] }),
            gem.quota429('day'), gem.quota429('day'), gem.quota429('day'), gem.quota429('day'));
    var r = s.say('reassign INC0010014 to Database');
    T.match(r.message, /I drafted a plan: 1\. assign \*\*incident ending 0 1 4\*\* to the group Database\. Shall I run it\?/);
    T.notMatch(r.message, /call execute_plan|Read the numbered steps/, 'no instructions meant for the model are spoken');
    T.match(s.say('yes').message, /Plan complete/);
    T.eq(s.inc('INC0010014').assignment_group, 'g_db');
});

T.test('an empty model reply after a write reports the write instead of "try again"', function () {
    var s = new S.Session();
    s.model(gem.call('assign_ticket_to_group', { ticket_number: 'INC0010016', group_name: 'Database' }),
            { candidates: [{ finishReason: 'SAFETY' }] });
    var r = s.say('assign INC0010016 to Database');
    T.eq(s.inc('INC0010016').assignment_group, 'g_db');
    T.match(r.message, /Here is what I did\. \S.*assigned to Database/);
    T.notMatch(r.message, /try again/i);
    T.ok(Array.isArray(r.history), 'history kept, so the model remembers the write');
});

T.test('ambiguous names ask instead of guessing', function () {
    var s = new S.Session();
    s.model(gem.call('assign_ticket_to_user', { ticket_number: 'INC0010017', user_name: 'Anglin' }),
            gem.text('Two people match: Beth Anglin and Bert Anglin. Which one?'));
    s.say('assign INC0010017 to Anglin');
    T.eq(s.inc('INC0010017').assigned_to || '', '', 'nobody assigned');
    var toolResult = JSON.stringify(s.gemini.generate[1].contents.slice(-1));
    T.match(toolResult, /matches more than one person: Bert Anglin, Beth Anglin - which one\?/);
    s.model(gem.call('assign_ticket_to_group', { ticket_number: 'INC0010017', group_name: 'Network' }), gem.text('Done.'));
    s.say('assign INC0010017 to Network');
    T.eq(s.inc('INC0010017').assignment_group, 'g_net', 'an exact name wins over "Network CAB Managers"');
});

T.test('the model re-filing the same draft in one turn is still one draft, and is kept', function () {
    var s = new S.Session();
    var order = { kind: 'watch_ticket', ticket_number: 'INC0010015', no_movement_hours: 2, action: 'escalate_priority', priority: '2', authorized_utterance: 'x' };
    var retry = JSON.parse(JSON.stringify(order)); retry.confirm = true;
    s.model(gem.call('create_standing_order', order), gem.call('create_standing_order', retry), gem.text('Shall I?'));
    var r = s.say('watch 15 and escalate if nothing moves');
    T.notMatch(r.message, /more than one change/);
    T.ok(s.blob().pendingOrder, 'kept');
    T.match(s.say('yes').message, /task 1 is armed/);
});

T.test('a draft parked in an earlier round is never hidden behind a terminal tool answer', function () {
    var s = new S.Session();
    s.model(gem.call('make_plan', { steps: [{ tool: 'assign_ticket_to_group', args: { ticket_number: 'INC0010014', group_name: 'Database' } }] }),
            gem.call('suspect_changes', { target: 'INC0010014' }),
            gem.text('No changes found. Also, the plan: assign it to Database. Shall I run it?'));
    var r = s.say('move 14 to database and check what changed on it');
    T.eq(s.gemini.generate.length, 3, 'the model got to compose a reply that reads the plan back');
    T.match(r.message, /Shall I run it\?/);
});

T.test('a partial answer still carries the navigation the tools asked for', function () {
    var s = new S.Session();
    s.model(gem.call('navigate_to_record', { ticket_number: 'INC0010013' }), { candidates: [{ finishReason: 'STOP', content: { parts: [] } }] });
    var r = s.say('open INC0010013');
    T.ok(r.directives && /incident/.test(String(r.directives.navigate_url)), 'navigate_url kept: ' + JSON.stringify(r.directives));
});

T.test('"no" answering an undo read-back drops the undo; it does not stop a plan', function () {
    var s = new S.Session();
    s.setBlob({ plan: { id: 'P1', steps: [{ tool: 'add_work_note', args: { ticket_number: 'INC0010013', note: 'x' } }, { tool: 'add_work_note', args: { ticket_number: 'INC0010013', note: 'y' } }],
                        cursor: 1, hops: 1, confirmed: true, turn: 0, at: S.g.P.now, hop_at: S.g.P.now, hop_turn: -5, undo: [], results: [] },
                last_action: { kind: 'field', number: 'INC0010013', table: 'incident', field: 'priority', old: '3', old_display: 'priority 3' } });
    s.say('undo that');
    var r = s.say('no');
    T.match(r.message, /dropped it/);
    T.ok(!s.blob().plan.halted, 'plan untouched');
});

T.test('plan read-backs say the words of comments and messages that can not be taken back', function () {
    var s = new S.Session();
    s.model(gem.call('make_plan', { steps: [{ tool: 'add_comment', args: { ticket_number: 'inc10013', text: 'Rebooting the VPN now' } },
                                            { tool: 'send_message', args: { recipient: 'Beth Anglin', text: 'Please check the VPN' } }] }),
            gem.quota429('day'), gem.quota429('day'), gem.quota429('day'), gem.quota429('day'));
    var r = s.say('tell the caller we are rebooting and message Beth');
    T.match(r.message, /add a comment the caller will see on \*\*incident ending 0 1 3\*\* saying "Rebooting the VPN now"/);
    T.match(r.message, /message Beth Anglin: "Please check the VPN"/);
    T.eq(s.blob().plan.steps[0].args.ticket_number, 'INC0010013', 'number normalised once, for read-back, crumb and write');
});

T.test('update_field plan steps use the spoken field name for their undo', function () {
    var s = new S.Session();
    s.model(gem.call('make_plan', { steps: [{ tool: 'update_field', args: { ticket_number: 'INC0010016', field: 'assignee', value: 'Beth Anglin' } }] }),
            gem.text('Shall I run it?'));
    s.say('assign 16 to Beth');
    s.say('yes');
    T.eq(s.inc('INC0010016').assigned_to, 'u_beth');
    s.say('undo the plan');
    T.match(s.say('yes').message, /Reversed and read back: assigned to on \*\*incident ending 0 1 6\*\*/);
    T.eq(s.inc('INC0010016').assigned_to || '', '');
});

T.test('a read-back the page never spoke (the user barged in) can not be confirmed', function () {
    var s = new S.Session(); withLastAction(s);
    s.say('undo that');                                  // reply arrives stale, never spoken
    var r = s.say('okay', { drop_unheard: true });
    T.notMatch(r.message, /Undone/);
    T.eq(s.inc('INC0010013').priority, '1', 'nothing undone');
});

T.run(__filename);
