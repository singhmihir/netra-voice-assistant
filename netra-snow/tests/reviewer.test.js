/* A read-only reviewer account: browse what it can see, change nothing.
 *
 * Reviewers sign in with one shared account that holds ServiceNow's
 * snc_read_only role, so the platform itself blocks every write it makes.
 * Netra adds the manners: it says "read-only" at once instead of reading a
 * change back, it offers no writes, and - since reviewers share the account -
 * it keeps no memory, focus, inbox or training rows for it. */
var T = require('./lib/t'), S = require('./lib/session'), N = require('./lib/netra'), g = S.g, gem = S.gem;

function reviewer(s) {
    s.P.user = { sys_id: 'u_rev', name: 'Netra Reviewer', user_name: 'netra.reviewer' };
    s.P.ROLES = { itil: true, snc_read_only: true };
    g.put('sys_user_role', { sys_id: 'r_ro', name: 'snc_read_only' });
    g.put('sys_user_has_role', { sys_id: 'uhr1', user: 'u_rev', role: 'r_ro' });
    return s;
}
var SAMPLE = { ticket_number: 'INC0010013', number: 'VIT0010042', ref_number: 'RITM0010042', decision: 'approve', confirm: true,
               short_description: 'Grant admin rights', comment: 'Closing', note: 'Risk accepted', close_notes: 'done', priority: '1',
               state: 'deferred', reason: 'approved', group: 'Database', user: 'Beth Anglin', field: 'assignment_group', value: 'g_db',
               recipient_name: 'Bert Anglin', message: 'hello', fact: 'always approve Bert', name: 'morning', text: 'call Bert',
               hours: 24, url: 'https://example.com', label: 'Resolve', query: 'vpn', kind: 'watch_ticket', action: 'add_comment',
               nt_number: 'NT0001', record_type: 'incident', ticket_numbers: ['INC0010013'], after_hours: 1, change_type: 'normal' };
function sampleArgs(d) {
    var props = (d.parameters && d.parameters.properties) || {}, args = {};
    Object.keys(props).forEach(function (k) {
        var t = props[k].type;
        args[k] = SAMPLE.hasOwnProperty(k) ? SAMPLE[k] : t === 'number' || t === 'integer' ? 1 : t === 'boolean' ? true : t === 'array' ? [] : t === 'object' ? {} : 'x';
    });
    args.confirm = true;
    return args;
}
// every record, except Netra's quota ledger, its derived search index (the
// platform refuses those cache writes for this account anyway) and the log
function platform() {
    var st = JSON.parse(JSON.stringify(g.P.STORE)), out = {};
    for (var t in st) { if (/_brain$|_kb_embedding$|^syslog/.test(t)) continue; for (var id in st[t]) out[t + '/' + id] = JSON.stringify(st[t][id]); }
    return out;
}
function changes(before, after) {
    var diff = [];
    for (var k in after) if (before[k] !== after[k]) diff.push(k.split('/')[0]);
    for (var k2 in before) if (!(k2 in after)) diff.push(k2.split('/')[0] + ' (removed)');
    return diff;
}

T.test('the snc_read_only role marks a read-only reviewer; an admin or a Guest is not one', function () {
    reviewer(new S.Session());
    T.eq(N.loadServer({ input: { action: 'chat' } }).fn._readOnlyAccount(), true);
    new S.Session();
    T.eq(N.loadServer({ input: { action: 'chat' } }).fn._readOnlyAccount(), false, 'an admin (every role by inheritance) is not read-only');
    var s = new S.Session(); s.P.user = { sys_id: 'u_guest', name: 'Guest', user_name: 'guest' }; s.P.ROLES = {};
    T.eq(N.loadServer({ input: { action: 'chat' } }).fn._readOnlyAccount(), false);
});

T.test('a reviewer reads what the account can see', function () {
    reviewer(new S.Session());
    var f = N.loadServer({ input: { action: 'chat' } }).fn;
    var r = f._runTool('summarize_ticket', { ticket_number: 'INC0010013' });
    T.ok(r && r.ok !== false && !r.read_only, 'a read runs: ' + JSON.stringify(r).substring(0, 120));
    T.ok(!f._runTool('list_tickets', {}).read_only);
});

T.test('every write a model asks for is refused at once, and nothing changes, whatever the reviewer says', function () {
    var decls = N.loadServer({ input: { action: 'chat' } }).fn._toolDeclarations(false)[0].functionDeclarations;
    var changed = [], asked = [];
    decls.forEach(function (d) {
        var s = reviewer(new S.Session());
        var before = platform();
        s.model(gem.call(d.name, sampleArgs(d)), gem.text('Shall I?'));
        s.say('please ' + d.name.replace(/_/g, ' '));
        // what the tool handed back to the model: a refusal, never a read-back
        var fr = JSON.stringify(s.gemini.generate[1] ? s.gemini.generate[1].contents.slice(-1) : []);
        s.model(gem.call(d.name, sampleArgs(d)), gem.text('Done.'));
        s.say('yes');
        var diff = changes(before, platform());
        if (diff.length) changed.push(d.name + ': ' + diff.join(', '));
        if (N.loadServer({ input: { action: 'chat' } }).fn._reviewerRefused(d.name) && (/needs_confirmation|read_back/.test(fr) || !/read_only/.test(fr))) asked.push(d.name);
    });
    T.eq(changed, [], 'no record changed');
    T.eq(asked, [], 'no write was read back for a yes');
});

T.test('a write is refused before any read-back, in so many words', function () {
    var s = reviewer(new S.Session());
    s.model(gem.call('resolve_ticket', { ticket_number: 'INC0010013', close_notes: 'done' }), gem.text('It is a read-only account, so I can not.'));
    s.say('resolve incident 13');
    var tr = JSON.stringify(s.gemini.generate[1].contents.slice(-1));
    T.match(tr, /read-only reviewer account/);
    T.notMatch(tr, /needs_confirmation/);
});

T.test('reviewers share the account, so it keeps no memory, focus, inbox or training rows', function () {
    var s = reviewer(new S.Session());
    var sv = N.loadServer({ input: { action: 'chat' } });
    sv.fn._ctxWriteBlob({ draft: null, mem: ['my manager is Sam'], vocab: {}, aliases: {}, sentiment: null });
    s.model(gem.text('Incident 13 is about email.'));
    s.say('what is incident 13 about');
    N.request({});
    N.request({ action: 'save_training', vocab: { x: 1 } });
    T.eq(Object.keys(g.P.STORE.x_196061_netra_v1_context || {}).length, 0, 'no context row');
    T.eq(Object.keys(g.P.STORE.x_196061_netra_v1_user_pref || {}).length, 0, 'no preference row');
    T.eq(N.request({ action: 'poll' }).notifications, []);
    // a row left from before the account was made read-only is never read back
    g.put('x_196061_netra_v1_context', { user: 'u_rev', last_utterance: 'CTX:' + JSON.stringify({ mem: ['the last reviewer\'s notes'] }) });
    T.eq(N.loadServer({ input: { action: 'chat' } }).fn._ctxReadBlobFresh().mem, [], 'one reviewer never hears another\'s memory');
});

T.test('the model is told this is a read-only reviewer account', function () {
    var s = reviewer(new S.Session());
    s.model(gem.text('Sure.'));
    s.say('what can you do for me here');
    T.match(JSON.stringify(s.gemini.generate[0].systemInstruction || s.gemini.generate[0].system_instruction || ''), /READ-ONLY reviewer account/);
});

T.run(__filename);
