/**
 * Scripted REST resource: GET /api/x_196061_netra/voice/notifications
 *
 * Returns and CONSUMES (marks delivered) any pending Netra notifications
 * for the current user — UNLESS the user has paused notifications, in
 * which case it returns an empty list (but does NOT consume).
 *
 * Response:
 *   {
 *     ok, paused, paused_until,
 *     notifications: [ { id, ticket_number, ticket_sys_id, message, kind, created } ]
 *   }
 */
(function process(request, response) {

    var user = gs.getUserID();

    // Check pause state
    var pref = new GlideRecord('x_196061_netra_user_pref');
    pref.addQuery('user', user);
    pref.setLimit(1);
    pref.query();
    var paused = false;
    var pausedUntil = null;
    if (pref.next()) {
        var pu = pref.paused_until;
        if (pu && String(pu) !== '') {
            var now = new GlideDateTime();
            if (new GlideDateTime(String(pu)).compareTo(now) > 0) {
                paused = true;
                pausedUntil = String(pu);
            } else {
                // Pause window expired — clear it
                pref.paused_until = '';
                pref.update();
            }
        }
    }

    if (paused) {
        return { ok: true, paused: true, paused_until: pausedUntil, notifications: [] };
    }

    var gr = new GlideRecord('x_196061_netra_notification');
    gr.addQuery('user', user);
    gr.addQuery('delivered', false);
    gr.orderBy('sys_created_on');
    gr.setLimit(10);
    gr.query();

    var out = [];
    while (gr.next()) {
        out.push({
            id: String(gr.sys_id),
            ticket_number: String(gr.ticket_number),
            ticket_sys_id: String(gr.ticket_sys_id),
            message: String(gr.message),
            kind: String(gr.kind),
            created: String(gr.sys_created_on)
        });
        gr.delivered = true;
        gr.delivered_at = new GlideDateTime();
        gr.update();
    }

    return { ok: true, paused: false, paused_until: null, notifications: out };

})(request, response);
