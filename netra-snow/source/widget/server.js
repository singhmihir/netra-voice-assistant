/**
 * Netra Mic widget - SERVER SCRIPT  (v5 - Gemini agent)
 *
 * Powered by Google's Gemini API with full function-calling (tool use).
 * The model decides when to call tools (create ticket, list, resolve,
 * search knowledge, etc.) and Netra carries out the action via
 * NetraTools / NetraKnowledge Script Includes, then loops the result
 * back to the model for a natural-language reply.
 *
 * Setup:
 *   System Property  x_196061_netra_v1.gemini_api_key   = <your key>
 *   System Property  x_196061_netra_v1.gemini_model     = gemini-2.5-flash  (optional)
 *
 *   Get a free Gemini API key at https://aistudio.google.com/apikey
 *
 * Protocol:
 *   input.action == 'chat'      -> input.message, input.history -> data.response
 *   input.action == 'poll'      -> data.notifications
 *   input.action == 'reset'     -> clears server-side memory (history is client-side)
 *   (initial load)              -> data.user_name, data.paused, data.has_api_key
 */
(function () {

    var SCOPE = 'x_196061_netra_v1';
    var user  = gs.getUserID();

    // ---- Always-on state ----
    data.user_name   = gs.getUserDisplayName();
    data.user_sys_id = user;
    data.error       = null;
    data.has_api_key = !!gs.getProperty(SCOPE + '.gemini_api_key');

    _ensurePref();
    _setPauseState();

    var action = (input && input.action) ? String(input.action) : null;

    if (action === 'chat') {
        try {
            data.response = _chat(
                String((input && input.message) || '').trim(),
                (input && Array.isArray(input.history)) ? input.history : []
            );
        } catch (e) {
            gs.error('[NetraGemini] chat outer error: ' + e);
            data.response = { ok: false, message: 'Sorry, I hit a server error: ' + String(e.message || e) };
        }
    } else if (action === 'poll') {
        try {
            if (data.paused) {
                data.notifications = [];
            } else {
                var gr = new GlideRecord(SCOPE + '_notification');
                gr.addQuery('user', user);
                gr.addQuery('delivered', false);
                gr.orderBy('sys_created_on');
                gr.setLimit(10);
                gr.query();
                var out = [];
                while (gr.next()) {
                    out.push({
                        id: String(gr.sys_id),
                        message: String(gr.message),
                        kind: String(gr.kind),
                        ticket_number: String(gr.ticket_number)
                    });
                    gr.delivered = true;
                    gr.delivered_at = new GlideDateTime();
                    gr.update();
                }
                data.notifications = out;
            }
        } catch (eP) {
            gs.error('[NetraGemini] poll: ' + eP);
            data.notifications = [];
        }
    }

    /* ===================================================================
     *  Gemini chat with tool use
     * =================================================================== */
    function _chat(userMessage, history) {
        if (!userMessage) {
            return { ok: false, message: 'I did not catch that. Kindly say it again.' };
        }
        var apiKey = gs.getProperty(SCOPE + '.gemini_api_key');
        if (!apiKey) {
            return {
                ok: false,
                message: 'My AI key has not been configured yet. Kindly set the system property ' +
                         SCOPE + '.gemini_api_key with your Gemini API key from Google AI Studio.'
            };
        }
        var model = gs.getProperty(SCOPE + '.gemini_model', 'gemini-2.5-flash');

        // Build conversation history for Gemini
        var contents = [];
        if (Array.isArray(history)) {
            for (var i = 0; i < history.length; i++) {
                var h = history[i];
                if (h && h.role && h.parts) contents.push(h);
            }
        }
        contents.push({ role: 'user', parts: [{ text: userMessage }] });

        var systemInstruction = _systemPrompt();
        var tools = _toolDeclarations();

        // Tool-use loop (max 5 iterations to prevent runaway)
        for (var iter = 0; iter < 5; iter++) {
            var resp = _callGemini(apiKey, model, contents, tools, systemInstruction);
            if (resp.error) {
                gs.error('[NetraGemini] API error: ' + resp.error);
                return { ok: false, message: 'I could not reach the AI service. ' + resp.error };
            }

            var candidate = (resp.candidates && resp.candidates[0]) || null;
            if (!candidate || !candidate.content || !candidate.content.parts) {
                return { ok: false, message: 'I got an empty response. Kindly try again.' };
            }

            var parts = candidate.content.parts;
            var functionCalls = [];
            var textChunks = [];
            for (var p = 0; p < parts.length; p++) {
                if (parts[p].functionCall) functionCalls.push(parts[p].functionCall);
                if (parts[p].text) textChunks.push(parts[p].text);
            }

            // If the model called a tool, execute it and loop
            if (functionCalls.length) {
                // Add the model's turn (with the function call) to contents
                contents.push({ role: 'model', parts: parts });

                // Execute each function call and append responses
                var responseParts = [];
                for (var f = 0; f < functionCalls.length; f++) {
                    var fc = functionCalls[f];
                    var result = _runTool(fc.name, fc.args || {});
                    gs.info('[NetraGemini] tool ' + fc.name + ' -> ' + JSON.stringify(result).substring(0, 200));
                    responseParts.push({
                        functionResponse: {
                            name: fc.name,
                            response: { result: result }
                        }
                    });
                }
                contents.push({ role: 'user', parts: responseParts });
                continue;
            }

            // Final natural-language reply
            var finalText = textChunks.join(' ').trim() || 'Done.';

            // Persist last spoken utterance into the context table (best-effort)
            try {
                var ctx = new NetraContext();
                ctx.setLastUtterance(finalText);
            } catch (eC) {}

            // Re-read pause state in case a tool toggled it
            _setPauseState();

            // Append the final model turn to contents so client history is complete
            contents.push({ role: 'model', parts: [{ text: finalText }] });

            return {
                ok: true,
                message: finalText,
                history: contents,
                paused: data.paused
            };
        }

        return { ok: false, message: 'I am thinking too much, kindly try again with a simpler request.' };
    }

    /* ===================================================================
     *  HTTP call to Google's Gemini API via sn_ws.RESTMessageV2
     * =================================================================== */
    function _callGemini(apiKey, model, contents, tools, systemInstruction) {
        var url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
                  encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(apiKey);
        var body = {
            contents: contents,
            tools: tools,
            systemInstruction: systemInstruction,
            generationConfig: {
                temperature: 0.7,
                maxOutputTokens: 1024,
                topP: 0.95
            }
        };
        try {
            var rm = new sn_ws.RESTMessageV2();
            rm.setEndpoint(url);
            rm.setHttpMethod('POST');
            rm.setRequestHeader('Content-Type', 'application/json');
            rm.setRequestBody(JSON.stringify(body));
            rm.setHttpTimeout(30000);
            var r = rm.execute();
            var code = r.getStatusCode();
            var rb = r.getBody();
            if (code !== 200) {
                return { error: 'HTTP ' + code + ': ' + String(rb || '').substring(0, 400) };
            }
            return JSON.parse(rb);
        } catch (e) {
            return { error: 'Could not call Gemini: ' + String(e.message || e) };
        }
    }

    /* ===================================================================
     *  System prompt - Indian English persona
     * =================================================================== */
    function _systemPrompt() {
        return {
            parts: [{
                text:
'You are Netra, a female voice assistant for ServiceNow, designed specifically for blind and visually-impaired users.\n' +
'You are speaking with ' + gs.getUserDisplayName() + '.\n' +
'\n' +
'CRITICAL - ACCESSIBILITY CONTEXT:\n' +
'- The user is BLIND. They cannot see anything on the screen.\n' +
'- Everything happens via voice. There is no chat panel, no buttons to click, no text to read.\n' +
'- Never reference visual elements ("click here", "see the screen", "look at the list", "as shown").\n' +
'- Confirm every action verbally and completely. Do not assume the user can verify on screen.\n' +
'- Speak the entire result, do not say things like "the list is shown above".\n' +
'\n' +
'VOICE & LANGUAGE STYLE - critical:\n' +
'- You speak in INDIAN ENGLISH with a warm, professional, female tone.\n' +
'- Use natural Indian English idioms: "kindly", "do let me know", "shall I", "I have done the needful",\n' +
'  "what is the status of", "as per your request", "I will revert back", "right away", "no issues".\n' +
'- Keep replies SHORT (one to three sentences). You are speaking aloud, not writing.\n' +
'- Use commas for natural breath pauses. NEVER use markdown, asterisks, code blocks, or bullet points.\n' +
'- Pronounce ticket numbers letter-by-digit so they are clear when spoken:\n' +
'  "I N C zero zero zero one two three four" for INC0001234.\n' +
'- Pronounce dates and numbers in spoken form, not abbreviated.\n' +
'- Do NOT over-greet. Start replies naturally - "Right, INC..." or "I have opened..." rather than "Hello!".\n' +
'- End every reply with a clear stop. Do not trail off. Do not say "is there anything else?" every time.\n' +
'\n' +
'YOUR ROLE:\n' +
'A sighted helper logged this blind user into ServiceNow. From here onward, the user runs their entire\n' +
'workflow through you, by voice. They will ask you to open tickets, update them, resolve them,\n' +
'check approvals, search knowledge. Be patient, be clear, be brief.\n' +
'\n' +
'YOUR CAPABILITIES (use tools - do not describe):\n' +
'- create_ticket - open a new incident\n' +
'- list_tickets - list the users open incidents\n' +
'- resolve_ticket - mark an incident resolved\n' +
'- update_ticket - add a comment to an incident\n' +
'- get_ticket_status - read state of an incident\n' +
'- search_knowledge - search the knowledge base\n' +
'- list_approvals - list pending approvals\n' +
'- decide_approval - approve or reject a pending approval\n' +
'- pause_notifications - silence proactive alerts for N hours\n' +
'- resume_notifications - turn notifications back on\n' +
'\n' +
'BEHAVIOUR:\n' +
'- When the user wants something done, CALL THE TOOL - do not just describe what it would do.\n' +
'- If the request is vague, ask ONE short clarifying question.\n' +
'- After a tool runs, confirm what happened in one sentence, with the ticket number spoken letter-by-digit.\n' +
'- For greetings / small talk, reply briefly and warmly. Do not always call a tool.\n' +
'- If a tool returns ok=false, apologise briefly and explain plainly. Do not retry silently.\n' +
'- For "list" results, read the FIRST two or three items aloud and offer to continue ("Shall I read more?").\n' +
'- Never reveal API keys, internal sys_ids, or technical jargon to the user.'
            }]
        };
    }

    /* ===================================================================
     *  Tool declarations passed to Gemini
     * =================================================================== */
    function _toolDeclarations() {
        return [{
            functionDeclarations: [
                {
                    name: 'create_ticket',
                    description: 'Open a new ServiceNow incident on behalf of the user. Use when the user reports an issue.',
                    parameters: {
                        type: 'object',
                        properties: {
                            short_description: { type: 'string', description: 'One-line plain-language summary of the issue.' },
                            urgency: { type: 'string', enum: ['1','2','3'], description: '1 high, 2 medium, 3 low. Default 3.' }
                        },
                        required: ['short_description']
                    }
                },
                {
                    name: 'list_tickets',
                    description: 'List the users open incidents (not closed).',
                    parameters: { type: 'object', properties: {} }
                },
                {
                    name: 'resolve_ticket',
                    description: 'Mark a specific incident as resolved.',
                    parameters: {
                        type: 'object',
                        properties: {
                            ticket_number: { type: 'string', description: 'e.g. INC0001234' },
                            close_notes: { type: 'string', description: 'What was done to resolve it. Optional.' }
                        },
                        required: ['ticket_number']
                    }
                },
                {
                    name: 'update_ticket',
                    description: 'Add a comment / note to an existing incident.',
                    parameters: {
                        type: 'object',
                        properties: {
                            ticket_number: { type: 'string' },
                            comment: { type: 'string' }
                        },
                        required: ['ticket_number','comment']
                    }
                },
                {
                    name: 'get_ticket_status',
                    description: 'Read back the current state, priority, assignee of a specific incident.',
                    parameters: {
                        type: 'object',
                        properties: { ticket_number: { type: 'string' } },
                        required: ['ticket_number']
                    }
                },
                {
                    name: 'search_knowledge',
                    description: 'Search published knowledge base articles by keyword.',
                    parameters: {
                        type: 'object',
                        properties: { query: { type: 'string' } },
                        required: ['query']
                    }
                },
                {
                    name: 'list_approvals',
                    description: 'List approvals waiting on the user.',
                    parameters: { type: 'object', properties: {} }
                },
                {
                    name: 'decide_approval',
                    description: 'Approve or reject a specific pending approval by its source record number.',
                    parameters: {
                        type: 'object',
                        properties: {
                            ref_number: { type: 'string', description: 'e.g. CHG0001234 or RITM0001234' },
                            decision:   { type: 'string', enum: ['approve','reject'] }
                        },
                        required: ['ref_number','decision']
                    }
                },
                {
                    name: 'pause_notifications',
                    description: 'Pause proactive notifications for a given number of hours.',
                    parameters: {
                        type: 'object',
                        properties: { hours: { type: 'number' } },
                        required: ['hours']
                    }
                },
                {
                    name: 'resume_notifications',
                    description: 'Turn notifications back on.',
                    parameters: { type: 'object', properties: {} }
                }
            ]
        }];
    }

    /* ===================================================================
     *  Tool dispatch
     * =================================================================== */
    function _runTool(name, args) {
        try {
            var tools = new NetraTools();
            switch (name) {
                case 'create_ticket':
                    return tools.createTicket(String(args.short_description || ''), String(args.urgency || '3'));
                case 'list_tickets':
                    return tools.listMyTickets(8);
                case 'resolve_ticket':
                    return tools.resolveTicket(_normNum(args.ticket_number), args.close_notes || '');
                case 'update_ticket':
                    return tools.updateTicket(_normNum(args.ticket_number), String(args.comment || ''));
                case 'get_ticket_status':
                    return tools.getStatus(_normNum(args.ticket_number));
                case 'search_knowledge':
                    return new NetraKnowledge().search(String(args.query || ''), 4);
                case 'list_approvals':
                    return tools.listPendingApprovals();
                case 'decide_approval':
                    return tools.decideApproval(_normNum(args.ref_number), String(args.decision) === 'approve');
                case 'pause_notifications':
                    return tools.pauseNotifications(Number(args.hours) || 1);
                case 'resume_notifications':
                    return tools.resumeNotifications();
                default:
                    return { ok: false, error: 'Unknown tool: ' + name };
            }
        } catch (e) {
            gs.error('[NetraGemini] tool ' + name + ' threw: ' + e);
            return { ok: false, error: String(e.message || e) };
        }
    }

    function _normNum(s) {
        if (!s) return '';
        var t = String(s).toUpperCase().replace(/\s+/g, '');
        var m = t.match(/^([A-Z]+)(\d+)$/);
        if (!m) return t;
        var prefix = m[1], digits = m[2];
        while (digits.length < 7) digits = '0' + digits;
        return prefix + digits;
    }

    /* ===================================================================
     *  Pref / pause helpers
     * =================================================================== */
    function _ensurePref() {
        var pref = new GlideRecord(SCOPE + '_user_pref');
        pref.addQuery('user', user);
        pref.setLimit(1);
        pref.query();
        if (!pref.next()) {
            pref.initialize();
            pref.user = user;
            pref.active = true;
            pref.watch_assignments = true;
            pref.watch_comments    = true;
            pref.watch_approvals   = true;
            pref.insert();
        }
        return pref;
    }

    function _setPauseState() {
        data.paused = false;
        data.paused_until = '';
        var pref = new GlideRecord(SCOPE + '_user_pref');
        pref.addQuery('user', user);
        pref.setLimit(1);
        pref.query();
        if (pref.next() && pref.paused_until && String(pref.paused_until) !== '') {
            var nowGdt = new GlideDateTime();
            if (new GlideDateTime(String(pref.paused_until)).compareTo(nowGdt) > 0) {
                data.paused = true;
                data.paused_until = String(pref.paused_until);
            }
        }
    }

})();
