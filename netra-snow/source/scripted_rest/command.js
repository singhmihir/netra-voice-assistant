/**
 * Scripted REST resource: POST /api/x_196061_netra/voice/command
 *
 * Request body:
 *   {
 *     "transcript": "create a ticket for my email is down",
 *     "pending":    "ticket_description" | "pause_duration" | "resolve_number" | null
 *   }
 *
 * Response:
 *   {
 *     ok, intent, message, data, refresh_tickets, stop,
 *     pending: <next pending state or null>,
 *     clear_pending: true/false,
 *     paused: true/false   (only on pause/resume actions)
 *   }
 */
(function process(request, response) {

    var body = request.body && request.body.data ? request.body.data : {};
    var transcript = String(body.transcript || '').trim();
    var pendingContext = body.pending ? String(body.pending) : null;

    if (!transcript) {
        response.setStatus(400);
        return { ok: false, message: 'No transcript provided.' };
    }

    var intent = new NetraIntent().parse(transcript, pendingContext);
    var responder = new NetraResponder();
    var result = responder.handle(intent);

    return {
        ok: !!result.ok,
        intent: intent,
        message: result.message,
        data: result.data || null,
        refresh_tickets: !!result.refresh_tickets,
        stop: !!result.stop,
        pending: result.pending || null,
        clear_pending: !!result.clear_pending,
        paused: typeof result.paused === 'boolean' ? result.paused : null
    };

})(request, response);
