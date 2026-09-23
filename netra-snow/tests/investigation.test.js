/*
 * Investigate before concluding: evidence first, one model call at most,
 * and nothing spoken that the evidence does not contain.
 */
'use strict';
var T = require('./lib/t'), S = require('./lib/session'), sc = require('./lib/scenario'), gem = S.gem, g = S.g;
var N = require('./lib/netra');
var f = N.loadServer({ input: { action: 'chat' } }).fn;

function outage(llm) {
    var s = new S.Session();
    sc.seedOutage(s, g);
    if (!llm) g.P.PROPS['x_196061_netra_v1.investigate_llm'] = 'false';
    return s;
}
function evidenceId(body, needle) {
    var text = body.contents[body.contents.length - 1].parts[0].text;
    var lines = text.split('\n');
    for (var i = 0; i < lines.length; i++) {
        var m = /^(E\d+) \[/.exec(lines[i]);
        if (m && lines[i].indexOf(needle) >= 0) return m[1];
    }
    return null;
}

T.test('rules mode: the direct change first, decoys absent, free', function () {
    var s = outage(false);
    var r = s.say('investigate INC0030010');
    T.eq(s.gemini.generate.length, 0);
    T.match(r.message, /Theory one, most likely: The trouble may be linked to CHG0030006 'Apply kernel patches': work finished on netra-lab-web01 40 minutes before the first ticket/);
    T.match(r.message, /40 minutes before the first of 4 tickets on that server \(direct CI, normal change, moderate risk, closed successful\)/);
    T.notMatch(r.message, /CHG0030007|CHG0030008/, 'outside the window / other box');
    T.match(r.message, /I checked 9 sources\./);
});

T.test('model mode: one call, invented facts dropped, spoken answer composed from evidence', function () {
    var s = outage(true);
    s.model(function (body, raw) {
        var chg = evidenceId(body, "CHG0030006 'Apply kernel patches'");
        var tkt = evidenceId(body, "INC0030010 'web01");
        return gem.json({
            headline: 'This lines up with CHG0099999 applied at 2:14 PM',          // invented change and time
            hypotheses: [
                { statement: 'CHG0030006 kernel patches finished 40 minutes before the first ticket', confidence: 'high', cites: [chg],
                  confirm_by: 'check the patch log', rule_out_by: 'errors before the window', signal: { type: 'change_backed_out', ref: 'CHG0030006' } },
                { statement: 'CHG0030006 finished 5 minutes before the errors', confidence: 'high', cites: [chg],
                  confirm_by: 'x', rule_out_by: 'y', signal: { type: 'none' } },                    // wrong figure
                { statement: 'The login page returns 502', confidence: 'medium', cites: [tkt],
                  confirm_by: 'x', rule_out_by: 'y', signal: { type: 'none' } }                    // restates the symptom
            ]
        });
    });
    var r = s.say('investigate INC0030010');
    T.eq(s.gemini.generate.length, 1, 'exactly one model call');
    T.notMatch(r.message, /CHG0099999|2:14/, 'invented headline never spoken');
    T.notMatch(r.message, /5 minutes before the errors/, 'wrong figure dropped');
    T.notMatch(r.message, /login page returns 502/, 'symptom is not a cause');
    T.match(r.message, /CHG0030006 kernel patches finished 40 minutes before the first ticket/);
    var again = s.say('investigate again');
    T.eq(s.gemini.generate.length, 1, 'second ask is served from cache, free');
    T.match(again.message, /40 minutes before the first ticket/);
});

T.test('thin evidence: says so instead of inventing a theory, even in model mode', function () {
    var s = outage(true);
    var r = s.say('investigate INC0030099');
    T.eq(s.gemini.generate.length, 0);
    T.match(r.message, /not enough evidence for an honest theory yet/);
    T.match(s.say('what did you check').message, /ci \(skipped, no CI on the ticket\)/);
});

T.test('basic mode and the turn budget bind the investigator too', function () {
    var s = outage(true);
    g.P.PROPS['x_196061_netra_v1.brain_offline'] = 'true';
    var r = s.say('investigate INC0030010');
    T.eq(s.gemini.generate.length, 0, 'no model call in forced basic mode');
    T.match(r.message, /these come from rules over the evidence/i);
});

T.test('a configuration-item investigation cannot be written up, linked or watched as a ticket', function () {
    var s = outage(false);
    s.say('investigate netra-lab-web01');
    T.match(s.say('write it up').message, /configuration item, not a ticket/);
    T.match(s.say('link that change').message, /configuration item, not a ticket/);
    T.match(s.say('keep digging').message, /only keep digging on a ticket/);
});

T.test('write-up: read back, then written and read back from the journal', function () {
    var s = outage(false);
    s.say('investigate INC0030010');
    T.match(s.say('write it up').message, /I will add a work note to \*\*incident ending 0 1 0\*\* .* Shall I\?/);
    g.GlideRecord.onUpdate.incident = function (next) {
        (next._work_notes || []).slice(-1).forEach(function (n) { g.put('sys_journal_field', { element_id: next.sys_id, element: 'work_notes', value: n, sys_created_on: g.fmtUtc(g.P.now) }); });
    };
    var r = s.say('yes');
    T.match(r.message, /Written up on \*\*incident ending 0 1 0\*\* as a work note - I read it back/);
    T.match(g.find('incident', 'number', 'INC0030010')._work_notes.join('\n'), /Netra investigation/);
});

T.test('link that change: caused_by only - never the problem\'s fix-change field', function () {
    var s = outage(false);
    g.P.INVALID_FIELDS.incident = { caused_by: true };
    s.say('investigate INC0030010');
    T.match(s.say('link that change').message, /no "caused by" field, so I will cross-reference/);
});

T.test('validator: figures and record numbers must come from the evidence', function () {
    var dossier = { anchor: { number: 'INC0010013' }, items: [
        { id: 'E1', kind: 'ticket', ref: 'INC0010013', text: 'INC0010013 opened 14:05: web01 errors', weight: 'medium' },
        { id: 'E2', kind: 'change', ref: 'CHG0030006', text: 'CHG0030006 patch applied on web01, 40 min before the first ticket', weight: 'strong' }] };
    var v = f._invValidate([
        { statement: 'CHG0030006 landed 40 minutes before the errors', confidence: 'high', cites: ['E2'], confirm_by: 'a', rule_out_by: 'b', signal: { type: 'none' } },
        { statement: 'CHG0030006 landed 5 minutes before the errors', confidence: 'high', cites: ['E2'], confirm_by: 'a', rule_out_by: 'b', signal: { type: 'none' } },
        { statement: 'CHG0030099 is to blame', confidence: 'high', cites: ['E2'], confirm_by: 'a', rule_out_by: 'b', signal: { type: 'none' } }], dossier, '');
    T.eq(v.hypotheses.map(function (h) { return h.statement; }), ['CHG0030006 landed 40 minutes before the errors']);
    T.ok(f._invTextOk('Lines up with CHG0030006, 40 minutes earlier', v));
    T.ok(!f._invTextOk('Lines up with CHG0030006 applied at 2:14 PM', v), 'invented clock time');
    T.ok(!f._invTextOk('Lines up with CHG 0030099', v), 'spaced-out invented number');
});

T.test('pronoun targets', function () {
    ['it', 'this', 'This', 'IT', 'that incident', 'The Ticket', 'this broke', 'that one', 'my ticket'].forEach(function (x) { T.eq(f._invTarget(x), '', x); });
    T.eq(f._invTarget('netra-lab-web01 went down'), 'netra-lab-web01');
    T.eq(f._invTarget('INC0010013'), 'INC0010013');
});

T.run(__filename);
