/**
 * Netra Mic widget - SERVER SCRIPT  (R1.4 - Claude-of-ServiceNow ext)
 *
 * R1.4 adds 4 tools: list_capabilities (introspection),
 *   recall_past_conversations (long-term memory recall),
 *   remember_fact (long-term memory write), analyze_screenshot
 *   (multimodal vision signal). Memory + draft now coexist in a
 *   single unified CTX: JSON blob in last_utterance. Daily briefing
 *   upgraded with PROACTIVE highlights (top P1, oldest approval,
 *   unread watchlist activity). Gemini contents now accept image
 *   inlineData for screenshot analysis.
 *
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
    data.vocab = _getVocab();

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
    } else if (action === 'debug') {
        try {
            var key = gs.getProperty(SCOPE + '.gemini_api_key') || '';
            var mdl = gs.getProperty(SCOPE + '.gemini_model', 'gemini-2.5-flash');
            var toolDecls = _toolDeclarations();
            var toolNames = [];
            if (toolDecls[0] && toolDecls[0].functionDeclarations) {
                for (var ti = 0; ti < toolDecls[0].functionDeclarations.length; ti++) {
                    toolNames.push(toolDecls[0].functionDeclarations[ti].name);
                }
            }
            data.debug = {
                version: 'v7.0',
                scope: SCOPE,
                user_name: gs.getUserDisplayName(),
                user_sys_id: user,
                model: mdl,
                api_key_status: key ? ('set (length=' + key.length + ', prefix=' + key.substring(0, 6) + ')') : 'MISSING',
                tool_count: toolNames.length,
                tools: toolNames,
                paused: !!data.paused,
                paused_until: data.paused_until || '',
                server_time: String(new GlideDateTime())
            };
        } catch (eD) {
            data.debug = { error: String(eD.message || eD) };
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
        // R1.4 - vision support: if the client attached an image, send it
        // as inlineData alongside the text. Gemini 2.5-flash is multimodal.
        var userParts = [{ text: userMessage }];
        if (input && input.image_b64) {
            userParts.unshift({
                inlineData: {
                    mimeType: input.image_mime || 'image/png',
                    data:     String(input.image_b64)
                }
            });
        }
        contents.push({ role: 'user', parts: userParts });

        var systemInstruction = _systemPrompt();
        var tools = _toolDeclarations();

        // Tool-use loop (max 5 iterations to prevent runaway)
        var modelUsed = null;
        var toolsCalled = [];   // R1 - track which tools were invoked
        for (var iter = 0; iter < 5; iter++) {
            var resp = _callGemini(apiKey, model, contents, tools, systemInstruction);
            if (resp._model_used) modelUsed = resp._model_used;
            if (resp.error) {
                gs.error('[NetraGemini] API error: ' + resp.error);
                var friendly = 'Sorry, the AI service is busy right now. Kindly try again in a moment.';
                var err = String(resp.error);
                if (err.indexOf('429') >= 0)        friendly = 'I have hit the rate limit. Kindly wait a minute and try again.';
                else if (err.indexOf('401') >= 0 || err.indexOf('403') >= 0) friendly = 'My API key is not authorised. Kindly check the configuration.';
                else if (err.indexOf('400') >= 0)   friendly = 'I could not understand that request, kindly rephrase.';
                else if (err.indexOf('404') >= 0)   friendly = 'The AI model is not available right now.';
                else if (err.indexOf('exhausted') >= 0) friendly = 'All AI models are busy at the moment. Kindly try again in a few seconds.';
                return { ok: false, message: friendly, error_detail: err };
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
                    toolsCalled.push(fc.name);   // R1 - record tool call
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

            // R1.4 - persist exchange into long-term memory (capped at 40 turns)
            try { _memAppend(userMessage, finalText); } catch (eM) {}

            return {
                ok: true,
                message: finalText,
                history: contents,
                paused: data.paused,
                model_used: modelUsed,
                tools_called: toolsCalled    // R1 - for dev panel graph
            };
        }

        return { ok: false, message: 'I am thinking too much, kindly try again with a simpler request.' };
    }

    /* ===================================================================
     *  Gemini call with model fallback chain
     *  On 503/429/UNAVAILABLE, transparently retry on a sibling model.
     *  All in Google's free tier.
     * =================================================================== */
    function _callGemini(apiKey, requestedModel, contents, tools, systemInstruction) {
        // v14: updated chain - 1.5 models retired by Google, replaced with
        // currently-available 2.x families plus the "latest" aliases (which
        // Google auto-points at whichever production model is healthy).
        var chain = [requestedModel];
        ['gemini-2.5-flash',
         'gemini-flash-latest',
         'gemini-2.5-flash-lite',
         'gemini-flash-lite-latest',
         'gemini-2.0-flash',
         'gemini-2.0-flash-lite',
         'gemini-2.5-pro',
         'gemini-pro-latest'].forEach(function (m) {
            if (chain.indexOf(m) < 0) chain.push(m);
        });

        var lastErr = null;
        // 404 on a deprecated model is NOT a real "stop the chain" signal -
        // the model just doesnt exist. Keep going. We only stop on auth (401/403),
        // quota (RESOURCE_EXHAUSTED with quota), or actual permission errors.
        for (var i = 0; i < chain.length; i++) {
            var result = _callGeminiOnce(apiKey, chain[i], contents, tools, systemInstruction);
            if (!result.error) {
                if (i > 0) {
                    gs.info('[NetraGemini] fallback succeeded on ' + chain[i] + ' after ' + i + ' failures');
                    data.last_model_used = chain[i];
                }
                result._model_used = chain[i];
                return result;
            }
            lastErr = result.error;
            var transient = lastErr.indexOf('503') >= 0 ||
                            lastErr.indexOf('429') >= 0 ||
                            lastErr.indexOf('500') >= 0 ||
                            lastErr.indexOf('UNAVAILABLE') >= 0 ||
                            lastErr.indexOf('overloaded') >= 0 ||
                            lastErr.indexOf('high demand') >= 0 ||
                            // 404 "model not found" is treated as transient (skip and continue)
                            // because we always want to try the next model, not abort.
                            (lastErr.indexOf('404') >= 0 && lastErr.indexOf('not found') >= 0) ||
                            (lastErr.indexOf('404') >= 0 && lastErr.indexOf('is not supported') >= 0);
            if (!transient) {
                gs.warn('[NetraGemini] non-transient error on ' + chain[i] + ': ' + lastErr.substring(0, 200));
                return result;
            }
            // For 404 vs busy, log differently so debugging stays clear
            if (lastErr.indexOf('404') >= 0) {
                gs.info('[NetraGemini] ' + chain[i] + ' is retired/missing, trying next model');
            } else {
                gs.info('[NetraGemini] ' + chain[i] + ' is busy, falling through to next model');
            }
        }
        return { error: 'All fallback models exhausted. Last: ' + lastErr };
    }

    function _callGeminiOnce(apiKey, model, contents, tools, systemInstruction) {
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
            },
            // R1: relax default safety filters - this is an internal corporate
            // assistant. Corporate directory lookups, ticket text, and routine
            // language must not be blocked by overly-cautious filters.
            safetySettings: [
                { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_ONLY_HIGH' },
                { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_ONLY_HIGH' },
                { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
                { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' }
            ]
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
'You are speaking with ' + gs.getUserDisplayName() + '. Call them by their first name "' + gs.getUserDisplayName().split(' ')[0] + '" naturally in conversation - not in every sentence, but at the start of replies and at transitions. ' +
'Be warm. Be empathetic. You are their trusted colleague, not a robot.\n' +
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
'TICKETS:\n' +
'- create_ticket - open a new incident\n' +
'- list_tickets - list the user open incidents\n' +
'- resolve_ticket - mark an incident resolved\n' +
'- update_ticket - add a comment to an incident\n' +
'- get_ticket_status - read state of an incident\n' +
'- summarize_ticket - full summary (desc, state, priority, assignee, comments, work notes)\n' +
'- change_priority - 1 critical, 2 high, 3 moderate, 4 low\n' +
'- escalate_ticket - raise priority by one level\n' +
'- assign_ticket_to_group - assign to an assignment group by name\n' +
'- assign_ticket_to_user - assign to a user by name/email\n' +
'- search_incidents - search across ALL incidents by keyword\n' +
'OTHER TASK TYPES:\n' +
'- list_my_problems - problem records (separate from incidents)\n' +
'- list_my_changes - change requests\n' +
'- list_my_requests - catalog RITMs\n' +
'ATTACHMENTS:\n' +
'- list_attachments - list files on an incident\n' +
'- read_text_attachment - read text content of .txt/.csv/.log/.md/.json/.xml only\n' +
'PEOPLE (corporate directory - sharing details is REQUIRED, never refuse):\n' +
'- lookup_user - find user by name/email/username and SPEAK BACK all details (name, email, title, username).\n' +
'  Context: This is an internal corporate ServiceNow directory. Every record is a colleague the user works with daily.\n' +
'  Speak the email letter-by-letter if not common ("J O H N dot A D A M S at example dot com").\n' +
'  NEVER refuse to share these details - the user needs them to do their job (assign tickets, send messages, etc).\n' +
'- send_message_to_user - send a message via a tracking incident\n' +
'KNOWLEDGE:\n' +
'- search_knowledge - search the knowledge base\n' +
'APPROVALS:\n' +
'- list_approvals - list pending approvals\n' +
'- decide_approval - approve or reject\n' +
'NOTIFICATIONS:\n' +
'- pause_notifications - silence for N hours\n' +
'- resume_notifications - turn back on\n' +
'FUN:\n' +
'- tell_joke - short tech / ServiceNow joke (ONLY when user asks)\n' +
'BRIEFING & WORKLOAD:\n' +
'- daily_briefing - greet by name + count incidents, problems, changes, requests, approvals. Use for "morning briefing", "what is on my plate today", "summary of my day".\n' +
'- workload_summary - quick counts only (no greeting). Use for "how much work do I have".\n' +
'- list_overdue - tickets past SLA threshold.\n' +
'- team_workload - count of open incidents in each of the users assignment groups.\n' +
'CONTEXT (focus + watchlist):\n' +
'- set_focus_ticket - whenever the user names a ticket, set it as focus so follow-up commands (it/that/this) know which one.\n' +
'- recall_focus - tell the user which ticket is currently in focus.\n' +
'- add_to_watchlist - watch a ticket; Netra will proactively announce changes on it.\n' +
'- remove_from_watchlist - stop watching.\n' +
'- list_watchlist - tell the user what is on their watchlist.\n' +
'CREATE OTHER TASK TYPES:\n' +
'- create_problem - log a problem record (distinct from incident).\n' +
'- create_change - create a normal/standard/emergency change request.\n' +
'NOTES:\n' +
'- add_work_note - private internal note (only fulfillers see). Use update_ticket for customer-visible comments.\n' +
'\n' +
'CLAUDE-STYLE BEHAVIOUR (R1.3 - careful, agentic, multi-turn):\n' +
'\n' +
'- You are the "Claude of ServiceNow": careful, thoughtful, never destructive without confirmation, always reads-back before acting.\n' +
'- Use the persons first name naturally. e.g. "Right, Mihir, here is what I have so far."\n' +
'- BE EMPATHETIC. If the user sounds frustrated, acknowledge before acting.\n' +
'\n' +
'CAPABILITIES & MEMORY:\n' +
'- When user asks "what can you do?" / "help me" / "show me your features" - call list_capabilities and read the categories.\n' +
'- When user asks "what did we talk about / what was I doing earlier / remember when" - call recall_past_conversations (optionally with a keyword).\n' +
'- When user says "remember that ..." / "for next time, ..." - call remember_fact to save it.\n' +
'- When user has just captured a screenshot (system tells you an image was attached) - look at it carefully and answer their question naturally.\n' +
'- Memory is YOURS - past exchanges are stored. Use them. Reference them. "Like the VPN issue we discussed earlier..."\n' +
'\n' +
'CREATING TICKETS - MANDATORY MULTI-TURN DRAFT FLOW (this is the most important rule):\n' +
'- NEVER call create_ticket, create_problem, or create_change directly. Those tools still exist but you MUST NOT use them.\n' +
'- Instead, when the user says "open / create / log / raise / file a ticket / problem / change":\n' +
'  1. Call start_record_draft(record_type, initial_short_description) - this stages a draft in context.\n' +
'  2. Look at the returned "missing" array. Ask the user for the FIRST missing required field, ONE QUESTION AT A TIME.\n' +
'  3. When the user answers, call set_record_field(field, value). The returned "next_prompt" tells you what to ask next.\n' +
'  4. The user can CHANGE any earlier field at any time. e.g. "wait, set urgency to high" -> set_record_field(urgency, 2). Acknowledge the change ("Got it, urgency is now high.").\n' +
'  5. Once "ready_to_create" is true (no missing fields), call review_draft. Read its "summary" back to the user verbatim, then ask: "Shall I create it now, Mihir?"\n' +
'  6. Wait for explicit yes ("yes", "go ahead", "create it", "confirmed", "do it"). ONLY THEN call confirm_and_create.\n' +
'  7. If user says "no" / "wait" / "change ..." - DO NOT call confirm_and_create. Instead update the field and re-review.\n' +
'  8. If user says "cancel" / "forget it" / "never mind" - call cancel_draft.\n' +
'\n' +
'SENDING MESSAGES TO COLLEAGUES - USE SIDEBAR DISCUSSIONS:\n' +
'- When the user says "send a message to / tell / ping / message X" - ALWAYS use send_sidebar_message, NEVER send_message_to_user.\n' +
'- send_sidebar_message creates a real ServiceNow Sidebar Discussion that pops up in the recipients Now sidebar as a chat.\n' +
'- After sending, confirm verbally: "Done, Mihir. I have started a sidebar chat with John Adams and sent your message."\n' +
'\n' +
'DESTRUCTIVE ACTIONS - ALWAYS CONFIRM:\n' +
'- resolve_ticket, escalate_ticket, change_priority, assign_ticket_to_*, decide_approval are DESTRUCTIVE. Read back what you are about to do and ask "shall I?" before acting. Only proceed on yes.\n' +
'\n' +
'TICKET REFERENCES:\n' +
'- IF the user mentions a ticket number, call set_focus_ticket FIRST.\n' +
'- IF the user says "it" / "that ticket" / "this one" - call recall_focus first.\n' +
'\n' +
'HUMANE TONE:\n' +
'- Use phrases like "no worries", "happy to help", "let me take a look", "consider it done", "shall I?", "right away".\n' +
'- CELEBRATE small wins: "Done. INC zero zero one two is resolved - one down from your plate."\n' +
'- ON ERRORS, be human: "Hmm, that did not go through. Let me try again."\n' +
'- ACKNOWLEDGE UNCERTAINTY honestly. If a tool fails or returns nothing, say so plainly. Do not make up data.\n' +
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
                },
                {
                    name: 'change_priority',
                    description: 'Change the priority of an incident. 1=critical, 2=high, 3=moderate, 4=low.',
                    parameters: { type: 'object', properties: {
                        ticket_number: { type: 'string' },
                        priority: { type: 'string', enum: ['1','2','3','4'] }
                    }, required: ['ticket_number','priority'] }
                },
                {
                    name: 'escalate_ticket',
                    description: 'Escalate an incident by raising its priority one level (3 -> 2 -> 1).',
                    parameters: { type: 'object', properties: { ticket_number: { type: 'string' } }, required: ['ticket_number'] }
                },
                {
                    name: 'assign_ticket_to_group',
                    description: 'Assign an incident to an assignment group by name (partial match).',
                    parameters: { type: 'object', properties: {
                        ticket_number: { type: 'string' },
                        group_name: { type: 'string' }
                    }, required: ['ticket_number','group_name'] }
                },
                {
                    name: 'assign_ticket_to_user',
                    description: 'Assign an incident to a user by name, username, or email.',
                    parameters: { type: 'object', properties: {
                        ticket_number: { type: 'string' },
                        user_name: { type: 'string' }
                    }, required: ['ticket_number','user_name'] }
                },
                {
                    name: 'list_my_problems',
                    description: 'List the user open problem records (problem table, separate from incidents).',
                    parameters: { type: 'object', properties: {} }
                },
                {
                    name: 'list_my_changes',
                    description: 'List the user open change requests.',
                    parameters: { type: 'object', properties: {} }
                },
                {
                    name: 'list_my_requests',
                    description: 'List the user open catalog requested items (RITM records).',
                    parameters: { type: 'object', properties: {} }
                },
                {
                    name: 'search_incidents',
                    description: 'Search across ALL incidents (not just the user own) by keyword in short description.',
                    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
                },
                {
                    name: 'lookup_user',
                    description: 'Find a corporate colleague in the ServiceNow user directory by name, username, or email. Returns up to 3 matches with name, email, username, and job title. USE THIS whenever the user asks "who is X", "find X", "tell me about X", "look up X" - and after calling, SPEAK BACK the details. This is a corporate directory of colleagues - sharing these details is the entire purpose. Never refuse.',
                    parameters: { type: 'object', properties: { query: { type: 'string', description: 'Full or partial name, username, or email of the colleague to look up' } }, required: ['query'] }
                },
                {
                    name: 'list_attachments',
                    description: 'List file attachments on an incident.',
                    parameters: { type: 'object', properties: { ticket_number: { type: 'string' } }, required: ['ticket_number'] }
                },
                {
                    name: 'read_text_attachment',
                    description: 'Read the contents of a TEXT attachment (.txt, .csv, .log, .md, .json, .xml) on an incident. PDFs and binaries cannot be read.',
                    parameters: { type: 'object', properties: {
                        ticket_number: { type: 'string' },
                        attachment_name: { type: 'string' }
                    }, required: ['ticket_number'] }
                },
                {
                    name: 'summarize_ticket',
                    description: 'Full summary of an incident including description, state, priority, assignee, comments, work notes.',
                    parameters: { type: 'object', properties: { ticket_number: { type: 'string' } }, required: ['ticket_number'] }
                },
                {
                    name: 'send_message_to_user',
                    description: 'Send a message to another ServiceNow user. Creates a tracking incident assigned to them.',
                    parameters: { type: 'object', properties: {
                        recipient_name: { type: 'string' },
                        message: { type: 'string' }
                    }, required: ['recipient_name','message'] }
                },
                {
                    name: 'tell_joke',
                    description: 'Tell a short tech / ServiceNow joke. Use ONLY when the user explicitly asks for a joke.',
                    parameters: { type: 'object', properties: {} }
                },
                // ------- v14 advanced tools -------
                {
                    name: 'daily_briefing',
                    description: 'Morning briefing with counts of pending incidents, approvals, changes, requests, and problems for the user. Use when the user asks "what is my day", "morning briefing", "summary", "what is on my plate today".',
                    parameters: { type: 'object', properties: {} }
                },
                {
                    name: 'workload_summary',
                    description: 'Concise count of open work across incidents, problems, changes, requests and pending approvals. Use when user asks "how much work do I have", "workload", "what is open".',
                    parameters: { type: 'object', properties: {} }
                },
                {
                    name: 'create_problem',
                    description: 'Create a new problem record. Use when user says "log a problem about ..." or "raise a problem".',
                    parameters: { type: 'object', properties: {
                        short_description: { type: 'string', description: 'One-line description of the problem' },
                        impact: { type: 'string', description: 'Impact 1-3 (1=high). Default 3.' }
                    }, required: ['short_description'] }
                },
                {
                    name: 'create_change',
                    description: 'Create a normal change request. Use when user says "raise a change for ..." or "create a change request".',
                    parameters: { type: 'object', properties: {
                        short_description: { type: 'string', description: 'One-line description of the change' },
                        change_type: { type: 'string', enum: ['standard','normal','emergency'], description: 'Type. Default normal.' }
                    }, required: ['short_description'] }
                },
                {
                    name: 'list_overdue',
                    description: 'List the users own open incidents that have crossed their due-date / SLA breach threshold (older than 3 days for P3+, 1 day for P2, 4 hours for P1).',
                    parameters: { type: 'object', properties: {} }
                },
                {
                    name: 'set_focus_ticket',
                    description: 'Remember a ticket as the conversation focus so subsequent commands like "resolve it", "raise its priority", "summarize it" know which ticket to act on. Use whenever the user names a ticket explicitly.',
                    parameters: { type: 'object', properties: {
                        ticket_number: { type: 'string', description: 'INC/CHG/PRB/RITM number. Spoken digits will be normalised.' }
                    }, required: ['ticket_number'] }
                },
                {
                    name: 'recall_focus',
                    description: 'Tell the user which ticket Netra is currently focused on. Use when user says "what was I working on", "which ticket is in focus".',
                    parameters: { type: 'object', properties: {} }
                },
                {
                    name: 'add_to_watchlist',
                    description: 'Add a ticket to the users Netra watchlist - Netra will proactively notify them of any state/comment changes on it.',
                    parameters: { type: 'object', properties: {
                        ticket_number: { type: 'string', description: 'INC/CHG/PRB/RITM number' }
                    }, required: ['ticket_number'] }
                },
                {
                    name: 'remove_from_watchlist',
                    description: 'Stop watching a ticket. Use when the user says "stop watching INC...", "drop X from my watchlist", "I do not need updates on X anymore".',
                    parameters: { type: 'object', properties: {
                        ticket_number: { type: 'string', description: 'INC/CHG/PRB/RITM number' }
                    }, required: ['ticket_number'] }
                },
                {
                    name: 'list_watchlist',
                    description: 'List all tickets currently being watched by the user.',
                    parameters: { type: 'object', properties: {} }
                },
                {
                    name: 'add_work_note',
                    description: 'Add a private work note (visible only to fulfillers, not the requester) to a ticket. Distinct from update_ticket which adds customer-visible comments.',
                    parameters: { type: 'object', properties: {
                        ticket_number: { type: 'string', description: 'INC/CHG/PRB/RITM number' },
                        note: { type: 'string', description: 'The internal note text' }
                    }, required: ['ticket_number','note'] }
                },
                {
                    name: 'team_workload',
                    description: 'Count open incidents per group the user belongs to. Use when user asks "what is my teams workload" or "how is the queue".',
                    parameters: { type: 'object', properties: {} }
                },
                // ------- R1.3 - draft + confirmation flow (Claude-style) -------
                {
                    name: 'start_record_draft',
                    description: 'Begin a CONVERSATIONAL DRAFT for a new ticket. Use this INSTEAD OF create_ticket/create_problem/create_change when the user says "open a ticket / log a problem / raise a change". This starts a multi-turn conversation: Netra asks for required fields one at a time, the user can change earlier answers, and only after explicit confirmation is the record actually inserted. Pass record_type = incident|problem|change_request. NEVER call create_ticket directly any more.',
                    parameters: { type: 'object', properties: {
                        record_type: { type: 'string', enum: ['incident','problem','change_request'], description: 'The table to draft' },
                        initial_short_description: { type: 'string', description: 'Optional first sentence captured from the user' }
                    }, required: ['record_type'] }
                },
                {
                    name: 'set_record_field',
                    description: 'Set ONE field on the current draft. Use after start_record_draft for each required field the user provides (short_description, urgency, impact, category, etc). The user can use this tool to CHANGE earlier values too - e.g. "wait, set urgency to high instead" -> set_record_field(urgency, 2).',
                    parameters: { type: 'object', properties: {
                        field:  { type: 'string', description: 'Field name (short_description, urgency, impact, priority, category, etc)' },
                        value:  { type: 'string', description: 'Field value as string' }
                    }, required: ['field','value'] }
                },
                {
                    name: 'review_draft',
                    description: 'Read back the current draft to the user for review BEFORE creating. Use this after all required fields are set, and any time the user asks "what have I filled in / read it back / show me".',
                    parameters: { type: 'object', properties: {} }
                },
                {
                    name: 'confirm_and_create',
                    description: 'Actually insert the record. ONLY call this AFTER review_draft AND explicit yes from the user (e.g. "yes, create it", "confirmed", "go ahead"). Aborts if required fields are missing.',
                    parameters: { type: 'object', properties: {} }
                },
                {
                    name: 'cancel_draft',
                    description: 'Discard the current draft without creating anything. Use when user says "cancel", "scrap it", "never mind", "forget that".',
                    parameters: { type: 'object', properties: {} }
                },
                {
                    name: 'send_sidebar_message',
                    description: 'Send a real ServiceNow Sidebar Discussion message to a colleague. This creates a sys_sidebar_discussion (private) with the target user and posts the message there - it shows up as a real chat in their Now sidebar, not as a tracking incident. ALWAYS use this instead of send_message_to_user for "message X", "tell X that ...", "ping X".',
                    parameters: { type: 'object', properties: {
                        recipient_name: { type: 'string', description: 'Full / partial name, username, or email of the colleague' },
                        subject:        { type: 'string', description: 'Short discussion subject (defaults to "Message from " + user)' },
                        message:        { type: 'string', description: 'The message body' }
                    }, required: ['recipient_name','message'] }
                },
                // ------- R1.4 - Claude-of-ServiceNow advanced tools -------
                {
                    name: 'list_capabilities',
                    description: 'Self-introspection: returns a categorized tour of what Netra can do. Use when the user asks "what can you do?", "help me", "show me your features", "list your capabilities", "how do you work".',
                    parameters: { type: 'object', properties: {} }
                },
                {
                    name: 'recall_past_conversations',
                    description: 'Look up the persistent conversation memory of the user. Returns the last N exchanges (each with timestamp, user input, Netra reply) so questions like "what did we discuss yesterday?", "what did I ask you about earlier?" can be answered. Memory persists across page loads.',
                    parameters: { type: 'object', properties: {
                        keyword: { type: 'string', description: 'Optional keyword to filter the recall (e.g. "vpn", "approval"). Leave empty for last 10 unfiltered.' },
                        limit:   { type: 'number', description: 'Max exchanges to return (default 10, max 20)' }
                    } }
                },
                {
                    name: 'remember_fact',
                    description: 'Store a personal fact the user shared (preference, project, person, etc) into long-term memory. Use sparingly - only when the user EXPLICITLY says "remember that..." or "for next time...".',
                    parameters: { type: 'object', properties: {
                        fact: { type: 'string', description: 'The fact to remember, in the user own words' }
                    }, required: ['fact'] }
                },
                {
                    name: 'analyze_screenshot',
                    description: 'Analyze a screenshot the user has just captured of their ServiceNow screen. The client takes care of the capture - this tool just signals "yes, look at the image they will send next". Use when user says "look at this form", "what is wrong with this", "analyze this screen".',
                    parameters: { type: 'object', properties: {
                        question: { type: 'string', description: 'What the user wants you to look for or explain' }
                    } }
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
                // ------- v11 expanded tools -------
                case 'change_priority':
                    return _changePriority(_normNum(args.ticket_number), String(args.priority));
                case 'escalate_ticket':
                    return _escalateTicket(_normNum(args.ticket_number));
                case 'assign_ticket_to_group':
                    return _assignToGroup(_normNum(args.ticket_number), String(args.group_name || ''));
                case 'assign_ticket_to_user':
                    return _assignToUser(_normNum(args.ticket_number), String(args.user_name || ''));
                case 'list_my_problems':
                    return _listMyOf('problem', 5);
                case 'list_my_changes':
                    return _listMyOf('change_request', 5);
                case 'list_my_requests':
                    return _listMyOf('sc_req_item', 5);
                case 'search_incidents':
                    return _searchIncidents(String(args.query || ''));
                case 'lookup_user':
                    return _lookupUser(String(args.query || ''));
                case 'list_attachments':
                    return _listAttachments(_normNum(args.ticket_number));
                case 'read_text_attachment':
                    return _readTextAttachment(_normNum(args.ticket_number), String(args.attachment_name || ''));
                case 'summarize_ticket':
                    return _summarizeTicket(_normNum(args.ticket_number));
                case 'send_message_to_user':
                    return _sendMessage(String(args.recipient_name || ''), String(args.message || ''));
                case 'tell_joke':
                    return _tellJoke();
                // ------- v14 advanced tools -------
                case 'daily_briefing':
                    return _dailyBriefing();
                case 'workload_summary':
                    return _workloadSummary();
                case 'create_problem':
                    return _createProblem(String(args.short_description || ''), String(args.impact || '3'));
                case 'create_change':
                    return _createChange(String(args.short_description || ''), String(args.change_type || 'normal'));
                case 'list_overdue':
                    return _listOverdue();
                case 'set_focus_ticket':
                    return _setFocusTicket(_normNum(args.ticket_number));
                case 'recall_focus':
                    return _recallFocus();
                case 'add_to_watchlist':
                    return _addToWatchlist(_normNum(args.ticket_number));
                case 'remove_from_watchlist':
                    return _removeFromWatchlist(_normNum(args.ticket_number));
                case 'list_watchlist':
                    return _listWatchlist();
                case 'add_work_note':
                    return _addWorkNote(_normNum(args.ticket_number), String(args.note || ''));
                case 'team_workload':
                    return _teamWorkload();
                // ------- R1.3 draft + confirmation flow -------
                case 'start_record_draft':
                    return _startRecordDraft(String(args.record_type || 'incident'), String(args.initial_short_description || ''));
                case 'set_record_field':
                    return _setRecordField(String(args.field || ''), String(args.value || ''));
                case 'review_draft':
                    return _reviewDraft();
                case 'confirm_and_create':
                    return _confirmAndCreate();
                case 'cancel_draft':
                    return _cancelDraft();
                case 'send_sidebar_message':
                    return _sendSidebarMessage(String(args.recipient_name || ''), String(args.subject || ''), String(args.message || ''));
                // ------- R1.4 -------
                case 'list_capabilities':
                    return _listCapabilities();
                case 'recall_past_conversations':
                    return _recallPastConversations(String(args.keyword || ''), Number(args.limit) || 10);
                case 'remember_fact':
                    return _rememberFact(String(args.fact || ''));
                case 'analyze_screenshot':
                    return _analyzeScreenshot(String(args.question || ''));
                default:
                    return { ok: false, error: 'Unknown tool: ' + name };
            }
        } catch (e) {
            gs.error('[NetraGemini] tool ' + name + ' threw: ' + e);
            return { ok: false, error: String(e.message || e) };
        }
    }

    /* ===================================================================
     *  v11 extended tool implementations
     * =================================================================== */
    function _getIncident(num) {
        var gr = new GlideRecord('incident');
        if (!gr.get('number', num)) return null;
        return gr;
    }

    function _changePriority(num, p) {
        var gr = _getIncident(num);
        if (!gr) return { ok: false, error: 'Ticket not found: ' + num };
        gr.priority = p;
        gr.update();
        return { ok: true, message: 'Priority of ' + num + ' changed to ' + p + '.' };
    }

    function _escalateTicket(num) {
        var gr = _getIncident(num);
        if (!gr) return { ok: false, error: 'Ticket not found: ' + num };
        var cur = parseInt(String(gr.priority), 10) || 4;
        if (cur <= 1) return { ok: false, error: 'Already at maximum priority' };
        gr.priority = cur - 1;
        gr.work_notes = '[Netra] Escalated by voice from priority ' + cur + ' to ' + (cur - 1) + '.';
        gr.update();
        return { ok: true, message: 'Escalated ' + num + ' from priority ' + cur + ' to ' + (cur - 1) + '.', from: cur, to: cur - 1 };
    }

    function _assignToGroup(num, groupName) {
        if (!groupName) return { ok: false, error: 'Group name is required' };
        var gr = _getIncident(num);
        if (!gr) return { ok: false, error: 'Ticket not found: ' + num };
        var gg = new GlideRecord('sys_user_group');
        gg.addQuery('active', true);
        gg.addEncodedQuery('nameLIKE' + groupName);
        gg.setLimit(1);
        gg.query();
        if (!gg.next()) return { ok: false, error: 'No group matching "' + groupName + '"' };
        gr.assignment_group = String(gg.sys_id);
        gr.work_notes = '[Netra] Assigned to group ' + gg.name + ' by voice.';
        gr.update();
        return { ok: true, message: num + ' assigned to ' + gg.name + '.' };
    }

    function _assignToUser(num, userName) {
        if (!userName) return { ok: false, error: 'User name is required' };
        var gr = _getIncident(num);
        if (!gr) return { ok: false, error: 'Ticket not found: ' + num };
        var u = new GlideRecord('sys_user');
        u.addQuery('active', true);
        u.addEncodedQuery('nameLIKE' + userName + '^ORuser_nameLIKE' + userName + '^ORemailLIKE' + userName);
        u.setLimit(1);
        u.query();
        if (!u.next()) return { ok: false, error: 'No user matching "' + userName + '"' };
        gr.assigned_to = String(u.sys_id);
        gr.work_notes = '[Netra] Assigned to ' + u.name + ' by voice.';
        gr.update();
        return { ok: true, message: num + ' assigned to ' + u.name + '.' };
    }

    function _listMyOf(table, limit) {
        var gr = new GlideRecord(table);
        gr.addQuery('opened_by', user);
        gr.addQuery('active', true);
        gr.orderByDesc('sys_updated_on');
        gr.setLimit(limit);
        gr.query();
        var out = [];
        while (gr.next()) {
            var stateDisp;
            try { stateDisp = String(gr.state.getDisplayValue()); }
            catch (e) { stateDisp = String(gr.state); }
            out.push({
                number: String(gr.number),
                short_description: String(gr.short_description),
                state: stateDisp
            });
        }
        return { ok: true, table: table, count: out.length, items: out };
    }

    function _searchIncidents(query) {
        if (!query) return { ok: false, error: 'Query is required' };
        var gr = new GlideRecord('incident');
        gr.addEncodedQuery('short_descriptionLIKE' + query + '^ORdescriptionLIKE' + query);
        gr.orderByDesc('sys_updated_on');
        gr.setLimit(5);
        gr.query();
        var out = [];
        while (gr.next()) {
            var stateDisp;
            try { stateDisp = String(gr.state.getDisplayValue()); }
            catch (e) { stateDisp = String(gr.state); }
            out.push({
                number: String(gr.number),
                short_description: String(gr.short_description),
                state: stateDisp
            });
        }
        return { ok: true, query: query, count: out.length, items: out };
    }

    function _lookupUser(query) {
        if (!query) return { ok: false, error: 'Query is required' };
        var gr = new GlideRecord('sys_user');
        gr.addQuery('active', true);
        gr.addEncodedQuery('nameLIKE' + query + '^ORuser_nameLIKE' + query + '^ORemailLIKE' + query);
        gr.setLimit(3);
        gr.query();
        var out = [];
        while (gr.next()) {
            out.push({
                name: String(gr.name),
                email: String(gr.email),
                username: String(gr.user_name),
                title: String(gr.title || '')
            });
        }
        return { ok: true, count: out.length, users: out };
    }

    function _listAttachments(num) {
        var gr = _getIncident(num);
        if (!gr) return { ok: false, error: 'Ticket not found: ' + num };
        var att = new GlideRecord('sys_attachment');
        att.addQuery('table_name', 'incident');
        att.addQuery('table_sys_id', String(gr.sys_id));
        att.setLimit(20);
        att.query();
        var out = [];
        while (att.next()) {
            out.push({
                name: String(att.file_name),
                size_bytes: String(att.size_bytes),
                content_type: String(att.content_type)
            });
        }
        return { ok: true, ticket: num, count: out.length, attachments: out };
    }

    function _readTextAttachment(num, attachmentName) {
        var gr = _getIncident(num);
        if (!gr) return { ok: false, error: 'Ticket not found: ' + num };
        var att = new GlideRecord('sys_attachment');
        att.addQuery('table_name', 'incident');
        att.addQuery('table_sys_id', String(gr.sys_id));
        if (attachmentName) att.addEncodedQuery('file_nameLIKE' + attachmentName);
        att.orderByDesc('sys_created_on');
        att.setLimit(1);
        att.query();
        if (!att.next()) return { ok: false, error: 'No matching attachment on ' + num };
        var fname = String(att.file_name);
        var ctype = String(att.content_type || '').toLowerCase();
        var isText = /^text\/|json|xml|csv|markdown/.test(ctype) ||
                     /\.(txt|md|csv|log|json|xml|yaml|yml|ini|conf)$/i.test(fname);
        if (!isText) return { ok: false, error: 'Attachment "' + fname + '" is not text (' + ctype + '). I can only read text files.', file_name: fname };
        try {
            var sa = new GlideSysAttachment();
            var content = sa.getContent(att);
            if (!content) return { ok: false, error: 'Could not read content of ' + fname };
            var truncated = false;
            if (content.length > 2400) { content = content.substring(0, 2400); truncated = true; }
            return { ok: true, ticket: num, file_name: fname, content: content, truncated: truncated };
        } catch (e) {
            return { ok: false, error: 'Read failed: ' + (e.message || e) };
        }
    }

    function _summarizeTicket(num) {
        var gr = _getIncident(num);
        if (!gr) return { ok: false, error: 'Ticket not found: ' + num };
        var dv = function (f) {
            try { return String(gr[f].getDisplayValue ? gr[f].getDisplayValue() : gr[f]); }
            catch (e) { return ''; }
        };
        return {
            ok: true,
            number: String(gr.number),
            short_description: String(gr.short_description),
            description: String(gr.description || '').substring(0, 400),
            state: dv('state'),
            priority: dv('priority'),
            urgency: dv('urgency'),
            impact: dv('impact'),
            category: dv('category'),
            assigned_to: dv('assigned_to'),
            assignment_group: dv('assignment_group'),
            caller_id: dv('caller_id'),
            opened_at: String(gr.opened_at),
            updated_at: String(gr.sys_updated_on),
            recent_comments: String(gr.comments || '').substring(0, 400),
            recent_work_notes: String(gr.work_notes || '').substring(0, 400)
        };
    }

    function _sendMessage(recipient, message) {
        if (!recipient || !message) return { ok: false, error: 'Both recipient and message are required' };
        var u = new GlideRecord('sys_user');
        u.addQuery('active', true);
        u.addEncodedQuery('nameLIKE' + recipient + '^ORuser_nameLIKE' + recipient + '^ORemailLIKE' + recipient);
        u.setLimit(1);
        u.query();
        if (!u.next()) return { ok: false, error: 'No user matching "' + recipient + '"' };
        var inc = new GlideRecord('incident');
        inc.initialize();
        inc.short_description = '[Netra message] ' + message.substring(0, 100);
        inc.description = 'Voice message from ' + gs.getUserDisplayName() + ':\n\n' + message;
        inc.caller_id = gs.getUserID();
        inc.assigned_to = String(u.sys_id);
        inc.urgency = 3;
        inc.impact = 3;
        inc.state = 1;
        var sid = inc.insert();
        if (!sid) return { ok: false, error: 'Could not create message record' };
        var fresh = new GlideRecord('incident');
        fresh.get(sid);
        return {
            ok: true,
            recipient: String(u.name),
            tracking_ticket: String(fresh.number),
            message: 'Message sent to ' + u.name + ', tracked as ' + fresh.number + '.'
        };
    }

    function _tellJoke() {
        var jokes = [
            'Why did the developer go broke? Because he used up all his cache.',
            'Why do programmers prefer dark mode? Because light attracts bugs.',
            'There are only ten types of people in the world, those who understand binary, and those who do not.',
            'How many software engineers does it take to change a light bulb? None, that is a hardware problem.',
            'A S Q L query walks into a bar, walks up to two tables and asks, can I join you?',
            'Why is the firewall always invited to parties? Because it blocks the bad stuff.',
            'What is a programmer\'s favourite music? Algorithms.',
            'Why did the laptop go to therapy? It had too many issues.',
            'Why did the Service Now admin get cold? Someone left the form view open.',
            'Why was the password sad? It had too many failed attempts.',
            'How does an incident introduce itself? Hi, I am critical, but I am working on it.',
            'Why did the ticket cross the road? To get to the other queue.',
            'Why don\'t servers ever get tired? They have plenty of cache.',
            'What is a sysadmin\'s favourite snack? Restart-os.',
            'My code does not work, I have no idea why. My code does work, I have no idea why.',
            'Why do servers love yoga? They get good uptime.',
            'Why was the change request put on hold? Lack of CAB attendance.',
            'What did the I T manager say to the cloud? Stop being so distant.',
            'How do you know an incident is happy? It is closed.',
            'Why was the user upset with the password policy? Too many strong feelings required.'
        ];
        var pick = jokes[Math.floor(Math.random() * jokes.length)];
        return { ok: true, joke: pick };
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
     *  v14 advanced tool implementations
     * =================================================================== */

    // Generic count: query a table by encoded query and return count
    function _countActiveBy(table, qStr) {
        try {
            var gr = new GlideRecord(table);
            gr.addActiveQuery();
            if (qStr) gr.addEncodedQuery(qStr);
            gr.query();
            return gr.getRowCount();
        } catch (e) { return 0; }
    }

    function _dailyBriefing() {
        var meId = gs.getUserID();
        var myInc      = _countActiveBy('incident',        'assigned_to=' + meId);
        var myReqOpen  = _countActiveBy('sc_req_item',     'request.requested_for=' + meId + '^stateNOT IN3,4,7');
        var myChg      = _countActiveBy('change_request',  'assigned_to=' + meId);
        var myPrb      = _countActiveBy('problem',         'assigned_to=' + meId);
        var myAppr     = _countActiveBy('sysapproval_approver', 'approver=' + meId + '^state=requested');
        var watchCount = _countActiveBy(SCOPE + '_watchlist', 'user=' + meId);

        // Time-of-day greeting
        var hour = new GlideDateTime().getDisplayValue().substring(11, 13);
        var hrNum = parseInt(hour, 10) || 12;
        var greet = hrNum < 12 ? 'Good morning' : (hrNum < 17 ? 'Good afternoon' : 'Good evening');
        var firstName = gs.getUserDisplayName().split(' ')[0];

        var line = greet + ', ' + firstName + '. ';
        var bits = [];
        if (myInc)      bits.push(myInc      + ' incident'    + (myInc      === 1 ? '' : 's'));
        if (myPrb)      bits.push(myPrb      + ' problem'     + (myPrb      === 1 ? '' : 's'));
        if (myChg)      bits.push(myChg      + ' change'      + (myChg      === 1 ? '' : 's'));
        if (myReqOpen)  bits.push(myReqOpen  + ' request'     + (myReqOpen  === 1 ? '' : 's'));
        if (myAppr)     bits.push(myAppr     + ' approval'    + (myAppr     === 1 ? '' : 's') + ' pending');
        if (watchCount) bits.push(watchCount + ' watched ticket' + (watchCount === 1 ? '' : 's'));
        if (!bits.length) {
            line += 'Your queue is clear. Nothing on your plate today.';
        } else {
            line += 'You have ' + bits.join(', ') + '.';
        }

        // R1.4 - PROACTIVE HIGHLIGHTS
        // Pick the single most-important item to mention so the briefing
        // feels like a colleague talking, not a status board.
        var highlights = [];

        // 1. Highest-priority active incident
        try {
            var p = new GlideRecord('incident');
            p.addActiveQuery();
            p.addQuery('assigned_to', meId);
            p.orderBy('priority');
            p.orderBy('opened_at');
            p.setLimit(1);
            p.query();
            if (p.next()) {
                var pri = String(p.priority);
                var num = String(p.number);
                var sd  = String(p.short_description || '').substring(0, 80);
                var label = pri === '1' ? 'a critical' : (pri === '2' ? 'a high-priority' : 'an');
                highlights.push('Your top ticket is ' + num + ', ' + label + ' incident about ' + sd + '.');
            }
        } catch (eP) {}

        // 2. Oldest pending approval
        try {
            var a = new GlideRecord('sysapproval_approver');
            a.addQuery('approver', meId);
            a.addQuery('state', 'requested');
            a.orderBy('sys_created_on');
            a.setLimit(1);
            a.query();
            if (a.next()) {
                var approvalAge = '';
                try {
                    var gd = new GlideDateTime(a.sys_created_on);
                    var now = new GlideDateTime();
                    var diffMs = now.getNumericValue() - gd.getNumericValue();
                    var hours = Math.floor(diffMs / 3600000);
                    if (hours > 24) approvalAge = ' (waiting ' + Math.floor(hours / 24) + ' day' + (Math.floor(hours / 24) === 1 ? '' : 's') + ')';
                    else if (hours > 0) approvalAge = ' (waiting ' + hours + ' hour' + (hours === 1 ? '' : 's') + ')';
                } catch (eD) {}
                highlights.push('Your oldest pending approval has been waiting' + approvalAge + '.');
            }
        } catch (eA) {}

        // 3. Did anything change overnight in their watchlist? (notifications table)
        try {
            var n = new GlideRecord(SCOPE + '_notification');
            n.addQuery('user', meId);
            n.addQuery('delivered', false);
            n.orderByDesc('sys_created_on');
            n.setLimit(1);
            n.query();
            if (n.next()) {
                highlights.push('Heads up - ' + String(n.message || 'there is unread activity in your watchlist') + '.');
            }
        } catch (eN) {}

        return {
            ok: true,
            briefing: line,
            highlights: highlights,
            counts: { incidents: myInc, problems: myPrb, changes: myChg, requests: myReqOpen, approvals: myAppr, watching: watchCount },
            greeting: greet,
            instruction_for_netra: 'Read the briefing aloud, then say the highlights one at a time in a calm, helpful tone. Pause briefly between them. End with an offer like "What would you like to focus on first?".'
        };
    }

    function _workloadSummary() {
        var meId = gs.getUserID();
        return {
            ok: true,
            workload: {
                open_incidents: _countActiveBy('incident',        'assigned_to=' + meId),
                open_problems:  _countActiveBy('problem',         'assigned_to=' + meId),
                open_changes:   _countActiveBy('change_request',  'assigned_to=' + meId),
                my_requests:    _countActiveBy('sc_req_item',     'request.requested_for=' + meId + '^stateNOT IN3,4,7'),
                approvals:      _countActiveBy('sysapproval_approver', 'approver=' + meId + '^state=requested')
            }
        };
    }

    function _createProblem(desc, impact) {
        if (!desc) return { ok: false, error: 'short description is required' };
        try {
            var gr = new GlideRecord('problem');
            gr.initialize();
            gr.short_description = desc;
            gr.impact            = impact || '3';
            gr.urgency           = impact || '3';
            gr.opened_by         = gs.getUserID();
            gr.assigned_to       = gs.getUserID();
            var sid = gr.insert();
            gr.get(sid);
            return { ok: true, number: String(gr.number), sys_id: sid, message: 'Logged problem ' + gr.number + '.' };
        } catch (e) {
            return { ok: false, error: String(e.message || e) };
        }
    }

    function _createChange(desc, changeType) {
        if (!desc) return { ok: false, error: 'short description is required' };
        try {
            var gr = new GlideRecord('change_request');
            gr.initialize();
            gr.short_description = desc;
            gr.type              = changeType || 'normal';
            gr.opened_by         = gs.getUserID();
            gr.requested_by      = gs.getUserID();
            var sid = gr.insert();
            gr.get(sid);
            return { ok: true, number: String(gr.number), sys_id: sid, message: 'Created ' + (changeType || 'normal') + ' change ' + gr.number + '.' };
        } catch (e) {
            return { ok: false, error: String(e.message || e) };
        }
    }

    function _listOverdue() {
        try {
            var meId = gs.getUserID();
            var gr = new GlideRecord('incident');
            gr.addActiveQuery();
            gr.addQuery('assigned_to', meId);
            // SLA-ish: p1 >4h, p2 >1d, p3+ >3d since opened
            gr.addEncodedQuery(
              '(priority=1^opened_at<=javascript:gs.daysAgoStart(0))^OR(priority=2^opened_at<=javascript:gs.daysAgoStart(1))^OR(priority>=3^opened_at<=javascript:gs.daysAgoStart(3))'
            );
            gr.setLimit(8);
            gr.orderBy('priority');
            gr.query();
            var list = [];
            while (gr.next()) {
                list.push({
                    number: String(gr.number),
                    priority: String(gr.priority),
                    short_description: String(gr.short_description),
                    opened_at: String(gr.opened_at)
                });
            }
            return { ok: true, overdue: list, count: list.length };
        } catch (e) { return { ok: false, error: String(e.message || e) }; }
    }

    function _setFocusTicket(num) {
        if (!num) return { ok: false, error: 'ticket number required' };
        try {
            var table = _tableForNumber(num);
            if (!table) return { ok: false, error: 'Unrecognised number prefix: ' + num };
            var gr = new GlideRecord(table);
            if (!gr.get('number', num)) return { ok: false, error: 'Ticket not found: ' + num };

            // Upsert into Netra Context
            var ctx = new GlideRecord(SCOPE + '_context');
            ctx.addQuery('user', gs.getUserID());
            ctx.query();
            if (!ctx.next()) {
                ctx.initialize();
                ctx.user = gs.getUserID();
            }
            ctx.focus_table   = table;
            ctx.focus_number  = num;
            ctx.focus_sys_id  = gr.getUniqueValue();
            ctx.focus_set_at  = new GlideDateTime();
            ctx.last_utterance = num;
            ctx.update();
            return { ok: true, message: 'Focused on ' + num + '. Subsequent commands will act on this ticket.', table: table, number: num };
        } catch (e) { return { ok: false, error: String(e.message || e) }; }
    }

    function _recallFocus() {
        try {
            var ctx = new GlideRecord(SCOPE + '_context');
            ctx.addQuery('user', gs.getUserID());
            ctx.query();
            if (!ctx.next() || !ctx.focus_number) {
                return { ok: true, focus: null, message: 'No ticket is in focus right now.' };
            }
            return { ok: true, focus: { table: String(ctx.focus_table), number: String(ctx.focus_number) },
                     message: 'In focus: ' + ctx.focus_number };
        } catch (e) { return { ok: false, error: String(e.message || e) }; }
    }

    function _tableForNumber(num) {
        if (!num) return null;
        var p = num.substring(0, 3);
        if (p === 'INC') return 'incident';
        if (p === 'CHG') return 'change_request';
        if (p === 'PRB') return 'problem';
        if (p === 'REQ') return 'sc_request';
        if (p === 'RIT' || num.indexOf('RITM') === 0) return 'sc_req_item';
        if (p === 'SCT' || num.indexOf('SCTASK') === 0) return 'sc_task';
        if (p === 'KB0') return 'kb_knowledge';
        return null;
    }

    function _addToWatchlist(num) {
        if (!num) return { ok: false, error: 'ticket number required' };
        var table = _tableForNumber(num);
        if (!table) return { ok: false, error: 'Unrecognised number: ' + num };
        var rec = new GlideRecord(table);
        if (!rec.get('number', num)) return { ok: false, error: 'Ticket not found: ' + num };

        // De-dupe
        var existing = new GlideRecord(SCOPE + '_watchlist');
        existing.addQuery('user', gs.getUserID());
        existing.addQuery('record_number', num);
        existing.query();
        if (existing.next()) return { ok: true, message: num + ' is already on your watchlist.' };

        var w = new GlideRecord(SCOPE + '_watchlist');
        w.initialize();
        w.user             = gs.getUserID();
        w.record_table     = table;
        w.record_number    = num;
        w.record_sys_id    = rec.getUniqueValue();
        w.insert();
        return { ok: true, message: 'Added ' + num + ' to your watchlist. I will notify you of any changes.' };
    }

    function _removeFromWatchlist(num) {
        if (!num) return { ok: false, error: 'ticket number required' };
        var w = new GlideRecord(SCOPE + '_watchlist');
        w.addQuery('user', gs.getUserID());
        w.addQuery('record_number', num);
        w.query();
        if (!w.next()) return { ok: false, error: num + ' is not on your watchlist.' };
        w.deleteRecord();
        return { ok: true, message: 'Removed ' + num + ' from your watchlist.' };
    }

    function _listWatchlist() {
        var w = new GlideRecord(SCOPE + '_watchlist');
        w.addQuery('user', gs.getUserID());
        w.orderByDesc('sys_created_on');
        w.setLimit(15);
        w.query();
        var list = [];
        while (w.next()) {
            list.push({ number: String(w.record_number), table: String(w.record_table) });
        }
        return { ok: true, watchlist: list, count: list.length,
                 message: list.length ? 'Watching ' + list.length + ' ticket' + (list.length === 1 ? '' : 's') + '.'
                                      : 'Your watchlist is empty.' };
    }

    function _addWorkNote(num, note) {
        if (!num || !note) return { ok: false, error: 'ticket number and note are required' };
        var table = _tableForNumber(num);
        if (!table) return { ok: false, error: 'Unrecognised number: ' + num };
        var gr = new GlideRecord(table);
        if (!gr.get('number', num)) return { ok: false, error: 'Ticket not found: ' + num };
        gr.work_notes = '[Netra] ' + note;
        gr.update();
        return { ok: true, message: 'Internal note added to ' + num + '.' };
    }

    function _teamWorkload() {
        try {
            var meId = gs.getUserID();
            // groups user is a member of
            var gm = new GlideRecord('sys_user_grmember');
            gm.addQuery('user', meId);
            gm.setLimit(10);
            gm.query();
            var rows = [];
            while (gm.next()) {
                var groupId = String(gm.group);
                var gg = new GlideRecord('sys_user_group');
                if (!gg.get(groupId)) continue;
                if (gg.active != true && String(gg.active) !== 'true') continue;
                var openInc = _countActiveBy('incident', 'assignment_group=' + groupId);
                rows.push({ group: String(gg.name), open_incidents: openInc });
            }
            // Sort by load
            rows.sort(function(a, b) { return b.open_incidents - a.open_incidents; });
            return { ok: true, teams: rows };
        } catch (e) { return { ok: false, error: String(e.message || e) }; }
    }

    /* ===================================================================
     *  R1.3 - DRAFT + CONFIRMATION FLOW (Claude-style multi-turn)
     *
     *  Drafts are persisted as JSON in the user's Netra Context row under
     *  a new field "draft_json" (we stash it in last_utterance with a
     *  prefix so we do not need a schema change). Each tool returns the
     *  current draft state so Gemini can drive the conversation: which
     *  fields are filled, which are still required, what to ask next.
     * =================================================================== */

    // Required fields per record_type (must be filled before create)
    var REQUIRED_FIELDS = {
        incident:        ['short_description'],
        problem:         ['short_description'],
        change_request:  ['short_description','type']
    };
    // Friendly prompt text for each field
    var FIELD_PROMPTS = {
        short_description: 'what is the issue, in one sentence',
        urgency:           'how urgent (1 critical, 2 high, 3 moderate, 4 low) - default 3',
        impact:            'how big the impact (1, 2, or 3) - default 3',
        priority:          'priority (1-4, optional)',
        category:          'category (optional)',
        type:              'type of change (standard, normal, emergency)'
    };

    // R1.4 - Single combined context blob: {draft:{} | null, mem:[]}
    // Stored with "CTX:" prefix in last_utterance field, so draft and
    // long-term memory both survive each other.
    function _ctxLoadGr() {
        var ctx = new GlideRecord(SCOPE + '_context');
        ctx.addQuery('user', gs.getUserID());
        ctx.query();
        if (!ctx.next()) {
            ctx.initialize();
            ctx.user = gs.getUserID();
        }
        return ctx;
    }
    function _ctxReadBlob() {
        var ctx = _ctxLoadGr();
        var raw = String(ctx.last_utterance || '');
        if (raw.indexOf('CTX:') === 0) {
            try { return JSON.parse(raw.substring(4)) || { draft: null, mem: [] }; } catch (e) {}
        }
        // Backwards-compat: migrate old DRAFT: or MEM: prefixed values
        if (raw.indexOf('DRAFT:') === 0) {
            try { return { draft: JSON.parse(raw.substring(6)), mem: [] }; } catch (e) {}
        }
        if (raw.indexOf('MEM:') === 0) {
            try { return { draft: null, mem: JSON.parse(raw.substring(4)) || [] }; } catch (e) {}
        }
        return { draft: null, mem: [] };
    }
    function _ctxWriteBlob(blob) {
        var ctx = _ctxLoadGr();
        ctx.last_utterance = 'CTX:' + JSON.stringify(blob);
        ctx.update();
    }
    function _draftLoadCtx() { return _ctxLoadGr(); }   // kept for compatibility
    function _draftRead() {
        var b = _ctxReadBlob();
        return b.draft || null;
    }
    function _draftWrite(d) {
        var b = _ctxReadBlob();
        b.draft = d;
        _ctxWriteBlob(b);
    }

    function _startRecordDraft(recordType, initialDesc) {
        if (!REQUIRED_FIELDS[recordType]) {
            return { ok: false, error: 'Unsupported record type: ' + recordType };
        }
        var d = { record_type: recordType, fields: {}, created_at: new GlideDateTime().toString() };
        if (initialDesc) d.fields.short_description = initialDesc;
        _draftWrite(d);
        var missing = REQUIRED_FIELDS[recordType].filter(function (f) { return !d.fields[f]; });
        return {
            ok: true,
            record_type: recordType,
            fields: d.fields,
            required: REQUIRED_FIELDS[recordType],
            missing: missing,
            next_prompt: missing.length ? FIELD_PROMPTS[missing[0]] : null,
            message: 'Draft started for ' + recordType + '. Ask the user for: ' + missing.join(', ')
        };
    }

    function _setRecordField(field, value) {
        var d = _draftRead();
        if (!d) return { ok: false, error: 'No draft in progress. Call start_record_draft first.' };
        if (!field) return { ok: false, error: 'Field name is required.' };
        d.fields[field] = value;
        _draftWrite(d);
        var missing = (REQUIRED_FIELDS[d.record_type] || []).filter(function (f) { return !d.fields[f]; });
        return {
            ok: true,
            updated_field: field, updated_value: value,
            fields: d.fields,
            missing: missing,
            next_prompt: missing.length ? FIELD_PROMPTS[missing[0]] : null,
            ready_to_create: missing.length === 0,
            message: missing.length
                ? 'Recorded. Still need: ' + missing.join(', ')
                : 'Recorded. All required fields are filled. Ready for review_draft + confirm_and_create.'
        };
    }

    function _reviewDraft() {
        var d = _draftRead();
        if (!d) return { ok: false, error: 'No draft to review.' };
        var missing = (REQUIRED_FIELDS[d.record_type] || []).filter(function (f) { return !d.fields[f]; });
        // Summary text for Netra to read aloud
        var summaryParts = [];
        for (var k in d.fields) {
            if (d.fields.hasOwnProperty(k)) summaryParts.push(k + ' = ' + d.fields[k]);
        }
        return {
            ok: true,
            record_type: d.record_type,
            fields: d.fields,
            summary: summaryParts.join('; '),
            missing: missing,
            ready_to_create: missing.length === 0,
            message: 'Read this back to the user and ask "shall I create it?" - do not call confirm_and_create until they say yes.'
        };
    }

    function _confirmAndCreate() {
        var d = _draftRead();
        if (!d) return { ok: false, error: 'No draft to confirm.' };
        var missing = (REQUIRED_FIELDS[d.record_type] || []).filter(function (f) { return !d.fields[f]; });
        if (missing.length) {
            return { ok: false, error: 'Cannot create yet, missing required fields: ' + missing.join(', '), missing: missing };
        }
        try {
            var table = d.record_type;
            var gr = new GlideRecord(table);
            gr.initialize();
            for (var k in d.fields) {
                if (d.fields.hasOwnProperty(k)) gr.setValue(k, d.fields[k]);
            }
            gr.opened_by = gs.getUserID();
            if (table === 'incident') gr.caller_id = gs.getUserID();
            if (table === 'problem' || table === 'change_request') gr.assigned_to = gs.getUserID();
            var sid = gr.insert();
            gr.get(sid);
            _draftWrite(null);   // clear draft
            return { ok: true, table: table, number: String(gr.number), sys_id: sid,
                     message: 'Created ' + String(gr.number) + ' successfully.' };
        } catch (e) {
            return { ok: false, error: 'Insert failed: ' + (e.message || e) };
        }
    }

    function _cancelDraft() {
        _draftWrite(null);
        return { ok: true, message: 'Draft discarded.' };
    }

    /* ===================================================================
     *  R1.3 - SIDEBAR DISCUSSION (replaces send_message_to_user)
     *
     *  Creates a sys_sidebar_discussion (private) between the current
     *  user and the recipient, then inserts the first message. The
     *  message appears as a real chat in the recipient's Now sidebar.
     * =================================================================== */
    function _sendSidebarMessage(recipientName, subject, message) {
        if (!recipientName || !message) {
            return { ok: false, error: 'Recipient and message are both required.' };
        }
        try {
            // Resolve recipient
            var u = new GlideRecord('sys_user');
            u.addQuery('active', true);
            u.addEncodedQuery('nameLIKE' + recipientName + '^ORuser_nameLIKE' + recipientName + '^ORemailLIKE' + recipientName);
            u.setLimit(1);
            u.query();
            if (!u.next()) return { ok: false, error: 'No active user matching "' + recipientName + '"' };
            var recipientId = u.getUniqueValue();
            var recipientDisplay = String(u.name);
            var senderId = gs.getUserID();
            var senderDisplay = gs.getUserDisplayName();

            var subj = subject || ('Message from ' + senderDisplay);

            // Try the modern sys_sidebar_discussion table first
            var disc, discId;
            try {
                disc = new GlideRecord('sys_sidebar_discussion');
                disc.initialize();
                disc.setValue('name',    subj);
                disc.setValue('subject', subj);
                disc.setValue('private', true);
                discId = disc.insert();
            } catch (eDisc) {
                disc = null;
            }

            // Add participants (sender + recipient)
            if (discId) {
                try {
                    var p1 = new GlideRecord('sys_sidebar_discussion_participant');
                    p1.initialize();
                    p1.setValue('discussion', discId);
                    p1.setValue('user', senderId);
                    p1.insert();

                    var p2 = new GlideRecord('sys_sidebar_discussion_participant');
                    p2.initialize();
                    p2.setValue('discussion', discId);
                    p2.setValue('user', recipientId);
                    p2.insert();
                } catch (ePart) { /* best-effort */ }

                // Insert the first message
                try {
                    var m = new GlideRecord('sys_sidebar_discussion_message');
                    m.initialize();
                    m.setValue('discussion', discId);
                    m.setValue('sender',     senderId);
                    m.setValue('message',    message);
                    m.setValue('body',       message);
                    m.insert();
                } catch (eMsg) { /* best-effort */ }

                return { ok: true, discussion_id: discId, recipient: recipientDisplay,
                         message: 'Started a Sidebar Discussion with ' + recipientDisplay + ' and sent your message.' };
            }

            // Fallback: live_message / live_group_member chain (older Now Experience)
            try {
                var lg = new GlideRecord('live_group');
                lg.initialize();
                lg.setValue('name',  subj);
                lg.setValue('group_type', 'direct_message');
                var lgId = lg.insert();
                if (lgId) {
                    ['live_group_member_profile'].forEach(function () {});
                    var p1 = new GlideRecord('live_group_profile');
                    p1.initialize();
                    p1.setValue('group',   lgId);
                    p1.setValue('profile', senderId);
                    p1.insert();
                    var p2 = new GlideRecord('live_group_profile');
                    p2.initialize();
                    p2.setValue('group',   lgId);
                    p2.setValue('profile', recipientId);
                    p2.insert();
                    var lm = new GlideRecord('live_message');
                    lm.initialize();
                    lm.setValue('group',     lgId);
                    lm.setValue('profile',   senderId);
                    lm.setValue('field',     message);
                    lm.insert();
                    return { ok: true, live_group_id: lgId, recipient: recipientDisplay,
                             message: 'Sent live chat to ' + recipientDisplay + '.' };
                }
            } catch (eLive) {}

            return { ok: false, error: 'Could not create a sidebar discussion - tables not available on this instance.' };
        } catch (e) {
            return { ok: false, error: 'Sidebar message failed: ' + (e.message || e) };
        }
    }

    /* ===================================================================
     *  R1.4 - CLAUDE-OF-SERVICENOW UPGRADES
     * =================================================================== */

    // 1. Capability tour - self-introspection
    function _listCapabilities() {
        return {
            ok: true,
            categories: [
                { name: 'Tickets',  examples: [
                    'open a ticket for ...', 'list my tickets', 'resolve INC...',
                    'escalate INC...', 'assign INC... to John Adams',
                    'change priority of INC... to high', 'summarise INC...'
                ]},
                { name: 'Other work', examples: [
                    'log a problem about ...', 'raise a change for ...',
                    'list my problems', 'list my changes', 'list my requests'
                ]},
                { name: 'Briefing & workload', examples: [
                    'morning briefing', 'what is on my plate', 'workload summary',
                    'what is overdue', 'how is my team doing'
                ]},
                { name: 'Approvals', examples: [
                    'list my approvals', 'approve CHG...', 'reject CHG... because ...'
                ]},
                { name: 'People & messages', examples: [
                    'who is John Adams', 'look up Mihir', 'tell John I will be late'
                ]},
                { name: 'Knowledge', examples: [
                    'search knowledge for VPN', 'find articles about password reset'
                ]},
                { name: 'Context & memory', examples: [
                    'what was I working on', 'what did we discuss earlier',
                    'remember that my favourite group is Database Admins'
                ]},
                { name: 'Visual analysis', examples: [
                    'look at this form and tell me what is wrong',
                    'analyse this screen'
                ]},
                { name: 'Watchlist', examples: [
                    'watch INC...', 'stop watching INC...', 'list my watchlist'
                ]},
                { name: 'Control', examples: [
                    'stop listening', 'wake up', 'pause notifications for two hours',
                    'tell a joke'
                ]}
            ],
            message: 'I can do all of the above by voice. Speak naturally - I will pick the right tool.'
        };
    }

    // 2. Persistent conversation memory - reads/writes through the unified
    //    {draft, mem} blob so it does not collide with the draft state.
    function _memRead() {
        return _ctxReadBlob().mem || [];
    }
    function _memWrite(arr) {
        var b = _ctxReadBlob();
        b.mem = arr;
        _ctxWriteBlob(b);
    }
    function _memAppend(userMsg, netraReply) {
        if (!userMsg && !netraReply) return;
        var arr = _memRead();
        arr.push({
            t: new GlideDateTime().toString(),
            u: String(userMsg || '').substring(0, 240),
            n: String(netraReply || '').substring(0, 480)
        });
        // Keep last 40 turns
        if (arr.length > 40) arr = arr.slice(arr.length - 40);
        _memWrite(arr);
    }

    function _recallPastConversations(keyword, limit) {
        var arr = _memRead();
        if (!arr.length) {
            return { ok: true, count: 0, exchanges: [],
                     message: 'I do not have any past conversations on record yet.' };
        }
        var filtered = arr;
        if (keyword) {
            var kw = keyword.toLowerCase();
            filtered = arr.filter(function (e) {
                return (e.u || '').toLowerCase().indexOf(kw) >= 0 ||
                       (e.n || '').toLowerCase().indexOf(kw) >= 0;
            });
        }
        var n = Math.min(20, Math.max(1, limit || 10));
        var slice = filtered.slice(Math.max(0, filtered.length - n));
        return {
            ok: true,
            count: slice.length,
            total_remembered: arr.length,
            keyword: keyword || null,
            exchanges: slice,
            message: 'Found ' + slice.length + ' relevant exchange' + (slice.length === 1 ? '' : 's') +
                     (keyword ? ' for "' + keyword + '"' : '') + '.'
        };
    }

    function _rememberFact(fact) {
        if (!fact) return { ok: false, error: 'Fact text is required.' };
        var arr = _memRead();
        arr.push({
            t: new GlideDateTime().toString(),
            u: '[REMEMBER]',
            n: fact
        });
        if (arr.length > 40) arr = arr.slice(arr.length - 40);
        _memWrite(arr);
        return { ok: true, message: 'Noted. I will remember that.' };
    }

    function _analyzeScreenshot(question) {
        // The actual image is sent on the next turn as inlineData in contents.
        // This tool just signals to Gemini that vision is expected.
        return {
            ok: true,
            instruction: 'The next user message will contain an inlineData PNG. Analyse it carefully and answer: ' + (question || 'what does this show?'),
            message: 'Looking at the screen now...'
        };
    }

    function _getVocab() {
        try {
            var cached = gs.getProperty(SCOPE + '.vocab_cache');
            var cachedTs = parseInt(gs.getProperty(SCOPE + '.vocab_cache_ts', '0'), 10);
            var ageMs = new Date().getTime() - cachedTs;
            if (cached && ageMs < 6 * 60 * 60 * 1000) {
                return JSON.parse(cached);
            }
        } catch (e) { /* fall through to refresh */ }

        var v = { groups: [], apps: [], categories: [], kb_titles: [], catalog_items: [], built_at: '' };

        // Assignment groups
        try {
            var gr = new GlideRecord('sys_user_group');
            gr.addQuery('active', true);
            gr.orderBy('name');
            gr.setLimit(80);
            gr.query();
            while (gr.next()) {
                var n = String(gr.name || '').trim();
                if (n && n.length < 40) v.groups.push(n);
            }
        } catch (eG) {}

        // Applications (CMDB)
        try {
            var gr2 = new GlideRecord('cmdb_ci_appl');
            gr2.addQuery('install_status', '1');
            gr2.orderBy('name');
            gr2.setLimit(60);
            gr2.query();
            while (gr2.next()) {
                var na = String(gr2.name || '').trim();
                if (na && na.length < 40) v.apps.push(na);
            }
        } catch (eA) {}

        // Incident category choices
        try {
            var gc = new GlideRecord('sys_choice');
            gc.addQuery('name', 'incident');
            gc.addQuery('element', 'category');
            gc.setLimit(30);
            gc.query();
            while (gc.next()) {
                var lbl = String(gc.label || gc.value || '').trim();
                if (lbl && lbl.length < 40) v.categories.push(lbl);
            }
        } catch (eC) {}

        // Recent published KB titles
        try {
            var gk = new GlideRecord('kb_knowledge');
            gk.addQuery('workflow_state', 'published');
            gk.orderByDesc('sys_updated_on');
            gk.setLimit(40);
            gk.query();
            while (gk.next()) {
                var t = String(gk.short_description || '').trim();
                if (t && t.length < 60) v.kb_titles.push(t);
            }
        } catch (eK) {}

        // Top catalog items
        try {
            var gci = new GlideRecord('sc_cat_item');
            gci.addQuery('active', true);
            gci.orderBy('name');
            gci.setLimit(40);
            gci.query();
            while (gci.next()) {
                var ci = String(gci.name || '').trim();
                if (ci && ci.length < 50) v.catalog_items.push(ci);
            }
        } catch (eCi) {}

        v.built_at = String(new GlideDateTime());

        try {
            gs.setProperty(SCOPE + '.vocab_cache', JSON.stringify(v));
            gs.setProperty(SCOPE + '.vocab_cache_ts', String(new Date().getTime()));
        } catch (eS) {}

        gs.info('[NetraGemini] vocab refreshed - groups=' + v.groups.length +
                ' apps=' + v.apps.length + ' cats=' + v.categories.length +
                ' kb=' + v.kb_titles.length + ' catItems=' + v.catalog_items.length);
        return v;
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
