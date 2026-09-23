/*
 * "Work through the unassigned queue": reviewed in the background with
 * embeddings only (never a generate call), reported on the board, applied
 * only after a yes with every write re-read, human-touched tickets skipped,
 * and fully undoable.
 */
'use strict';
var T = require('./lib/t'), S = require('./lib/session'), N = require('./lib/netra'), g = S.g;
var MIN = 60000;

function queueWorld() {
    var s = new S.Session();
    for (var i = 0; i < 6; i++) {
        g.put('incident', { number: 'INC00400' + (10 + i), state: '7', active: 'false', assignment_group: 'g_net', category: 'network', priority: '3', impact: '2', urgency: '2',
                            short_description: 'VPN tunnel keeps dropping for remote staff ' + i, close_notes: 'Restarted the VPN concentrator',
                            resolved_at: g.fmtUtc(g.P.now - (i + 2) * 86400000), caller_id: 'u_bert' });
    }
    for (var j = 0; j < 3; j++) {
        g.put('incident', { sys_id: 'q' + j, number: 'INC00500' + (10 + j), state: '1', active: 'true', assignment_group: '', assigned_to: '', impact: '2', urgency: '2', priority: '3',
                            short_description: 'VPN disconnects every few minutes ' + j, caller_id: 'u_bert',
                            sys_created_on: g.fmtUtc(g.P.now - (60 - j) * MIN), opened_at: g.fmtUtc(g.P.now - (60 - j) * MIN) });
    }
    // warm the vector cache the way an admin would ("reindex my tickets")
    var w = N.loadServer({ input: { action: 'chat' } }).fn._reindexIncidents(40);
    T.ok(w.ok && w.embedded_now >= 9, 'cache warmed: ' + JSON.stringify(w));
    return s;
}
function advance(times) {
    var out = [];
    for (var i = 0; i < times; i++) { N.loadScriptIncludes(); g.P.now += 5 * MIN; out.push(new NetraMissionRunner().advance()); }
    return out;
}

T.test('mission: launch on a yes, review with no generate calls, apply verified, undo', function () {
    var s = queueWorld();
    var pv = s.say('work through the unassigned queue');
    T.match(pv.message, /3 unassigned incidents/);
    T.eq(g.P.STORE.x_196061_netra_v1_mission_item, undefined, 'nothing launched before the yes');
    var go = s.say('yes');
    T.match(go.message, /mission|Mission/);
    advance(6);
    T.eq(s.gemini.generate.length, 0, 'reviewing costs no generate calls');
    T.ok(s.gemini.embed > 0, 'it used embeddings');
    var board = s.say("how's the mission going");
    T.match(board.message, /Mission 1 finished reviewing all 3: 3 confident routings.*Nothing has changed yet/);
    var ask = s.say('apply the confident ones');
    T.match(ask.message, /I will route 3 tickets .* Shall I\?/);
    // a human routes one of them meanwhile: the mission must leave it alone
    var human = g.find('incident', 'number', 'INC0050011');
    human.assignment_group = 'g_sw'; human.sys_mod_count = String(parseInt(human.sys_mod_count, 10) + 1);
    s.say('yes');
    advance(4);
    T.eq(g.find('incident', 'number', 'INC0050010').assignment_group, 'g_net');
    T.eq(g.find('incident', 'number', 'INC0050012').assignment_group, 'g_net');
    T.eq(g.find('incident', 'number', 'INC0050011').assignment_group, 'g_sw', 'human routing kept');
    T.eq(s.gemini.generate.length, 0, 'still no generate calls');
    s.say('undo the mission');
    s.say('yes');
    advance(2);
    T.eq(g.find('incident', 'number', 'INC0050010').assignment_group, '', 'undone');
    T.eq(g.find('incident', 'number', 'INC0050011').assignment_group, 'g_sw', 'undo leaves the human routing alone');
});

T.run(__filename);
