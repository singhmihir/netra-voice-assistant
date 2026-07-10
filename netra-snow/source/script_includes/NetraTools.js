/**
 * NetraTools — server-side GlideRecord operations.
 *
 * v3 adds:
 *   - Approvals: list, approve, reject
 *   - Watchlist: add/remove a ticket to the user's watch list
 *   - Search:    free-text incident search
 *   - Read:      fetch full record + comments for read-aloud
 *
 * Tables referenced via __NETRA_SCOPE__ placeholder, replaced at install.
 */
var NetraTools = Class.create();
NetraTools.prototype = {

    STATE:        { NEW: '1', IN_PROGRESS: '2', ON_HOLD: '3', RESOLVED: '6', CLOSED: '7', CANCELLED: '8' },
    STATE_LABEL:  { '1': 'new', '2': 'in progress', '3': 'on hold', '6': 'resolved', '7': 'closed', '8': 'cancelled' },
    PRIORITY_LABEL: { '1': 'critical', '2': 'high', '3': 'moderate', '4': 'low', '5': 'planning' },

    PREF_TABLE:         '__NETRA_SCOPE___user_pref',
    NOTIFICATION_TABLE: '__NETRA_SCOPE___notification',
    WATCHLIST_TABLE:    '__NETRA_SCOPE___watchlist',

    initialize: function () {
        this.userSysId = gs.getUserID();
        this.userName  = gs.getUserName();
    },

    // ============================================================
    //  Release X - TICKET SAFETY POLICY
    //  Netra is read-only on ticket records. Creation is refused
    //  unconditionally; mutation (resolve / comment) is refused
    //  unless <scope>.ticket_writes is explicitly 'true'. This is
    //  the second enforcement layer - the widget server strips the
    //  same tools from the model's toolset, and this guard covers
    //  the legacy scripted-REST /command path as well.
    // ============================================================
    _ticketWritesEnabled: function () {
        return gs.getProperty('__NETRA_SCOPE__.ticket_writes', 'false') === 'true';
    },

    READ_ONLY_MSG: 'I can\'t raise or change tickets myself - I\'m read-only there. But I can pull up everything about existing ones: status, summaries, history, or keep watch on one for you.',

    // ============================================================
    //  Incident operations (creation permanently disabled)
    // ============================================================
    createTicket: function (description, urgency) {
        // Release X: ticket creation is permanently disabled for Netra.
        // No property re-enables this path.
        return { ok: false, read_only: true, error: 'Ticket creation is disabled.', message: this.READ_ONLY_MSG };
    },

    listMyTickets: function (limit) {
        var gr = new GlideRecord('incident');
        gr.addQuery('caller_id', this.userSysId);
        gr.addQuery('state', 'NOT IN', this.STATE.CLOSED + ',' + this.STATE.CANCELLED);
        gr.orderByDesc('sys_updated_on');
        gr.setLimit(limit || 10);
        gr.query();
        var out = [];
        while (gr.next()) out.push(this._shape(gr));
        return { ok: true, tickets: out };
    },

    resolveTicket: function (number, closeNotes) {
        if (!this._ticketWritesEnabled())
            return { ok: false, read_only: true, error: 'Ticket modification is disabled.', message: this.READ_ONLY_MSG };
        var gr = this._findByNumber(number);
        if (!gr) return { ok: false, error: 'Ticket ' + number + ' not found, or you are not the caller.' };
        gr.state = this.STATE.RESOLVED;
        gr.close_code = 'Solved (Permanently)';
        gr.close_notes = closeNotes || 'Resolved by caller via Netra.';
        gr.resolved_by = this.userSysId;
        gr.resolved_at = new GlideDateTime();
        gr.update();
        return { ok: true, number: number };
    },

    updateTicket: function (number, comment) {
        if (!this._ticketWritesEnabled())
            return { ok: false, read_only: true, error: 'Ticket modification is disabled.', message: this.READ_ONLY_MSG };
        if (!comment || comment.trim().length < 1) return { ok: false, error: 'Comment is empty.' };
        var gr = this._findByNumber(number);
        if (!gr) return { ok: false, error: 'Ticket ' + number + ' not found, or you are not the caller.' };
        gr.comments = comment;
        gr.update();
        return { ok: true, number: number };
    },

    getStatus: function (number) {
        var gr = this._findByNumber(number);
        if (!gr) return { ok: false, error: 'Ticket ' + number + ' not found, or you are not the caller.' };
        return { ok: true, ticket: this._shape(gr) };
    },

    /** Search the user's incidents by keyword in short_description / description. */
    searchTickets: function (keyword, limit) {
        var q = String(keyword || '').trim();
        if (q.length < 2) return { ok: false, error: 'Please give me a longer search term.' };
        var gr = new GlideRecord('incident');
        gr.addQuery('caller_id', this.userSysId)
          .addOrCondition('assigned_to', this.userSysId);
        gr.addQuery('short_descriptionLIKE' + q + '^ORdescriptionLIKE' + q);
        gr.orderByDesc('sys_updated_on');
        gr.setLimit(limit || 5);
        gr.query();
        var out = [];
        while (gr.next()) out.push(this._shape(gr));
        return { ok: true, tickets: out, query: q };
    },

    /** Full record + recent comments for read-aloud. */
    readTicket: function (number) {
        var gr = this._findByNumberAny(number);
        if (!gr) return { ok: false, error: 'Ticket ' + number + ' not found.' };
        var shaped = this._shape(gr);
        shaped.description = String(gr.description || '');
        shaped.recent_comments = this._recentJournal(String(gr.sys_id), 5);
        return { ok: true, ticket: shaped };
    },

    // ============================================================
    //  Approvals
    // ============================================================
    listPendingApprovals: function () {
        var gr = new GlideRecord('sysapproval_approver');
        gr.addQuery('approver', this.userSysId);
        gr.addQuery('state', 'requested');
        gr.orderByDesc('sys_created_on');
        gr.setLimit(10);
        gr.query();
        var out = [];
        while (gr.next()) {
            var subject = '';
            var ref = '';
            // Avoid getRefRecord() - fenced in some scoped contexts.
            // Use Document-ID pattern: sysapproval = sys_id, source_table = table name.
            try {
                var srcSysId = String(gr.sysapproval || '');
                var srcTable = String(gr.source_table || gr.sysapproval_table || '');
                if (srcSysId && srcTable) {
                    var srcRec = new GlideRecord(srcTable);
                    if (srcRec.isValid() && srcRec.get(srcSysId)) {
                        ref = String(srcRec.getValue('number') || '');
                        subject = ref + ' - ' + String(srcRec.getValue('short_description') || '');
                    }
                }
            } catch (e) {}
            out.push({
                sys_id:  String(gr.sys_id),
                subject: subject,
                ref_number: ref,
                created: String(gr.sys_created_on)
            });
        }
        return { ok: true, approvals: out };
    },

    decideApproval: function (refNumber, approve) {
        if (!refNumber) return { ok: false, error: 'Which one should I act on?' };
        var gr = new GlideRecord('sysapproval_approver');
        gr.addQuery('approver', this.userSysId);
        gr.addQuery('state', 'requested');
        gr.query();
        while (gr.next()) {
            try {
                var srcSysId = String(gr.sysapproval || '');
                var srcTable = String(gr.source_table || gr.sysapproval_table || '');
                if (!srcSysId || !srcTable) continue;
                var srcRec = new GlideRecord(srcTable);
                if (!srcRec.isValid() || !srcRec.get(srcSysId)) continue;
                if (String(srcRec.getValue('number') || '').toUpperCase() === String(refNumber).toUpperCase()) {
                    gr.state = approve ? 'approved' : 'rejected';
                    gr.comments = approve ? 'Approved via Netra.' : 'Rejected via Netra.';
                    gr.update();
                    return { ok: true, number: refNumber, decision: approve ? 'approved' : 'rejected' };
                }
            } catch (e) {}
        }
        return { ok: false, error: 'I could not find a pending approval for ' + refNumber + '.' };
    },

    // ============================================================
    //  Watchlist
    // ============================================================
    addWatch: function (table, sysId, number) {
        var w = new GlideRecord(this.WATCHLIST_TABLE);
        w.addQuery('user', this.userSysId);
        w.addQuery('record_table', table);
        w.addQuery('record_sys_id', sysId);
        w.setLimit(1);
        w.query();
        if (w.next()) return { ok: true, already: true, number: number };
        w.initialize();
        w.user = this.userSysId;
        w.record_table = table;
        w.record_sys_id = sysId;
        w.record_number = number || '';
        w.insert();
        return { ok: true, number: number };
    },

    removeWatch: function (table, sysId) {
        var w = new GlideRecord(this.WATCHLIST_TABLE);
        w.addQuery('user', this.userSysId);
        w.addQuery('record_table', table);
        w.addQuery('record_sys_id', sysId);
        w.deleteMultiple();
        return { ok: true };
    },

    listWatched: function () {
        var w = new GlideRecord(this.WATCHLIST_TABLE);
        w.addQuery('user', this.userSysId);
        w.orderByDesc('sys_created_on');
        w.setLimit(20);
        w.query();
        var out = [];
        while (w.next()) out.push({
            table:  String(w.record_table),
            sys_id: String(w.record_sys_id),
            number: String(w.record_number)
        });
        return { ok: true, watched: out };
    },

    // ============================================================
    //  User preferences (pause / resume / voice mode)
    // ============================================================
    pauseNotifications: function (hours) {
        if (!hours || hours <= 0) return { ok: false, error: 'Invalid pause duration.' };
        var pref = this._getOrCreatePref();
        var until = new GlideDateTime();
        until.add(Math.round(hours * 3600 * 1000));
        pref.paused_until = until;
        pref.update();
        return { ok: true, paused_until: String(pref.paused_until), hours: hours };
    },

    resumeNotifications: function () {
        var pref = this._getOrCreatePref();
        pref.paused_until = '';
        pref.update();
        return { ok: true };
    },

    isPaused: function () {
        var pref = this._getOrCreatePref(true);
        if (!pref) return false;
        var until = pref.paused_until;
        if (!until || String(until) === '') return false;
        return new GlideDateTime(String(until)).compareTo(new GlideDateTime()) > 0;
    },

    setVoiceMode: function (mode) {
        var pref = this._getOrCreatePref();
        pref.voice_mode = String(mode || 'normal').toLowerCase();
        pref.update();
        return { ok: true, mode: pref.voice_mode };
    },

    _getOrCreatePref: function (readOnly) {
        var gr = new GlideRecord(this.PREF_TABLE);
        gr.addQuery('user', this.userSysId);
        gr.setLimit(1);
        gr.query();
        if (gr.next()) return gr;
        if (readOnly) return null;
        gr.initialize();
        gr.user = this.userSysId;
        gr.watch_assignments = true;
        gr.watch_comments = true;
        gr.watch_approvals = true;
        gr.voice_mode = 'normal';
        gr.insert();
        gr.get(gr.sys_id);
        return gr;
    },

    // ============================================================
    //  Helpers
    // ============================================================
    _findByNumber: function (number) {
        if (!number) return null;
        var gr = new GlideRecord('incident');
        gr.addQuery('number', String(number).toUpperCase());
        gr.addQuery('caller_id', this.userSysId);
        gr.query();
        return gr.next() ? gr : null;
    },

    _findByNumberAny: function (number) {
        if (!number) return null;
        var gr = new GlideRecord('incident');
        gr.addQuery('number', String(number).toUpperCase());
        // either caller or assignee can read
        gr.addQuery('caller_idORassigned_to', this.userSysId)
          .addOrCondition('caller_id', this.userSysId);
        gr.query();
        return gr.next() ? gr : null;
    },

    _recentJournal: function (sysId, limit) {
        var j = new GlideRecord('sys_journal_field');
        j.addQuery('element_id', sysId);
        j.addQuery('element', 'IN', 'comments,work_notes');
        j.orderByDesc('sys_created_on');
        j.setLimit(limit || 5);
        j.query();
        var out = [];
        while (j.next()) out.push({
            element: String(j.element),
            author:  String(j.sys_created_by),
            body:    String(j.value || '').replace(/\s+/g, ' ').trim(),
            created: String(j.sys_created_on)
        });
        return out;
    },

    _shape: function (gr) {
        var state = String(gr.state || '');
        var prio  = String(gr.priority || '');
        return {
            number: String(gr.number),
            sys_id: String(gr.sys_id),
            short_description: String(gr.short_description),
            state: this.STATE_LABEL[state] || state,
            priority: this.PRIORITY_LABEL[prio] || prio,
            assigned_to: gr.assigned_to.getDisplayValue() || null,
            updated: String(gr.sys_updated_on),
            created: String(gr.sys_created_on)
        };
    },

    type: 'NetraTools'
};
