/**
 * Service Portal widget server script - netra-mic (v4 - self-contained)
 *
 * Replaces ALL Scripted REST calls. The widget client uses
 * c.server.update() to invoke this script, which keeps every server-side
 * operation inside the same widget + same scope.
 *
 * Protocol:
 *   Initial load (no input.action):
 *     data.user_name, data.user_sys_id, data.paused, data.paused_until
 *
 *   input.action == 'command':
 *     reads input.transcript and input.pending
 *     sets data.response = { ok, intent, message, ...same as old REST shape }
 *
 *   input.action == 'poll':
 *     sets data.notifications = [ {id, ticket_number, message, kind, ...} ]
 *     (consumed = marked delivered as we read them, unless paused)
 *
 *   input.action == 'refresh':
 *     just re-reads pause state (used after a pause/resume command)
 *
 * Every action is wrapped in try/catch and sets data.error on failure so
 * the client can speak the real error.
 */
(function () {

    var SCOPE = 'x_196061_netra_v1';
    var user  = gs.getUserID();

    // ------------------------------------------------------------
    // Always populate state for every render / update
    // ------------------------------------------------------------
    data.user_name    = gs.getUserDisplayName();
    data.user_sys_id  = user;
    data.error        = null;

    // Make sure a user_pref row exists
    var pref = new GlideRecord(SCOPE + '_user_pref');
    pref.addQuery('user', user);
    pref.setLimit(1);
    pref.query();
    if (!pref.next()) {
        pref.initialize();
        pref.user              = user;
        pref.active            = true;
        pref.watch_assignments = true;
        pref.watch_comments    = true;
        pref.watch_approvals   = true;
        pref.insert();
        pref.get(pref.sys_id);
    }

    // Pause window
    data.paused       = false;
    data.paused_until = '';
    if (pref.paused_until && String(pref.paused_until) !== '') {
        var nowGdt = new GlideDateTime();
        if (new GlideDateTime(String(pref.paused_until)).compareTo(nowGdt) > 0) {
            data.paused       = true;
            data.paused_until = String(pref.paused_until);
        }
    }

    // ------------------------------------------------------------
    // Dispatch on input.action
    // ------------------------------------------------------------
    var action = (input && input.action) ? String(input.action) : null;

    if (action === 'command') {
        _handleCommand();
    } else if (action === 'poll') {
        _handlePoll();
    } else if (action === 'refresh') {
        // Nothing more needed - state is already populated above
    }

    // ------------------------------------------------------------
    function _handleCommand() {
        try {
            var transcript = String((input && input.transcript) || '').trim();
            var pending    = (input && input.pending) ? String(input.pending) : null;

            if (!transcript) {
                data.response = { ok: false, message: 'No transcript provided.' };
                return;
            }

            // Build intent
            var intent;
            try {
                intent = new NetraIntent().parse(transcript, pending);
            } catch (eI) {
                gs.error('[NetraWidget] NetraIntent failed: ' + eI);
                data.response = { ok: false, message: 'Intent parser not loaded. Re-paste NetraIntent script.' };
                return;
            }

            // Build responder
            var responder;
            try {
                responder = new NetraResponder();
            } catch (eR) {
                gs.error('[NetraWidget] NetraResponder init failed: ' + eR);
                data.response = { ok: false, message: 'Responder init failed: ' + String(eR.message || eR) };
                return;
            }

            // Handle the intent
            var result;
            try {
                result = responder.handle(intent);
            } catch (eH) {
                gs.error('[NetraWidget] handle(' + intent.action + ') failed: ' + eH);
                data.response = {
                    ok: false,
                    intent: intent,
                    message: 'Handler error on ' + intent.action + ': ' + String(eH.message || eH)
                };
                return;
            }

            // Re-read pause state since this command may have changed it
            pref.get(pref.sys_id);
            if (pref.paused_until && String(pref.paused_until) !== '') {
                var nGdt = new GlideDateTime();
                if (new GlideDateTime(String(pref.paused_until)).compareTo(nGdt) > 0) {
                    data.paused       = true;
                    data.paused_until = String(pref.paused_until);
                } else {
                    data.paused       = false;
                    data.paused_until = '';
                }
            } else {
                data.paused       = false;
                data.paused_until = '';
            }

            data.response = {
                ok:              !!result.ok,
                intent:          intent,
                message:         result.message,
                data:            result.data || null,
                refresh_tickets: !!result.refresh_tickets,
                stop:            !!result.stop,
                navigate:        result.navigate || null,
                pending:         result.pending || null,
                clear_pending:   !!result.clear_pending,
                paused:          data.paused
            };

        } catch (e) {
            gs.error('[NetraWidget] command outer error: ' + e);
            data.response = { ok: false, message: 'Server error: ' + String(e.message || e) };
        }
    }

    // ------------------------------------------------------------
    function _handlePoll() {
        try {
            if (data.paused) {
                data.notifications = [];
                return;
            }
            var gr = new GlideRecord(SCOPE + '_notification');
            gr.addQuery('user', user);
            gr.addQuery('delivered', false);
            gr.orderBy('sys_created_on');
            gr.setLimit(10);
            gr.query();

            var out = [];
            while (gr.next()) {
                out.push({
                    id:             String(gr.sys_id),
                    ticket_number:  String(gr.ticket_number),
                    ticket_sys_id:  String(gr.ticket_sys_id),
                    message:        String(gr.message),
                    kind:           String(gr.kind),
                    created:        String(gr.sys_created_on)
                });
                gr.delivered    = true;
                gr.delivered_at = new GlideDateTime();
                gr.update();
            }
            data.notifications = out;

        } catch (e) {
            gs.error('[NetraWidget] poll error: ' + e);
            data.notifications = [];
            data.error = String(e.message || e);
        }
    }

})();
