/*
 * Audit fixes for NetraInvestigator: what it says about changes, tickets and
 * its own theories must be true, and it reads only what the user may read.
 */
'use strict';
var T = require('./lib/t'), S = require('./lib/session'), N = require('./lib/netra'), sc = require('./lib/scenario'), g = S.g;
var MIN = 60000, H = 3600000;

function engine(opts) { N.loadScriptIncludes(); return new NetraInvestigator(opts); }
function at(ms) { return g.fmtUtc(ms); }
function rulesOnly() { g.P.PROPS['x_196061_netra_v1.investigate_llm'] = 'false'; }
function server(id, name) {
    g.put('cmdb_ci_linux_server', { sys_id: id, name: name, operational_status: '1', install_status: '1' });
    g.P.DISPLAY[id] = name;
}
function incident(id, num, ci, openedMs, extra) {
    var r = { sys_id: id, number: num, cmdb_ci: ci, state: '2', active: 'true', impact: '2', urgency: '2', priority: '3',
              caller_id: 'u_admin', short_description: 'web01 502 on login page', opened_at: at(openedMs), sys_created_on: at(openedMs) };
    for (var k in (extra || {})) r[k] = extra[k];
    return g.put('incident', r);
}
function dependsOn(parent, child) {
    g.P.DISPLAY.rel_dep = 'Depends on::Used by';
    g.put('cmdb_rel_ci', { parent: parent, child: child, type: 'rel_dep' });
}
function itemText(d) { return d.items.map(function (i) { return i.text; }).join('\n'); }

// ---- #1 a change being worked when the first ticket came in ----

T.test('#1 a change still being worked when the first ticket came in is a suspect, not "nothing changed"', function () {
    var s = new S.Session(); rulesOnly();
    var now = g.P.now;
    server('ci_web', 'netra-lab-web01');
    g.put('change_request', { number: 'CHG0030042', short_description: 'Upgrade Apache', type: 'normal', risk: '3', state: '3',
                              cmdb_ci: 'ci_web', work_start: at(now - 270 * MIN), work_end: at(now - 60 * MIN), closed_at: at(now - 55 * MIN),
                              sys_created_on: at(now - 48 * H), sys_updated_on: at(now - 55 * MIN) });
    incident('o1', 'INC0030010', 'ci_web', now - 240 * MIN);
    var r = s.say('what changed on INC0030010');
    T.notMatch(r.message, /Nothing changed/);
    T.match(r.message, /CHG0030042 'Upgrade Apache': work started on netra-lab-web01 .*30 minutes before the ticket on that server, and work finished 3 hours after that/);
    var top = engine().suspectChanges('ci_web', now - 240 * MIN, {}).suspects[0];
    T.eq(top.factors.time, 1, 'in progress at the first ticket is the strongest timing');
    T.match(top.brief, /^work started on netra-lab-web01 30 minutes before the ticket, and work finished 3 hours after that$/);
});

T.test('#1 changes raised after the trouble can not push the real suspect out of the row cap', function () {
    new S.Session();
    var now = g.P.now, t0 = now - 240 * MIN;
    server('ci_web', 'netra-lab-web01');
    g.put('change_request', { number: 'CHG0030042', short_description: 'Upgrade Apache', type: 'normal', risk: '3', state: '3', cmdb_ci: 'ci_web',
                              work_start: at(t0 - 70 * MIN), work_end: at(t0 - 40 * MIN), sys_created_on: at(now - 48 * H), sys_updated_on: at(t0 - 30 * MIN) });
    for (var i = 0; i < 45; i++) {
        g.put('change_request', { number: 'CHG00400' + (10 + i), short_description: 'Later change ' + i, type: 'standard', state: '-2', cmdb_ci: 'ci_web',
                                  start_date: at(now + 24 * H), sys_created_on: at(now - 30 * MIN), sys_updated_on: at(now - 10 * MIN) });
    }
    incident('o1', 'INC0030010', 'ci_web', t0);
    var r = engine().suspectChanges('ci_web', t0, {});
    T.eq(r.suspects.length && r.suspects[0].number, 'CHG0030042');
});

T.test('#1 when the row cap was hit and nothing lined up, it says so instead of "nothing changed"', function () {
    new S.Session();
    var now = g.P.now, t0 = now - 240 * MIN;
    server('ci_web', 'netra-lab-web01');
    for (var i = 0; i < 45; i++) {
        g.put('change_request', { number: 'CHG00400' + (10 + i), short_description: 'Planned change ' + i, type: 'standard', state: '-2', cmdb_ci: 'ci_web',
                                  start_date: at(now + 24 * H), sys_created_on: at(t0 - 48 * H), sys_updated_on: at(now - 10 * MIN) });
    }
    incident('o1', 'INC0030010', 'ci_web', t0);
    var inv = engine(), r = inv.suspectChanges('ci_web', t0, {});
    var said = inv.describeSuspects(r, {});
    T.notMatch(said, /Nothing changed/);
    T.match(said, /only read the 40 most recently updated changes/);
});

// ---- #6 a fix started long after the outage is not the cause ----

T.test('#6 an emergency fix started hours after the first ticket is not ranked as the cause', function () {
    var s = new S.Session(); rulesOnly();
    var now = g.P.now;
    server('ci_web', 'netra-lab-web01');
    g.put('change_request', { number: 'CHG0030050', short_description: 'Emergency: restore web01 login service', type: 'emergency', risk: '2', state: '-1',
                              cmdb_ci: 'ci_web', work_start: at(now - 60 * MIN), sys_created_on: at(now - 7 * H) });
    incident('o1', 'INC0030010', 'ci_web', now - 6 * H);
    T.eq(engine().suspectChanges('ci_web', now - 6 * H, {}).suspects.length, 0);
    T.notMatch(s.say('investigate INC0030010').message, /CHG0030050/);
});

// ---- #4 no tickets means no "first ticket" ----

T.test('#4 a server with no tickets: changes and neighbour tickets are "N ago", never "before the first ticket"', function () {
    var s = new S.Session(); rulesOnly();
    var now = g.P.now;
    server('ci_web', 'netra-lab-web01'); server('ci_db', 'netra-lab-db01');
    dependsOn('ci_web', 'ci_db');
    g.put('change_request', { number: 'CHG0030006', short_description: 'Apply kernel patches', type: 'normal', risk: '3', state: '3', close_code: 'successful',
                              cmdb_ci: 'ci_web', work_start: at(now - 100 * MIN), work_end: at(now - 70 * MIN), closed_at: at(now - 65 * MIN),
                              sys_created_on: at(now - 48 * H) });
    incident('d1', 'INC0040001', 'ci_db', now - 3 * H, { short_description: 'db01 slow queries' });
    var r = s.say('investigate netra-lab-web01');
    T.notMatch(r.message, /first ticket/);
    T.match(r.message, /The trouble may be linked to CHG0030006 'Apply kernel patches': work finished on netra-lab-web01 70 minutes ago\./);
    T.match(r.message, /it had one ticket starting 3 hours ago, beginning with INC0040001/);
    T.match(r.message, /1 opened in the last 24 hours, starting with INC0040001 3 hours ago/);
});

// ---- #2 / #3 grading the theories against the close notes ----

var CHANGE_THEORY = { n: 1, type: 'change_backed_out', ref: 'CHG0030042', kw: ['apache', 'config', 'push', 'rollback'],
                      s: "The trouble may be linked to CHG0030042 'Apache config push': work finished on netra-lab-web01 40 minutes before the first ticket." };
var OUTAGE_THEORY = { n: 2, type: 'new_siblings', ref: 'netra-lab-web01', kw: ['login', 'page'],
                      s: '4 tickets hit netra-lab-web01 within 2 hours of each other, which looks like one shared outage on that server rather than separate faults.' };
function grade(sig, notes) { return engine().grade(sig, notes, { exclude: ['netra-lab-web01'], anchor: 'INC0030010' }); }

T.test('#2 close notes naming the blamed change match that theory', function () {
    ['Rolled back CHG0030042 after users reported 502s; confirmed the site loads again.',
     'Backed out CHG0030042. Root cause confirmed as that change.',
     'Reverted CHG 0030042, site is up.',
     'Restarting did not help. Rolled back CHG0030042, site restored.'].forEach(function (notes) {
        var gr = grade([CHANGE_THEORY, OUTAGE_THEORY], notes);
        T.eq([gr.outcome, gr.n], ['matched', 1], notes);
        T.match(gr.text, /that matches my theory one/);
    });
});

T.test('#2 one shared word is "can\'t tell", not "I got this one wrong"; a clearly different fix still is', function () {
    var one = grade([CHANGE_THEORY, OUTAGE_THEORY], 'Restarted the apache service after clearing a stuck worker.');
    T.eq(one.outcome, 'unclear');
    T.notMatch(one.text, /got this one wrong/);
    var other = grade([CHANGE_THEORY, OUTAGE_THEORY], 'Replaced the failed disk on the SAN controller, storage latency is back to normal.');
    T.eq(other.outcome, 'missed');
    T.match(other.text, /I got this one wrong/);
    T.eq(grade([CHANGE_THEORY], 'Rolled back the apache config push.').outcome, 'matched', 'keywords alone still match');
});

T.test('#3 template words and ruled-out mentions never count as a match', function () {
    var process = [{ n: 1, type: 'none', ref: 'INC0030010', kw: ['assign', 'caller'],
                     s: 'This may be stuck in process rather than a technical mystery: it has been reassigned 4 times.' }];
    T.ok(grade(process, 'Reassigned to DBA team who rebuilt the index; query time back to normal.').outcome !== 'matched', 'reassigned + time is not the process theory');
    var upgrade = [{ n: 1, type: 'change_backed_out', ref: 'CHG0030042', kw: ['upgrade', 'apache', 'rollback'],
                     s: "The trouble may be linked to CHG0030042 'Upgrade Apache': work finished on netra-lab-web01 40 minutes before the first ticket." }];
    var neg = grade(upgrade, 'Not the Apache upgrade - that was fine. Disk full on /var, cleared old logs.');
    T.ok(neg.outcome !== 'matched', 'ruled out in the notes: ' + neg.outcome);
    T.ok(grade(upgrade, 'Not related to CHG0030042 - disk full on /var, cleared old logs.').outcome !== 'matched', 'a negated ref');
});

T.test('#2 end to end: the away watch hears "Rolled back CHG0030006" as a match', function () {
    var s = new S.Session(); sc.seedOutage(s, g); rulesOnly();
    s.say('investigate INC0030010');
    s.say('keep digging');
    s.say('yes');
    g.P.now += 31 * MIN;
    var inc = s.inc('INC0030010');
    inc.state = '6'; inc.close_notes = 'Rolled back CHG0030006; login works again.';
    N.loadScriptIncludes();
    new NetraTaskRunner().run();
    var store = g.P.STORE.x_196061_netra_v1_notification || {};
    var said = Object.keys(store).map(function (k) { return store[k].message; }).join(' | ');
    T.match(said, /INC0030010 is resolved, and that matches my theory one/);
    T.notMatch(said, /got this one wrong/);
});

// ---- #5 the watch: only newly resolved tickets are news ----

T.test('#5 a ticket resolved days ago and auto-closed now is not announced as newly resolved', function () {
    var s = new S.Session(); sc.seedOutage(s, g);
    var now = g.P.now;
    incident('old1', 'INC0020001', 'ci_web', now - 8 * 24 * H, { state: '6', close_notes: 'Restarted apache and rolled back the config push',
                                                               resolved_at: at(now - 7 * 24 * H), sys_updated_on: at(now - 7 * 24 * H) });
    var inv = engine({ background: true });
    var anchor = inv.resolveAnchor('INC0030010');
    var old = inv.compactSnapshot(inv.snapshot(anchor, { since_ms: 0, track: ['CHG0030006'] }), null);
    g.P.now += 30 * MIN;
    var r = g.rec('incident', 'old1');
    r.state = '7'; r.active = 'false'; r.closed_at = at(g.P.now); r.sys_updated_on = at(g.P.now);
    var fresh = g.rec('incident', 'out2');        // resolved for real during the watch
    fresh.state = '6'; fresh.close_notes = 'Rolled back the apache config push'; fresh.resolved_at = at(g.P.now); fresh.sys_updated_on = at(g.P.now);
    var nw = inv.snapshot(anchor, { since_ms: old.at, track: ['CHG0030006'] });
    var facts = inv.diffSnapshot(old, nw).join(' | ');
    T.notMatch(facts, /INC0020001/);
    T.match(facts, /INC0030012 on netra-lab-web01 was resolved/);
    var sig = inv.checkSignals([{ n: 1, type: 'change_backed_out', ref: 'CHG0030006', kw: ['apache', 'config', 'push', 'rollback'] }], old, nw);
    T.notMatch(JSON.stringify(sig), /INC0020001/);
});

// ---- #7 rollback detection ----

T.test('#7 the rollback test needs whole words', function () {
    var re = engine().ROLLBACK_RE;
    ['Payroll backend upgrade', 'Enroll backup agent', 'Feedback outage fix', 'Fallback output tuning'].forEach(function (x) { T.ok(!re.test(x), x); });
    ['Roll back apache config', 'Rolled back the patch', 'Backout CHG0030042', 'backed out the push', 'Revert DNS TTL', 'rollback'].forEach(function (x) { T.ok(re.test(x), x); });
});

T.test('#7 a new change supports the theory only when it rolls back that change, and names the CI it is on', function () {
    new S.Session();
    var now = g.P.now;
    server('ci_web', 'netra-lab-web01'); server('ci_db', 'netra-lab-db01');
    dependsOn('ci_web', 'ci_db');
    incident('o1', 'INC0030010', 'ci_web', now - 60 * MIN);
    var sig = [{ n: 1, type: 'change_backed_out', ref: 'CHG0030042', kw: ['apache', 'config', 'push', 'rollback'] }];
    var inv = engine({ background: true });
    var anchor = inv.resolveAnchor('INC0030010');
    var old = inv.compactSnapshot(inv.snapshot(anchor, { since_ms: 0, track: ['CHG0030042'] }), null);
    g.P.now += 30 * MIN;
    g.put('change_request', { number: 'CHG0030051', short_description: 'Payroll backend upgrade', state: '-2', cmdb_ci: 'ci_db', sys_created_on: at(g.P.now) });
    g.put('change_request', { number: 'CHG0030052', short_description: 'Revert DNS TTL', state: '-2', cmdb_ci: 'ci_db', sys_created_on: at(g.P.now) });
    var nw = inv.snapshot(anchor, { since_ms: old.at, track: ['CHG0030042'] });
    T.eq(inv.checkSignals(sig, old, nw), [], 'neither is a rollback of the apache change');
    var facts = inv.diffSnapshot(old, nw).join(' | ');
    T.match(facts, /a new change touches netra-lab-db01 \(linked to netra-lab-web01\): CHG0030051/);
    old = inv.compactSnapshot(nw, old);
    g.P.now += 30 * MIN;
    g.put('change_request', { number: 'CHG0030053', short_description: 'Roll back apache config push', state: '-2', cmdb_ci: 'ci_db', sys_created_on: at(g.P.now) });
    nw = inv.snapshot(anchor, { since_ms: old.at, track: ['CHG0030042'] });
    var got = inv.checkSignals(sig, old, nw);
    T.eq(got.length, 1);
    T.match(got[0].text, /a new change on netra-lab-db01 \(linked to netra-lab-web01\), CHG0030053 'Roll back apache config push', looks like a rollback; that supports my theory one/);
});

// ---- #8 neighbour and sibling counts ----

T.test('#8 old open tickets on one neighbour can not hide recent tickets upstream; counts are totals', function () {
    new S.Session();
    var now = g.P.now;
    server('ci_web', 'netra-lab-web01'); server('ci_db', 'netra-lab-db01');
    g.put('cmdb_ci_service', { sys_id: 'ci_mail', name: 'Email' }); g.P.DISPLAY.ci_mail = 'Email';
    dependsOn('ci_web', 'ci_db'); dependsOn('ci_web', 'ci_mail');
    for (var i = 0; i < 120; i++) incident('m' + i, 'INC0050' + (100 + i), 'ci_mail', now - (30 + i) * 24 * H, { short_description: 'mailbox full ' + i });
    [90, 80, 70].forEach(function (m, k) { incident('db' + k, 'INC004000' + (k + 1), 'ci_db', now - m * MIN, { short_description: 'db01 connection refused' }); });
    incident('o1', 'INC0030010', 'ci_web', now - 30 * MIN);
    var inv = engine(), d = inv.gatherDossier(inv.resolveAnchor('INC0030010'), {});
    var txt = itemText(d);
    T.match(txt, /Email, which netra-lab-web01 depends on: 120 open tickets/);
    T.match(txt, /netra-lab-db01, which netra-lab-web01 depends on: 3 open tickets; 3 opened before the first ticket here, starting with INC0040001 60 minutes earlier/);
    T.notMatch(txt, /no recent tickets: netra-lab-db01/);
    var up = inv.ruleHypotheses(d, { max: 9 }).filter(function (h) { return h.rule === 'upstream'; });
    T.eq(up.length, 1);
    T.match(up[0].statement, /started on netra-lab-db01/);
});

T.test('#8 a capped sibling list is spoken as "at least"', function () {
    new S.Session();
    var now = g.P.now;
    server('ci_web', 'netra-lab-web01');
    for (var i = 0; i < 40; i++) incident('w' + i, 'INC0060' + (100 + i), 'ci_web', now - (20 + i) * MIN);
    var inv = engine(), d = inv.gatherDossier(inv.resolveAnchor('INC0060100'), {});
    T.match(itemText(d), /at least \d+ other open tickets on netra-lab-web01/);
});

// ---- #9 clock times that can be wrong ----

T.test('#9 the scanner broadcast carries no clock time', function () {
    var s = new S.Session(); sc.seedOutage(s, g);
    g.put('x_196061_netra_v1_user_pref', { user: 'u_admin', active: 'true', watch_assignments: 'true' });
    N.loadScriptIncludes();
    new NetraScanner().detectMajorIncidentClusters();
    var store = g.P.STORE.x_196061_netra_v1_notification || {};
    var msg = Object.keys(store).map(function (k) { return store[k].message; }).join(' | ');
    T.match(msg, /Likely trigger: CHG0030006 'Apply kernel patches', work finished on netra-lab-web01 40 minutes before the first ticket\./);
    T.notMatch(msg, /\d{1,2}:\d{2}/);
});

T.test('#9 times that are not today say which day', function () {
    var s = new S.Session(); rulesOnly();
    var now = g.P.now, t0 = now - 30 * MIN;
    server('ci_web', 'netra-lab-web01');
    g.put('change_request', { number: 'CHG0030070', short_description: 'Tune the web tier', type: 'normal', risk: '3', state: '3', cmdb_ci: 'ci_web',
                              work_start: at(t0 - 21 * H), work_end: at(t0 - 20 * H), sys_created_on: at(now - 48 * H) });
    incident('o1', 'INC0030010', 'ci_web', t0);
    incident('o2', 'INC0030011', 'ci_web', now - 3 * 24 * H);
    incident('o3', 'INC0030012', 'ci_web', now - 10 * MIN);
    var inv = engine(), d = inv.gatherDossier(inv.resolveAnchor('INC0030010'), {});
    T.match(itemText(d), /opened between Sunday at 20:00 and 19:50/);
    s.say('investigate INC0030010');
    var hs = s.blob().investigation.result.hypotheses;
    T.match(hs.map(function (h) { return h.rule_out_by; }).join(' | '), /If the errors started before yesterday at 23:30/);
});

// ---- #10 the user's permissions ----

T.test('#10 a ticket the user can not open is not investigated, and its work notes are never read', function () {
    var s = new S.Session(); sc.seedOutage(s, g); rulesOnly();
    g.put('sys_journal_field', { element_id: 'out0', element: 'work_notes', value: 'INTERNAL: VIP exec laptop, password is hunter2',
                                 sys_created_by: 'jdoe', sys_created_on: at(g.P.now - 5 * MIN) });
    g.P.user = { sys_id: 'u_beth', name: 'Beth Anglin', user_name: 'beth.anglin' };
    g.P.ROLES = {};
    g.P.ACL = function (table, op, rec) {
        if (table !== 'incident' && table !== 'task') return true;
        return rec.caller_id === 'u_beth';
    };
    var r = s.say('investigate INC0030010');
    T.notMatch(r.message, /hunter2|Theory|INC0030011/);
    T.notMatch(JSON.stringify(s.blob()), /hunter2/);
});

T.test('#10 on a ticket the user can open: only the fields and other tickets they may read', function () {
    var s = new S.Session(); sc.seedOutage(s, g); rulesOnly();
    var now = g.P.now;
    g.put('sys_journal_field', { element_id: 'out0', element: 'work_notes', value: 'INTERNAL: VIP exec laptop, password is hunter2',
                                 sys_created_by: 'jdoe', sys_created_on: at(now - 5 * MIN) });
    g.put('sys_journal_field', { element_id: 'out0', element: 'comments', value: 'Still getting the 502 after a refresh',
                                 sys_created_by: 'beth.anglin', sys_created_on: at(now - 4 * MIN) });
    g.put('sys_audit', { tablename: 'incident', documentkey: 'out0', fieldname: 'assignment_group', oldvalue: 'g_net', newvalue: 'g_db', user: 'admin', sys_created_on: at(now - 20 * MIN) });
    g.put('sys_audit', { tablename: 'incident', documentkey: 'out0', fieldname: 'priority', oldvalue: '4', newvalue: '3', user: 'admin', sys_created_on: at(now - 15 * MIN) });
    g.P.user = { sys_id: 'u_beth', name: 'Beth Anglin', user_name: 'beth.anglin' };
    g.P.ROLES = {};
    g.P.ACL = function (table, op, rec, field) {
        if (table !== 'incident' && table !== 'task') return true;
        if (field === 'work_notes' || field === 'assignment_group') return false;
        return rec.sys_id === 'out0';
    };
    s.say('investigate INC0030010');
    var items = JSON.stringify(s.blob().investigation.items);
    T.notMatch(items, /hunter2/, 'work notes the user can not read');
    T.match(items, /Still getting the 502/, 'comments they can read');
    T.notMatch(items, /assignment group/, 'audit of a field they can not read');
    T.match(items, /priority 4 - Low -> 3 - Moderate/);
    T.notMatch(items, /INC0030011|INC0030012|INC0030013/, 'other incidents they can not open');
});

T.run(__filename);
