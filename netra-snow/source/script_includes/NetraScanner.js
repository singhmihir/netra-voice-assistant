/**
 * NetraScanner — periodic watcher that wakes Netra up.
 *
 * Invoked by the "Netra Watch" scheduled job every 3 minutes.
 *
 * For every user with an x_196061_netra_v1_user_pref row, scans for:
 *   1. Incidents newly assigned to them since their last scan
 *   2. Approvals newly waiting on them
 *   3. Service Catalog tasks newly assigned to them
 *   4. Generic tasks (change, problem) newly assigned to them
 *
 * Comments on tickets are handled separately by the Business Rule on
 * sys_journal_field (real-time, not part of this scan).
 *
 * Each fresh hit creates one x_196061_netra_v1_notification row, deduplicated by
 * a (table, sys_id, kind) key in the message so we never re-announce.
 */
var NetraScanner = Class.create();
NetraScanner.prototype = {

    initialize: function () {},

    /**
     * Main entry point — called from the scheduled job.
     * Iterates active users with prefs and runs scanForUser for each.
     */
    run: function () {
        var processed = 0;
        var enqueued = 0;

        // R8.2 - promote due voice reminders BEFORE the per-user scans so
        // they ride the very next widget poll.
        try { enqueued += this.promoteDueReminders(); } catch (eR) {
            gs.warn('[NetraScanner] reminder promotion failed: ' + eR);
        }

        // R16 - look for an outage forming. This one is instance-wide, not
        // per-user, so it runs ONCE up here instead of re-crunching the same
        // numbers inside every user's scan.
        try { enqueued += this.detectMajorIncidentClusters(); } catch (eM) {
            gs.warn('[NetraScanner] cluster detection failed: ' + eM);
        }

        var prefs = new GlideRecord('x_196061_netra_v1_user_pref');
        prefs.addQuery('active', true);
        prefs.query();

        while (prefs.next()) {
            try {
                var r = this.scanForUser(prefs);
                processed++;
                enqueued += r;
            } catch (e) {
                gs.warn('[NetraScanner] user scan failed: ' + e);
            }
        }

        gs.info('[NetraScanner] scanned ' + processed + ' users, enqueued ' + enqueued + ' notifications.');
        return { users: processed, enqueued: enqueued };
    },

    /**
     * R8.2 - Voice reminders are stored by the widget as notification rows
     * with kind 'reminder_scheduled', delivered=true (hidden from the poll)
     * and the due epoch-ms in ticket_sys_id. Once due, flip them to a live
     * notification the widget announces on its next poll.
     */
    promoteDueReminders: function () {
        var nowMs = new GlideDateTime().getNumericValue();
        var n = new GlideRecord('x_196061_netra_v1_notification');
        n.addQuery('kind', 'reminder_scheduled');
        n.query();
        var promoted = 0;
        while (n.next()) {
            var dueMs = parseInt(String(n.ticket_sys_id), 10) || 0;
            if (dueMs > nowMs) continue;
            n.kind = 'reminder';
            n.delivered = false;
            n.update();
            promoted++;
        }
        if (promoted) gs.info('[NetraScanner] promoted ' + promoted + ' due reminder(s).');
        return promoted;
    },

    /**
     * R16 - MAJOR INCIDENT RADAR (proactive).
     *
     * Three or more active tickets landing on the same configuration item
     * (or five on one category) inside a couple of hours is almost never a
     * coincidence - its one outage wearing several hats. Netra says so out
     * loud instead of waiting to be asked.
     *
     * Dedupe: the cluster key goes in ticket_sys_id, so _alreadyNotified
     * stops us announcing the same server every five minutes. The key
     * carries the hour bucket, so a genuinely NEW flare-up later still
     * gets announced.
     */
    detectMajorIncidentClusters: function () {
        var WINDOW_HOURS = 2;
        var CI_MIN  = 3;
        var CAT_MIN = 5;

        var gr = new GlideRecord('incident');
        gr.addActiveQuery();
        gr.addEncodedQuery('sys_created_on>=javascript:gs.hoursAgoStart(' + WINDOW_HOURS + ')');
        gr.setLimit(200);
        gr.query();

        var byCi = {}, byCat = {}, total = 0;
        while (gr.next()) {
            total++;
            var ci = String(gr.cmdb_ci.getDisplayValue ? gr.cmdb_ci.getDisplayValue() : '');
            if (ci) { byCi[ci] = (byCi[ci] || 0) + 1; }
            var cat = String(gr.category || '');
            if (cat) { byCat[cat] = (byCat[cat] || 0) + 1; }
        }
        if (!total) return 0;

        var hits = [];
        var k;
        for (k in byCi)  { if (byCi.hasOwnProperty(k)  && byCi[k]  >= CI_MIN)  hits.push({ what: k, n: byCi[k],  kind: 'on ' + k }); }
        for (k in byCat) { if (byCat.hasOwnProperty(k) && byCat[k] >= CAT_MIN) hits.push({ what: k, n: byCat[k], kind: 'in the ' + k + ' category' }); }
        if (!hits.length) return 0;

        hits.sort(function (a, b) { return b.n - a.n; });
        var top = hits[0];

        // bucket the key by hour so a fresh flare-up tomorrow still speaks up
        var bucket = new GlideDateTime().toString().substring(0, 13).replace(/[^0-9]/g, '');
        var key = ('mic_' + top.what + '_' + bucket).substring(0, 32);
        var msg = 'Heads up - ' + top.n + ' tickets have come in ' + top.kind +
                  ' in the last couple of hours. That looks like one outage rather than separate issues.';

        var sent = 0;
        var prefs = new GlideRecord('x_196061_netra_v1_user_pref');
        prefs.addQuery('active', true);
        prefs.addQuery('watch_assignments', true);
        prefs.query();
        while (prefs.next()) {
            var uid = String(prefs.user);
            if (!uid) continue;
            if (this._alreadyNotified(uid, key, 'major_incident')) continue;
            this._enqueue(uid, {
                ticket_sys_id: key,
                ticket_number: '',
                kind: 'major_incident',
                message: msg
            });
            sent++;
        }
        if (sent) gs.info('[NetraScanner] major-incident cluster announced: ' + top.what + ' x' + top.n + ' -> ' + sent + ' user(s)');
        return sent;
    },

    /**
     * @param {GlideRecord} pref  x_196061_netra_v1_user_pref row, already loaded
     * @returns {number}          count of notifications enqueued for this user
     */
    scanForUser: function (pref) {
        var userSysId = String(pref.user);
        if (!userSysId) return 0;

        // If user has paused notifications, skip entirely.
        var pausedUntil = pref.paused_until;
        if (pausedUntil && String(pausedUntil) !== '') {
            var nowGdt = new GlideDateTime();
            if (new GlideDateTime(String(pausedUntil)).compareTo(nowGdt) > 0) {
                return 0;
            }
        }

        // Find a "since" cutoff — last_scan_time, or 5 min ago if never scanned.
        var since;
        if (pref.last_scan_time && String(pref.last_scan_time) !== '') {
            since = new GlideDateTime(String(pref.last_scan_time));
        } else {
            since = new GlideDateTime();
            since.subtract(5 * 60 * 1000);  // 5 minutes
        }

        var count = 0;
        if (pref.watch_assignments) {
            count += this._scanIncidentAssignments(userSysId, since);
            count += this._scanChangeAssignments(userSysId, since);
            count += this._scanCatalogTasks(userSysId, since);
        }
        if (pref.watch_approvals) {
            count += this._scanApprovals(userSysId, since);
        }

        // Advance the watermark
        pref.last_scan_time = new GlideDateTime();
        pref.update();

        return count;
    },

    // ============================================================
    //  Per-table scans
    // ============================================================

    _scanIncidentAssignments: function (userSysId, since) {
        var gr = new GlideRecord('incident');
        gr.addQuery('assigned_to', userSysId);
        gr.addQuery('sys_updated_on', '>=', since);
        gr.addQuery('state', 'NOT IN', '6,7,8'); // not resolved/closed/cancelled
        gr.setLimit(20);
        gr.query();

        var n = 0;
        while (gr.next()) {
            // Only fire when assigned_to actually changed in this window.
            // Cheap check: compare audit history would be ideal; for v1 we
            // dedupe by ensuring no prior notification of this kind exists.
            if (this._alreadyNotified(userSysId, String(gr.sys_id), 'incident_assigned')) continue;
            this._enqueue(userSysId, {
                ticket_sys_id: String(gr.sys_id),
                ticket_number: String(gr.number),
                kind: 'incident_assigned',
                message: 'Heads up. Incident ' + this._spokenNumber(String(gr.number)) +
                         ' has been assigned to you. The issue is: ' + String(gr.short_description) + '.'
            });
            n++;
        }
        return n;
    },

    _scanChangeAssignments: function (userSysId, since) {
        var gr = new GlideRecord('change_request');
        gr.addQuery('assigned_to', userSysId);
        gr.addQuery('sys_updated_on', '>=', since);
        gr.addQuery('state', 'NOT IN', '3,4'); // not closed/cancelled (state codes vary by org)
        gr.setLimit(20);
        gr.query();

        var n = 0;
        while (gr.next()) {
            if (this._alreadyNotified(userSysId, String(gr.sys_id), 'change_assigned')) continue;
            this._enqueue(userSysId, {
                ticket_sys_id: String(gr.sys_id),
                ticket_number: String(gr.number),
                kind: 'change_assigned',
                message: 'A change request, ' + this._spokenNumber(String(gr.number)) +
                         ', has been assigned to you. Title: ' + String(gr.short_description) + '.'
            });
            n++;
        }
        return n;
    },

    _scanCatalogTasks: function (userSysId, since) {
        var gr = new GlideRecord('sc_task');
        gr.addQuery('assigned_to', userSysId);
        gr.addQuery('sys_updated_on', '>=', since);
        gr.addQuery('state', 'NOT IN', '3,4,7'); // open-ish
        gr.setLimit(20);
        gr.query();

        var n = 0;
        while (gr.next()) {
            if (this._alreadyNotified(userSysId, String(gr.sys_id), 'sc_task_assigned')) continue;
            this._enqueue(userSysId, {
                ticket_sys_id: String(gr.sys_id),
                ticket_number: String(gr.number),
                kind: 'sc_task_assigned',
                message: 'A catalog task, ' + this._spokenNumber(String(gr.number)) +
                         ', is now waiting on you. Title: ' + String(gr.short_description) + '.'
            });
            n++;
        }
        return n;
    },

    _scanApprovals: function (userSysId, since) {
        var gr = new GlideRecord('sysapproval_approver');
        gr.addQuery('approver', userSysId);
        gr.addQuery('state', 'requested');
        gr.addQuery('sys_updated_on', '>=', since);
        gr.setLimit(20);
        gr.query();

        var n = 0;
        while (gr.next()) {
            if (this._alreadyNotified(userSysId, String(gr.sys_id), 'approval_requested')) continue;

            // Best-effort: name what we're approving (avoid getRefRecord -
            // it's fenced in some scoped contexts). Use the document_id pattern:
            // sysapproval is a Document ID reference; source_table tells us
            // which table to query.
            var subject = '';
            try {
                var srcSysId = String(gr.sysapproval || '');
                var srcTable = String(gr.source_table || gr.sysapproval_table || '');
                if (srcSysId && srcTable) {
                    var srcRec = new GlideRecord(srcTable);
                    if (srcRec.isValid() && srcRec.get(srcSysId)) {
                        subject = String(srcRec.getValue('number') || '') + ' - ' +
                                  String(srcRec.getValue('short_description') || '');
                    }
                }
            } catch (e) {}

            this._enqueue(userSysId, {
                ticket_sys_id: String(gr.sys_id),
                ticket_number: subject || 'request',
                kind: 'approval_requested',
                message: 'An approval is waiting on you' + (subject ? ' for ' + subject : '') + '.'
            });
            n++;
        }
        return n;
    },

    // ============================================================
    //  Dedupe + enqueue
    // ============================================================
    _alreadyNotified: function (userSysId, recordSysId, kind) {
        var gr = new GlideRecord('x_196061_netra_v1_notification');
        gr.addQuery('user', userSysId);
        gr.addQuery('ticket_sys_id', recordSysId);
        gr.addQuery('kind', kind);
        gr.setLimit(1);
        gr.query();
        return gr.next();
    },

    _enqueue: function (userSysId, opts) {
        var gr = new GlideRecord('x_196061_netra_v1_notification');
        gr.initialize();
        gr.user = userSysId;
        gr.ticket_sys_id = opts.ticket_sys_id;
        gr.ticket_number = opts.ticket_number;
        gr.kind = opts.kind;
        gr.message = opts.message;
        gr.delivered = false;
        gr.insert();
    },

    _spokenNumber: function (num) {
        if (!num) return '';
        var m = String(num).match(/^([A-Z]+)(\d+)$/);
        if (!m) return num;
        var letters = m[1].split('').join(' ');
        var digitWords = { '0':'zero','1':'one','2':'two','3':'three','4':'four','5':'five','6':'six','7':'seven','8':'eight','9':'nine' };
        var digits = m[2].split('').map(function (d) { return digitWords[d] || d; }).join(' ');
        return letters + ' ' + digits;
    },

    type: 'NetraScanner'
};
