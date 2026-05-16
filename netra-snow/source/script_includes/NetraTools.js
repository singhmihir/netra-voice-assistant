/**
 * NetraTools — GlideRecord operations.
 *
 * v2.0 — adds pause/resume preference management, and helpers used by the
 * scheduled scanner.
 *
 * Returns plain JS objects ready to be JSON-serialised to the client.
 */
var NetraTools = Class.create();
NetraTools.prototype = {

    STATE: { NEW: '1', IN_PROGRESS: '2', ON_HOLD: '3', RESOLVED: '6', CLOSED: '7', CANCELLED: '8' },
    STATE_LABEL: {
        '1': 'new', '2': 'in progress', '3': 'on hold',
        '6': 'resolved', '7': 'closed', '8': 'cancelled'
    },
    PRIORITY_LABEL: { '1': 'critical', '2': 'high', '3': 'moderate', '4': 'low', '5': 'planning' },

    initialize: function () {
        this.userSysId = gs.getUserID();
        this.userName = gs.getUserName();
    },

    // ============================================================
    //  Incident CRUD
    // ============================================================
    createTicket: function (description, urgency) {
        if (!description || description.trim().length < 3) {
            return { ok: false, error: 'Description is too short.' };
        }
        var gr = new GlideRecord('incident');
        gr.initialize();
        gr.short_description = description;
        gr.description = 'Created via Netra voice assistant.';
        gr.caller_id = this.userSysId;
        gr.urgency = urgency || '3';
        gr.impact = '3';
        gr.contact_type = 'self-service';
        var sysId = gr.insert();
        if (!sysId) return { ok: false, error: 'Could not create the ticket. ' + gr.getLastErrorMessage() };
        gr.get(sysId);
        return { ok: true, ticket: { number: String(gr.number), sys_id: sysId, short_description: String(gr.short_description) } };
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

    // ============================================================
    //  User preferences (pause / resume)
    // ============================================================

    /**
     * Pause Netra notifications for the given duration (in hours).
     * Stored in x_netra_user_pref.paused_until as an absolute GlideDateTime.
     */
    pauseNotifications: function (hours) {
        if (!hours || hours <= 0) return { ok: false, error: 'Invalid pause duration.' };
        var pref = this._getOrCreatePref();
        var until = new GlideDateTime();
        until.add(Math.round(hours * 3600 * 1000));   // ms
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
        var pref = this._getOrCreatePref(/*don't create*/ true);
        if (!pref) return false;
        var until = pref.paused_until;
        if (!until || String(until) === '') return false;
        var now = new GlideDateTime();
        return new GlideDateTime(String(until)).compareTo(now) > 0;
    },

    /**
     * Look up the pref row for the current user, or create one if missing.
     * @param {boolean} [readOnly] if true, returns null when no row exists
     */
    _getOrCreatePref: function (readOnly) {
        var gr = new GlideRecord('x_netra_user_pref');
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

    _shape: function (gr) {
        var state = String(gr.state || '');
        var prio = String(gr.priority || '');
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
