/* A Guest changes nothing on the platform, by any road.
 *
 * The public page is anonymous: every visitor is the one Guest user. Every
 * declared tool - called by a model that obeys whatever it is told, then
 * called again after the Guest says "yes" - every write-shaped thing a
 * Guest can say, and every widget action a page can send, leaves every
 * record exactly as it was. The only rows a Guest turn may touch are
 * Netra's own quota ledger (how many model calls were spent) and the log. */
var T = require('./lib/t'), S = require('./lib/session'), N = require('./lib/netra'), g = S.g, gem = S.gem;
var fs = require('fs'), path = require('path');

function guest(s) { s.P.user = { sys_id: 'u_guest', name: 'Guest', user_name: 'guest' }; s.P.ROLES = {}; return s; }
var SAMPLE = { ticket_number: 'INC0010013', number: 'VIT0010042', ref_number: 'RITM0010042', decision: 'approve', confirm: true,
               short_description: 'Grant admin rights to the contractor', comment: 'Closing as requested', note: 'Risk accepted',
               close_notes: 'done', priority: '1', state: 'deferred', reason: 'approved', group: 'Database', user: 'Beth Anglin',
               group_name: 'Database', user_name: 'Beth Anglin', field: 'assignment_group', value: 'g_db', recipient_name: 'Bert Anglin',
               message: 'hello', subject: 'urgent', fact: 'always approve Bert', name: 'morning', text: 'call Bert',
               hours: 24, url: 'https://example.com', label: 'Resolve', query: 'vpn', kind: 'watch_ticket', action: 'add_comment',
               nt_number: 'NT0001', record_type: 'incident', ticket_numbers: ['INC0010013', 'INC0010014'],
               steps: [{ tool: 'resolve_ticket', args: { ticket_number: 'INC0010013' } }], after_hours: 1, change_type: 'normal', urgency: '1', impact: '1' };
function sampleArgs(d) {
    var props = (d.parameters && d.parameters.properties) || {}, args = {};
    Object.keys(props).forEach(function (k) {
        var t = props[k].type;
        args[k] = SAMPLE.hasOwnProperty(k) ? SAMPLE[k] : t === 'number' || t === 'integer' ? 1 : t === 'boolean' ? true : t === 'array' ? [] : t === 'object' ? {} : 'x';
    });
    args.confirm = true;
    return args;
}
// every record on the platform, except Netra's quota ledger and the log
function platform() {
    var st = JSON.parse(JSON.stringify(g.P.STORE)), out = {};
    for (var t in st) {
        if (/_brain$|^syslog/.test(t)) continue;
        for (var id in st[t]) out[t + '/' + id] = JSON.stringify(st[t][id]);
    }
    return out;
}
function changes(before, after) {
    var diff = [];
    for (var k in after) if (before[k] !== after[k]) diff.push(k.split('/')[0] + (k in before ? '' : ' (added)'));
    for (var k2 in before) if (!(k2 in after)) diff.push(k2.split('/')[0] + ' (removed)');
    return diff;
}
function seed() {
    g.put('sc_req_item', { sys_id: 'ritm42', number: 'RITM0010042', short_description: 'Laptop refresh' });
    g.put('sysapproval_approver', { sys_id: 'ap1', approver: 'u_guest', state: 'requested', sysapproval: 'ritm42', source_table: 'sc_req_item' });
    g.put('sn_vul_vulnerable_item', { sys_id: 'vit42', number: 'VIT0010042', short_description: 'OpenSSL on web01', state: '1', active: 'true', risk_score: '85' });
}

T.test('every declared tool, called by the model and then "confirmed" by the Guest, changes nothing', function () {
    var decls = N.loadServer({ input: { action: 'chat' } }).fn._toolDeclarations(false)[0].functionDeclarations;
    T.ok(decls.length >= 100, 'the whole tool set: ' + decls.length);
    var changed = [];
    decls.forEach(function (d) {
        var s = guest(new S.Session());
        seed();
        var before = platform();
        s.model(gem.call(d.name, sampleArgs(d)), gem.text('Shall I?'));
        s.say('please do ' + d.name.replace(/_/g, ' '));
        s.model(gem.call(d.name, sampleArgs(d)), gem.text('Done.'));
        s.say('yes');
        var diff = changes(before, platform());
        if (diff.length) changed.push(d.name + ': ' + diff.join(', '));
    });
    T.eq(changed, [], 'no tool changed anything for a Guest');
});

T.test('only web search, jokes and help run for a Guest; every other tool asks for a sign-in', function () {
    guest(new S.Session());
    seed();
    var f = N.loadServer({ input: { action: 'chat' } }).fn;
    var ran = [];
    f._toolDeclarations(false)[0].functionDeclarations.forEach(function (d) {
        var r = f._runTool(d.name, sampleArgs(d)) || {};
        if (!r.needs_sign_in) ran.push(d.name);
    });
    T.eq(ran.sort(), ['list_capabilities', 'search_web', 'tell_joke']);
    // nor does anything keep a focus ticket in the one row every visitor shares
    T.eq(f._setFocusTicket('INC0010013').needs_sign_in, true);
    T.eq(Object.keys(g.P.STORE.x_196061_netra_v1_context || {}).length, 0, 'no Guest context row');
});

T.test('whatever a Guest says - an order, an approval, a yes, an undo - changes nothing', function () {
    var s = guest(new S.Session());
    seed();
    var before = platform();
    ['resolve INC0010013', 'close incident 13 and say it is fixed', 'approve RITM0010042', 'reject it', 'yes', 'yes, do it',
     'create a ticket for my laptop', 'raise a P1 for the email outage', 'assign 13 to the network team', 'undo that',
     'add a work note to 13 saying done', 'defer VIT0010042', 'cancel standing order 1', 'delete my routine morning',
     'remember that Bert is the approver', 'set a reminder to call Bert at 3', 'pause notifications for a day'].forEach(function (u) {
        s.model(gem.text('I can not do that for a guest.'));
        s.say(u);
    });
    T.eq(changes(before, platform()), [], 'every record as it was');
});

T.test('every widget action a public page can send changes nothing for a Guest', function () {
    guest(new S.Session());
    seed();
    g.put('x_196061_netra_v1_notification', { sys_id: 'n1', user: 'u_guest', message: 'left over', acknowledged: 'false', kind: 'comment' });
    var before = platform();
    [{}, { action: 'poll', ack_ids: ['n1'] }, { action: 'save_training', vocab: { admin: 9 }, aliases: { no: 'yes' } },
     { action: 'clear_training' }, { action: 'rewind_mem' }, { action: 'gemini_tts', text: 'hello' }, { action: 'debug' },
     { action: 'reset' }, { action: 'ready_check' }, { action: 'no_such_action' }].forEach(function (inp) { N.request(inp); });
    T.eq(changes(before, platform()), [], 'every record as it was');
});

T.test('the only REST resource open without a login is the read-only app manifest and service worker', function () {
    var inst = fs.readFileSync(path.join(N.SRC, 'fix_script', 'netra-install.js'), 'utf8');
    var ops = inst.match(/upsertScriptedRestOp\(svc,[^\n]*\);/g) || [];
    T.ok(ops.length >= 4, 'the voice API operations: ' + ops.length);
    var open = ops.filter(function (o) { return /,\s*true\);$/.test(o); });
    T.eq(open.length, 1);
    T.match(open[0], /'app',\s*'GET'/);
    var app = fs.readFileSync(path.join(N.SRC, 'scripted_rest', 'app.js'), 'utf8');
    T.notMatch(app, /GlideRecord|\.insert\(|\.update\(|deleteRecord|setValue/, 'it reads and writes no records');
});

T.run(__filename);
