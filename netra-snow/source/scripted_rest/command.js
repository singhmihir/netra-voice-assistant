/**
 * Scripted REST resource: POST /api/__NETRA_SCOPE__/voice/command
 *
 * Request body:
 *   {
 *     "transcript": "create a ticket for my email is down",
 *     "pending":    "ticket_description" | "pause_duration" | "resolve_number" |
 *                   "kb_query" | "chat_reply_body" | "confirm_destructive" | null
 *   }
 *
 * Response (always HTTP 200 - errors are returned in the body as ok=false
 * so the widget can speak them):
 *   {
 *     ok, intent, message, data, refresh_tickets, stop, navigate,
 *     pending, clear_pending, paused
 *   }
 */
(function process(request, response) {

    try {
        var body = (request.body && request.body.data) ? request.body.data : {};
        var transcript     = String(body.transcript || '').trim();
        var pendingContext = body.pending ? String(body.pending) : null;

        if (!transcript) {
            return {
                ok: false,
                message: 'No transcript provided. Say something or click the mic again.'
            };
        }

        var intent;
        try {
            intent = new NetraIntent().parse(transcript, pendingContext);
        } catch (eIntent) {
            gs.error('[NetraCommand] NetraIntent failed: ' + eIntent);
            return {
                ok: false,
                message: 'Intent parser is not loaded. Please paste the latest NetraIntent script.'
            };
        }

        var responder;
        try {
            responder = new NetraResponder();
        } catch (eResp) {
            gs.error('[NetraCommand] NetraResponder construct failed: ' + eResp);
            return {
                ok: false,
                message: 'Responder failed to initialise: ' + String(eResp.message || eResp)
            };
        }

        var result;
        try {
            result = responder.handle(intent);
        } catch (eHandle) {
            gs.error('[NetraCommand] handle() threw on action ' + intent.action + ': ' + eHandle);
            return {
                ok: false,
                intent: intent,
                message: 'I tried, but the ' + intent.action + ' action errored: ' + String(eHandle.message || eHandle)
            };
        }

        return {
            ok:              !!result.ok,
            intent:          intent,
            message:         result.message,
            data:            result.data || null,
            refresh_tickets: !!result.refresh_tickets,
            stop:            !!result.stop,
            navigate:        result.navigate || null,
            pending:         result.pending || null,
            clear_pending:   !!result.clear_pending,
            paused:          (typeof result.paused === 'boolean') ? result.paused : null
        };

    } catch (e) {
        gs.error('[NetraCommand] unexpected: ' + e + (e.stack ? ' | ' + String(e.stack).split('\n')[0] : ''));
        return {
            ok: false,
            message: 'Server error: ' + String(e.message || e)
        };
    }

})(request, response);
