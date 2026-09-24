/*
 * Keeps working while you are away - and tells you honestly what it did.
 * A standing order is filed in conversation, armed only on a yes, fired by
 * the real background runner hours later, spoken in the debrief, and undone
 * by its debrief number.
 */
'use strict';
var T = require('./lib/t'), S = require('./lib/session'), N = require('./lib/netra'), gem = S.gem, g = S.g;
var H = 3600000;

function scanner() { N.loadScriptIncludes(); return new NetraTaskRunner().run(); }

T.test('standing order: read back, armed on yes, fires later, debriefed, undone by number', function () {
    var s = new S.Session();
    var order = { kind: 'watch_ticket', ticket_number: 'INC0010015', no_movement_hours: 2, action: 'escalate_priority', priority: '2',
                  authorized_utterance: 'watch 15 and escalate it to P2 if nobody touches it for 2 hours' };
    s.model(gem.call('create_standing_order', order),
            gem.text('I will watch incident ending 0 1 5 and raise it to priority 2 if nobody touches it for 2 hours. Shall I?'));
    s.say('watch INC0010015 and if nobody touches it for 2 hours escalate it to priority 2');
    T.eq(g.P.STORE.x_196061_netra_v1_task, undefined, 'nothing armed before the yes');
    var armed = s.say('yes');
    T.match(armed.message, /Done - task 1 is armed/);
    T.eq(s.gemini.generate.length, 2, 'the yes itself costs nothing');

    g.P.now += 1 * H;
    T.eq(scanner(), 0, 'an hour in, the condition is not met');
    T.eq(s.inc('INC0010015').priority, '3');

    g.P.now += 2 * H;
    T.eq(scanner(), 1, 'three hours untouched: it fires');
    var inc = s.inc('INC0010015');
    T.eq(inc.priority, '2', 'priority really moved (through impact/urgency if it had to)');

    var debrief = s.say('what did you do while i was away');
    T.eq(s.gemini.generate.length, 2, 'debrief is free');
    T.match(debrief.message, /INC0010015|incident ending 0 1 5/);
    T.match(debrief.message, /\b2\b/);

    var rb = s.say('undo number one');
    T.match(rb.message, /reverse item 1 - .* - which was task 1\. Shall I\?/);
    var done = s.say('yes');
    T.match(done.message, /^Done/);
    T.eq(s.inc('INC0010015').priority, '3', 'priority restored');
});

T.test('a human edit after the order was armed wins: the runner does not fight it', function () {
    var s = new S.Session();
    s.model(gem.call('create_standing_order', { kind: 'watch_ticket', ticket_number: 'INC0010016', no_movement_hours: 2, action: 'escalate_priority', priority: '2', authorized_utterance: 'x' }),
            gem.text('Shall I?'));
    s.say('watch 16');
    s.say('yes');
    g.P.now += 1 * H;
    var inc = s.inc('INC0010016');
    inc.work_notes_seen = 'human looked at it'; inc.sys_updated_on = g.fmtUtc(g.P.now);   // someone touched it
    g.P.now += 1.5 * H;
    T.eq(scanner(), 0, 'moved 1.5h ago - condition not met');
    T.eq(s.inc('INC0010016').priority, '3');
});

T.test('the kill switch stops background writes', function () {
    var s = new S.Session();
    s.model(gem.call('create_standing_order', { kind: 'watch_ticket', ticket_number: 'INC0010017', no_movement_hours: 1, action: 'escalate_priority', priority: '2', authorized_utterance: 'x' }),
            gem.text('Shall I?'));
    s.say('watch 17');
    s.say('yes');
    g.P.PROPS['x_196061_netra_v1.ticket_writes'] = 'false';
    g.P.now += 3 * H;
    scanner();
    T.eq(s.inc('INC0010017').priority, '3', 'no write while ticket_writes is off');
});

T.test('the model\'s confirm=true is not a yes: an order is armed only by the user\'s own yes to a heard read-back', function () {
    var s = new S.Session();
    var o = { kind: 'watch_ticket', ticket_number: 'INC0010013', after_hours: 1, action: 'add_comment', comment: 'Resolved, closing', authorized_utterance: 'x' };
    s.model(gem.call('create_standing_order', o), gem.text('Shall I arm it?'));
    s.say('watch incident 10013 and add a comment in an hour');
    var c = JSON.parse(JSON.stringify(o)); c.confirm = true;
    s.model(gem.call('create_standing_order', c), gem.text('Shall I?'));
    s.say('hmm, who is the caller');
    T.eq(g.P.STORE.x_196061_netra_v1_task, undefined, 'a question never arms it');
    s.model(gem.call('create_standing_order', c), gem.text('Armed.'));
    s.say('yes, arm it', { drop_unheard: true });
    T.eq(g.P.STORE.x_196061_netra_v1_task, undefined, 'a yes to a read-back the page never spoke never arms it');
});

T.run(__filename);
