/*
 * Writes that can not be taken back (comments the caller sees, work notes,
 * messages, batch changes) and undo are read back from their real arguments
 * before they run - on every path, not only when other people's text is in
 * play - and a natural yes carries them out.
 */
'use strict';
var T = require('./lib/t'), S = require('./lib/session'), gem = S.gem, g = S.g;

function sysText(body) { return JSON.stringify(body.systemInstruction || body.system_instruction || ''); }

T.test('a customer comment is read back with its exact words, and "yeah, go ahead" sends it', function () {
    var s = new S.Session();
    s.model(gem.call('update_ticket', { ticket_number: 'INC0010013', comment: 'Rebooting the VPN concentrator now' }), gem.text('Done.'));
    var r = s.say('tell the caller on 13 we are rebooting the concentrator');
    T.match(r.message, /add a comment the caller will see on \*\*incident ending 0 1 3\*\* saying "Rebooting the VPN concentrator now"\. Shall I\?/);
    T.eq((s.inc('INC0010013')._comments || []).length, 0, 'nothing sent before the yes');
    T.eq(s.gemini.generate.length, 1, 'the read-back cost no second model call');
    var y = s.say('yeah, go ahead');
    T.eq(s.inc('INC0010013')._comments, ['Rebooting the VPN concentrator now']);
    T.match(y.message, /Comment added/);
});

T.test('a fuller yes reaches the model; the same write asked again is the confirmation', function () {
    var s = new S.Session();
    s.model(gem.call('add_work_note', { ticket_number: 'INC0010014', note: 'Fan replaced' }), gem.text('Shall I?'));
    s.say('note on 14 that the fan was replaced');
    s.model(gem.call('add_work_note', { ticket_number: 'inc10014', note: 'fan replaced' }), gem.text('Added.'));
    s.say('yes, and thanks for doing that');
    T.eq(s.inc('INC0010014')._work_notes, ['[Netra] fan replaced']);
    // a different write is not confirmed by that yes
    s.model(gem.call('add_work_note', { ticket_number: 'INC0010015', note: 'x' }), gem.text('Shall I?'));
    s.say('and note x on 15');
    s.model(gem.call('add_work_note', { ticket_number: 'INC0010016', note: 'x' }), gem.text('Shall I?'));
    s.say('yes, and put the same note on 16');
    T.ok(!s.inc('INC0010016')._work_notes, 'another ticket is not written on the yes to 15 - it is read back first');
    T.match(JSON.stringify(s.blob().flDraft), /INC0010016/);
});

T.test('undo on the model path reads back what the slot really holds', function () {
    var s = new S.Session();
    s.setBlob({ last_action: { kind: 'field', number: 'INC0010013', table: 'incident', field: 'assignment_group', old: 'g_db', old_display: 'Database', at_ms: g.P.now } });
    s.model(gem.call('undo_last_action', {}), gem.text('Undone.'));
    var r = s.say('take that back');
    T.match(r.message, /That would put assignment group on \*\*incident ending 0 1 3\*\* back to Database\. Shall I\?/);
    T.eq(s.inc('INC0010013').assignment_group, 'g_net', 'nothing undone before the yes');
    s.say('yes');
    T.eq(s.inc('INC0010013').assignment_group, 'g_db');
});

T.test('the focus follows the ticket a tool worked on and rides the next prompt', function () {
    var s = new S.Session();
    s.model(gem.call('assign_ticket_to_group', { ticket_number: 'INC0010014', group_name: 'Database' }), gem.text('Done.'));
    s.say('give 14 to Database');
    s.model(gem.text('It is with Database.'));
    s.say('who has it now');
    T.match(sysText(s.gemini.generate[0]), /CURRENT FOCUS TICKET: INC0010014/);
});

T.test('a plan step "message Beth" is a real message, read back as one', function () {
    var s = new S.Session();
    s.model(gem.call('make_plan', { steps: [{ tool: 'send_message', args: { to: 'Beth Anglin', text: 'VPN is back' } }] }), gem.text('Shall I run it?'));
    var r = s.say('tell Beth the VPN is back');
    T.match(JSON.stringify(s.blob().plan.steps), /send_sidebar_message/);
    T.match(r.message, /message Beth Anglin: "VPN is back"/);
});

T.test('a batch change can be undone ticket by ticket; comments stay', function () {
    var s = new S.Session();
    s.model(gem.call('batch_update_tickets', { ticket_numbers: ['INC0010013', 'INC0010014'], state: '3', comment: 'On hold for the vendor' }), gem.text('Done.'));
    s.say('put 13 and 14 on hold for the vendor');
    s.say('yes');
    T.eq(s.inc('INC0010013').state, '3');
    T.match(s.say('undo that').message, /put back what the batch change did on 2 tickets - \*\*incident ending 0 1 3\*\*, \*\*incident ending 0 1 4\*\* - the comments stay\. Shall I\?/);
    var r = s.say('yes');
    T.eq(s.inc('INC0010013').state, '2');
    T.eq(s.inc('INC0010014').state, '2');
    T.match(r.message, /The comments stay - they can not be taken back/);
});

T.test('a yes to an undo read-back never undoes a newer change made since', function () {
    var s = new S.Session();
    s.setBlob({ last_action: { kind: 'field', number: 'INC0010013', table: 'incident', field: 'assignment_group', old: 'g_db', old_display: 'Database', at_ms: g.P.now } });
    T.match(s.say('undo that').message, /back to Database\. Shall I\?/);
    var b = s.blob();   // a newer write lands before the yes
    b.last_action = { kind: 'field', number: 'INC0010014', table: 'incident', field: 'assignment_group', old: 'g_sw', old_display: 'Software', at_ms: g.P.now + 1000 };
    s.setBlob(b);
    T.match(s.say('yes').message, /not the one I read back any more, so I undid nothing/);
    T.eq(s.inc('INC0010014').assignment_group, 'g_net');
    T.eq(s.inc('INC0010013').assignment_group, 'g_net');
});

T.test('the prompt never teaches a one-breath "Done." for a write', function () {
    var s = new S.Session();
    s.model(gem.text('Hi.'));
    s.say('hello there netra, how are things going today');
    T.notMatch(sysText(s.gemini.generate[0]), /reply BRIEF and TRANSACTIONAL \(\\"Done\.\\"\)/);
    T.match(sysText(s.gemini.generate[0]), /Brevity never skips a read-back/);
});

T.run(__filename);
