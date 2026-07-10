/**
 * NetraPerformance — READ-ONLY instance performance analytics for the Netra
 * voice assistant (R5). Lets an admin ask "what's slowing this instance
 * down?", "which scheduled jobs are the heaviest?", and "what integrations
 * are running?" by voice.
 *
 * This script include NEVER mutates anything. Pausing/restoring jobs is done
 * exclusively by the reviewed one-shot script install/perf-audit.js, run by a
 * human, inside a tracked update set (see docs/PERF-RUNBOOK.md).
 *
 * The classification lists below are duplicated in install/perf-audit.js by
 * design (a background script cannot require a scoped script include). Keep
 * the two copies in sync when editing.
 *
 * Access: 'admin' role, or any role listed in the comma-separated scoped
 * property __NETRA_SCOPE__.perf_read_roles.
 *
 * Every method returns { ok: true, ... } or { ok: false, error }.
 */
var NetraPerformance = Class.create();
NetraPerformance.prototype = {

    initialize: function () {
        this.userName = gs.getUserName();
    },

    // ============================================================
    //  Access control
    // ============================================================
    _canRead: function () {
        if (gs.hasRole('admin')) return true;
        var extra = String(gs.getProperty('__NETRA_SCOPE__.perf_read_roles', '') || '');
        if (!extra) return false;
        var parts = extra.split(',');
        for (var i = 0; i < parts.length; i++) {
            var r = parts[i].replace(/^\s+|\s+$/g, '');
            if (r && gs.hasRole(r)) return true;
        }
        return false;
    },

    _deny: function () {
        return { ok: false, error: 'Instance performance data needs the admin role.' };
    },

    // ============================================================
    //  Classification (KEEP IN SYNC with install/perf-audit.js)
    // ============================================================
    // Never suggest pausing anything matching these. Checked against the
    // job name AND its scope/package name. Over-protecting is deliberate.
    PROTECTED: [
        [/netra/i,                                'Netra product work'],
        [/trident/i,                              'Trident product work'],
        [/x_196061/i,                             'Netra application scope'],
        [/vulnerab|nvd|cve|third.?party.?entry/i, 'Vulnerability Response data feeds — the Netra VR demo depends on these'],
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
    ],

    // Common telemetry/analytics jobs that are safe to pause on a dev
    // instance IF the named feature is not in use. Candidates only — a human
    // reviews before anything is paused, via install/perf-audit.js.
    CANDIDATES: [
        [/performance analytics|\[pa\]|pa (daily|weekly) /i, 'Performance Analytics data collection'],
        [/predictive intelligence|ml (training|solution)/i,  'Predictive Intelligence model training'],
        [/agent client collector|\bacc\b/i,                  'Agent Client Collector telemetry'],
        [/benchmark/i,                                        'Benchmarks telemetry'],
        [/instance troubleshooter/i,                          'Instance Troubleshooter'],
        [/mobile analytics/i,                                 'Mobile app analytics'],
        [/virtual agent.*(analytic|metric)/i,                 'Virtual Agent analytics'],
        [/chat analytics/i,                                   'Chat analytics']
    ],

    // Netra maintenance leftover from the 2026-07-09 privilege incident:
    // re-grants cross-scope privileges every 5 minutes. Flag for removal
    // once the privilege set is stable (perf-audit.js can deactivate it,
    // opt-in only).
    AUTO_HEALER_NAME: 'Cross-Scope Privilege Auto-Healer (temporary)',

    /** Classify one job. Returns { klass, reason }. */
    _classify: function (name, scopeName) {
        var text = String(name || '') + ' ' + String(scopeName || '');
        if (String(name || '') === this.AUTO_HEALER_NAME) {
            return { klass: 'remove-recommended', reason: 'Netra maintenance leftover: re-grants privileges every 5 minutes. Remove once the privilege set is stable.' };
        }
        var i;
        for (i = 0; i < this.PROTECTED.length; i++) {
            if (this.PROTECTED[i][0].test(text)) return { klass: 'protected', reason: this.PROTECTED[i][1] };
        }
        for (i = 0; i < this.CANDIDATES.length; i++) {
            if (this.CANDIDATES[i][0].test(text)) return { klass: 'candidate', reason: this.CANDIDATES[i][1] };
        }
        return { klass: 'review', reason: 'Unclassified — leave alone unless a human review says otherwise.' };
    },

    // ============================================================
    //  Helpers
    // ============================================================
    /** '1970-01-02 00:03:00'-style glide duration -> seconds. */
    _durationSeconds: function (v) {
        var m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
        if (!m) return 0;
        var days = (parseInt(m[1], 10) - 1970) * 365 + (parseInt(m[2], 10) - 1) * 31 + (parseInt(m[3], 10) - 1);
        return days * 86400 + parseInt(m[4], 10) * 3600 + parseInt(m[5], 10) * 60 + parseInt(m[6], 10);
    },

    _perDay: function (repeatValue) {
        var secs = this._durationSeconds(repeatValue);
        if (secs <= 0) return 0;
        return Math.round((86400 / secs) * 10) / 10;
    },

    // ============================================================
    //  Public API (all read-only)
    // ============================================================
    /** Spoken-friendly instance health snapshot. */
    healthSummary: function () {
        if (!this._canRead()) return this._deny();
        var out = { ok: true, flags: [] };

        // scheduled job counts (sysauto covers script + non-script jobs)
        out.jobs_total = 0; out.jobs_active = 0;
        try {
            var ja = new GlideAggregate('sysauto');
            if (ja.isValid()) {
                ja.addAggregate('COUNT');
                ja.query();
                if (ja.next()) out.jobs_total = parseInt(ja.getAggregate('COUNT'), 10) || 0;
                var jb = new GlideAggregate('sysauto');
                jb.addQuery('active', true);
                jb.addAggregate('COUNT');
                jb.query();
                if (jb.next()) out.jobs_active = parseInt(jb.getAggregate('COUNT'), 10) || 0;
            }
        } catch (e1) { /* table not readable — counts stay 0 */ }

        // what the scheduler will fire in the next hour
        out.due_next_hour = 0;
        try {
            var soon = new GlideDateTime();
            soon.addSeconds(3600);
            var tr = new GlideAggregate('sys_trigger');
            if (tr.isValid()) {
                tr.addQuery('next_action', '<=', soon);
                tr.addAggregate('COUNT');
                tr.query();
                if (tr.next()) out.due_next_hour = parseInt(tr.getAggregate('COUNT'), 10) || 0;
            }
        } catch (e2) { /* ignore */ }

        // busiest repeating triggers
        out.busiest = [];
        var top = this.topJobs(3);
        if (top.ok && top.jobs) {
            for (var b = 0; b < top.jobs.length; b++) {
                out.busiest.push({ name: top.jobs[b].name, per_day: top.jobs[b].runs_per_day });
                if (top.jobs[b].runs_per_day >= 288) {
                    out.flags.push(top.jobs[b].name + ' runs ' + top.jobs[b].runs_per_day + ' times a day.');
                }
            }
        }

        // slow transactions in the last 24h (bounded scan)
        out.slow_transactions_24h = { count: 0, worst_ms: 0, worst_url: '' };
        try {
            var since = new GlideDateTime();
            since.addSeconds(-86400);
            var sl = new GlideRecord('syslog_transaction');
            if (sl.isValid()) {
                sl.addQuery('sys_created_on', '>=', since);
                sl.addQuery('response_time', '>', 5000);
                sl.orderByDesc('response_time');
                sl.setLimit(50);
                sl.query();
                while (sl.next()) {
                    out.slow_transactions_24h.count++;
                    var ms = parseInt(String(sl.response_time), 10) || 0;
                    if (ms > out.slow_transactions_24h.worst_ms) {
                        out.slow_transactions_24h.worst_ms = ms;
                        out.slow_transactions_24h.worst_url = String(sl.url || '').substring(0, 80);
                    }
                }
            }
        } catch (e3) { /* log table not readable */ }

        // standing flags
        try {
            var heal = new GlideRecord('sysauto_script');
            if (heal.isValid()) {
                heal.addQuery('name', this.AUTO_HEALER_NAME);
                heal.addQuery('active', true);
                heal.setLimit(1);
                heal.query();
                if (heal.next()) out.flags.push('The temporary Cross-Scope Privilege Auto-Healer is still active — it re-runs every 5 minutes and should be removed once privileges are stable.');
            }
        } catch (e4) { /* ignore */ }

        var msg = 'There are ' + out.jobs_active + ' active scheduled jobs, with ' + out.due_next_hour + ' runs due in the next hour.';
        if (out.busiest.length) msg += ' The busiest is ' + out.busiest[0].name + ' at ' + out.busiest[0].per_day + ' runs a day.';
        if (out.slow_transactions_24h.count) msg += ' ' + out.slow_transactions_24h.count + ' transactions took over five seconds in the last day.';
        if (out.flags.length) msg += ' ' + out.flags[0];
        out.message = msg;
        return out;
    },

    /** Heaviest repeating jobs, ranked by runs per day, with classification. */
    topJobs: function (limit) {
        if (!this._canRead()) return this._deny();
        var max = parseInt(limit, 10) || 10;
        var rows = [];
        try {
            var tr = new GlideRecord('sys_trigger');
            if (!tr.isValid()) return { ok: false, error: 'The scheduler queue table is not readable from this scope.' };
            tr.addQuery('trigger_type', 1); // repeating
            tr.setLimit(200);
            tr.query();
            while (tr.next()) {
                var name = String(tr.name);
                var perDay = this._perDay(String(tr.repeat));
                var cls = this._classify(name, '');
                rows.push({
                    name: name,
                    runs_per_day: perDay,
                    next_run: String(tr.next_action || ''),
                    classification: cls.klass,
                    reason: cls.reason
                });
            }
        } catch (e) {
            return { ok: false, error: 'Could not read the scheduler queue: ' + e };
        }
        rows.sort(function (a, b) { return b.runs_per_day - a.runs_per_day; });
        if (rows.length > max) rows.length = max;
        return { ok: true, count: rows.length, jobs: rows };
    },

    /** Read-only inventory of integration machinery. */
    integrationReport: function () {
        if (!this._canRead()) return this._deny();
        var out = { ok: true };

        out.scheduled_imports = { active_count: 0, names: [] };
        try {
            var si = new GlideRecord('scheduled_import_set');
            if (si.isValid()) {
                si.addQuery('active', true);
                si.setLimit(50);
                si.query();
                while (si.next()) {
                    out.scheduled_imports.active_count++;
                    if (out.scheduled_imports.names.length < 5) out.scheduled_imports.names.push(String(si.name));
                }
            }
        } catch (e1) { /* ignore */ }

        out.ldap = { configured: 0 };
        try {
            var ld = new GlideRecord('ldap_server_config');
            if (ld.isValid()) {
                ld.query();
                while (ld.next()) out.ldap.configured++;
            }
        } catch (e2) { /* ignore */ }

        out.outbound_rest = { definitions: 0, netra_owned: 0 };
        try {
            var rm = new GlideRecord('sys_rest_message');
            if (rm.isValid()) {
                rm.setLimit(200);
                rm.query();
                while (rm.next()) {
                    out.outbound_rest.definitions++;
                    if (/netra/i.test(String(rm.name))) out.outbound_rest.netra_owned++;
                }
            }
        } catch (e3) { /* ignore */ }

        out.mid_servers = 0;
        try {
            var ma = new GlideAggregate('ecc_agent');
            if (ma.isValid()) {
                ma.addAggregate('COUNT');
                ma.query();
                if (ma.next()) out.mid_servers = parseInt(ma.getAggregate('COUNT'), 10) || 0;
            }
        } catch (e4) { /* ignore */ }

        out.message = 'I see ' + out.scheduled_imports.active_count + ' active scheduled imports, ' +
            out.ldap.configured + ' LDAP servers, ' + out.outbound_rest.definitions +
            ' outbound REST message definitions, and ' + out.mid_servers + ' MID servers.' +
            ' Netra itself calls the Gemini API directly and owns no outbound REST records.';
        return out;
    },

    /** Full classification dump of active scheduled jobs (for audits/tests). */
    auditReport: function () {
        if (!this._canRead()) return this._deny();
        var jobs = [];
        var table = 'sysauto';
        try {
            var probe = new GlideRecord('sysauto');
            if (!probe.isValid()) table = 'sysauto_script';
        } catch (e0) { table = 'sysauto_script'; }
        try {
            var gr = new GlideRecord(table);
            if (!gr.isValid()) return { ok: false, error: 'Scheduled job tables are not readable from this scope.' };
            gr.addQuery('active', true);
            gr.setLimit(200);
            gr.query();
            while (gr.next()) {
                var name = String(gr.name);
                var scopeName = '';
                try { scopeName = gr.sys_scope.nil() ? '' : String(gr.sys_scope.getDisplayValue()); } catch (es) { scopeName = ''; }
                var cls = this._classify(name, scopeName);
                jobs.push({ name: name, scope: scopeName, classification: cls.klass, reason: cls.reason });
            }
        } catch (e) {
            return { ok: false, error: 'Could not read scheduled jobs: ' + e };
        }
        return { ok: true, count: jobs.length, jobs: jobs };
    },

    type: 'NetraPerformance'
};
