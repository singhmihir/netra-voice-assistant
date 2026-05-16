/**
 * NetraContext — per-user session context.
 *
 * Lets the conversation refer to "that ticket", "resolve it", "read it again"
 * by remembering the last entity mentioned. Stored on __NETRA_SCOPE___context.
 *
 * Context is short-lived (12 hours by default) and cleared on "forget context".
 *
 * NOTE: The string __NETRA_SCOPE__ is replaced with the user's actual scope
 * (e.g. x_NNNNN_netra) by the Fix Script at install time, so this code
 * works regardless of company id.
 */
var NetraContext = Class.create();
NetraContext.prototype = {
    TABLE: '__NETRA_SCOPE___context',
    TTL_MS: 12 * 3600 * 1000,

    initialize: function () {
        this.user = gs.getUserID();
    },

    /** Set the focus to the given table+sys_id. */
    setFocus: function (table, sysId, number) {
        var gr = this._get(true);
        gr.focus_table = table;
        gr.focus_sys_id = sysId;
        gr.focus_number = number || '';
        gr.focus_set_at = new GlideDateTime();
        gr.update();
    },

    /** @returns {{table,sys_id,number}|null} */
    getFocus: function () {
        var gr = this._get(false);
        if (!gr) return null;
        if (!gr.focus_table || !gr.focus_sys_id) return null;
        var set = gr.focus_set_at;
        if (set) {
            var age = new GlideDateTime().getNumericValue() - new GlideDateTime(String(set)).getNumericValue();
            if (age > this.TTL_MS) return null;
        }
        return {
            table:  String(gr.focus_table),
            sys_id: String(gr.focus_sys_id),
            number: String(gr.focus_number || '')
        };
    },

    /** Track the last spoken sentence so the user can ask "what did you say?" */
    setLastUtterance: function (text) {
        var gr = this._get(true);
        gr.last_utterance = String(text || '').substring(0, 1000);
        gr.update();
    },

    getLastUtterance: function () {
        var gr = this._get(false);
        return gr ? String(gr.last_utterance || '') : '';
    },

    clear: function () {
        var gr = this._get(false);
        if (gr) {
            gr.focus_table = ''; gr.focus_sys_id = ''; gr.focus_number = '';
            gr.update();
        }
    },

    _get: function (createIfMissing) {
        var gr = new GlideRecord(this.TABLE);
        gr.addQuery('user', this.user);
        gr.setLimit(1);
        gr.query();
        if (gr.next()) return gr;
        if (!createIfMissing) return null;
        gr.initialize();
        gr.user = this.user;
        gr.insert();
        gr.get(gr.sys_id);
        return gr;
    },

    type: 'NetraContext'
};
