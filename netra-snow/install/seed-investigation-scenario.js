/**
 * Netra - seed the investigation lab scenario (R18, features 3-6)
 *
 * Run in System Definition > Scripts - Background, in the GLOBAL scope, as
 * admin. It creates CMDB, change and incident rows, which the Netra scope
 * has no business creating.
 *
 * What it builds (all times relative to "now" when you run it):
 *   - cmdb_ci_linux_server  netra-lab-web01
 *   - cmdb_ci_appl          Netra Lab Payroll, "Depends on::Used by" web01
 *   - cmdb_ci_linux_server  netra-lab-unrelated01 (CHG-C's home, linked to nothing)
 *   - CHG-A on web01: work_start now-100m, work_end now-70m, 'Apply kernel patches'
 *       + change task on web01 under CHG-A (work_end now-72m) so the
 *         change_task source has a row to count
 *   - CHG-B on web01: work_end 5 days ago           -> outside the 72h window
 *   - CHG-C on the unrelated CI, 50 minutes ago      -> not in web01's CI set
 *   - CHG-D with no CI, linked to web01 only via task_ci, work_end 3 hours ago
 *   - I1, I2, I3 on web01, opened now-30m, now-20m, now-10m
 *   - I0 with no CI (the honest "tell me the server name" case)
 *
 * Expected: suspectChanges(web01, I1 opened) -> CHG-A first, 40 minutes,
 * link direct; CHG-D second, affected_ci; CHG-B and CHG-C absent.
 *
 * Rules this sticks to:
 *  - setWorkflow(false) everywhere: no business rules, no notifications,
 *    no approval engines kicking off on lab data
 *  - every date goes in with setDateNumericValue(ms). assigning a date
 *    string is re-interpreted in the session timezone and lands hours off
 *  - incidents get sys_created_on backdated to match opened_at (the outage
 *    radar keys on sys_created_on, so "first ticket" must agree)
 *  - idempotent-ish: CIs and the relationship are reused by name; changes
 *    and incidents from an earlier run (tagged in their description) are
 *    deleted first, because a stale CHG-A from yesterday would compete
 *
 * Output: ONE line, "[netra-seed-inv] {json}", with every number and sys_id.
 */
(function () {
    var TAG = '[netra-seed-inv]';
    var MARK = 'netra-seed-inv lab record';
    var MIN = 60 * 1000;
    var H = 60 * MIN;
    var now = new GlideDateTime().getNumericValue();
    var me = gs.getUserID();
    var out = { now_ms: now, cleaned: 0, ci: {}, chg: {}, inc: {} };

    function setDate(gr, field, ms) {
        gr[field].setDateNumericValue(ms);
    }

    function msOf(gr, field) {
        var v = gr.getValue(field);
        return v ? new GlideDateTime(v).getNumericValue() : null;
    }

    // ---- clean up an earlier run (only rows this script tagged) -----------
    function wipe(table) {
        var n = 0;
        var gr = new GlideRecord(table);
        gr.addQuery('description', 'CONTAINS', MARK);
        gr.setLimit(100);
        gr.query();
        while (gr.next()) {
            if (table === 'change_request') {
                var tc = new GlideRecord('task_ci');
                tc.addQuery('task', gr.getUniqueValue());
                tc.setLimit(50);
                tc.query();
                while (tc.next()) { tc.setWorkflow(false); tc.deleteRecord(); }
            }
            gr.setWorkflow(false);
            gr.deleteRecord();
            n++;
        }
        return n;
    }
    out.cleaned += wipe('change_task');
    out.cleaned += wipe('change_request');
    out.cleaned += wipe('incident');

    // ---- CIs, reused by name ------------------------------------------------
    function ci(cls, name) {
        var gr = new GlideRecord('cmdb_ci');
        gr.addQuery('name', name);
        gr.setLimit(1);
        gr.query();
        var rec;
        if (gr.next()) {
            rec = new GlideRecord(String(gr.getValue('sys_class_name')));
            rec.get(gr.getUniqueValue());
        } else {
            rec = new GlideRecord(cls);
            rec.initialize();
            rec.setValue('name', name);
        }
        // put the lab back to healthy on every run (F6 tests flip these)
        rec.setValue('operational_status', '1');
        rec.setValue('install_status', '1');
        rec.setWorkflow(false);
        var id = rec.isNewRecord() ? rec.insert() : rec.update();
        return { sys_id: String(id || rec.getUniqueValue()), name: name, cls: String(rec.getValue('sys_class_name') || cls) };
    }
    out.ci.web01 = ci('cmdb_ci_linux_server', 'netra-lab-web01');
    out.ci.payroll = ci('cmdb_ci_appl', 'Netra Lab Payroll');
    out.ci.unrelated = ci('cmdb_ci_linux_server', 'netra-lab-unrelated01');

    // ---- Payroll depends on web01 ------------------------------------------
    var rt = new GlideRecord('cmdb_rel_type');
    rt.addQuery('name', 'Depends on::Used by');
    rt.setLimit(1);
    rt.query();
    var relTypeId;
    if (rt.next()) {
        relTypeId = rt.getUniqueValue();
    } else {
        rt.initialize();
        rt.setValue('parent_descriptor', 'Depends on');
        rt.setValue('child_descriptor', 'Used by');
        rt.setValue('name', 'Depends on::Used by');
        rt.setWorkflow(false);
        relTypeId = rt.insert();
    }
    var rel = new GlideRecord('cmdb_rel_ci');
    rel.addQuery('parent', out.ci.payroll.sys_id);
    rel.addQuery('child', out.ci.web01.sys_id);
    rel.addQuery('type', relTypeId);
    rel.setLimit(1);
    rel.query();
    if (rel.next()) {
        out.rel = { sys_id: rel.getUniqueValue(), type: 'Depends on::Used by', reused: true };
    } else {
        rel.initialize();
        rel.setValue('parent', out.ci.payroll.sys_id);
        rel.setValue('child', out.ci.web01.sys_id);
        rel.setValue('type', relTypeId);
        rel.setWorkflow(false);
        out.rel = { sys_id: String(rel.insert()), type: 'Depends on::Used by', reused: false };
    }

    // ---- changes --------------------------------------------------------------
    function change(key, spec) {
        var gr = new GlideRecord('change_request');
        gr.initialize();
        gr.setValue('short_description', spec.sd);
        gr.setValue('description', MARK + ' (' + key + '): ' + spec.why);
        gr.setValue('type', 'normal');
        gr.setValue('risk', '3');
        gr.setValue('impact', '3');
        gr.setValue('state', spec.state);
        if (spec.ci) gr.setValue('cmdb_ci', spec.ci);
        if (spec.close_code) {
            gr.setValue('close_code', spec.close_code);
            gr.setValue('close_notes', spec.close_notes || 'Completed as planned.');
        }
        if (spec.start_date) setDate(gr, 'start_date', spec.start_date);
        if (spec.end_date) setDate(gr, 'end_date', spec.end_date);
        if (spec.work_start) setDate(gr, 'work_start', spec.work_start);
        if (spec.work_end) setDate(gr, 'work_end', spec.work_end);
        if (spec.closed_at) setDate(gr, 'closed_at', spec.closed_at);
        gr.setWorkflow(false);
        var id = gr.insert();
        var chk = new GlideRecord('change_request');
        chk.get(id);
        out.chg[key] = { number: String(chk.getValue('number')), sys_id: String(id), short_description: spec.sd,
                         cmdb_ci: spec.ci || '', work_end_ms: msOf(chk, 'work_end') };
        return out.chg[key];
    }
    var A = change('A', { sd: 'Apply kernel patches', why: 'direct on web01, should rank first at 40 minutes',
                          ci: out.ci.web01.sys_id, state: '0',
                          start_date: now - 110 * MIN, end_date: now - 60 * MIN,
                          work_start: now - 100 * MIN, work_end: now - 70 * MIN });
    change('B', { sd: 'Rotate TLS certificates', why: 'on web01 but 5 days ago, must be absent',
                  ci: out.ci.web01.sys_id, state: '3', close_code: 'successful',
                  work_start: now - 5 * 24 * H - H, work_end: now - 5 * 24 * H, closed_at: now - 5 * 24 * H + 10 * MIN });
    change('C', { sd: 'Resize batch volume', why: 'recent but on an unrelated CI, must be absent',
                  ci: out.ci.unrelated.sys_id, state: '0',
                  work_start: now - 80 * MIN, work_end: now - 50 * MIN });
    var D = change('D', { sd: 'Update load balancer pool', why: 'no CI, linked to web01 only through task_ci, should rank second',
                          ci: '', state: '0',
                          work_start: now - 200 * MIN, work_end: now - 180 * MIN });

    // CHG-D reaches web01 only as an affected CI
    var tc = new GlideRecord('task_ci');
    tc.initialize();
    tc.setValue('task', D.sys_id);
    tc.setValue('ci_item', out.ci.web01.sys_id);
    tc.setWorkflow(false);
    out.task_ci = { sys_id: String(tc.insert()), task: D.number, ci: out.ci.web01.name };

    // a change task on web01 under CHG-A, so the change_task source is non-empty
    var ct = new GlideRecord('change_task');
    ct.initialize();
    ct.setValue('change_request', A.sys_id);
    ct.setValue('short_description', 'Reboot web01 after patching');
    ct.setValue('description', MARK + ' (CTASK under A)');
    ct.setValue('cmdb_ci', out.ci.web01.sys_id);
    ct.setValue('state', '3');
    setDate(ct, 'work_start', now - 90 * MIN);
    setDate(ct, 'work_end', now - 72 * MIN);
    ct.setWorkflow(false);
    var ctId = ct.insert();
    var ctChk = new GlideRecord('change_task');
    ctChk.get(ctId);
    out.ctask = { number: String(ctChk.getValue('number')), sys_id: String(ctId), parent: A.number };

    // ---- incidents ---------------------------------------------------------
    function incident(key, sd, ciId, minsAgo, state) {
        var at = now - minsAgo * MIN;
        var gr = new GlideRecord('incident');
        gr.initialize();
        gr.setValue('short_description', sd);
        gr.setValue('description', MARK + ' (' + key + ')');
        gr.setValue('caller_id', me);
        gr.setValue('impact', '2');
        gr.setValue('urgency', '2');
        gr.setValue('state', state);
        if (ciId) gr.setValue('cmdb_ci', ciId);
        setDate(gr, 'opened_at', at);
        // backdate the sys fields too, so "first ticket" agrees everywhere
        gr.autoSysFields(false);
        setDate(gr, 'sys_created_on', at);
        setDate(gr, 'sys_updated_on', at);
        gr.setValue('sys_created_by', gs.getUserName());
        gr.setValue('sys_updated_by', gs.getUserName());
        gr.setValue('sys_mod_count', 0);
        gr.setWorkflow(false);
        var id = gr.insert();
        var chk = new GlideRecord('incident');
        chk.get(id);
        out.inc[key] = { number: String(chk.getValue('number')), sys_id: String(id), opened_ms: msOf(chk, 'opened_at'),
                         cmdb_ci: ciId || '' };
        return out.inc[key];
    }
    var I1 = incident('I1', 'Web01 returning 502 errors', out.ci.web01.sys_id, 30, '2');
    incident('I2', 'Payroll page times out', out.ci.web01.sys_id, 20, '1');
    incident('I3', 'nginx 502 on netra-lab-web01', out.ci.web01.sys_id, 10, '1');
    incident('I0', 'Netra lab: printer jammed on floor 3', '', 15, '1');

    out.expect = {
        first: A.number, first_delta_minutes: 40, first_link: 'direct',
        second: D.number, second_link: 'affected_ci',
        absent: [out.chg.B.number, out.chg.C.number],
        call: "new x_196061_netra_v1.NetraInvestigator().suspectChanges('" + out.ci.web01.sys_id + "', " + I1.opened_ms + ')'
    };

    // run the check right here if the investigator is reachable from global;
    // it executes in the Netra scope, so this also exercises its privileges
    try {
        var r = new x_196061_netra_v1.NetraInvestigator().suspectChanges(out.ci.web01.sys_id, I1.opened_ms);
        var got = [];
        for (var i = 0; i < r.suspects.length; i++) {
            got.push({ n: r.suspects[i].number, link: r.suspects[i].link, d: r.suspects[i].delta_minutes, s: r.suspects[i].score });
        }
        out.check = { ok: r.ok, suspects: got, sources: r.sources,
                      pass: !!(got.length >= 2 && got[0].n === A.number && Math.abs(got[0].d - 40) <= 1 && got[0].link === 'direct' &&
                               got[1].n === D.number && got[1].link === 'affected_ci') };
    } catch (e) {
        out.check = { skipped: 'NetraInvestigator not callable from here: ' + String((e && e.message) || e).substring(0, 160) };
    }

    gs.info(TAG + ' ' + JSON.stringify(out));
})();
