/**
 * Netra R5 — Instance Performance Audit & Safe-Pause (one-shot)
 * =============================================================
 * Paste into  System Definition > Scripts - Background  (global scope)
 * on the target instance and run.
 *
 * WHAT THIS IS
 *   A conservative, reversible way to quiet a dev instance down: it ranks
 *   the scheduled jobs that burn the most scheduler time, flags everything
 *   that must NOT be touched, and — only when YOU list names explicitly —
 *   pauses the leftovers, with a snapshot so one run restores everything.
 *
 * MODES (edit the MODE var below)
 *   'AUDIT'    (default) read-only report. Run this first, always.
 *   'APPLY'    pauses ONLY the jobs you copied into PAUSE_LIST after
 *              reviewing the AUDIT output. Every pause is re-checked
 *              against the protected patterns first — protected names are
 *              refused even if you list them.
 *   'RESTORE'  re-activates everything recorded in the snapshot property
 *              (or SNAPSHOT_OVERRIDE if you paste one).
 *
 * RULES THIS SCRIPT ENFORCES
 *   - Never touches anything matching PROTECTED patterns (Netra, Trident,
 *     VR/NVD feeds, email, SLA, indexing, flows, upgrades, cleanup, LDAP,
 *     MID, discovery, eventing, licensing).
 *   - Never deletes records. Pausing = active=false. Restoring = active=true.
 *   - Snapshots prior state to sys_properties: x_196061_netra_v1.perf_snapshot
 *     AND prints it — save the printed JSON too.
 *   - The temporary Cross-Scope Privilege Auto-Healer is only deactivated
 *     when REMOVE_AUTO_HEALER = true (opt-in), and is never deleted.
 *
 * !!! RUN 'APPLY' AND 'RESTORE' INSIDE A TRACKED UPDATE SET !!!
 *   Create/select update set "Netra R5 - Instance Perf Tuning" (global)
 *   first, so every active-flag change is captured and revertible.
 *   (sysauto_script/sysauto are tracked tables; the changes WILL be
 *   captured as customer updates in your current update set.)
 *
 * The classification lists are duplicated in
 * source/script_includes/NetraPerformance.js — keep them in sync.
 */

(function netraPerfAudit() {

    // ================= EDIT ME =================
    var MODE = 'AUDIT';               // 'AUDIT' | 'APPLY' | 'RESTORE'
    var PAUSE_LIST = [                // exact job names, copied from AUDIT output
        // 'Example: PA Daily Data Collection'
    ];
    var REMOVE_AUTO_HEALER = false;   // set true to also deactivate the temporary privilege auto-healer
    var SNAPSHOT_OVERRIDE = '';       // paste a printed snapshot JSON here to RESTORE from it
    // ===========================================

    var SNAPSHOT_PROP = 'x_196061_netra_v1.perf_snapshot';
    var AUTO_HEALER_NAME = 'Cross-Scope Privilege Auto-Healer (temporary)';

    // KEEP IN SYNC with NetraPerformance.js (PROTECTED / CANDIDATES)
    var PROTECTED = [
        [/netra/i,                                'Netra product work'],
        [/trident/i,                              'Trident product work'],
        [/x_196061/i,                             'Netra application scope'],
        [/vulnerab|nvd|cve|third.?party.?entry/i, 'Vulnerability Response data feeds — Netra VR demo depends on these'],
        [/smtp|pop reader|email (send|read)/i,    'Email delivery'],
        [/\bsla\b|sla (update|engine)/i,          'SLA engine'],
        [/text index|indexing|index (events|suggest)/i, 'Search indexing'],
        [/flow engine|process automation|flow trigger/i, 'Flow Designer engine'],
        [/upgrade|patch/i,                        'Platform upgrade machinery'],
        [/cluster|node (sync|state)|heartbeat/i,  'Cluster coordination'],
        [/session cleanup|table clean|db clean|log rotat|rotation/i, 'Housekeeping that prevents table bloat'],
        [/ldap/i,                                 'Directory sync'],
        [/mid server/i,                           'MID server infrastructure'],
        [/discovery/i,                            'Discovery'],
        [/event management/i,                     'Event Management pipeline'],
        [/instance scan/i,                        'Instance Scan (HealthScan)'],
        [/license|subscription|usage analytic|usage calc/i, 'Licensing / usage accounting']
    ];
    var CANDIDATES = [
        [/performance analytics|\[pa\]|pa (daily|weekly) /i, 'Performance Analytics data collection'],
        [/predictive intelligence|ml (training|solution)/i,  'Predictive Intelligence model training'],
        [/agent client collector|\bacc\b/i,                  'Agent Client Collector telemetry'],
        [/benchmark/i,                                        'Benchmarks telemetry'],
        [/instance troubleshooter/i,                          'Instance Troubleshooter'],
        [/mobile analytics/i,                                 'Mobile app analytics'],
        [/virtual agent.*(analytic|metric)/i,                 'Virtual Agent analytics'],
        [/chat analytics/i,                                   'Chat analytics']
    ];

    function classify(name, scopeName) {
        var text = String(name || '') + ' ' + String(scopeName || '');
        if (String(name || '') === AUTO_HEALER_NAME)
            return { klass: 'REMOVE-RECOMMENDED', reason: 'Netra maintenance leftover; runs every 5 min. Deactivate once privileges are stable (opt-in flag below).' };
        var i;
        for (i = 0; i < PROTECTED.length; i++)
            if (PROTECTED[i][0].test(text)) return { klass: 'PROTECTED', reason: PROTECTED[i][1] };
        for (i = 0; i < CANDIDATES.length; i++)
            if (CANDIDATES[i][0].test(text)) return { klass: 'CANDIDATE', reason: CANDIDATES[i][1] };
        return { klass: 'REVIEW', reason: 'Unclassified — do not pause without human review.' };
    }

    function isProtected(name, scopeName) {
        var c = classify(name, scopeName);
        return c.klass === 'PROTECTED';
    }

    function durationSeconds(v) {
        var m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
        if (!m) return 0;
        var days = (parseInt(m[1], 10) - 1970) * 365 + (parseInt(m[2], 10) - 1) * 31 + (parseInt(m[3], 10) - 1);
        return days * 86400 + parseInt(m[4], 10) * 3600 + parseInt(m[5], 10) * 60 + parseInt(m[6], 10);
    }

    function perDay(repeatValue) {
        var secs = durationSeconds(repeatValue);
        if (secs <= 0) return 0;
        return Math.round((86400 / secs) * 10) / 10;
    }

    function pad(s, n) {
        s = String(s);
        while (s.length < n) s += ' ';
        return s.substring(0, n);
    }

    // ---------- snapshot helpers (property upsert via GlideRecord) ----------
    function writeSnapshotProp(json) {
        var pr = new GlideRecord('sys_properties');
        pr.addQuery('name', SNAPSHOT_PROP);
        pr.query();
        if (pr.next()) {
            pr.value = json;
            pr.update();
        } else {
            pr.initialize();
            pr.name = SNAPSHOT_PROP;
            pr.value = json;
            pr.description = 'Netra perf-audit pause snapshot. Used by install/perf-audit.js RESTORE mode.';
            pr.type = 'string';
            pr.insert();
        }
    }

    function readSnapshotProp() {
        var pr = new GlideRecord('sys_properties');
        pr.addQuery('name', SNAPSHOT_PROP);
        pr.query();
        if (pr.next()) return String(pr.value || '');
        return '';
    }

    // =====================================================================
    //  AUDIT
    // =====================================================================
    function runAudit() {
        gs.info('==================================================================');
        gs.info(' NETRA PERF AUDIT (read-only) — ' + new GlideDateTime().getDisplayValue());
        gs.info('==================================================================');

        // ---- 1. repeating scheduler load, ranked ----
        var rows = [];
        var tr = new GlideRecord('sys_trigger');
        tr.addQuery('trigger_type', 1);
        tr.setLimit(400);
        tr.query();
        while (tr.next()) {
            rows.push({ name: String(tr.name), per_day: perDay(String(tr.repeat)) });
        }
        rows.sort(function (a, b) { return b.per_day - a.per_day; });
        gs.info('');
        gs.info('--- 1. Heaviest repeating jobs (runs/day, from the live scheduler queue) ---');
        gs.info(pad('RUNS/DAY', 10) + pad('CLASS', 20) + 'NAME');
        for (var i = 0; i < rows.length && i < 25; i++) {
            var c1 = classify(rows[i].name, '');
            gs.info(pad(rows[i].per_day, 10) + pad(c1.klass, 20) + rows[i].name);
        }

        // ---- 2. active scheduled jobs, classified ----
        var protectedRows = [], candidateRows = [], reviewRows = [], specialRows = [];
        var ja = new GlideRecord('sysauto');
        if (!ja.isValid()) ja = new GlideRecord('sysauto_script');
        ja.addQuery('active', true);
        ja.setLimit(400);
        ja.query();
        while (ja.next()) {
            var nm = String(ja.name);
            var sc = '';
            try { sc = ja.sys_scope.nil() ? '' : String(ja.sys_scope.getDisplayValue()); } catch (e) { sc = ''; }
            var c2 = classify(nm, sc);
            var line = pad(c2.klass, 20) + pad(nm, 60) + ' | ' + c2.reason;
            if (c2.klass === 'PROTECTED') protectedRows.push(line);
            else if (c2.klass === 'CANDIDATE') { candidateRows.push(line); }
            else if (c2.klass === 'REMOVE-RECOMMENDED') specialRows.push(line);
            else reviewRows.push(line);
        }

        gs.info('');
        gs.info('--- 2. FLAGGED — DO NOT DISABLE (' + protectedRows.length + ') ---');
        for (var p = 0; p < protectedRows.length; p++) gs.info(protectedRows[p]);

        gs.info('');
        gs.info('--- 3. CANDIDATES — safe to pause IF the feature is unused (' + candidateRows.length + ') ---');
        if (!candidateRows.length) gs.info('(none found)');
        for (var q = 0; q < candidateRows.length; q++) gs.info(candidateRows[q]);

        gs.info('');
        gs.info('--- 4. SPECIAL FLAGS (' + specialRows.length + ') ---');
        if (!specialRows.length) gs.info('(none)');
        for (var s = 0; s < specialRows.length; s++) gs.info(specialRows[s]);

        gs.info('');
        gs.info('--- 5. REVIEW — unclassified, leave alone unless reviewed (' + reviewRows.length + ') ---');
        for (var r = 0; r < reviewRows.length && r < 40; r++) gs.info(reviewRows[r]);
        if (reviewRows.length > 40) gs.info('... and ' + (reviewRows.length - 40) + ' more');

        // ---- 6. integrations inventory ----
        gs.info('');
        gs.info('--- 6. Integrations (read-only inventory) ---');
        var counts = { imports: 0, ldap: 0, rest: 0, mid: 0 };
        var si = new GlideRecord('scheduled_import_set');
        if (si.isValid()) { si.addQuery('active', true); si.query(); while (si.next()) { counts.imports++; gs.info('   scheduled import: ' + si.name); } }
        var ld = new GlideRecord('ldap_server_config');
        if (ld.isValid()) { ld.query(); while (ld.next()) { counts.ldap++; gs.info('   LDAP server: ' + ld.name); } }
        var rm = new GlideRecord('sys_rest_message');
        if (rm.isValid()) { rm.setLimit(200); rm.query(); while (rm.next()) counts.rest++; }
        var ma = new GlideRecord('ecc_agent');
        if (ma.isValid()) { ma.query(); while (ma.next()) counts.mid++; }
        gs.info('   totals: ' + counts.imports + ' active imports, ' + counts.ldap + ' LDAP, ' + counts.rest + ' outbound REST definitions, ' + counts.mid + ' MID servers');

        gs.info('');
        gs.info('--- NEXT STEPS ---');
        gs.info('1. Review section 3. Copy the exact names you want paused into PAUSE_LIST.');
        gs.info('2. Create/select update set "Netra R5 - Instance Perf Tuning" (global scope).');
        gs.info('3. Set MODE = \'APPLY\' and run again. Snapshot is saved automatically.');
        gs.info('4. To undo: MODE = \'RESTORE\' (same update set).');
        gs.info('NOTHING has been changed by this run.');
    }

    // =====================================================================
    //  APPLY
    // =====================================================================
    function runApply() {
        gs.info('=== NETRA PERF APPLY — pausing ' + PAUSE_LIST.length + ' listed job(s) ===');
        gs.info('REMINDER: this run should be inside update set "Netra R5 - Instance Perf Tuning".');
        if (!PAUSE_LIST.length && !REMOVE_AUTO_HEALER) {
            gs.warn('PAUSE_LIST is empty and REMOVE_AUTO_HEALER is false — nothing to do. Run AUDIT first.');
            return;
        }
        var snapshot = [];
        var tables = ['sysauto_script', 'sysauto'];

        for (var i = 0; i < PAUSE_LIST.length; i++) {
            var name = String(PAUSE_LIST[i]);
            var done = false;
            for (var t = 0; t < tables.length && !done; t++) {
                var gr = new GlideRecord(tables[t]);
                if (!gr.isValid()) continue;
                gr.addQuery('name', name);
                gr.query();
                while (gr.next()) {
                    var sc = '';
                    try { sc = gr.sys_scope.nil() ? '' : String(gr.sys_scope.getDisplayValue()); } catch (e) { sc = ''; }
                    // defense in depth: refuse protected names even if listed
                    if (isProtected(name, sc)) {
                        gs.warn('REFUSED (protected): ' + name + ' — ' + classify(name, sc).reason);
                        done = true;
                        break;
                    }
                    if (String(gr.active) !== 'true') {
                        gs.info('SKIP (already inactive): ' + name);
                        done = true;
                        break;
                    }
                    snapshot.push({ table: tables[t], sys_id: String(gr.sys_id), name: name, was_active: true });
                    gr.active = false;
                    gr.update();
                    gs.info('PAUSED: ' + name + ' (' + tables[t] + ')');
                    done = true;
                }
            }
            if (!done) gs.warn('NOT FOUND: ' + name);
        }

        if (REMOVE_AUTO_HEALER) {
            var heal = new GlideRecord('sysauto_script');
            heal.addQuery('name', AUTO_HEALER_NAME);
            heal.query();
            if (heal.next()) {
                if (String(heal.active) === 'true') {
                    snapshot.push({ table: 'sysauto_script', sys_id: String(heal.sys_id), name: AUTO_HEALER_NAME, was_active: true });
                    heal.active = false;
                    heal.update();
                    gs.info('DEACTIVATED (opt-in): ' + AUTO_HEALER_NAME + ' — record kept, not deleted.');
                } else {
                    gs.info('Auto-healer already inactive.');
                }
            } else {
                gs.info('Auto-healer not found on this instance.');
            }
        }

        if (snapshot.length) {
            // merge with any previous snapshot so repeated APPLYs stay restorable
            var prev = [];
            try { prev = JSON.parse(readSnapshotProp() || '[]'); } catch (ep) { prev = []; }
            var seen = {};
            var merged = [];
            var all = prev.concat(snapshot);
            for (var m = 0; m < all.length; m++) {
                if (!seen[all[m].sys_id]) { seen[all[m].sys_id] = true; merged.push(all[m]); }
            }
            var json = JSON.stringify(merged);
            writeSnapshotProp(json);
            gs.info('');
            gs.info('=== NETRA PERF SNAPSHOT (save this — also stored in ' + SNAPSHOT_PROP + ') ===');
            gs.info(json);
            gs.info('=== END SNAPSHOT ===');
        }
        gs.info('APPLY complete. ' + snapshot.length + ' job(s) paused this run.');
    }

    // =====================================================================
    //  RESTORE
    // =====================================================================
    function runRestore() {
        var json = String(SNAPSHOT_OVERRIDE || '').replace(/^\s+|\s+$/g, '') || readSnapshotProp();
        if (!json) {
            gs.error('No snapshot found in ' + SNAPSHOT_PROP + ' and SNAPSHOT_OVERRIDE is empty. Nothing to restore.');
            return;
        }
        var list;
        try { list = JSON.parse(json); } catch (e) {
            gs.error('Snapshot JSON did not parse: ' + e);
            return;
        }
        gs.info('=== NETRA PERF RESTORE — re-activating ' + list.length + ' job(s) ===');
        var restored = 0;
        for (var i = 0; i < list.length; i++) {
            var item = list[i];
            var gr = new GlideRecord(String(item.table || 'sysauto_script'));
            if (!gr.isValid() || !gr.get(String(item.sys_id))) {
                gs.warn('NOT FOUND: ' + item.name + ' (' + item.sys_id + ')');
                continue;
            }
            if (String(gr.active) === 'true') {
                gs.info('SKIP (already active): ' + item.name);
                continue;
            }
            gr.active = true;
            gr.update();
            restored++;
            gs.info('RESTORED: ' + item.name);
        }
        gs.info('RESTORE complete. ' + restored + ' job(s) re-activated. Snapshot property left in place for audit history.');
    }

    // =====================================================================
    if (MODE === 'APPLY') runApply();
    else if (MODE === 'RESTORE') runRestore();
    else runAudit();

})();
