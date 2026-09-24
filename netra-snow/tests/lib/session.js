/*
 * A conversation with Netra the way the page has it: every turn is a fresh
 * widget request through the real router, carrying the history the client
 * keeps. Seeds a small, realistic instance (users, groups, incidents).
 */
'use strict';
var N = require('./netra'), g = N.glide, gem = require('./gemini');

var PRIORITY = { '1,1': '1', '1,2': '2', '2,1': '2', '1,3': '3', '2,2': '3', '3,1': '3', '2,3': '4', '3,2': '4', '3,3': '5' };

function world(opts) {
    opts = opts || {};
    g.reset();
    var P = g.P;
    P.PROPS['x_196061_netra_v1.gemini_api_key'] = opts.key === undefined ? 'test-key' : opts.key;
    P.PROPS['x_196061_netra_v1.ticket_writes'] = 'true';
    g.put('sys_user', { sys_id: 'u_admin', name: 'System Administrator', user_name: 'admin', active: 'true', email: 'admin@example.com' });
    g.put('sys_user', { sys_id: 'u_beth', name: 'Beth Anglin', user_name: 'beth.anglin', active: 'true', email: 'beth@example.com' });
    g.put('sys_user', { sys_id: 'u_bert', name: 'Bert Anglin', user_name: 'bert.anglin', active: 'true', email: 'bert@example.com' });
    // like every instance, the admin account holds the admin role
    g.put('sys_user_role', { sys_id: 'role_admin', name: 'admin' });
    g.put('sys_user_has_role', { user: 'u_admin', role: 'role_admin' });
    [['g_net', 'Network'], ['g_cab', 'Network CAB Managers'], ['g_db', 'Database'], ['g_dbsd', 'Database San Diego'], ['g_sw', 'Software']].forEach(function (x) {
        g.put('sys_user_group', { sys_id: x[0], name: x[1], active: 'true' });
        P.DISPLAY[x[0]] = x[1];
    });
    P.DISPLAY.u_admin = 'System Administrator'; P.DISPLAY.u_beth = 'Beth Anglin'; P.DISPLAY.u_bert = 'Bert Anglin';
    for (var i = 0; i < 6; i++) {
        g.put('incident', { sys_id: 'inc' + (13 + i), number: 'INC00100' + (13 + i), caller_id: 'u_admin', opened_by: 'u_admin',
                            state: '2', active: 'true', impact: '2', urgency: '2', priority: '3', assignment_group: 'g_net',
                            short_description: ['VPN drops every few minutes', 'Outlook will not open', 'Printer jammed on floor 3',
                                                'Laptop fan loud', 'Password reset loop', 'Monitor flickers'][i] });
    }
    // a real instance is never empty: one unrelated row in the tables the
    // investigator reads, so "no rows at all" is not mistaken for "no access"
    ['sys_audit', 'sys_journal_field', 'cmdb_rel_ci', 'task_ci', 'change_task', 'kb_knowledge', 'cmdb_ci', 'change_request', 'problem']
        .forEach(function (t) { g.put(t, { sys_id: 'base_' + t, name: 'baseline', number: 'BASE' + t.length, documentkey: 'none', element_id: 'none', ci_item: 'none', parent: 'none', child: 'none', cmdb_ci: 'none', state: '7', active: 'false' }); });
    // the platform derives incident priority from impact x urgency
    g.GlideRecord.onUpdate.incident = function (next) {
        var p = PRIORITY[String(next.impact) + ',' + String(next.urgency)];
        if (p) next.priority = p;
    };
    return P;
}

function Session(opts) {
    this.P = world(opts);
    this.history = [];
    this.last = null;
    this.gemini = gem.install(this.P, []);
}
Session.prototype.model = function () {           // queue what the model will reply, in order
    var q = [];
    for (var i = 0; i < arguments.length; i++) q.push(arguments[i]);
    this.gemini = gem.install(this.P, q);
    return this;
};
Session.prototype.say = function (text, opts) {
    opts = opts || {};
    var data = N.request({ action: 'chat', message: text, history: this.history, auto: !!opts.auto, live_mode: true, drop_unheard: !!opts.drop_unheard });
    var r = data.response || {};
    if (Array.isArray(r.history)) this.history = r.history;
    this.last = r;
    return r;
};
Session.prototype.blob = function () {
    var ctx = g.find('x_196061_netra_v1_context', 'user', this.P.user.sys_id);
    var raw = ctx ? String(ctx.last_utterance || '') : '';
    return raw.indexOf('CTX:') === 0 ? JSON.parse(raw.substring(4)) : {};
};
Session.prototype.setBlob = function (patch) {
    var fns = N.loadServer({ input: { action: 'chat' } }).fn;
    var b = fns._ctxReadBlob();
    for (var k in patch) if (patch.hasOwnProperty(k)) b[k] = patch[k];
    fns._ctxWriteBlob(b);
};
Session.prototype.inc = function (num) { return g.find('incident', 'number', num); };

module.exports = { Session: Session, world: world, g: g, gem: gem };
