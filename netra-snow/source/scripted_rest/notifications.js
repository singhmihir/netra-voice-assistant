/**
 * Scripted REST resource: GET /api/x_netra/voice/notifications
 *
 * Returns and CONSUMES (marks delivered) any pending Netra notifications
 * for the current user. The widget polls this every ~10 seconds.
 *
 * Response: { ok: true, notifications: [ { id, ticket_number, ticket_sys_id, message, kind, created } ] }
 */
(function process(request, response) {

    var user = gs.getUserID();

    var gr = new GlideRecord('x_netra_notification');
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

    return { ok: true, notifications: out };

})(request, response);
