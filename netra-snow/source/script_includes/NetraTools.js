/**
 * NetraTools — server-side GlideRecord operations on incidents.
 *
 * All methods enforce the rule that the user can only touch tickets where
 * they are the caller. ACLs reinforce this on the table level.
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
    PRIORITY_LABEL: {
        '1': 'critical', '2': 'high', '3': 'moderate', '4': 'low', '5': 'planning'
    },

    initialize: function () {
        this.userSysId = gs.getUserID();
        this.userName = gs.getUserName();
    },

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
        if (!sysId) {
            return { ok: false, error: 'Could not create the ticket. ' + gr.getLastErrorMessage() };
        }
        gr.get(sysId);
        return {
            ok: true,
            ticket: {
                number: String(gr.number),
                sys_id: sysId,
                short_description: String(gr.short_description)
            }
        };
    },

    listMyTickets: function (limit) {
        var gr = new GlideRecord('incident');
        gr.addQuery('caller_id', this.userSysId);
        gr.addQuery('state', 'NOT IN', this.STATE.CLOSED + ',' + this.STATE.CANCELLED);
        gr.orderByDesc('sys_updated_on');
        gr.setLimit(limit || 10);
        gr.query();
        var out = [];
        while (gr.next()) {
            out.push(this._shape(gr));
        }
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
        if (!comment || comment.trim().length < 1) {
            return { ok: false, error: 'Comment is empty.' };
        }
        var gr = this._findByNumber(number);
        if (!gr) return { ok: false, error: 'Ticket ' + number + ' not found, or you are not the caller.' };
        gr.comments = comment;  // 'comments' journal = customer-visible additional comments
        gr.update();
        return { ok: true, number: number };
    },

    getStatus: function (number) {
        var gr = this._findByNumber(number);
        if (!gr) return { ok: false, error: 'Ticket ' + number + ' not found, or you are not the caller.' };
        return { ok: true, ticket: this._shape(gr) };
    },

    // ---------- helpers ----------
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
