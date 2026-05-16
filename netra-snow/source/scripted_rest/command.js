/**
 * Scripted REST resource: POST /api/x_netra/voice/command
 *
 * Request body:  { "transcript": "create a ticket for my email is down" }
 *
 * Response:
 *   {
 *     "ok": true,
 *     "intent": { action, args, original },
 *     "message": "Ticket I N C zero zero ... opened.",
 *     "data": { ... },
 *     "refresh_tickets": true
 *   }
 *
 * Auth: requires authenticated user. ACLs are enforced via NetraTools because
 * every operation queries by caller_id = current user.
 */
(function process(request, response) {

    var body = request.body && request.body.data ? request.body.data : {};
    var transcript = String(body.transcript || '').trim();

    if (!transcript) {
        response.setStatus(400);
        return { ok: false, message: 'No transcript provided.' };
    }

    var intent = new NetraIntent().parse(transcript);
    var responder = new NetraResponder();
    var result = responder.handle(intent);

    return {
        ok: !!result.ok,
        intent: intent,
        message: result.message,
        data: result.data || null,
        refresh_tickets: !!result.refresh_tickets,
        stop: !!result.stop
    };

})(request, response);
