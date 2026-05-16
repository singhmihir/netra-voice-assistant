/**
 * NetraChat — read and send messages in ServiceNow Connect Chat conversations.
 *
 * Uses the ootb Connect tables (sys_cs_session / sys_cs_message) when
 * available. Gracefully no-ops if the instance does not have Connect Chat.
 *
 * Use cases for blind users:
 *   - "Read new chat messages"  -> reads aloud unread inbound messages
 *   - "Reply to last chat with X" -> posts a message to the last active session
 *   - Proactive: NetraScanner enqueues a notification when a new message arrives
 */
var NetraChat = Class.create();
NetraChat.prototype = {

    initialize: function () {
        this.user = gs.getUserID();
        this.userName = gs.getUserName();
    },

    isEnabled: function () {
        var t = new GlideRecord('sys_cs_message');
        return t.isValid();
    },

    /** Recent unread messages addressed to the current user (across sessions). */
    listUnread: function (since) {
        if (!this.isEnabled()) return { ok: false, error: 'Connect Chat is not enabled.', messages: [] };

        var sinceGdt = since ? new GlideDateTime(since) : (function () {
            var g = new GlideDateTime(); g.subtract(24 * 3600 * 1000); return g;
        })();

        var gr = new GlideRecord('sys_cs_message');
        gr.addQuery('sys_created_on', '>=', sinceGdt);
        gr.addQuery('created_by', '!=', this.userName);
        gr.orderByDesc('sys_created_on');
        gr.setLimit(50);
        gr.query();

        var out = [];
        while (gr.next()) {
            // Only include messages from sessions where the current user is a participant
            var session = String(gr.session || '');
            if (session && this._userInSession(session)) {
                out.push({
                    sys_id: String(gr.sys_id),
                    session: session,
                    author: String(gr.created_by),
                    body: this._plain(String(gr.message_text || gr.message || '')),
                    created: String(gr.sys_created_on)
                });
            }
        }
        return { ok: true, messages: out };
    },

    /** Post a message to the user's most recently active chat session. */
    replyToLast: function (text) {
        if (!this.isEnabled()) return { ok: false, error: 'Connect Chat is not enabled.' };
        if (!text || !text.trim()) return { ok: false, error: 'Reply text is empty.' };

        var session = this._mostRecentSession();
        if (!session) return { ok: false, error: 'No recent chat session to reply to.' };

        var m = new GlideRecord('sys_cs_message');
        m.initialize();
        m.session = session;
        // Field names vary by Connect version — set the most common ones
        if (m.isValidField('message_text')) m.message_text = text;
        else if (m.isValidField('message')) m.message = text;
        m.author = this.user;
        m.insert();
        return { ok: true, session: session };
    },

    // ---- helpers ----
    _mostRecentSession: function () {
        var gr = new GlideRecord('sys_cs_message');
        gr.addQuery('created_by', this.userName);
        gr.orderByDesc('sys_created_on');
        gr.setLimit(1);
        gr.query();
        return gr.next() ? String(gr.session) : null;
    },

    _userInSession: function (sessionSysId) {
        // sys_cs_session typically has 'opened_by' and a member-list table
        var s = new GlideRecord('sys_cs_session');
        if (!s.get(sessionSysId)) return false;
        if (String(s.opened_by) === this.user) return true;
        // try member table if it exists
        var members = new GlideRecord('sys_cs_session_member');
        if (!members.isValid()) return true;  // unknown - default to true
        members.addQuery('session', sessionSysId);
        members.addQuery('user', this.user);
        members.setLimit(1);
        members.query();
        return members.next();
    },

    _plain: function (s) {
        return String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    },

    type: 'NetraChat'
};
