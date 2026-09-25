/*
 * The legacy POST /voice/command endpoint follows the widget's rule: every
 * write is read back and runs only on the caller's next "yes".
 */
'use strict';
var fs = require('fs'), path = require('path'), vm = require('vm');
var T = require('./lib/t'), S = require('./lib/session'), N = require('./lib/netra'), g = S.g;

var SRC = fs.readFileSync(path.join(__dirname, '..', 'source', 'scripted_rest', 'command.js'), 'utf8');
function post(transcript, pending) {
    N.loadScriptIncludes();
    global.request = { body: { data: { transcript: transcript, pending: pending || null } } };
    global.response = {};
    return vm.runInThisContext(SRC, { filename: 'command.js' });
}
function count(table) { return Object.keys(g.P.STORE[table] || {}).length; }

T.test('create is read back and happens only on the yes', function () {
    new S.Session();
    var before = count('incident');
    var r1 = post('create a ticket for the vpn dropping every hour');
    T.match(r1.message, /I will raise a ticket: "the vpn dropping every hour"\. Shall I\?/);
    T.eq(r1.pending, 'confirm_destructive');
    T.eq(count('incident'), before, 'nothing created on the first breath');
    var r2 = post('yes', r1.pending);
    T.ok(r2.ok, r2.message);
    T.eq(count('incident'), before + 1);
    T.ok(r2.clear_pending);
    T.match(post('yes', 'confirm_destructive').message, /nothing waiting for a yes/, 'a second yes does nothing');
    T.eq(count('incident'), before + 1);
});

T.test('no drops it; an old yes does nothing', function () {
    new S.Session();
    var r1 = post('resolve INC0010013');
    T.match(r1.message, /I will resolve .*Shall I\?/);
    T.match(post('no', r1.pending).message, /nothing was changed/);
    T.eq(g.find('incident', 'number', 'INC0010013').state, '2');
    post('resolve INC0010013');
    g.P.now += 11 * 60000;
    T.match(post('yes', 'confirm_destructive').message, /nothing waiting for a yes/);
    T.eq(g.find('incident', 'number', 'INC0010013').state, '2', 'a read-back from 11 minutes ago is not confirmed');
});

T.test('a caller reading a ticket never hears its work notes', function () {
    new S.Session();
    g.find('incident', 'number', 'INC0010015').caller_id = 'u_beth';
    g.put('sys_journal_field', { element_id: 'inc15', element: 'work_notes', value: 'internal: probably user error', sys_created_by: 'admin', sys_created_on: g.fmtUtc(g.P.now) });
    g.P.user = { sys_id: 'u_beth', name: 'Beth Anglin', user_name: 'beth.anglin' };
    g.P.ACL = function (table, op, rec, field) { return table !== 'incident' || (op === 'read' && field !== 'work_notes' && rec.caller_id === 'u_beth'); };
    var r = post('read INC0010015');
    T.notMatch(JSON.stringify(r), /probably user error/);
});

T.run(__filename);
