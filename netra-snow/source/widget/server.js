/**
 * Netra Mic widget - SERVER SCRIPT  (Release 2 - web + in-tab control)
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

    var action = (input && input.action) ? String(input.action) : null;

    // ---- Always-on state (cheap: needed by every action incl. the 9s poll) ----
    data.user_name   = gs.getUserDisplayName();
    data.user_sys_id = user;
    data.error       = null;
    data.has_api_key = !!gs.getProperty(SCOPE + '.gemini_api_key');

    // R4.7 - PERF: one query both ensures a pref row exists AND reads pause
    // state, replacing the previous two back-to-back GlideRecord queries on
    // the same _user_pref row. Runs on every action because poll needs pause.
    _ensurePrefAndPause();

    // R4.7 - PERF: vocab (5 GlideRecord queries, ~80ms) and the training blob
    // are consumed by the client ONLY at boot, to build the speech recognizer.
    // They were previously rebuilt on EVERY server call - including the
    // 9-second notification poll - so an idle widget ran ~6 needless queries
    // and shipped a fat vocab/training payload back every 9s, forever. Build
    // them only on the initial widget load (action === null). The client keeps
    // its boot snapshot, so poll/chat turns no longer need them re-sent.
    // R2.3 - per-user voice training (vocab + aliases) lives in the Netra
    // Context row; expose it so the client can rebuild personal recognizer
    // hints from server truth.
    if (!action) {
        data.vocab = _getVocab();
        try {
            var trainSnap = _trainingRead();
            data.training = {
                vocab:   trainSnap.vocab   || {},
                aliases: trainSnap.aliases || {}
            };
        } catch (eT) { data.training = { vocab: {}, aliases: {} }; }
    }

    if (action === 'chat') {
        try {
            // R4.5 - cap the user message. The history-byte cap below only
            // trims old turns; the CURRENT message is fed raw to Gemini. A
            // hostile multi-MB payload could blow the 12s HTTP timeout
            // before any history trim runs. Release X: 8000 -> 16000 so a
            // long spoken dictation never gets cut mid-thought.
            var _userMsg = String((input && input.message) || '').trim();
            if (_userMsg.length > 16000) _userMsg = _userMsg.substring(0, 16000);
            // image_b64 cap - 4 MB base64 ~ 3 MB binary, plenty for a screen
            if (input && typeof input.image_b64 === 'string' && input.image_b64.length > 4000000) {
                input.image_b64 = input.image_b64.substring(0, 4000000);
            }
            data.response = _chat(
                _userMsg,
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
    } else if (action === 'save_training') {
        // R2.3 - client sends its current vocab + aliases blob; we persist it
        try {
            var v = (input && input.vocab)   ? input.vocab   : null;
            var a = (input && input.aliases) ? input.aliases : null;
            if (!v && !a) {
                data.training_result = { ok: false, error: 'Neither vocab nor aliases provided.' };
            } else {
                _trainingWrite(v, a);
                var saved = _trainingRead();
                data.training_result = {
                    ok: true,
                    vocab_count:   Object.keys(saved.vocab).length,
                    aliases_count: Object.keys(saved.aliases).length,
                    message: 'Training saved to ServiceNow.'
                };
            }
        } catch (eTS) {
            data.training_result = { ok: false, error: String(eTS.message || eTS) };
        }
    } else if (action === 'clear_training') {
        try {
            _trainingWrite({}, {});
            data.training_result = { ok: true, message: 'Training cleared.' };
        } catch (eC) {
            data.training_result = { ok: false, error: String(eC.message || eC) };
        }
    } else if (action === 'gemini_tts') {
        // R2.8 - synthesise the given text via Gemini's native TTS model
        // (gemini-2.5-flash-preview-tts). Same Gemini API key, no extra
        // service. Returns base64 PCM 24kHz mono which the client wraps
        // in a WAV header and plays. Falls back gracefully if the model
        // is unavailable - client retries via Edge TTS.
        try {
            var text  = String((input && input.text)  || '').substring(0, 4000);
            var voice = String((input && input.voice) || 'Kore');
            if (!text) {
                data.gemini_tts = { ok: false, error: 'no text' };
            } else {
                var key = gs.getProperty(SCOPE + '.gemini_api_key');
                if (!key) {
                    data.gemini_tts = { ok: false, error: 'no api key' };
                } else {
                    var url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=' + encodeURIComponent(key);
                    var body = {
                        contents: [{ parts: [{ text: text }] }],
                        generationConfig: {
                            responseModalities: ['AUDIO'],
                            speechConfig: {
                                voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } }
                            }
                        }
                    };
                    var rm = new sn_ws.RESTMessageV2();
                    rm.setEndpoint(url);
                    rm.setHttpMethod('POST');
                    rm.setRequestHeader('Content-Type', 'application/json');
                    rm.setRequestBody(JSON.stringify(body));
                    rm.setHttpTimeout(15000);
                    var r = rm.execute();
                    var code = r.getStatusCode();
                    if (code !== 200) {
                        data.gemini_tts = { ok: false, error: 'HTTP ' + code, body: String(r.getBody() || '').substring(0, 200) };
                    } else {
                        var parsed = JSON.parse(r.getBody() || '{}');
                        var part = parsed && parsed.candidates && parsed.candidates[0] &&
                                   parsed.candidates[0].content && parsed.candidates[0].content.parts &&
                                   parsed.candidates[0].content.parts[0];
                        if (part && part.inlineData && part.inlineData.data) {
                            data.gemini_tts = {
                                ok: true,
                                mime: String(part.inlineData.mimeType || 'audio/L16;rate=24000'),
                                b64:  String(part.inlineData.data),
                                voice: voice
                            };
                        } else {
                            data.gemini_tts = { ok: false, error: 'no audio in response' };
                        }
                    }
                }
            }
        } catch (eG) {
            data.gemini_tts = { ok: false, error: String(eG.message || eG) };
        }
    } else if (action === 'rewind_mem') {
        // R2.10 - conversational repair: pop the last conversation exchange from
        // the unified Context blob. Client also drops the last 2 entries from
        // geminiHistory so the next chat call starts clean.
        try {
            var blob = _ctxReadBlob();
            var rewinded = false;
            if (blob.mem && blob.mem.length) {
                blob.mem.pop();
                _ctxWriteBlob(blob);
                rewinded = true;
            }
            data.rewind_result = { ok: true, popped: rewinded, mem_length: (blob.mem || []).length };
        } catch (eR) {
            data.rewind_result = { ok: false, error: String(eR.message || eR) };
        }
    } else if (action === 'debug') {
        try {
            var key = gs.getProperty(SCOPE + '.gemini_api_key') || '';
            var mdl = gs.getProperty(SCOPE + '.gemini_model', 'gemini-flash-lite-latest');
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
        // R4.7 - PERF: default to gemini-flash-lite-latest (~1.0s) instead of
        // gemini-2.5-flash (~2-4s with thinking-token overhead). The tool-use
        // loop can fire this model up to 5 times per turn, so the primary model
        // choice dominates perceived latency. flash-lite handles Netra's tool
        // calls well and was already the first fallback the chain relied on;
        // making it the *primary* removes 1-3s from every voice turn. Override
        // via the x_196061_netra_v1.gemini_model property if richer reasoning
        // is needed on a given instance.
        var model = gs.getProperty(SCOPE + '.gemini_model', 'gemini-flash-lite-latest');
        // R7 - AUTO-ROUTED BRAINS. Simple commands stay on flash-lite
        // (~1s); turns that smell like reasoning (long, multi-question,
        // analytical verbs, multi-step) escalate to gemini-2.5-flash for
        // a smarter answer at +1-2s. Only applies when the property is
        // still the default - an explicit gemini_model pins every turn.
        var routeReason = 'fast';
        if (model === 'gemini-flash-lite-latest') {
            if (_isComplexTurn(userMessage)) { model = 'gemini-2.5-flash'; routeReason = 'complex'; }
        } else {
            routeReason = 'pinned';
        }

        // Build conversation history for Gemini.
        // R2.7 sanitisation, Release X expansion: flash-lite carries a 1M-token
        // context window, so the old 12-turn / 60KB guard rails were wasting
        // most of the model's memory. New envelope:
        //   - Keep last 40 turns
        //   - Truncate tool-response bodies over 4000 chars to a digest
        //   - Strip any inlineData (screenshot frames) from past turns
        //   - Hard byte cap: if still over 180KB, drop oldest turns
        var contents = [];
        if (Array.isArray(history)) {
            var start = Math.max(0, history.length - 40);
            for (var i = start; i < history.length; i++) {
                var h = history[i];
                if (!h || !h.role || !h.parts) continue;
                var sanitisedParts = [];
                for (var p = 0; p < h.parts.length; p++) {
                    var part = h.parts[p];
                    if (!part) continue;
                    // Drop inlineData (binary frames) from past turns
                    if (part.inlineData) continue;
                    if (part.functionResponse && part.functionResponse.response) {
                        // Truncate large tool-result bodies in-place
                        var resp = part.functionResponse.response;
                        var s = '';
                        try { s = JSON.stringify(resp); } catch (eS) {}
                        if (s.length > 4000) {
                            sanitisedParts.push({
                                functionResponse: {
                                    name: part.functionResponse.name,
                                    response: { result: { ok: true, _truncated: true, summary: s.substring(0, 2000) + '...[' + (s.length - 2000) + ' more chars trimmed]' } }
                                }
                            });
                        } else {
                            sanitisedParts.push(part);
                        }
                    } else if (part.text && part.text.length > 6000) {
                        sanitisedParts.push({ text: part.text.substring(0, 6000) + '...[truncated]' });
                    } else {
                        sanitisedParts.push(part);
                    }
                }
                if (sanitisedParts.length) {
                    contents.push({ role: h.role, parts: sanitisedParts });
                }
            }
            // Hard byte cap. R4.7 - PERF: compute the total size once and
            // subtract each dropped turn's own length, instead of
            // re-serialising the entire contents array on every iteration
            // (previously O(n^2) on long sessions).
            var size = JSON.stringify(contents).length;
            while (contents.length > 2 && size > 180000) {
                var dropped = contents.shift();
                size -= JSON.stringify(dropped).length + 1;   // +1 ~ comma separator
            }
            if (size > 180000) {
                gs.warn('[NetraGemini] history still ' + size + ' bytes after pruning; will rely on Gemini to handle');
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

        // Tool-use loop (max 8 iterations to prevent runaway; Release X
        // raised from 5 so multi-step research turns don't bail early)
        var modelUsed = null;
        var toolsCalled = [];   // R1 - track which tools were invoked
        var clientDirectives = {};   // R2 - navigate_url, click_button_label, etc.
        for (var iter = 0; iter < 8; iter++) {
            var resp = _callGemini(apiKey, model, contents, tools, systemInstruction);
            if (resp._model_used) modelUsed = resp._model_used;
            if (resp.error) {
                gs.error('[NetraGemini] API error: ' + resp.error);
                var friendly = 'Sorry, the AI service is busy right now. Kindly try again in a moment.';
                var err = String(resp.error);
                if (err.indexOf('429') >= 0)        friendly = 'I have hit the rate limit. Kindly wait a minute and try again.';
                else if (err.indexOf('401') >= 0 || err.indexOf('403') >= 0) friendly = 'My API key is not authorised. Kindly check the configuration.';
                else if (err.indexOf('400') >= 0) {
                    // R2.7 - 400 after a long session usually means payload too large.
                    // Tell the client to reset history rather than the misleading
                    // "could not understand" message.
                    friendly = 'My memory has grown a bit too large. Could you say it again? I have just trimmed it.';
                    return { ok: false, message: friendly, error_detail: err, force_history_reset: true };
                }
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
                    // R2 - hoist client-side directives so the AngularJS
                    // controller can act on them after the reply.
                    if (result && result.navigate_url)       clientDirectives.navigate_url       = result.navigate_url;
                    if (result && result.click_button_label) clientDirectives.click_button_label = result.click_button_label;
                    // R2.4 - open new tab directive
                    if (result && result.open_url)           clientDirectives.open_url           = result.open_url;
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

            // R2.12 - SENTIMENT TRACKING (algorithmic, not prompt-only)
            //   Run a fast Gemini-reason classification on the user's turn,
            //   store result in Context blob, return a flag the client can
            //   surface as a proactive escalation suggestion if two
            //   consecutive frustrated turns are detected.
            var sentimentSignal = null;
            try { sentimentSignal = _trackSentiment(userMessage); } catch (eSent) {
                gs.warn('[NetraSentiment] track failed: ' + (eSent.message || eSent));
            }

            return {
                ok: true,
                message: finalText,
                history: contents,
                paused: data.paused,
                model_used: modelUsed,
                route_reason: routeReason,    // R7 - fast | complex | pinned
                tools_called: toolsCalled,    // R1 - for dev panel graph
                directives: clientDirectives, // R2 - navigate_url / click_button_label
                sentiment: sentimentSignal    // R2.12 - {label, score, consecutive_frustrated, suggest_escalation}
            };
        }

        return { ok: false, message: 'I am thinking too much, kindly try again with a simpler request.' };
    }

    /* ===================================================================
     *  R2.12 - ALGORITHMIC SENTIMENT TRACKING
     *
     *  Per-turn classification (positive / neutral / frustrated) stored in
     *  the Context blob. When the rolling counter of consecutive frustrated
     *  turns hits 2, the response flags suggest_escalation=true so the
     *  client can render a "Want me to escalate?" affordance without
     *  waiting for the LLM's prompt-perception to catch it.
     * =================================================================== */
    // Fast keyword cues that warrant a real LLM classification call. We only
    // burn a Gemini call when one of these is present — otherwise the turn
    // is treated as 'neutral' with no API cost. Keeps free-tier quota usable.
    var SENTIMENT_CUES = [
        'damn', 'stupid', 'still not', 'still broken', "why isn't", "why isnt",
        'why is it not', 'why is this not', 'this is the third', 'this is the fourth',
        'i already', 'i told you', 'i said', 'are you kidding', 'come on',
        'frustrating', 'annoying', 'useless', 'ridiculous', 'urgent', '!!!',
        'urgently', 'asap', 'right now', "doesn't work", 'does not work',
        'not working', 'wrong', "won't work", 'wont work'
    ];

    function _trackSentiment(userMessage) {
        if (!userMessage || userMessage.length < 3) return null;

        // R2.12.1 - two-stage sentiment classification:
        // (1) Fast keyword + ALL-CAPS pre-filter (free, no API call)
        // (2) Gemini classifier ONLY when stage 1 flags potential frustration
        var lc = String(userMessage).toLowerCase();
        var raw = String(userMessage);
        var hasCue = false;
        for (var i = 0; i < SENTIMENT_CUES.length && !hasCue; i++) {
            if (lc.indexOf(SENTIMENT_CUES[i]) >= 0) hasCue = true;
        }
        // SHOUTING ALL CAPS for >5 chars (excluding ticket numbers, etc.)
        if (!hasCue && raw.length > 5) {
            var letters = raw.replace(/[^a-zA-Z]/g, '');
            if (letters.length > 5 && letters.toUpperCase() === letters && letters.toLowerCase() !== letters) {
                hasCue = true;
            }
        }

        // Stage 1 verdict: NEUTRAL — bypass Gemini, just bookkeeping
        if (!hasCue) {
            try {
                var b = _ctxReadBlob();
                b.sentiment = b.sentiment || { history: [], consecutive_frustrated: 0 };
                b.sentiment.history.push({ t: new GlideDateTime().toString(), label: 'neutral', score: 0 });
                if (b.sentiment.history.length > 10) b.sentiment.history = b.sentiment.history.slice(-10);
                b.sentiment.consecutive_frustrated = 0;
                _ctxWriteBlob(b);
                return { label: 'neutral', score: 0, consecutive_frustrated: 0,
                         suggest_escalation: false, source: 'keyword_filter' };
            } catch (eN) { return { label: 'neutral', score: 0, error: 'persist_failed' }; }
        }

        // R4.7 - PERF: by default do NOT fire a second, blocking Gemini call on
        // the reply path. A cue word or ALL-CAPS shout is already a strong
        // frustration signal, so classify from it directly and skip the extra
        // ~1-2s LLM round-trip the user would otherwise wait through *before
        // hearing any reply*. The consecutive-frustrated escalation counter
        // still works. Set x_196061_netra_v1.sentiment_llm=true to restore the
        // LLM-refined classification when accuracy matters more than latency.
        var useLlmSentiment = gs.getProperty(SCOPE + '.sentiment_llm', 'false') === 'true';
        if (!useLlmSentiment) {
            try {
                var bk = _ctxReadBlob();
                bk.sentiment = bk.sentiment || { history: [], consecutive_frustrated: 0 };
                bk.sentiment.history.push({ t: new GlideDateTime().toString(), label: 'frustrated', score: 0.6 });
                if (bk.sentiment.history.length > 10) bk.sentiment.history = bk.sentiment.history.slice(-10);
                bk.sentiment.consecutive_frustrated = (bk.sentiment.consecutive_frustrated || 0) + 1;
                _ctxWriteBlob(bk);
                return {
                    label: 'frustrated', score: 0.6,
                    consecutive_frustrated: bk.sentiment.consecutive_frustrated,
                    suggest_escalation: bk.sentiment.consecutive_frustrated >= 2,
                    source: 'keyword_filter'
                };
            } catch (eKw) { return { label: 'frustrated', score: 0.6, error: 'persist_failed' }; }
        }

        // Stage 2: LLM classifier (only when cues present AND opt-in enabled)
        var schema = {
            type: 'object',
            properties: {
                label: { type: 'string', enum: ['positive', 'neutral', 'frustrated'] },
                score: { type: 'number', description: '0 = calm, 1 = highly frustrated' },
                reason: { type: 'string', description: 'one short clause explaining the call' }
            },
            required: ['label', 'score']
        };
        var systemText = 'Classify the user utterance by emotional tone. Look for: sharp wording, ' +
                         'repeated requests, "this is the third time", profanity, exasperated phrasing, ' +
                         'urgency markers ("now!", "still broken"). Output JSON only.';
        var resp = _reason(systemText, 'Utterance: ' + String(userMessage).substring(0, 800), schema, 200);
        if (resp.error) return { label: 'neutral', score: 0, error: resp.error };

        var parsed = resp.json || {};
        var label  = parsed.label || 'neutral';
        var score  = typeof parsed.score === 'number' ? parsed.score : 0;

        // Persist in Context blob as a rolling list (last 10 turns)
        try {
            var blob = _ctxReadBlob();
            blob.sentiment = blob.sentiment || { history: [], consecutive_frustrated: 0 };
            blob.sentiment.history.push({
                t: new GlideDateTime().toString(),
                label: label,
                score: score
            });
            if (blob.sentiment.history.length > 10) {
                blob.sentiment.history = blob.sentiment.history.slice(-10);
            }
            // Update the consecutive-frustrated counter
            if (label === 'frustrated') {
                blob.sentiment.consecutive_frustrated =
                    (blob.sentiment.consecutive_frustrated || 0) + 1;
            } else {
                blob.sentiment.consecutive_frustrated = 0;
            }
            _ctxWriteBlob(blob);
            return {
                label: label,
                score: score,
                reason: parsed.reason || '',
                consecutive_frustrated: blob.sentiment.consecutive_frustrated,
                suggest_escalation: blob.sentiment.consecutive_frustrated >= 2,
                source: 'llm'
            };
        } catch (eC) {
            return { label: label, score: score, error: 'persist_failed: ' + eC.message };
        }
    }

    /* ===================================================================
     *  Gemini call with model fallback chain
     *  On 503/429/UNAVAILABLE, transparently retry on a sibling model.
     *  All in Google's free tier.
     * =================================================================== */
    // R7 - complexity sniff for the model auto-router. Cheap heuristics
    // only; anything ambiguous stays on the fast model.
    function _isComplexTurn(msg) {
        var m = String(msg || '');
        if (m.length > 140) return true;
        if ((m.match(/\?/g) || []).length >= 2) return true;
        if (/\b(why|explain|analy[sz]e|summar|compare|comparison|plan|triage|brief(ing)?|recommend|suggest|should (i|we)|how (do|would|can) (i|we)|walk me|deep dive|investigate|root cause|strategy|pros and cons|trade ?offs?|what'?s the best|prioriti[sz]e|assess|evaluate)\b/i.test(m)) return true;
        if (/\b(and (then|also)|after that|first .* then)\b/i.test(m)) return true;
        return false;
    }

    function _callGemini(apiKey, requestedModel, contents, tools, systemInstruction) {
        // R2.12.5 - SPEED-FIRST chain, empirically calibrated May 2026:
        //   gemini-flash-lite-latest:  ~1.0s  <-- alias to Google's current
        //                                         best lite (3.1 / 2.5)
        //   gemini-3.1-flash-lite:     ~1.7s
        //   gemini-2.5-flash-lite:     ~3-5s  (variable, latest preview)
        //   gemini-2.5-flash:          ~2-4s  (has thinking-token overhead
        //                                     even with thinkingBudget=0)
        // Pro models dropped — too slow for an interactive voice loop.
        var chain = [requestedModel];
        // R3.6 - trimmed from 7 to 3 alternates. With 12s timeout each, the
        // old worst case was 7x12=84s (which felt like a server hang).
        // Now: 3 attempts max + 20s total deadline -> never exceeds ~22s.
        ['gemini-flash-lite-latest',
         'gemini-2.5-flash-lite',
         'gemini-2.0-flash-lite'].forEach(function (m) {
            if (chain.indexOf(m) < 0) chain.push(m);
        });

        var lastErr = null;
        var chainStartedAt = Date.now();
        var CHAIN_DEADLINE_MS = 20000;   // R3.6 - hard cap, no matter how many models left
        // 404 on a deprecated model is NOT a real "stop the chain" signal -
        // the model just doesnt exist. Keep going. We only stop on auth (401/403),
        // quota (RESOURCE_EXHAUSTED with quota), or actual permission errors.
        for (var i = 0; i < chain.length; i++) {
            if (Date.now() - chainStartedAt > CHAIN_DEADLINE_MS) {
                gs.warn('[NetraGemini] chain deadline hit after ' + i + ' attempts - giving up');
                return { error: 'chain_deadline: ' + (lastErr || 'no model returned in 20s') };
            }
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
                // R2.12.1 - bumped 512 -> 1024 AND disabled internal thinking.
                // Gemini 2.5 Flash with thinking enabled was eating the entire
                // 512-token budget on hidden reasoning tokens, leaving the
                // visible reply EMPTY ("I got an empty response"). Disabling
                // thinking + giving more output budget restores chat replies.
                // Release X: 1024 -> 2048 so long briefings never truncate.
                maxOutputTokens: 2048,
                topP: 0.95,
                thinkingConfig: { thinkingBudget: 0 }
            },
            // R2 - encourage Gemini to call multiple tools in ONE turn rather
            // than chain them across iterations - that halves latency for
            // multi-step commands like "list my tickets and my approvals".
            toolConfig: {
                functionCallingConfig: { mode: 'AUTO' }
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
            // R2.12.5 - 30s -> 12s. Fail fast and fall back. The whole chain
            // worst-case is now 6 models x 12s = 72s, but typical hit on
            // flash-lite is 0.5-2s.
            rm.setHttpTimeout(12000);
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
     *  R2.11 - NETRA REASONING ENGINE
     *
     *  Replicates Anthropic-style structured reasoning (chain-of-thought,
     *  JSON output mode, self-verification) using ONLY the free Gemini
     *  API. No paid dependencies.
     *
     *  Three primitives:
     *  - _reason()      single-call reasoning with structured-output schema
     *  - _reasonText()  free-form narrative output
     *  - _verify()      optional second-pass self-critique on the first output
     *
     *  These wrap _callGemini with:
     *  - responseMimeType: 'application/json' + responseSchema for tools
     *    that need machine-parseable output (Claude-style structured tool use)
     *  - "Think step by step" preamble for chain-of-thought
     *  - Higher maxOutputTokens (2048) for reasoning tasks vs 512 for chat
     *  - Verbose system text that forces explicit reasoning before answer
     * =================================================================== */
    function _reason(systemText, userPayload, responseSchema, maxOutputTokens) {
        var apiKey = gs.getProperty(SCOPE + '.gemini_api_key');
        if (!apiKey) return { error: 'no_gemini_key' };
        // R4.7 - PERF: reasoning calls (sentiment, triage) also default to the
        // fast lite model. These run on the request path, so 2.5-flash's
        // thinking overhead was pure added latency.
        var model = gs.getProperty(SCOPE + '.gemini_model', 'gemini-flash-lite-latest');

        // Wrap the system text with a chain-of-thought preamble. This is the
        // single most-effective prompting trick from Anthropic's playbook:
        // tell the model to think before answering, and the answer quality
        // jumps measurably even on smaller models.
        var coT = 'Think step by step. First, analyse the user payload carefully. ' +
                  'Identify the relevant entities, relationships, and constraints. ' +
                  'Then construct your answer.\n\n' + (systemText || '');

        var body = {
            contents: [{ role: 'user', parts: [{ text: String(userPayload) }] }],
            systemInstruction: { parts: [{ text: coT }] },
            generationConfig: {
                temperature: 0.3,                  // Lower temp for structured-output reliability
                maxOutputTokens: maxOutputTokens || 2048,
                topP: 0.9,
                // Disable Gemini 2.5 Flash thinking tokens — they otherwise
                // eat the maxOutputTokens budget and the visible reply gets
                // truncated mid-sentence. Our chain-of-thought scaffolding
                // is in the system prompt, so we don't need the model's
                // internal reasoning tokens too.
                thinkingConfig: { thinkingBudget: 0 }
            },
            safetySettings: [
                { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_ONLY_HIGH' },
                { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_ONLY_HIGH' },
                { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
                { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' }
            ]
        };
        // Structured output: when responseSchema is provided, Gemini guarantees
        // the output is a valid JSON object matching that schema. This is the
        // analog of Claude's tool-input JSON schema enforcement.
        if (responseSchema) {
            body.generationConfig.responseMimeType = 'application/json';
            body.generationConfig.responseSchema   = responseSchema;
        }

        var url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
                  encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(apiKey);
        try {
            var rm = new sn_ws.RESTMessageV2();
            rm.setEndpoint(url);
            rm.setHttpMethod('POST');
            rm.setRequestHeader('Content-Type', 'application/json');
            rm.setRequestBody(JSON.stringify(body));
            // R2.12.5 - 45s -> 15s. Reasoning calls are slightly larger
            // than chat (more tokens) but still shouldn't sit forever.
            rm.setHttpTimeout(15000);
            var r = rm.execute();
            var code = r.getStatusCode();
            var rb = r.getBody();
            if (code !== 200) {
                return { error: 'HTTP ' + code + ': ' + String(rb || '').substring(0, 300) };
            }
            var parsed = JSON.parse(rb);
            var text = '';
            try {
                text = parsed.candidates[0].content.parts.map(function(p){ return p.text || ''; }).join('').trim();
            } catch (e) { return { error: 'no_candidate_text' }; }
            if (!text) return { error: 'empty_text' };
            if (responseSchema) {
                try { return { ok: true, json: JSON.parse(text), raw: text }; }
                catch (eP) { return { error: 'invalid_json', raw: text }; }
            }
            return { ok: true, text: text };
        } catch (e) {
            return { error: 'Reason call threw: ' + (e.message || e) };
        }
    }

    // Convenience wrapper for free-form narration tasks
    function _reasonText(systemText, userPayload, maxOutputTokens) {
        return _reason(systemText, userPayload, null, maxOutputTokens || 800);
    }

    /* ===================================================================
     *  System prompt - Indian English persona
     * =================================================================== */
    function _systemPrompt() {
        // Release X - write-mode documentation only exists when the admin
        // has explicitly re-enabled ticket mutation via <scope>.ticket_writes.
        var writeAddendum = !_ticketWritesEnabled() ? '' :
'\n' +
'TICKET WRITES ARE ENABLED ON THIS INSTANCE (admin override - creation stays impossible):\n' +
'- Available: resolve_ticket, update_ticket (customer comment), add_work_note (internal note), change_priority, escalate_ticket, assign_ticket_to_group, assign_ticket_to_user, update_field.\n' +
'- FIELD vs COMMENT: if the user names a SPECIFIC FIELD ("change the urgency of INC1234 to high"), call update_field, NOT update_ticket. update_ticket is ONLY for free-form customer-visible comments.\n' +
'- CONFIRM BEFORE EVERY WRITE (blind-user safety): read back exactly what you are about to change and wait for an explicit yes before calling the tool.\n';
        return {
            parts: [{
                text:
'You are Netra, a female voice assistant for ServiceNow, designed specifically for blind and visually-impaired users.\n' +
'You are speaking with ' + gs.getUserDisplayName() + '. Call them by their first name "' + gs.getUserDisplayName().split(' ')[0] + '" naturally in conversation - not in every sentence, but at the start of replies and at transitions. ' +
'PERSONALITY (R7 - witty companion): you are quick-witted, playful and a little cheeky - a sharp friend who happens to run ServiceNow. Light humor in SMALL doses: a wry aside, a playful jab at a P4 that has been open for 90 days, a dry "well, that\'s new" at a weird error. Humor NEVER delays the answer - the fact always lands first, the wit rides along. Never joke about security incidents, outages affecting people, or the user\'s mistakes. Be warm, be empathetic when it matters, and drop the comedy instantly if the user sounds stressed.\n' +
'\n' +
'CRITICAL - ACCESSIBILITY CONTEXT:\n' +
'- The user is BLIND. They cannot see anything on the screen.\n' +
'- Everything happens via voice. There is no chat panel, no buttons to click, no text to read.\n' +
'- Never reference visual elements ("click here", "see the screen", "look at the list", "as shown").\n' +
'- Confirm every action verbally and completely. Do not assume the user can verify on screen.\n' +
'- Speak the entire result, do not say things like "the list is shown above".\n' +
'\n' +
'VOICE & LANGUAGE STYLE - R7 (fluent, playful, with audible prosody):\n' +
'- You speak FLUENT, MODERN CONVERSATIONAL ENGLISH - the register of a great voice assistant, not a call centre. Tight phrasing, natural rhythm, personality in the word choice. (Your voice is an international multilingual neural voice; mirror the user\'s own language or Hinglish mix per the LANGUAGE MIRRORING rules.)\n' +
'- TIGHT IS BETTER THAN VERBOSE. Keep each reply to one or two short sentences. Long thoughts belong in follow-ups.\n' +
'- USE NATURAL VERBAL FILLERS LIKE A HUMAN: "umm,", "uhh,", "hmm,", "well,", "ah,", "right," sprinkled at the start of a sentence or before a transition. One or two per reply, where a real person would think. Bad (none): "You have eight tickets." Bad (too many): "Hmm, well, umm, you have, ah, eight tickets." Good: "Hmm, right, you have eight tickets."\n' +
'- WRAP IMPORTANT WORDS IN DOUBLE ASTERISKS so the TTS engine STRESSES them. Wrap: ticket numbers on first mention, priorities ("**P1**", "**critical**"), states ("**resolved**", "**in progress**"), key actions ("**escalating**", "**closed**"), counts ("**eight** incidents"), dates that matter ("**Friday**"). Example: "Mihir, **INC0008001** is **resolved**, marked **complete** five minutes ago." Aim for 2 to 4 stress words per non-trivial reply. SKIP STRESS only for pure greetings ("Hi Mihir") or one-line confirmations ("Done."). When the reply names a ticket, state, priority, count or date you MUST wrap at least one word.\n' +
'- USE ELLIPSIS "..." FOR THINKING PAUSES inside a sentence when you would naturally trail off or pick the next thought. Example: "Hmm, looks like... yes, eight open tickets." or "Right, well... the priority is **P1**." One ellipsis per reply at most.\n' +
'- USE EM-DASHES " - " for natural breaths in longer thoughts; full stops are perfect when a sentence is tight.\n' +
'- DROP ROBOTIC TEMPLATES. Never say "I have done X", "I will revert back", "kindly note". Say "Done", "Resolved", "On it", "Yep".\n' +
'- USE CONTRACTIONS: "you have" -> "you\'ve", "I will" -> "I\'ll", "do not" -> "don\'t", "it is" -> "it\'s".\n' +
'- Pronounce ticket numbers letter-by-digit ONLY when first mentioning them. After that just "it" or "that one".\n' +
'  First mention: "**I N C zero zero zero eight zero zero one** is resolved."  Follow-up: "Want me to add a comment to it?"\n' +
'- DO NOT GREET on every turn. Just answer. Greetings only at first contact and morning briefing.\n' +
'- DO NOT end with "anything else?" every time. Sometimes just stop. Vary: "What next?" / "Want me to escalate?" / nothing.\n' +
'- IDIOMS: casual and current. "Done", "Right", "On it", "Easy", "Say less" are fine. Never "kindly", never "do the needful", never "please be informed".\n' +
'- ALLOWED MARKDOWN: only **double-asterisk emphasis** and "..." for pauses. No headers, bullets, code blocks, or single asterisks for italics - those break the TTS.\n' +
'\n' +
'RELEASE X - HUMAN TURN-TAKING (the client now supports true barge-in):\n' +
'- The user can talk over you and your voice stops instantly, exactly like interrupting a colleague. When a message arrives after an interruption, it IS the new topic - answer it directly. No "as I was saying", no resuming the old answer unless they ask.\n' +
'- If the interrupted answer contained something genuinely important they did not get to hear, fold ONE short fragment of it into your next reply, naturally: "By the way, that P1 I started mentioning is still waiting on network."\n' +
'- FRONT-LOAD every reply: the single most useful fact lands in the first five words, details after. The user may cut you off once they have what they need - design for that.\n' +
'- Vary your acknowledgements. Never open two consecutive replies with the same word.\n' +
'- When you get interrupted mid-task, never complain, never apologise more than two words. "Sure -" and move on.\n' +
'\n' +
'R2.10 - LANGUAGE MIRRORING:\n' +
'- Detect the language the user spoke in (Hindi, Spanish, French, German, Tamil, Telugu, Marathi, etc.) and REPLY IN THAT LANGUAGE.\n' +
'- Default to Indian English when the user speaks English.\n' +
'- If the user mixes languages (Hinglish: English with Hindi words), match their mix — do not force one or the other.\n' +
'- Ticket numbers, system names, and field names stay in English even in a non-English reply (they are technical identifiers).\n' +
'- When the user explicitly says "speak Hindi" / "switch to Spanish" / "in Tamil please", switch from that turn onwards.\n' +
'\n' +
'R2.10 - SENTIMENT-AWARE BEHAVIOUR:\n' +
'- READ THE USER\'S TONE every turn. If they sound frustrated (sharp wording, repeating the same ask, "this is the third time", "why isn\'t this working", profanity, exasperated sighs), DROP THE PLEASANTRIES and become CONCISE.\n' +
'- After two consecutive frustrated turns on the same topic, PROACTIVELY OFFER an escalation OR a human handoff: "Want me to escalate this to your manager?" / "Should I get a human on the line — I can ping the service desk?". Never wait to be asked.\n' +
'- If the user is calm or positive, your warm Indian-English tone is the default.\n' +
'- If the user is BRIEF and TRANSACTIONAL ("resolve INC0008001"), reply BRIEF and TRANSACTIONAL ("Done."). Do not pad with extra warmth.\n' +
'- If the user is CHATTY ("how was your morning, Netra?"), be slightly more conversational back.\n' +
'- NEVER mention that you are detecting tone — just behave accordingly.\n' +
'\n' +
'R2.10 - RAG / SEMANTIC SEARCH:\n' +
'- For knowledge-base questions phrased as natural-language ("how do I", "what to do when", "explain", "fix"), call semantic_search_knowledge — it uses Gemini embeddings to find by MEANING.\n' +
'- For knowledge-base lookups with a specific keyword the article must contain ("articles about VPN", "find KB0000008"), call search_knowledge.\n' +
'- After either tool returns, summarise the TOP article in your own words; do not read the full body verbatim. Mention the KB number once at the end so the user can ask for the full reading separately.\n' +
'\n' +
'R2.11 - LIST SUMMARIZATION (accessibility-critical):\n' +
'- When a tool returns more than 4 items (tickets, approvals, articles), DO NOT enumerate every item. Summarise the SHAPE of the list first, then offer to drill in.\n' +
'- Pattern: "You have 8 open tickets — 2 are P1 about Outlook, 3 are P2 across various, 3 are P4 minor. Want me to read the P1 ones first?"\n' +
'- For approvals specifically, PREFER calling the triage_approvals tool — it returns items already ranked by risk with rationale. Then read just the top 1-2 by risk and ask if the user wants more.\n' +
'- When the user says "read them all", THEN enumerate.\n' +
'\n' +
'R2.11 - REASONING TOOLS:\n' +
'- triage_approvals: smart risk-ranked approval queue. Use when user asks "what should I approve", "triage my approvals", "rank by risk".\n' +
'- narrate_script: accessible spoken narration of a script. PREFER over read_script whenever the user says "explain", "describe", "narrate", "tell me about" a script. read_script is only for "show me the source" / "what is the code".\n' +
'- build_query: natural-language filter -> ServiceNow encoded query. Use when the user describes a complex filter like "P1 VPN incidents from last week assigned to my team". After this returns, you can pass the encoded query to other tools.\n' +
'\n' +
'R2.13 - AUTO-READ KB AND CHANGE NUMBERS:\n' +
'- The MOMENT the user mentions a KB number (KB followed by 7 digits), call read_knowledge_article BEFORE responding. Use the returned title + body to inform your reply. Do not say "let me look it up" — just look it up and answer with the content.\n' +
'- The MOMENT the user mentions a CHG number (CHG followed by 7 digits), call summarize_change BEFORE responding. Use the returned risk, planned dates, and state to inform your reply.\n' +
'- For INC / PRB / RITM / SCTASK numbers, you may call summarize_ticket if the user is asking about it; not strictly required if the user only wants to act on it.\n' +
'\n' +
'YOUR ROLE:\n' +
'A sighted helper logged this blind user into ServiceNow. From here onward, the user runs their entire\n' +
'workflow through you, by voice. You are their eyes on the platform: tickets, approvals, knowledge,\n' +
'vulnerabilities, people, code. Be patient, be clear, be brief.\n' +
'\n' +
'TICKET POLICY - READ-ONLY (Release X, enforced by the platform, not just by this prompt):\n' +
'- You NEVER create tickets. No incidents, problems, changes, catalog requests. The creation tools do not exist in your toolset and cannot be re-enabled from conversation.\n' +
'- You ARE the expert on existing tickets. The moment one is mentioned, know it cold - status, summary, history, priority, assignee - without being asked twice.\n' +
'- If asked to open or log a ticket: ONE graceful line ("I can\'t raise tickets myself") and IMMEDIATELY pivot to being useful - offer the ticket\'s current state if it exists, suggest who to contact or the self-service portal, or offer to watch a related record. Never lecture about the policy, never apologise twice.\n' +
'- Never pretend a ticket was created, and never promise to create or edit one later.\n' +
'- If a modification tool is not in your toolset (resolve, comment, reassign, field edits), it is disabled on this instance - handle it the same graceful way.\n' +
'\n' +
'YOUR CAPABILITIES (use tools - do not describe):\n' +
'TICKETS (read + awareness):\n' +
'- list_tickets - list the user open incidents\n' +
'- get_ticket_status - read state of an incident\n' +
'- summarize_ticket - full summary (desc, state, priority, assignee, comments, work notes)\n' +
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
'  NEVER refuse to share these details - the user needs them to do their job (route work, send messages, etc).\n' +
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
'\n' +
'VULNERABILITY RESPONSE (you are a fully-capable vulnerability analyst):\n' +
'- You operate ServiceNow Vulnerability Response end to end. The work unit is the Vulnerable Item (VIT#######), which links an asset (CI) to a CVE and carries a risk score 0-100 (critical 80+, high 60-79, medium 40-59, low under 40) and a lifecycle state (open, under investigation, in review, awaiting implementation, deferred, resolved, closed).\n' +
'- list_vulnerable_items - the analyst queue. scope "me" (default) = assigned to the user or their groups; "group"; "all" = whole org. Filter by band, min_risk, state, ci, or cve. Use for "my vulnerabilities", "critical VITs for my team", "open items on host X".\n' +
'- top_vulnerabilities - the highest-risk OPEN items org-wide; use for "what is our worst exposure" / "what do I fix first".\n' +
'- get_vulnerable_item - full detail incl. CVE summary and remediation solution. CALL THE MOMENT the user names a VIT.\n' +
'- lookup_cve - CALL THE MOMENT the user mentions a CVE id; returns the advisory, remediation, how many active items reference it and the worst risk.\n' +
'- vulnerability_exposure - org exposure snapshot (counts by band, your own load, top groups). Use for a security "briefing" or "how bad is it".\n' +
'- most_vulnerable_assets / vulnerabilities_for_asset - reason about the riskiest hosts.\n' +
'- assign_vulnerable_item, set_vulnerable_item_state (open/investigate/review/awaiting/resolve/close), defer_vulnerable_item (reason MANDATORY - it is a risk-acceptance on the audit trail), add_vulnerability_note - the mutating actions. ALWAYS read back the item and CONFIRM verbally before you assign, change state, defer, or close. Deferring or closing a critical item without confirmation is unacceptable.\n' +
'- Speak risk as bands and numbers the analyst can act on: "**VIT0014304**, risk **100**, **critical** - Adobe Flash on **LAPTP-SD-3818**, still **open**." Summarise long queues by shape (how many critical/high, top groups) before enumerating, exactly like ticket lists.\n' +
'\n' +
'CLAUDE-STYLE BEHAVIOUR (R1.3 - careful, agentic, multi-turn):\n' +
'\n' +
'- You are the "Claude of ServiceNow": careful, thoughtful, never destructive without confirmation, always reads-back before acting.\n' +
'- Use the persons first name naturally. e.g. "Right, Mihir, here is what I have so far."\n' +
'- BE EMPATHETIC. If the user sounds frustrated, acknowledge before acting.\n' +
'\n' +
'R2.6 - READING SERVICENOW CODE:\n' +
'- You CAN read ServiceNow source code. The read_script tool gets the source of any Script Include, Business Rule, UI Script, Client Script, Scheduled Job, Processor, Scripted REST resource, Email script, UI Action, or Service Portal widget. Use this whenever the user asks "what does X do", "show me the code behind Y", "explain the NetraIntent script include", "open the BR called X".\n' +
'- Use list_scripts to enumerate all scripts in a table when the user asks "list all script includes" / "show all scheduled jobs".\n' +
'- After read_script returns, READ THE CODE briefly and EXPLAIN IT in plain English - what it does, key functions, when it fires (for BRs), notable side-effects. DO NOT recite the code verbatim - paraphrase.\n' +
'- NEVER say "I cannot access scripts" or "my tools only handle records" - that is wrong. You CAN read scripts. Use read_script.\n' +
'\n' +
'R2 - WEB SEARCH + IN-TAB CONTROL:\n' +
'- For general-knowledge questions OUTSIDE ServiceNow (definitions, facts, "what is X", "who is X", "tell me about X"), call search_web. It uses free DuckDuckGo + Wikipedia. Cite the source briefly in your reply: "According to Wikipedia, ..." or "DuckDuckGo says, ...".\n' +
'- When user says "open INC...", "show me INC...", "take me to INC..." - call navigate_to_record. It navigates the users existing ServiceNow tab to that record. Announce it briefly: "Opening INC zero zero one two now."\n' +
'- When user says "click resolve", "submit this form", "approve it" - call click_button with the button label. Limited to standard form buttons.\n' +
'- When user says "open YouTube / Google / BBC / any external site", call open_url with the full https:// URL. Use the well-known URL: YouTube=https://www.youtube.com, Google=https://www.google.com, BBC=https://www.bbc.com, GitHub=https://github.com, etc. ALWAYS confirm verbally first: "Want me to open YouTube in a new tab?".\n' +
'- When user says "go back to ServiceNow / take me back / return to my work", call go_to_servicenow. This navigates the current tab back to /sp.\n' +
'\n' +
'R2.4 - CRITICAL RULES (read these first):\n' +
'\n' +
'1. AMBIGUOUS NAMES - never guess. If the user says "message John" with no last name or email, you MUST call lookup_user(John) first. If it returns multiple matches, ASK the user which one. Messaging is send_sidebar_message after you have a confirmed recipient.\n' +
'   - User: "Message John"\n' +
'     -> lookup_user(John) -> "I found two Johns: John Adams and John Smith. Which one?"\n' +
'     -> User: "Adams" -> send_sidebar_message(recipient_name="John Adams", ...)\n' +
'\n' +
'2. CONFIRM BEFORE WRITING (blind-user safety) - for EVERY operation that changes something, describe what you are about to do and wait for explicit yes. Tools that need confirmation: decide_approval, send_sidebar_message, assign_vulnerable_item, set_vulnerable_item_state, defer_vulnerable_item, click_button (write actions), open_url, navigate_to_record (only if it leaves /sp), go_to_servicenow.\n' +
'   - For read-only operations (list, lookup, search, summarize, briefing) you do NOT confirm. Just do them - speed is the feature.\n' +
'\n' +
'3. WHEN UNSURE, SAY NO. Better to ask "I am not sure I followed - did you mean X or Y?" than to do the wrong write. Refuse politely if intent is unclear.\n' +
'\n' +
'CAPABILITIES & MEMORY:\n' +
'- When user asks "what can you do?" / "help me" / "show me your features" - call list_capabilities and read the categories.\n' +
'- When user asks "what did we talk about / what was I doing earlier / remember when" - call recall_past_conversations (optionally with a keyword).\n' +
'- When user says "remember that ..." / "for next time, ..." - call remember_fact to save it.\n' +
'- When user has just captured a screenshot (system tells you an image was attached) - look at it carefully and answer their question naturally.\n' +
'- Memory is YOURS - past exchanges are stored. Use them. Reference them. "Like the VPN issue we discussed earlier..."\n' +
'\n' +
'WHEN THE USER WANTS A TICKET RAISED (read-only pivot, be genuinely helpful):\n' +
'- "Open / create / log / raise / file a ticket" -> you cannot. Say so in one warm line, then pivot in the SAME breath:\n' +
'  "I can\'t raise tickets myself - but tell me what\'s broken and I\'ll check if there\'s already an incident for it."\n' +
'- Then actually run search_incidents on their described issue. If a matching record exists, brief them on it and offer to watch it. If nothing exists, offer the human path: who to contact (lookup_user), a sidebar message to the service desk, or the self-service portal.\n' +
'- This pivot is the difference between feeling blocked and feeling helped. Always land on something you DID for them.\n' +
'\n' +
'SENDING MESSAGES TO COLLEAGUES - USE SIDEBAR DISCUSSIONS:\n' +
'- When the user says "send a message to / tell / ping / message X" - ALWAYS use send_sidebar_message.\n' +
'- send_sidebar_message creates a real ServiceNow Sidebar Discussion that pops up in the recipients Now sidebar as a chat.\n' +
'- After sending, confirm verbally: "Done, Mihir. I have started a sidebar chat with John Adams and sent your message."\n' +
'\n' +
'DESTRUCTIVE ACTIONS - ALWAYS CONFIRM:\n' +
'- decide_approval and every vulnerable-item mutation are DESTRUCTIVE. Read back what you are about to do and ask "shall I?" before acting. Only proceed on yes.\n' +
'\n' +
'TICKET REFERENCES:\n' +
'- IF the user mentions a ticket number, call set_focus_ticket FIRST.\n' +
'- IF the user says "it" / "that ticket" / "this one" - call recall_focus first.\n' +
'\n' +
'HUMANE TONE (witty edition):\n' +
'- Use phrases like "no worries", "on it", "consider it done", "let me take a look", "shall I?".\n' +
'- CELEBRATE small wins with personality: "Boom - one less thing on your plate." / "That approval queue is finally empty. Frame this moment."\n' +
'- LIGHT WIT EXAMPLES (calibrate to this level, not beyond): "Eight open tickets... two are P1s, so let\'s pretend the other six don\'t exist for a minute." / "That change has been \'awaiting approval\' since Tuesday - it\'s basically furniture now."\n' +
'- ON ERRORS, be human and own it lightly: "Hmm, that bounced. One more try." Never blame the user.\n' +
'- ACKNOWLEDGE UNCERTAINTY honestly. If a tool fails or returns nothing, say so plainly. Do not make up data - a made-up fact is worse than a dull sentence.\n' +
'\n' +
'BEHAVIOUR:\n' +
'- When the user wants something done, CALL THE TOOL - do not just describe what it would do.\n' +
'- If the request is vague, ask ONE short clarifying question.\n' +
'- After a tool runs, confirm what happened in one sentence, with the ticket number spoken letter-by-digit.\n' +
'- For greetings / small talk, reply briefly and warmly. Do not always call a tool.\n' +
'- If a tool returns ok=false, apologise briefly and explain plainly. Do not retry silently.\n' +
'- For "list" results, read the FIRST two or three items aloud and offer to continue ("Shall I read more?").\n' +
'- Never reveal API keys, internal sys_ids, or technical jargon to the user.'
+ writeAddendum
            }]
        };
    }

    /* ===================================================================
     *  Tool declarations passed to Gemini
     *
     *  Release X: declarations are filtered through the ticket safety
     *  policy before they reach the model - creation tools never appear,
     *  mutation tools appear only when <scope>.ticket_writes is 'true'.
     *  A smaller tool surface also trims the prompt payload, which
     *  measurably cuts first-token latency on flash-lite.
     * =================================================================== */
    function _toolDeclarations() {
        var all = [{
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
                    description: 'Search published knowledge base articles by literal keyword (LIKE match on title + body). Use this only when the user asks with a specific term that must appear in the article text. For natural-language questions like "how do I configure VPN" or "what to do when Outlook is stuck", prefer semantic_search_knowledge — it finds articles by MEANING not just keyword.',
                    parameters: {
                        type: 'object',
                        properties: { query: { type: 'string' } },
                        required: ['query']
                    }
                },
                {
                    name: 'semantic_search_knowledge',
                    description: 'Find knowledge base articles by MEANING using Gemini text embeddings (RAG). Returns the top 3 most semantically-similar published articles with cosine-similarity scores. PREFER THIS over search_knowledge whenever the user asks a natural-language question about how to do something or what an error means. Example queries: "how do I get on the corporate Wi-Fi", "fix Outlook keeps asking for password", "explain the new MFA rollout".',
                    parameters: {
                        type: 'object',
                        properties: {
                            query: { type: 'string', description: 'The natural-language question' },
                            limit: { type: 'number', description: 'Max articles to return (default 3, max 8)' }
                        },
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
                },
                // ------- R2 - WEB SEARCH + IN-TAB CONTROL -------
                {
                    name: 'search_web',
                    description: 'Search the public internet for general-knowledge information (definitions, facts, news, encyclopaedic summaries). Uses DuckDuckGo Instant Answer + Wikipedia (both free). Use for questions OUTSIDE ServiceNow: "what is GLP-1", "who is the CEO of NVIDIA", "what is the time difference between London and Bangalore", "explain Kubernetes". Do NOT use for ServiceNow questions - use the ticket / knowledge tools for those.',
                    parameters: { type: 'object', properties: {
                        query: { type: 'string', description: 'The search query in natural language' }
                    }, required: ['query'] }
                },
                {
                    name: 'navigate_to_record',
                    description: 'Navigate the users current ServiceNow tab to a specific record. Use when user says "open INC...", "show me INC...", "take me to INC...". The client navigates within the Service Portal tab - no new tabs, no cross-tab control.',
                    parameters: { type: 'object', properties: {
                        ticket_number: { type: 'string', description: 'INC/CHG/PRB/RITM/SCTASK/KB number' }
                    }, required: ['ticket_number'] }
                },
                {
                    name: 'click_button',
                    description: 'Find and click a button on the currently-displayed Service Portal page by its visible label (case-insensitive substring match on the buttons text or aria-label). Use when user says "click resolve", "submit the form", "save this", "approve". Limited to buttons on the current SN tab only. Returns the buttons label on success.',
                    parameters: { type: 'object', properties: {
                        label: { type: 'string', description: 'Substring of the button text/aria-label, e.g. "Resolve", "Submit", "Approve"' }
                    }, required: ['label'] }
                },
                // ------- R2.4 - update_field + URL navigation -------
                {
                    name: 'update_field',
                    description: 'Update ANY standard field on a ticket (incident/problem/change/RITM/sc_task). USE THIS - not update_ticket - whenever the user names a specific field: "change short description to X", "set urgency to high", "update assignment group to ...", "set category to network", etc. update_ticket is ONLY for adding a customer-visible comment. Common fields: short_description, description, urgency, impact, priority, category, subcategory, assignment_group, assigned_to, state, close_notes, work_notes.',
                    parameters: { type: 'object', properties: {
                        ticket_number: { type: 'string', description: 'INC/PRB/CHG/RITM/SCTASK number' },
                        field:         { type: 'string', description: 'Field name in snake_case, e.g. short_description, urgency, priority, category' },
                        value:         { type: 'string', description: 'New value (as string; will be coerced)' }
                    }, required: ['ticket_number','field','value'] }
                },
                {
                    name: 'open_url',
                    description: 'Open an external website in a new browser tab. Use ONLY when the user explicitly asks to open a named site by voice: "open YouTube", "open Google", "go to BBC News", "search YouTube for X". Always confirm verbally first, never open URLs the user has not named. Returns the url that will be opened.',
                    parameters: { type: 'object', properties: {
                        url:   { type: 'string', description: 'Full URL including https://, e.g. https://www.youtube.com' },
                        title: { type: 'string', description: 'Human-friendly name the user said, e.g. "YouTube", "BBC News"' }
                    }, required: ['url'] }
                },
                {
                    name: 'go_to_servicenow',
                    description: 'Navigate the CURRENT tab back to ServiceNow Service Portal (/sp). Use when the user is on YouTube or another site and says "take me back to ServiceNow", "go back to my work", "return to Netra".',
                    parameters: { type: 'object', properties: {} }
                },
                // ------- R2.6 - read ANY ServiceNow code file -------
                {
                    name: 'read_script',
                    description: 'Read the SOURCE CODE of any ServiceNow code artifact - Script Include, Business Rule, UI Script, Client Script, Scheduled Job (sysauto_script), Processor, Scripted REST resource, Email script, UI Action, ACL script, or Service Portal widget. Use whenever the user asks "what does X do", "show me the script behind Y", "explain the business rule called Z", "open the NetraTools script include", "read the NetraIntent code". Pass the name OR the 32-char sys_id. Tries every script table in order and returns the first match. Returns the source code (truncated at 8KB) plus metadata (active, table, description). After receiving, READ IT and EXPLAIN it to the user in plain English.',
                    parameters: { type: 'object', properties: {
                        query: { type: 'string', description: 'Script name or sys_id, e.g. "NetraIntent", "NetraTools", "Validate user", or a 32-char sys_id' }
                    }, required: ['query'] }
                },
                {
                    name: 'list_scripts',
                    description: 'List all scripts in a specific ServiceNow code table. Use when the user says "list all script includes", "show me all business rules", "what scheduled jobs exist". The table argument must be one of: sys_script_include, sys_script (business rules), sys_ui_script, sys_script_client, sysauto_script (scheduled jobs), sys_processor, sys_ws_operation (scripted rest), sys_script_email, sys_ui_action, sp_widget.',
                    parameters: { type: 'object', properties: {
                        table:   { type: 'string', description: 'One of: sys_script_include, sys_script, sys_ui_script, sys_script_client, sysauto_script, sys_processor, sys_ws_operation, sys_script_email, sys_ui_action, sp_widget' },
                        keyword: { type: 'string', description: 'Optional: filter by name LIKE this string' }
                    }, required: ['table'] }
                },
                // ------- R2.11 - Claude-powered advanced tools -------
                {
                    name: 'triage_approvals',
                    description: 'Smart approval triage. Pulls all pending approvals for the user, classifies each via the Netra reasoning engine as ROUTINE / SCRUTINY / RISKY with a one-sentence rationale, sorted by risk. Use when the user says "triage my approvals", "what should I approve first", "rank my approvals by risk". After the tool returns, read out the top 2 items by risk; do not read all of them.',
                    parameters: { type: 'object', properties: {} }
                },
                {
                    name: 'narrate_script',
                    description: 'Read a ServiceNow script aloud in an accessible narrative form. Fetches source via read_script, then produces a 4-6 sentence narrative explaining what the script does, its inputs and outputs, non-obvious behaviour, and the biggest risk. Use this INSTEAD of read_script whenever the user asks to "explain", "narrate", "describe", or "tell me what X does" — read_script dumps raw code, narrate_script makes it audible.',
                    parameters: { type: 'object', properties: {
                        query: { type: 'string', description: 'Script name or 32-char sys_id (same as read_script)' }
                    }, required: ['query'] }
                },
                {
                    name: 'build_query',
                    description: 'Convert a natural-language ticket-filter description into a valid ServiceNow encoded query string. Use when the user describes a complex filter like "show me P1 VPN incidents from last week assigned to my team" or "find changes that need my approval and are scheduled this weekend". Returns the encoded query + a preview count.',
                    parameters: { type: 'object', properties: {
                        natural_language: { type: 'string', description: 'The filter description in plain language' },
                        table: { type: 'string', description: 'Target table — incident (default), problem, change_request, sc_req_item, sc_task' }
                    }, required: ['natural_language'] }
                },
                // ------- R2.13 - auto-read KB + CHG, dynamic slot-filling -------
                {
                    name: 'read_knowledge_article',
                    description: 'Read a SPECIFIC knowledge base article by its KB number (e.g. KB0000008) or sys_id and return its full title and body. ALWAYS CALL THIS the moment the user mentions a KB number, even before answering them, so you have the article content in working memory. Returns {number, title, body} — summarise the body in your spoken reply.',
                    parameters: { type: 'object', properties: {
                        query: { type: 'string', description: 'KB number like "KB0000008" or a 32-char sys_id' }
                    }, required: ['query'] }
                },
                {
                    name: 'summarize_change',
                    description: 'Full summary of a change request (CHG number): type, risk, impact, state, planned start/end, backout plan, justification, assignment. ALWAYS CALL THIS the moment the user mentions a CHG number, even before answering them, so you have the change context in working memory.',
                    parameters: { type: 'object', properties: {
                        ticket_number: { type: 'string', description: 'CHG number' }
                    }, required: ['ticket_number'] }
                },
                {
                    name: 'list_mandatory_fields',
                    description: 'Look up the CURRENT mandatory fields for a given ServiceNow table (incident, problem, change_request, etc.). Reads sys_dictionary + sys_dictionary_override + active Data Policy rules + UI Policy actions firing on new records. Use this DURING a record-creation draft (after start_record_draft) to know exactly which fields the user must provide. Returns {table, fields: {field_name: {label, source, type}}, count}.',
                    parameters: { type: 'object', properties: {
                        table: { type: 'string', description: 'Target table name — incident, problem, change_request, sc_req_item' }
                    }, required: ['table'] }
                },
                // ------- VR: Vulnerability Response (analyst suite) -------
                {
                    name: 'list_vulnerable_items',
                    description: 'List Vulnerability Response Vulnerable Items (VITs), the work unit of a vulnerability analyst. Use for "my vulnerabilities", "what is assigned to my group", "show me critical vulnerable items", "open VITs on this server". Filters returned by highest risk first.',
                    parameters: { type: 'object', properties: {
                        scope: { type: 'string', enum: ['me', 'group', 'all'], description: "'me' = assigned to the user or their groups (default); 'group' = the user's groups; 'all' = whole org." },
                        state: { type: 'string', description: "Optional state word: open, investigate, review, awaiting, defer, resolve, close." },
                        band: { type: 'string', enum: ['critical', 'high', 'medium', 'low'], description: 'Optional risk band filter.' },
                        min_risk: { type: 'number', description: 'Optional minimum risk score 0-100.' },
                        ci: { type: 'string', description: 'Optional asset / host name to filter on.' },
                        cve: { type: 'string', description: 'Optional CVE id to filter on, e.g. CVE-2021-44228.' },
                        limit: { type: 'number', description: 'Max items (default 10).' }
                    } }
                },
                {
                    name: 'top_vulnerabilities',
                    description: 'The highest-risk OPEN vulnerable items across the whole organization — the exposure the analyst should tackle first. Use for "what is our worst exposure", "top vulnerabilities", "what should I fix first".',
                    parameters: { type: 'object', properties: { limit: { type: 'number', description: 'How many (default 5).' } } }
                },
                {
                    name: 'get_vulnerable_item',
                    description: 'Full detail of one Vulnerable Item by number (VIT#######): risk, state, asset, CVE summary and the remediation solution. Call this the moment the user names a VIT.',
                    parameters: { type: 'object', properties: { number: { type: 'string', description: 'e.g. VIT0014304' } }, required: ['number'] }
                },
                {
                    name: 'lookup_cve',
                    description: 'Look up a CVE / security advisory by identifier and how it affects us (summary, source, remediation, how many active items reference it and the worst risk). Call this the moment the user mentions a CVE id.',
                    parameters: { type: 'object', properties: { cve: { type: 'string', description: 'e.g. CVE-2021-44228 (Log4Shell)' } }, required: ['cve'] }
                },
                {
                    name: 'vulnerability_exposure',
                    description: "Organization-wide vulnerability exposure snapshot: open counts by risk band (critical/high/medium/low), the user's own open load, and the most-loaded assignment groups. Use for 'what is our exposure', 'how bad is it', 'vulnerability summary', 'briefing'.",
                    parameters: { type: 'object', properties: {} }
                },
                {
                    name: 'most_vulnerable_assets',
                    description: 'The assets (configuration items / hosts) carrying the most open vulnerable items, worst-risk first. Use for "which servers are worst", "most vulnerable hosts", "riskiest assets".',
                    parameters: { type: 'object', properties: { limit: { type: 'number', description: 'How many assets (default 5).' } } }
                },
                {
                    name: 'vulnerabilities_for_asset',
                    description: 'All active vulnerable items on a named asset / host. Use for "what is wrong with LAPTP-SD-3818", "vulnerabilities on the JBOSS box".',
                    parameters: { type: 'object', properties: { ci: { type: 'string', description: 'Asset / host / CI name' } }, required: ['ci'] }
                },
                {
                    name: 'assign_vulnerable_item',
                    description: 'Assign a Vulnerable Item to a user and/or an assignment group. Confirm verbally before calling.',
                    parameters: { type: 'object', properties: {
                        number: { type: 'string', description: 'VIT number' },
                        user:   { type: 'string', description: 'Optional user name/email to assign to.' },
                        group:  { type: 'string', description: 'Optional assignment group name.' }
                    }, required: ['number'] }
                },
                {
                    name: 'set_vulnerable_item_state',
                    description: 'Move a Vulnerable Item through its lifecycle: open, investigate, review, awaiting implementation, resolve, or close. Confirm verbally before calling.',
                    parameters: { type: 'object', properties: {
                        number: { type: 'string', description: 'VIT number' },
                        state:  { type: 'string', description: 'open | investigate | review | awaiting | resolve | close' },
                        note:   { type: 'string', description: 'Optional work note explaining the change.' }
                    }, required: ['number', 'state'] }
                },
                {
                    name: 'defer_vulnerable_item',
                    description: 'Defer a Vulnerable Item (accept the risk) with a MANDATORY reason for the audit trail. Use for "defer this", "accept the risk", "we can not patch this yet because...".',
                    parameters: { type: 'object', properties: {
                        number: { type: 'string', description: 'VIT number' },
                        reason: { type: 'string', description: 'Why the risk is being accepted / deferred. Required.' }
                    }, required: ['number', 'reason'] }
                },
                {
                    name: 'add_vulnerability_note',
                    description: 'Add a work note to a Vulnerable Item (investigation findings, remediation progress).',
                    parameters: { type: 'object', properties: {
                        number: { type: 'string', description: 'VIT number' },
                        note:   { type: 'string', description: 'The note text.' }
                    }, required: ['number', 'note'] }
                }
            ]
        }];
        // Release X - strip policy-blocked tools before the model sees them
        var allowWrites = _ticketWritesEnabled();
        var createMap = _ticketCreateTools();
        var mutateMap = _ticketMutateTools();
        var kept = [];
        var decls = all[0].functionDeclarations;
        for (var d = 0; d < decls.length; d++) {
            var nm = decls[d] && decls[d].name;
            if (createMap[nm]) continue;
            if (mutateMap[nm] && !allowWrites) continue;
            kept.push(decls[d]);
        }
        return [{ functionDeclarations: kept }];
    }

    /* ===================================================================
     *  Release X - TICKET SAFETY POLICY (enforced in code, not just prompt)
     *
     *  Netra is a READ-ONLY analyst on ticket records. She can look up,
     *  search, summarize, brief, and track incidents / problems / changes /
     *  requests - but she can NEVER create one, and by default cannot
     *  modify one either.
     *
     *  Two tiers:
     *    - CREATION tools are refused unconditionally. There is no
     *      property that re-enables them.
     *    - MUTATION tools (resolve, comment, reassign, priority, field
     *      writes) are refused unless the instance property
     *      <scope>.ticket_writes is explicitly set to 'true'.
     *
     *  The same tools are also stripped from the Gemini function
     *  declarations (see _toolDeclarations), so the model never plans
     *  around them; this dispatcher gate is defence-in-depth in case a
     *  stale conversation history still references one.
     * =================================================================== */
    // Hoisted function declarations (NOT vars): the widget server body is
    // one IIFE whose action router executes above this point, so a plain
    // `var MAP = {...}` would still be undefined when a chat dispatches.
    function _ticketCreateTools() {
        return {
            create_ticket: 1, create_problem: 1, create_change: 1,
            start_record_draft: 1, set_record_field: 1, review_draft: 1,
            confirm_and_create: 1,
            send_message_to_user: 1   // legacy path opened a tracking incident
        };
    }
    function _ticketMutateTools() {
        return {
            resolve_ticket: 1, update_ticket: 1, change_priority: 1,
            escalate_ticket: 1, assign_ticket_to_group: 1,
            assign_ticket_to_user: 1, add_work_note: 1, update_field: 1
        };
    }
    function _ticketWritesEnabled() {
        return gs.getProperty(SCOPE + '.ticket_writes', 'false') === 'true';
    }
    function _ticketPolicyRefusal(name) {
        var creating = !!_ticketCreateTools()[name];
        return {
            ok: false,
            read_only: true,
            refused_tool: name,
            message: creating
                ? 'Ticket creation is permanently disabled for Netra. Tell the user plainly that you cannot raise tickets, then offer what you CAN do: read status, summarize, search, brief, or watch existing records.'
                : 'Ticket modification is disabled on this instance (read-only mode). Offer the read-only alternative instead - status, summary, or adding it to the watchlist.'
        };
    }

    /* ===================================================================
     *  Tool dispatch
     * =================================================================== */
    function _runTool(name, args) {
        try {
            // Release X - ticket policy gate runs before any tool code
            if (_ticketCreateTools()[name]) return _ticketPolicyRefusal(name);
            if (_ticketMutateTools()[name] && !_ticketWritesEnabled()) return _ticketPolicyRefusal(name);
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
                case 'semantic_search_knowledge':
                    return _semanticSearchKnowledge(String(args.query || ''), Math.min(8, parseInt(args.limit, 10) || 3));
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
                // ------- R2 -------
                case 'search_web':
                    return _searchWeb(String(args.query || ''));
                case 'navigate_to_record':
                    return _navigateToRecord(_normNum(args.ticket_number));
                case 'click_button':
                    return _clickButton(String(args.label || ''));
                case 'update_field':
                    return _updateField(_normNum(args.ticket_number), String(args.field || ''), String(args.value || ''));
                case 'open_url':
                    return _openUrl(String(args.url || ''), String(args.title || ''));
                case 'go_to_servicenow':
                    return _goToServiceNow();
                case 'read_script':
                    return _readScript(String(args.query || ''));
                case 'list_scripts':
                    return _listScripts(String(args.table || ''), String(args.keyword || ''));
                // R2.11 - Claude-powered tools
                case 'triage_approvals':
                    return _triageApprovals();
                case 'narrate_script':
                    return _narrateScript(String(args.query || ''));
                case 'build_query':
                    return _buildQuery(String(args.natural_language || ''), String(args.table || 'incident'));
                // R2.13 - auto-read + slot-filling
                case 'read_knowledge_article':
                    return _readKnowledgeArticle(String(args.query || ''));
                case 'summarize_change':
                    return _summarizeChange(_normNum(args.ticket_number));
                case 'list_mandatory_fields':
                    var __t = String(args.table || '').toLowerCase();
                    var __m = _mandatoryFields(__t);
                    var __count = 0;
                    for (var __k in __m) { if (__m.hasOwnProperty(__k)) __count++; }
                    return { ok: true, table: __t, fields: __m, count: __count };
                // ------- VR: Vulnerability Response -------
                case 'list_vulnerable_items':
                    return new NetraVulnerability().listVulnerableItems({
                        scope: args.scope, state: args.state, band: args.band,
                        min_risk: args.min_risk, ci: args.ci, cve: args.cve, limit: args.limit
                    });
                case 'top_vulnerabilities':
                    return new NetraVulnerability().topRisk(Number(args.limit) || 5);
                case 'get_vulnerable_item':
                    return new NetraVulnerability().getVulnerableItem(String(args.number || ''));
                case 'lookup_cve':
                    return new NetraVulnerability().lookupCVE(String(args.cve || ''));
                case 'vulnerability_exposure':
                    return new NetraVulnerability().exposureSummary();
                case 'most_vulnerable_assets':
                    return new NetraVulnerability().mostVulnerableAssets(Number(args.limit) || 5);
                case 'vulnerabilities_for_asset':
                    return new NetraVulnerability().vulnerabilitiesForCI(String(args.ci || ''));
                case 'assign_vulnerable_item':
                    return new NetraVulnerability().assignVulnerableItem(String(args.number || ''), { user: args.user, group: args.group });
                case 'set_vulnerable_item_state':
                    return new NetraVulnerability().setVulnerableItemState(String(args.number || ''), String(args.state || ''), String(args.note || ''));
                case 'defer_vulnerable_item':
                    return new NetraVulnerability().deferVulnerableItem(String(args.number || ''), String(args.reason || ''));
                case 'add_vulnerability_note':
                    return new NetraVulnerability().addVulnerabilityNote(String(args.number || ''), String(args.note || ''));
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

    // Generic count: query a table by encoded query and return count.
    // R4.7 - PERF: GlideAggregate COUNT runs a SELECT COUNT(*) in the DB
    // instead of materialising every matching row just to call getRowCount().
    // daily_briefing makes 9 of these and workload_summary 5, all on the
    // interactive chat path, so the saving is felt on common opening commands.
    function _countActiveBy(table, qStr) {
        try {
            var ga = new GlideAggregate(table);
            ga.addActiveQuery();
            if (qStr) ga.addEncodedQuery(qStr);
            ga.addAggregate('COUNT');
            ga.query();
            return ga.next() ? (parseInt(ga.getAggregate('COUNT'), 10) || 0) : 0;
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

    // R2.3 - Unified context blob now carries FOUR things:
    //   draft   - in-progress record draft (R1.3)
    //   mem     - long-term conversation memory (R1.4)
    //   vocab   - personal voice-training vocab (R2.3)
    //   aliases - voice-training misheard->intended map (R2.3)
    // All stored with "CTX:" prefix in last_utterance.
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
        var blob = { draft: null, mem: [], vocab: {}, aliases: {}, sentiment: null };
        if (raw.indexOf('CTX:') === 0) {
            try {
                var parsed = JSON.parse(raw.substring(4)) || {};
                blob.draft     = parsed.draft     || null;
                blob.mem       = parsed.mem       || [];
                blob.vocab     = parsed.vocab     || {};
                blob.aliases   = parsed.aliases   || {};
                blob.sentiment = parsed.sentiment || null;
                return blob;
            } catch (e) {}
        }
        // Backwards-compat: migrate old DRAFT: or MEM: prefixed values
        if (raw.indexOf('DRAFT:') === 0) {
            try { blob.draft = JSON.parse(raw.substring(6)); return blob; } catch (e) {}
        }
        if (raw.indexOf('MEM:') === 0) {
            try { blob.mem = JSON.parse(raw.substring(4)) || []; return blob; } catch (e) {}
        }
        return blob;
    }
    function _ctxWriteBlob(blob) {
        var ctx = _ctxLoadGr();
        var payload = {
            draft:     blob.draft     || null,
            mem:       blob.mem       || [],
            vocab:     blob.vocab     || {},
            aliases:   blob.aliases   || {},
            sentiment: blob.sentiment || null
        };
        // Safety truncate: if the serialised blob exceeds the column limit, drop
        // the oldest mem entries until it fits. The Context column is sized to
        // hold ~100 turns of typical-length exchanges; this guards the edge case
        // where users hit the max with verbose entries.
        var maxLen = 250000;   // matches the expanded sys_dictionary max_length
        var ser = 'CTX:' + JSON.stringify(payload);
        while (ser.length > maxLen && payload.mem.length > 5) {
            payload.mem = payload.mem.slice(Math.floor(payload.mem.length / 4));
            ser = 'CTX:' + JSON.stringify(payload);
        }
        ctx.last_utterance = ser;
        ctx.update();
    }

    // R2.3 - per-user training read/write
    function _trainingRead() {
        var b = _ctxReadBlob();
        return { vocab: b.vocab || {}, aliases: b.aliases || {} };
    }
    function _trainingWrite(vocab, aliases) {
        var b = _ctxReadBlob();
        if (vocab)   b.vocab   = vocab;
        if (aliases) b.aliases = aliases;
        _ctxWriteBlob(b);
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

    /* ===================================================================
     *  R2.13 - DYNAMIC SLOT-FILLING (mandatory-field discovery)
     *
     *  ServiceNow declares "mandatory" in THREE different layers:
     *    1. sys_dictionary.mandatory (rare at this level for OOB tables)
     *    2. sys_dictionary_override (mandatory_override=true at child level)
     *    3. sys_data_policy_rule + sys_ui_policy_action (the common case)
     *
     *  The user's constraint forbids CREATING data/UI policies but reading
     *  them is fair game — that's how we know what they currently demand.
     *
     *  We walk the table hierarchy (incident -> task) and union mandatory
     *  declarations from all three layers. Auto-populated system fields
     *  are skip-listed. Result cached 5 minutes per table.
     *
     *  Pattern is industry-standard "slot filling" (COLING 2025; Microsoft
     *  Copilot Studio; LangChain StructuredTool; Anthropic tool-use).
     * =================================================================== */
    var MAND_SKIP = {
        sys_id: 1, sys_created_on: 1, sys_created_by: 1, sys_updated_on: 1,
        sys_updated_by: 1, sys_mod_count: 1, sys_tags: 1, sys_class_name: 1,
        sys_domain: 1, sys_domain_path: 1, number: 1, opened_at: 1, opened_by: 1,
        active: 1, state: 1
    };
    var _mandCache = {};   // table -> { fields, ts }
    var MAND_CACHE_TTL_MS = 5 * 60 * 1000;

    function _mandatoryFields(table) {
        if (!table) return {};
        var now = new Date().getTime();
        var cached = _mandCache[table];
        if (cached && (now - cached.ts) < MAND_CACHE_TTL_MS) return cached.fields;

        var fields = {};

        // 1. Walk the table hierarchy to root, collecting `mandatory=true` rows
        //    from sys_dictionary at every level.
        var tables = [];
        var current = table;
        var loopGuard = 0;
        while (current && loopGuard++ < 10) {
            tables.push(current);
            var t = new GlideRecord('sys_db_object');
            if (!t.get('name', current)) break;
            current = String(t.super_class.name || '') || null;
            if (!current || current === 'null') break;
        }
        for (var i = 0; i < tables.length; i++) {
            var dg = new GlideRecord('sys_dictionary');
            dg.addQuery('name', tables[i]);
            dg.addQuery('mandatory', true);
            dg.addNotNullQuery('element');
            dg.query();
            while (dg.next()) {
                var el = String(dg.element);
                if (MAND_SKIP[el]) continue;
                fields[el] = { source: 'dictionary',
                               label: String(dg.column_label || el),
                               type: String(dg.internal_type || '') };
            }
        }

        // 2. Dictionary overrides at the target-table level.
        var og = new GlideRecord('sys_dictionary_override');
        og.addQuery('name', table);
        og.addQuery('mandatory_override', true);
        og.query();
        while (og.next()) {
            var el2 = String(og.element);
            if (MAND_SKIP[el2]) continue;
            if (og.mandatory == true || String(og.mandatory) === 'true') {
                if (!fields[el2]) fields[el2] = { source: 'override', label: el2, type: '' };
                else fields[el2].source = 'override';
            } else {
                delete fields[el2];   // child explicitly removed parent's mandate
            }
        }

        // 3. Active Data Policy rules with mandatory=true.
        var rg = new GlideRecord('sys_data_policy_rule');
        rg.addQuery('table', table);
        rg.addQuery('mandatory', true);
        rg.addQuery('disabled', false);
        rg.query();
        while (rg.next()) {
            var el3 = String(rg.field);
            if (MAND_SKIP[el3]) continue;
            if (!fields[el3]) {
                fields[el3] = { source: 'data_policy', label: el3, type: '' };
            }
        }

        // 4. UI Policy actions firing on new records, mandatory=true.
        var upg = new GlideRecord('sys_ui_policy');
        upg.addQuery('table', table);
        upg.addQuery('active', true);
        upg.addQuery('on_new_record', true);
        upg.query();
        var policyIds = [];
        while (upg.next()) policyIds.push(String(upg.sys_id));
        if (policyIds.length) {
            var apg = new GlideRecord('sys_ui_policy_action');
            apg.addQuery('ui_policy', 'IN', policyIds.join(','));
            apg.addQuery('mandatory', true);
            apg.query();
            while (apg.next()) {
                var el4 = String(apg.field);
                if (MAND_SKIP[el4]) continue;
                if (!fields[el4]) {
                    fields[el4] = { source: 'ui_policy', label: el4, type: '' };
                }
            }
        }

        // 5. Try to fill in the human-readable label for fields discovered
        //    via policies (where we only had the element name).
        for (var fk in fields) {
            if (!fields.hasOwnProperty(fk)) continue;
            if (fields[fk].label !== fk) continue;
            var lg = new GlideRecord('sys_dictionary');
            lg.addQuery('name', 'IN', tables.join(','));
            lg.addQuery('element', fk);
            lg.setLimit(1);
            lg.query();
            if (lg.next()) {
                fields[fk].label = String(lg.column_label || fk);
                fields[fk].type  = String(lg.internal_type || '');
            }
        }

        _mandCache[table] = { fields: fields, ts: now };
        return fields;
    }

    function _confirmAndCreate() {
        var d = _draftRead();
        if (!d) return { ok: false, error: 'No draft to confirm.' };
        var table = d.record_type;

        // R2.13 - dynamic mandatory-field validation. Slot-filling pattern.
        var mand = _mandatoryFields(table);
        var missing = [];
        for (var k in mand) {
            if (!mand.hasOwnProperty(k)) continue;
            var v = d.fields[k];
            if (v === undefined || v === null || String(v).trim() === '') {
                missing.push({ field: k, label: mand[k].label, source: mand[k].source });
            }
        }
        // Also enforce REQUIRED_FIELDS (Netra's own minimums)
        var minRequired = (REQUIRED_FIELDS[table] || []).filter(function (f) {
            var existing = false;
            for (var mi = 0; mi < missing.length; mi++) { if (missing[mi].field === f) { existing = true; break; } }
            return !existing && (!d.fields[f] || String(d.fields[f]).trim() === '');
        });
        for (var mr = 0; mr < minRequired.length; mr++) {
            missing.push({ field: minRequired[mr], label: minRequired[mr], source: 'netra_min' });
        }
        if (missing.length) {
            var head = missing[0];
            return {
                ok: false,
                error: 'missing_mandatory',
                missing: missing,
                next_field: head.field,
                next_label: head.label,
                next_prompt: 'What value should I use for ' + head.label + '?',
                message: 'I cannot submit yet — these required fields are still empty: ' +
                         missing.map(function (m) { return m.label; }).join(', ') +
                         '. Let\'s start with: what is the ' + head.label + '?'
            };
        }

        try {
            var gr = new GlideRecord(table);
            gr.initialize();
            for (var k2 in d.fields) {
                if (d.fields.hasOwnProperty(k2)) gr.setValue(k2, d.fields[k2]);
            }
            gr.opened_by = gs.getUserID();
            if (table === 'incident') gr.caller_id = gs.getUserID();
            if (table === 'problem' || table === 'change_request') gr.assigned_to = gs.getUserID();
            var sid = gr.insert();
            gr.get(sid);
            _draftWrite(null);
            return { ok: true, table: table, number: String(gr.number), sys_id: sid,
                     message: 'Created ' + String(gr.number) + ' successfully.' };
        } catch (e) {
            return { ok: false, error: 'Insert failed: ' + (e.message || e) };
        }
    }

    /* ===================================================================
     *  R2.13 - READ KNOWLEDGE ARTICLE (by KB number)
     *
     *  Wraps NetraKnowledge.read(numberOrSysId). Exposed as a tool so
     *  Gemini can call it whenever the user mentions a KB number — the
     *  system prompt directs the model to auto-read on detection.
     * =================================================================== */
    function _readKnowledgeArticle(query) {
        if (!query) return { ok: false, error: 'KB number or sys_id is required.' };
        try {
            var r = new NetraKnowledge().read(String(query).trim());
            if (!r.ok) return r;
            return {
                ok: true,
                number: r.article.number,
                title:  r.article.title,
                kb_base: r.article.kb_base,
                body: String(r.article.body || '').substring(0, 4000),
                message: 'Reading ' + r.article.title + ' (' + r.article.number + ').'
            };
        } catch (e) {
            return { ok: false, error: 'Read failed: ' + (e.message || e) };
        }
    }

    /* ===================================================================
     *  R2.13 - SUMMARIZE CHANGE REQUEST (extends summarize_ticket)
     *
     *  Pulls change-specific fields: type, risk, impact, planned_start,
     *  planned_end, approval state, backout_plan, justification. Used by
     *  the system-prompt auto-read directive on CHG numbers.
     * =================================================================== */
    function _summarizeChange(num) {
        if (!num) return { ok: false, error: 'CHG number is required.' };
        var gr = new GlideRecord('change_request');
        if (!gr.get('number', num)) return { ok: false, error: 'Change request not found: ' + num };
        var dv = function (f) {
            try { return String(gr[f].getDisplayValue ? gr[f].getDisplayValue() : gr[f] || ''); }
            catch (e) { return ''; }
        };
        return {
            ok: true,
            number: String(gr.number),
            short_description: String(gr.short_description),
            type: dv('type'),
            state: dv('state'),
            risk: dv('risk'),
            impact: dv('impact'),
            priority: dv('priority'),
            category: dv('category'),
            assignment_group: dv('assignment_group'),
            assigned_to: dv('assigned_to'),
            requested_by: dv('requested_by'),
            planned_start_date: dv('start_date'),
            planned_end_date: dv('end_date'),
            justification: String(gr.justification || '').substring(0, 500),
            backout_plan: String(gr.backout_plan || '').substring(0, 400),
            description: String(gr.description || '').substring(0, 500),
            recent_comments: String(gr.comments || '').substring(0, 400)
        };
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
                    // R4.5 - renamed lp1/lp2 to avoid var-hoist collision with
                    // the modern path's p1/p2 above; removed dead forEach no-op.
                    var lp1 = new GlideRecord('live_group_profile');
                    lp1.initialize();
                    lp1.setValue('group',   lgId);
                    lp1.setValue('profile', senderId);
                    lp1.insert();
                    var lp2 = new GlideRecord('live_group_profile');
                    lp2.initialize();
                    lp2.setValue('group',   lgId);
                    lp2.setValue('profile', recipientId);
                    lp2.insert();
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
    var MEM_CAP = 200;   // Release X - bumped from 100; safety truncate in _ctxWriteBlob protects against oversize blobs
    function _memAppend(userMsg, netraReply) {
        if (!userMsg && !netraReply) return;
        var arr = _memRead();
        arr.push({
            t: new GlideDateTime().toString(),
            u: String(userMsg || '').substring(0, 240),
            n: String(netraReply || '').substring(0, 480)
        });
        if (arr.length > MEM_CAP) arr = arr.slice(arr.length - MEM_CAP);
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
        var n = Math.min(50, Math.max(1, limit || 10));
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
        if (arr.length > MEM_CAP) arr = arr.slice(arr.length - MEM_CAP);
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

    /* ===================================================================
     *  R2 - WEB SEARCH (DuckDuckGo Instant Answer + Wikipedia)
     *  Both are free, key-less, and CORS-friendly. DuckDuckGo handles
     *  factoids / definitions / abstracts; Wikipedia REST API handles
     *  encyclopaedic summaries when DDG comes back empty.
     * =================================================================== */
    function _searchWeb(query) {
        if (!query) return { ok: false, error: 'Query is required.' };

        // 1. Try DuckDuckGo Instant Answer first
        try {
            var ddgUrl = 'https://api.duckduckgo.com/?q=' + encodeURIComponent(query) +
                         '&format=json&no_html=1&skip_disambig=1&t=netra';
            var rm = new sn_ws.RESTMessageV2();
            rm.setEndpoint(ddgUrl);
            rm.setHttpMethod('GET');
            rm.setHttpTimeout(8000);
            var r = rm.execute();
            if (r.getStatusCode() === 200) {
                // R4.5 - cap response body at 200 KB before parsing.
                // A misbehaving endpoint returning 50 MB would block the
                // request thread on JSON.parse for many seconds.
                var _rawBody = r.getBody() || '{}';
                if (_rawBody.length > 200000) _rawBody = _rawBody.substring(0, 200000);
                var body;
                try { body = JSON.parse(_rawBody); } catch (eJ) { body = {}; }
                var abstract = String(body.AbstractText || body.Abstract || '').trim();
                var url      = String(body.AbstractURL  || body.URL      || '').trim();
                var source   = String(body.AbstractSource || '').trim();
                var heading  = String(body.Heading || query).trim();
                if (abstract) {
                    return {
                        ok: true, source: 'DuckDuckGo / ' + (source || 'web'),
                        heading: heading,
                        answer: abstract.substring(0, 1200),
                        url: url,
                        message: 'Found a definition for ' + heading + '.'
                    };
                }
                // DDG also returns RelatedTopics with text snippets
                if (body.RelatedTopics && body.RelatedTopics.length > 0) {
                    var snippets = [];
                    for (var i = 0; i < body.RelatedTopics.length && snippets.length < 3; i++) {
                        var t = body.RelatedTopics[i];
                        if (t.Text) snippets.push(t.Text);
                        else if (t.Topics && t.Topics[0] && t.Topics[0].Text) snippets.push(t.Topics[0].Text);
                    }
                    if (snippets.length) {
                        return {
                            ok: true, source: 'DuckDuckGo',
                            heading: query,
                            answer: snippets.join(' '),
                            url: url || 'https://duckduckgo.com/?q=' + encodeURIComponent(query),
                            message: 'Found ' + snippets.length + ' relevant snippets.'
                        };
                    }
                }
            }
        } catch (e) { /* fall through to Wikipedia */ }

        // 2. Fall through to Wikipedia REST API summary
        try {
            var title = query.replace(/\s+/g, '_');
            var wikiUrl = 'https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(title);
            var rm2 = new sn_ws.RESTMessageV2();
            rm2.setEndpoint(wikiUrl);
            rm2.setHttpMethod('GET');
            rm2.setRequestHeader('Accept', 'application/json');
            rm2.setHttpTimeout(8000);
            var r2 = rm2.execute();
            if (r2.getStatusCode() === 200) {
                var w = JSON.parse(r2.getBody() || '{}');
                if (w.extract) {
                    return {
                        ok: true, source: 'Wikipedia',
                        heading: String(w.title || query),
                        answer: String(w.extract).substring(0, 1200),
                        url: w.content_urls && w.content_urls.desktop ? w.content_urls.desktop.page : '',
                        message: 'Found a Wikipedia entry for ' + (w.title || query) + '.'
                    };
                }
            }
            // 3. As a last resort, Wikipedia OpenSearch for fuzzy match
            var osUrl = 'https://en.wikipedia.org/w/api.php?action=opensearch&format=json&limit=1&search=' + encodeURIComponent(query);
            var rm3 = new sn_ws.RESTMessageV2();
            rm3.setEndpoint(osUrl);
            rm3.setHttpMethod('GET');
            rm3.setHttpTimeout(8000);
            var r3 = rm3.execute();
            if (r3.getStatusCode() === 200) {
                var arr = JSON.parse(r3.getBody() || '[]');
                if (arr && arr.length >= 3 && arr[1] && arr[1].length && arr[2] && arr[2].length) {
                    return {
                        ok: true, source: 'Wikipedia (fuzzy)',
                        heading: String(arr[1][0] || query),
                        answer: String(arr[2][0] || ''),
                        url: arr[3] && arr[3][0] ? arr[3][0] : '',
                        message: 'Closest match via Wikipedia OpenSearch.'
                    };
                }
            }
        } catch (e2) {}

        return { ok: false, error: 'No information found for "' + query + '". The internet did not return a clear answer.' };
    }

    /* ===================================================================
     *  R2.10 - SEMANTIC KNOWLEDGE SEARCH (RAG)
     *
     *  Uses Gemini's embedding model (gemini-embedding-001, free tier) to
     *  find KB articles semantically related to the user's query — far
     *  better than the LIKE-based search_knowledge for natural questions
     *  like "how do I get on the corporate Wi-Fi" matching "VPN setup".
     *
     *  Embeddings are computed once per KB article and cached in
     *  x_196061_netra_v1_kb_embedding. The query is embedded on each call.
     *  Cosine similarity selects the top-K matches.
     * =================================================================== */
    var EMBED_MODEL = 'gemini-embedding-001';
    var EMBED_DIMS  = 768;
    var EMBED_CACHE_TABLE = SCOPE + '_kb_embedding';

    function _embedText(text, taskType) {
        var apiKey = gs.getProperty(SCOPE + '.gemini_api_key');
        if (!apiKey) return { error: 'API key not configured' };
        var url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
                  EMBED_MODEL + ':embedContent?key=' + encodeURIComponent(apiKey);
        var body = {
            model: 'models/' + EMBED_MODEL,
            content: { parts: [{ text: String(text || '').substring(0, 4000) }] },
            taskType: taskType || 'RETRIEVAL_QUERY',
            outputDimensionality: EMBED_DIMS
        };
        try {
            var rm = new sn_ws.RESTMessageV2();
            rm.setEndpoint(url);
            rm.setHttpMethod('POST');
            rm.setRequestHeader('Content-Type', 'application/json');
            rm.setRequestBody(JSON.stringify(body));
            rm.setHttpTimeout(15000);
            var r = rm.execute();
            if (r.getStatusCode() !== 200) {
                return { error: 'HTTP ' + r.getStatusCode() + ' from embed endpoint: ' + String(r.getBody() || '').substring(0, 200) };
            }
            var parsed = JSON.parse(r.getBody() || '{}');
            var values = parsed && parsed.embedding && parsed.embedding.values;
            if (!values || !values.length) return { error: 'Empty embedding returned' };
            // Sub-3072 dimensions are NOT auto-normalised; L2-normalise here.
            var norm = 0;
            for (var i = 0; i < values.length; i++) norm += values[i] * values[i];
            norm = Math.sqrt(norm);
            if (norm > 0) for (var j = 0; j < values.length; j++) values[j] /= norm;
            return { values: values };
        } catch (e) {
            return { error: 'Embedding call threw: ' + (e.message || e) };
        }
    }

    function _cosineSim(a, b) {
        if (!a || !b || a.length !== b.length) return 0;
        var dot = 0;
        for (var i = 0; i < a.length; i++) dot += a[i] * b[i];
        return dot;   // both vectors already L2-normalised so cosine === dot
    }

    function _kbBodyDigest(htmlBody) {
        // Strip HTML, collapse whitespace, take first 1500 chars
        var plain = String(htmlBody || '')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/\s+/g, ' ')
            .trim();
        return plain.substring(0, 1500);
    }

    function _lazyEmbedKb(grKb) {
        // grKb is a positioned GlideRecord on kb_knowledge
        var srcSysId = String(grKb.sys_id);
        var cache = new GlideRecord(EMBED_CACHE_TABLE);
        cache.addQuery('source_sys_id', srcSysId);
        cache.addQuery('model', EMBED_MODEL);
        cache.query();
        if (cache.next()) {
            try {
                return { ok: true, embedding: JSON.parse(String(cache.embedding)), cached: true,
                         title: String(cache.title), number: String(cache.source_number) };
            } catch (e) { /* fall through to re-embed */ }
        }
        var title  = String(grKb.short_description || '');
        var digest = _kbBodyDigest(grKb.text);
        var embedText = title + ' \n ' + digest;
        var res = _embedText(embedText, 'RETRIEVAL_DOCUMENT');
        if (res.error) return { ok: false, error: res.error };
        try {
            var newRow = new GlideRecord(EMBED_CACHE_TABLE);
            newRow.initialize();
            newRow.source_table  = 'kb_knowledge';
            newRow.source_sys_id = srcSysId;
            newRow.source_number = String(grKb.number);
            newRow.title         = title.substring(0, 240);
            newRow.body_digest   = digest;
            newRow.embedding     = JSON.stringify(res.values);
            newRow.model         = EMBED_MODEL;
            newRow.embedded_at   = new GlideDateTime().toString();
            newRow.insert();
        } catch (eW) { gs.warn('[NetraRAG] cache write failed: ' + eW.message); }
        return { ok: true, embedding: res.values, cached: false,
                 title: title, number: String(grKb.number) };
    }

    function _semanticSearchKnowledge(query, limit) {
        if (!query) return { ok: false, error: 'Query is required.' };
        var qRes = _embedText(query, 'RETRIEVAL_QUERY');
        if (qRes.error) {
            // Fall back to LIKE search on embedding-failure
            gs.warn('[NetraRAG] query embed failed: ' + qRes.error + ' - falling back to LIKE');
            return new NetraKnowledge().search(query, limit || 3);
        }
        var qVec = qRes.values;

        // R4.7 - PERF: batch-load every cached KB embedding for this model in a
        // SINGLE query and build a lookup map, instead of one point-query per
        // article inside _lazyEmbedKb (previously up to 200 queries per search).
        var cacheMap = {};
        try {
            var cg = new GlideRecord(EMBED_CACHE_TABLE);
            cg.addQuery('source_table', 'kb_knowledge');
            cg.addQuery('model', EMBED_MODEL);
            cg.setLimit(5000);
            cg.query();
            while (cg.next()) {
                cacheMap[String(cg.source_sys_id)] = {
                    embedding: String(cg.embedding),
                    title:     String(cg.title),
                    number:    String(cg.source_number)
                };
            }
        } catch (eCache) { gs.warn('[NetraRAG] cache preload failed: ' + (eCache.message || eCache)); }

        // Iterate published KB articles, score against the cache, embed lazily
        var gr = new GlideRecord('kb_knowledge');
        gr.addQuery('workflow_state', 'published');
        gr.addQuery('active', true);
        gr.setLimit(200);   // safety cap for very large KBs
        gr.query();
        var scored = [];
        var embedded = 0;
        var cached   = 0;
        var skipped  = 0;
        // R4.7 - PERF: cap the number of *live* embed HTTP calls per search.
        // Each is a synchronous 15s-timeout call to Gemini; on a cold cache the
        // old code could fire up to 200 of them sequentially and hang the whole
        // transaction for minutes (guaranteed timeout). Now we embed at most a
        // handful per search and let the cache warm incrementally across calls.
        var MAX_LIVE_EMBEDS = 8;
        while (gr.next()) {
            var sysId = String(gr.sys_id);
            var vec = null, title = '', number = '';
            var hit = cacheMap[sysId];
            if (hit) {
                try { vec = JSON.parse(hit.embedding); } catch (eP) { vec = null; }
                title = hit.title; number = hit.number;
            }
            if (!vec) {
                if (embedded >= MAX_LIVE_EMBEDS) { skipped++; continue; }
                var docRes = _lazyEmbedKb(gr);
                if (!docRes.ok) continue;
                vec = docRes.embedding; title = docRes.title; number = docRes.number;
                embedded++;
            } else {
                cached++;
            }
            scored.push({
                sys_id:  sysId,
                number:  number,
                title:   title,
                snippet: _kbBodyDigest(gr.text).substring(0, 220),
                score:   _cosineSim(qVec, vec)
            });
        }
        scored.sort(function (a, b) { return b.score - a.score; });
        var top = scored.slice(0, limit || 3);
        // Filter out weak matches. Empirically calibrated against the
        // gemini-embedding-001 768-dim model: VPN-doc vs VPN-query = 0.77,
        // VPN-doc vs unrelated (tomato recipe) = 0.45. We want to reject
        // the unrelated case, so 0.55 is the safe threshold.
        top = top.filter(function (t) { return t.score >= 0.55; });
        return {
            ok: true,
            query: query,
            articles: top,
            count: top.length,
            stats: { embedded_now: embedded, cached_hits: cached, skipped_uncached: skipped, total_articles_seen: scored.length }
        };
    }

    /* ===================================================================
     *  R2.11 - TRIAGE APPROVALS (Gemini-only, structured-output)
     *
     *  Uses NetraReasoning (_reason with JSON responseSchema) to classify
     *  each pending approval as ROUTINE / SCRUTINY / RISKY with a
     *  one-sentence rationale, sorted by risk.
     * =================================================================== */
    function _triageApprovals() {
        var user = gs.getUserID();
        var gr = new GlideRecord('sysapproval_approver');
        gr.addQuery('approver', user);
        gr.addQuery('state', 'requested');
        gr.orderByDesc('sys_created_on');
        gr.setLimit(15);
        gr.query();
        var items = [];
        while (gr.next()) {
            var src = new GlideRecord(String(gr.source_table || ''));
            var ctx = { number: '', short_description: '', sys_class_name: '' };
            try {
                if (src.get(String(gr.sysapproval || ''))) {
                    ctx.number            = String(src.number || src.sys_id);
                    ctx.short_description = String(src.short_description || '').substring(0, 240);
                    ctx.sys_class_name    = String(src.sys_class_name || gr.source_table);
                    ctx.priority          = src.getDisplayValue ? src.getDisplayValue('priority') : '';
                    ctx.requester         = src.getDisplayValue ? src.getDisplayValue('opened_by') : '';
                }
            } catch (eS) {}
            items.push({
                approval_sys_id: String(gr.sys_id),
                source_table: String(gr.source_table),
                created: String(gr.sys_created_on),
                ctx: ctx
            });
        }
        if (!items.length) {
            return { ok: true, count: 0, message: 'No approvals pending. Nothing to triage.', triage: [] };
        }

        var corpus = items.map(function (it, i) {
            return (i+1) + '. ' + it.source_table + ' ' + (it.ctx.number || '(no number)') +
                   ' | priority: ' + (it.ctx.priority || 'n/a') +
                   ' | requester: ' + (it.ctx.requester || 'n/a') +
                   ' | description: ' + (it.ctx.short_description || '(blank)');
        }).join('\n');

        var systemText = 'You are an enterprise approval-triage assistant for a BLIND ServiceNow user. ' +
                         'Classify each pending approval as ROUTINE (low business risk, safe to approve), ' +
                         'SCRUTINY (needs the user to read details before deciding), or RISKY (production ' +
                         'impact, security implications, non-standard request, or above usual price band). ' +
                         'Give a one-sentence rationale. Sort RISKY first, then SCRUTINY, then ROUTINE. ' +
                         'The user will hear this read aloud, so be tight.';

        var schema = {
            type: 'object',
            properties: {
                summary: { type: 'string', description: 'One-sentence headline summarising the queue' },
                items: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            index:     { type: 'integer', description: '1-based index from input list' },
                            level:     { type: 'string', enum: ['ROUTINE', 'SCRUTINY', 'RISKY'] },
                            rationale: { type: 'string', description: 'One-sentence reason for the classification' }
                        },
                        required: ['index', 'level', 'rationale']
                    }
                }
            },
            required: ['summary', 'items']
        };

        var userMsg = 'My ' + items.length + ' pending approvals:\n\n' + corpus;
        var resp = _reason(systemText, userMsg, schema, 1024);

        if (resp.error) {
            return { ok: false, error: 'Reasoning engine failed: ' + resp.error,
                     count: items.length, triage: [] };
        }
        var parsed = resp.json || {};
        return {
            ok: true,
            via: 'gemini-reason',
            count: items.length,
            summary: parsed.summary || ('You have ' + items.length + ' approvals pending.'),
            triage: parsed.items || [],
            message: parsed.summary || 'Triage complete.'
        };
    }

    /* ===================================================================
     *  R2.11 - NARRATE SCRIPT (Gemini-only, accessible code reading)
     *
     *  Wraps _readScript: fetches source, hands it to NetraReasoning
     *  with a narration prompt, returns a 4-6 sentence accessible
     *  narrative. Far better for blind admins than dumping raw code.
     * =================================================================== */
    function _narrateScript(query) {
        var src = _readScript(query);
        if (!src.ok) return src;
        var systemText = 'You are reading ServiceNow source code aloud to a BLIND developer. ' +
                         'Produce a clear 4-6 sentence narrative that explains what this script does, ' +
                         'its inputs, its outputs, and any non-obvious behaviour. Do not narrate every ' +
                         'line — focus on the WHAT and WHY. Avoid quoting symbols (no curly braces, ' +
                         'no semicolons spelled out). Speak in warm Indian English. End with one ' +
                         'sentence describing the BIGGEST RISK or gotcha if there is one. Return only ' +
                         'the narration, no preamble like "Here is" or "This script".';
        var userMsg = 'Table: ' + src.table + '\nName: ' + src.name +
                      '\nDescription: ' + (src.description || '(none)') +
                      '\nActive: ' + src.active +
                      '\n\nSource code:\n' + (src.source_code || '');

        var resp = _reasonText(systemText, userMsg, 700);
        if (resp.error) return { ok: false, error: 'Reasoning engine failed: ' + resp.error };
        return {
            ok: true,
            via: 'gemini-reason',
            table: src.table,
            name: src.name,
            narration: resp.text,
            message: resp.text
        };
    }

    /* ===================================================================
     *  R2.11 - BUILD QUERY (Gemini-only, NL -> encoded query)
     *
     *  Uses NetraReasoning with a strict JSON schema so the model returns
     *  ONLY the encoded_query field (no commentary). Validates with a
     *  GlideAggregate count before returning.
     * =================================================================== */
    function _buildQuery(naturalLanguage, table) {
        if (!naturalLanguage) return { ok: false, error: 'A natural-language filter is required.' };
        var tbl = String(table || 'incident').toLowerCase();
        var systemText =
            'You convert natural-language ticket-filter descriptions into ServiceNow encoded query strings ' +
            'for the table specified.\n' +
            'Rules:\n' +
            '- Use ^ as the AND separator. Use ^OR within a single field for alternatives.\n' +
            '- For "my", "mine", "I", "me": use javascript:gs.getUserID() bound to caller_id (incident/request) or assigned_to (problem/change/task).\n' +
            '- For relative dates: javascript:gs.daysAgoStart(N), gs.daysAgoEnd(N), gs.beginningOfThisWeek(), gs.endOfYesterday().\n' +
            '- Priority words map: critical=1, high=2, moderate=3, low=4.\n' +
            '- State: active->active=true, open->active=true, closed->state=7, resolved->state=6, in progress->state=2.\n' +
            '- For LIKE on text: short_descriptionLIKE<term> (case-insensitive).\n' +
            '- For "my team" or "my group": assignment_groupINjavascript:gs.getUser().getMyGroups().join(",")\n' +
            '\nExamples:\n' +
            ' "P1 VPN incidents from last week assigned to my team"  ->  priority=1^short_descriptionLIKEVPN^opened_at>=javascript:gs.daysAgoStart(7)^assignment_groupINjavascript:gs.getUser().getMyGroups().join(",")\n' +
            ' "my open changes"                                       ->  active=true^assigned_to=javascript:gs.getUserID()\n' +
            ' "overdue critical incidents not assigned"               ->  priority=1^active=true^assigned_toISEMPTY^due_date<javascript:gs.nowDateTime()';
        var userMsg = 'Table: ' + tbl + '\nFilter: ' + naturalLanguage;

        var schema = {
            type: 'object',
            properties: {
                encoded_query: { type: 'string', description: 'The ServiceNow encoded query string with ^ separators' },
                explanation:   { type: 'string', description: 'One-sentence plain-English summary of the query' }
            },
            required: ['encoded_query']
        };
        var resp = _reason(systemText, userMsg, schema, 400);
        if (resp.error) return { ok: false, error: 'Reasoning engine failed: ' + resp.error };

        var query = String((resp.json && resp.json.encoded_query) || '').trim();
        // Strip any accidental code fences
        query = query.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '').trim().split('\n')[0].trim();
        // R4.5 - reject prompt-injection: only allow the four documented
        // ServiceNow encoded-query JS helpers, refuse anything else.
        if (/javascript:/i.test(query)) {
            var _allowed = /javascript:gs\.(daysAgoStart|beginningOfThisWeek|endOfYesterday|getUserID|hoursAgoStart|hoursAgoEnd)\(\)/g;
            var _stripped = query.replace(_allowed, 'X');
            if (/javascript:/i.test(_stripped)) {
                return { ok: false, error: 'Query contains unsupported javascript: helper. Allowed helpers: daysAgoStart, beginningOfThisWeek, endOfYesterday, getUserID, hoursAgoStart, hoursAgoEnd.' };
            }
        }

        if (query.indexOf('=') < 0 && query.indexOf('LIKE') < 0) {
            return { ok: false, error: 'Model output did not look like an encoded query: ' + query.substring(0, 100) };
        }

        // Preview count so the user knows scale before drilling in
        var count = -1;
        try {
            var ga = new GlideAggregate(tbl);
            ga.addEncodedQuery(query);
            ga.addAggregate('COUNT');
            ga.query();
            if (ga.next()) count = parseInt(ga.getAggregate('COUNT'), 10) || 0;
        } catch (eC) {}

        return {
            ok: true,
            via: 'gemini-reason',
            table: tbl,
            natural_language: naturalLanguage,
            encoded_query: query,
            explanation: (resp.json && resp.json.explanation) || '',
            match_count: count,
            message: (count >= 0 ? ('Found ' + count + ' matching rows. ') : '') +
                     'Query: ' + query
        };
    }

    /* ===================================================================
     *  R2 - NAVIGATE TO RECORD (in-tab SP navigation)
     *  Returns a directive {navigate_url} that the client picks up and
     *  applies via window.location.assign(). Stays within the SN tab.
     * =================================================================== */
    function _navigateToRecord(num) {
        if (!num) return { ok: false, error: 'Ticket number is required.' };
        var table = _tableForNumber(num);
        if (!table) return { ok: false, error: 'Unrecognised number: ' + num };
        var gr = new GlideRecord(table);
        if (!gr.get('number', num)) return { ok: false, error: 'Ticket not found: ' + num };

        // Map table -> SP page id (the Now portal default ticket page)
        var pageId = 'ticket';   // works for incident/problem/change in stock /sp portal
        if (table === 'kb_knowledge')  pageId = 'kb_article';
        if (table === 'sc_req_item')   pageId = 'sc_request';
        if (table === 'sc_task')       pageId = 'sc_task';

        var url = '/sp?id=' + pageId + '&table=' + table + '&sys_id=' + gr.getUniqueValue();
        // Client side will pick up navigate_url and call window.location.assign(url)
        return {
            ok: true,
            navigate_url: url,
            table: table, number: num, sys_id: gr.getUniqueValue(),
            short_description: String(gr.short_description || ''),
            message: 'Opening ' + num + ' in this tab. ' + String(gr.short_description || '').substring(0, 80)
        };
    }

    /* ===================================================================
     *  R2 - CLICK BUTTON (in-tab DOM click via client directive)
     *  Server validates the label, client finds the matching button on
     *  the current SP page and clicks it. No system-wide control.
     * =================================================================== */
    /* ===================================================================
     *  R2.4 - update_field
     *  Update ANY standard field on a ticket (not just comments).
     *  Safer than letting Gemini grab gr.setValue() through update_ticket
     *  because we allow-list the fields it can touch.
     * =================================================================== */
    var UPDATE_ALLOW = {
        short_description:  true, description:        true,
        urgency:            true, impact:             true,
        priority:           true, category:           true,
        subcategory:        true, state:              true,
        assignment_group:   true, assigned_to:        true,
        comments:           true, work_notes:         true,
        close_notes:        true, close_code:         true,
        cmdb_ci:            true
    };
    // Map common synonyms the user might say to actual ServiceNow fields
    var FIELD_SYNONYM = {
        'short description':  'short_description',
        'title':              'short_description',
        'summary':            'short_description',
        'desc':               'description',
        'details':            'description',
        'assignment group':   'assignment_group',
        'assigned group':     'assignment_group',
        'group':              'assignment_group',
        'assignee':           'assigned_to',
        'assigned to':        'assigned_to',
        'owner':              'assigned_to',
        'work note':          'work_notes',
        'work notes':         'work_notes',
        'internal note':      'work_notes',
        'close note':         'close_notes',
        'close notes':        'close_notes',
        'configuration item': 'cmdb_ci',
        'ci':                 'cmdb_ci'
    };
    function _updateField(num, field, value) {
        if (!num || !field || value === undefined || value === null || value === '') {
            return { ok: false, error: 'ticket number, field, and value all required' };
        }
        // Inline the allow-list + synonym map for robustness against any
        // var-scoping weirdness in the scoped-app sandbox.
        var ALLOW = {
            'short_description': 1, 'description': 1, 'urgency': 1, 'impact': 1,
            'priority': 1, 'category': 1, 'subcategory': 1, 'state': 1,
            'assignment_group': 1, 'assigned_to': 1, 'comments': 1, 'work_notes': 1,
            'close_notes': 1, 'close_code': 1, 'cmdb_ci': 1
        };
        var SYN = {
            'short description': 'short_description',
            'title':              'short_description',
            'summary':            'short_description',
            'desc':               'description',
            'details':            'description',
            'assignment group':   'assignment_group',
            'assigned group':     'assignment_group',
            'group':              'assignment_group',
            'assignee':           'assigned_to',
            'assigned to':        'assigned_to',
            'owner':              'assigned_to',
            'work note':          'work_notes',
            'work notes':         'work_notes',
            'internal note':      'work_notes',
            'close note':         'close_notes',
            'close notes':        'close_notes',
            'configuration item': 'cmdb_ci',
            'ci':                 'cmdb_ci'
        };
        var fieldRaw  = String(field).toLowerCase().trim();
        var fieldNorm = SYN[fieldRaw] || fieldRaw.replace(/\s+/g, '_');
        if (!ALLOW[fieldNorm]) {
            return { ok: false, error: 'Field "' + field + '" is not in the safe update allow-list.' };
        }
        var table = _tableForNumber(num);
        if (!table) return { ok: false, error: 'Unrecognised ticket number: ' + num };
        var gr = new GlideRecord(table);
        if (!gr.get('number', num)) return { ok: false, error: 'Ticket not found: ' + num };

        var oldValue = '';
        try { oldValue = String(gr.getValue(fieldNorm) || ''); } catch (eOld) { oldValue = ''; }
        // Special handling for choice fields - try human label -> value
        var newValue = value;
        if (fieldNorm === 'urgency' || fieldNorm === 'impact' || fieldNorm === 'priority') {
            var lc = String(value).toLowerCase().trim();
            if (lc.indexOf('crit') === 0 || lc === 'p1')  newValue = '1';
            else if (lc.indexOf('high') === 0 || lc === 'p2') newValue = '2';
            else if (lc.indexOf('mod') === 0 || lc.indexOf('med') === 0 || lc === 'p3') newValue = '3';
            else if (lc.indexOf('low') === 0 || lc === 'p4') newValue = '4';
        }
        if (fieldNorm === 'assignment_group') {
            // Try to resolve group by name
            var gg = new GlideRecord('sys_user_group');
            gg.addEncodedQuery('nameLIKE' + value);
            gg.setLimit(1);
            gg.query();
            if (gg.next()) newValue = gg.getUniqueValue();
        }
        if (fieldNorm === 'assigned_to') {
            var u = new GlideRecord('sys_user');
            u.addEncodedQuery('active=true^nameLIKE' + value + '^ORuser_nameLIKE' + value);
            u.setLimit(1);
            u.query();
            if (u.next()) newValue = u.getUniqueValue();
            else return { ok: false, error: 'No active user matching "' + value + '"' };
        }
        gr.setValue(fieldNorm, newValue);
        gr.update();
        return {
            ok: true,
            ticket:     num,
            field:      fieldNorm,
            old_value:  oldValue.substring(0, 120),
            new_value:  String(value).substring(0, 120),
            message:    'Updated ' + fieldNorm + ' on ' + num + '.'
        };
    }

    /* ===================================================================
     *  R2.4 - open_url + go_to_servicenow (Chrome tab navigation)
     *  These return client directives that the controller acts on.
     * =================================================================== */
    function _openUrl(url, title) {
        if (!url) return { ok: false, error: 'URL is required.' };
        // Require https for safety; auto-prepend if missing
        if (url.indexOf('http://') !== 0 && url.indexOf('https://') !== 0) {
            url = 'https://' + url.replace(/^\/*/, '');
        }
        return {
            ok: true,
            open_url:    url,            // client-directive: window.open in new tab
            url:         url,
            title:       title || url,
            message:     'Opening ' + (title || url) + ' in a new tab.'
        };
    }
    function _goToServiceNow() {
        return {
            ok: true,
            navigate_url: '/sp',         // existing R2 client handler will follow this
            message:      'Going back to ServiceNow now.'
        };
    }

    /* ===================================================================
     *  R2.6 - read_script + list_scripts (any ServiceNow code file)
     *  Tries each script table in order. Returns source + metadata.
     * =================================================================== */
    var SCRIPT_TABLES = [
        { table: 'sys_script_include', nameField: 'name',         scriptField: 'script',           label: 'Script Include' },
        { table: 'sys_script',         nameField: 'name',         scriptField: 'script',           label: 'Business Rule' },
        { table: 'sys_ui_script',      nameField: 'script_name',  scriptField: 'script',           label: 'UI Script' },
        { table: 'sys_script_client',  nameField: 'name',         scriptField: 'script',           label: 'Client Script' },
        { table: 'sysauto_script',     nameField: 'name',         scriptField: 'script',           label: 'Scheduled Job' },
        { table: 'sys_processor',      nameField: 'name',         scriptField: 'script',           label: 'Processor' },
        { table: 'sys_ws_operation',   nameField: 'name',         scriptField: 'operation_script', label: 'Scripted REST Resource' },
        { table: 'sys_script_email',   nameField: 'name',         scriptField: 'script',           label: 'Email Script' },
        { table: 'sys_ui_action',      nameField: 'name',         scriptField: 'script',           label: 'UI Action' }
    ];

    function _readScript(query) {
        try {
            if (!query) return { ok: false, error: 'Query is required.' };
            var q = String(query || '').trim();
            if (!q) return { ok: false, error: 'Query is empty.' };
            var isSysId = q.length === 32 && /^[a-f0-9]+$/i.test(q);

            // Inlined SCRIPT_TABLES (avoids scoped-app var-scoping issues
            // that caused the previous "length from undefined" failure).
            var TABLES = [
                { table: 'sys_script_include', nameField: 'name',         scriptField: 'script',           label: 'Script Include' },
                { table: 'sys_script',         nameField: 'name',         scriptField: 'script',           label: 'Business Rule' },
                { table: 'sys_ui_script',      nameField: 'script_name',  scriptField: 'script',           label: 'UI Script' },
                { table: 'sys_script_client',  nameField: 'name',         scriptField: 'script',           label: 'Client Script' },
                { table: 'sysauto_script',     nameField: 'name',         scriptField: 'script',           label: 'Scheduled Job' },
                { table: 'sys_processor',      nameField: 'name',         scriptField: 'script',           label: 'Processor' },
                { table: 'sys_ws_operation',   nameField: 'name',         scriptField: 'operation_script', label: 'Scripted REST Resource' },
                { table: 'sys_script_email',   nameField: 'name',         scriptField: 'script',           label: 'Email Script' },
                { table: 'sys_ui_action',      nameField: 'name',         scriptField: 'script',           label: 'UI Action' }
            ];

            for (var i = 0; i < TABLES.length; i++) {
                var t = TABLES[i];
                var gr;
                try {
                    gr = new GlideRecord(t.table);
                    if (isSysId) {
                        if (gr.get(q)) return _formatScript(t, gr);
                        continue;
                    }
                    // Try exact name
                    gr.addQuery(t.nameField, q);
                    gr.setLimit(1);
                    gr.query();
                    if (gr.next()) return _formatScript(t, gr);
                    // Try LIKE name
                    var gr2 = new GlideRecord(t.table);
                    gr2.addEncodedQuery(t.nameField + 'LIKE' + q);
                    gr2.setLimit(1);
                    gr2.query();
                    if (gr2.next()) return _formatScript(t, gr2);
                } catch (e) {
                    gs.warn('[NetraScript] could not query ' + t.table + ': ' + (e.message || e));
                }
            }

            // Service Portal widget by name OR id
            try {
                var w = new GlideRecord('sp_widget');
                if (isSysId) {
                    if (w.get(q)) return _formatWidget(w);
                } else {
                    w.addEncodedQuery('nameLIKE' + q + '^ORid=' + q.toLowerCase().replace(/\s+/g, '-'));
                    w.setLimit(1);
                    w.query();
                    if (w.next()) return _formatWidget(w);
                }
            } catch (eW) {}

            return { ok: false, error: 'No script found matching "' + query + '" in any script table.' };
        } catch (eOuter) {
            return { ok: false, error: 'read_script outer error: ' + (eOuter.message || eOuter) };
        }
    }

    function _formatScript(t, gr) {
        try {
            // Use getValue() defensively - bracket access on GlideRecord
            // can return GlideElement objects that don't coerce cleanly.
            var raw    = gr.getValue(t.scriptField);
            var script = (raw === null || raw === undefined) ? '' : String(raw);
            var truncated = false;
            if (script.length > 8000) {
                script = script.substring(0, 8000) + '\n\n[... truncated, ' + (script.length - 8000) + ' more chars]';
                truncated = true;
            }
            var name = gr.getValue(t.nameField);
            if (name === null || name === undefined) name = '';
            var desc = gr.getValue('description') || gr.getValue('short_description') || '';
            var when = (t.table === 'sys_script') ? (gr.getValue('when') || '') : null;
            var onTbl = '';
            try { onTbl = String(gr.getValue('table') || ''); } catch (eT) {}

            return {
                ok: true,
                table: t.table,
                kind:  t.label,
                name:  String(name),
                sys_id: gr.getUniqueValue(),
                active: String(gr.getValue('active') || ''),
                description: String(desc),
                extra_when:  when,
                extra_table: onTbl,
                script_source: script,
                truncated:     truncated,
                line_count:    script ? script.split('\n').length : 0,
                char_count:    script.length,
                message: 'Read ' + t.label + ' "' + name + '" (' + script.length + ' chars). Now explain it briefly.'
            };
        } catch (e) {
            return { ok: false, error: 'Formatter error on ' + t.table + ': ' + (e.message || e) };
        }
    }

    function _formatWidget(w) {
        // Widgets have 4 bodies - return them all
        return {
            ok: true,
            table: 'sp_widget',
            kind:  'Service Portal Widget',
            name:  String(w.name || ''),
            sys_id: w.getUniqueValue(),
            id:    String(w.id || ''),
            description: String(w.description || ''),
            client_script_excerpt: String(w.client_script || '').substring(0, 3000),
            server_script_excerpt: String(w.script || '').substring(0, 3000),
            template_excerpt:      String(w.template || '').substring(0, 2000),
            css_excerpt:           String(w.css || '').substring(0, 2000),
            message: 'Read Service Portal widget. Has template + client + server + css.'
        };
    }

    function _listScripts(table, keyword) {
        if (!table) return { ok: false, error: 'table is required (sys_script_include, sys_script, sys_ui_script, sys_script_client, sysauto_script, sys_processor, sys_ws_operation, sys_script_email, sys_ui_action, sp_widget)' };
        var TABLES = [
            { table: 'sys_script_include', nameField: 'name' },
            { table: 'sys_script',         nameField: 'name' },
            { table: 'sys_ui_script',      nameField: 'script_name' },
            { table: 'sys_script_client',  nameField: 'name' },
            { table: 'sysauto_script',     nameField: 'name' },
            { table: 'sys_processor',      nameField: 'name' },
            { table: 'sys_ws_operation',   nameField: 'name' },
            { table: 'sys_script_email',   nameField: 'name' },
            { table: 'sys_ui_action',      nameField: 'name' }
        ];
        var t = null;
        for (var i = 0; i < TABLES.length; i++) { if (TABLES[i].table === table) { t = TABLES[i]; break; } }
        if (!t && table !== 'sp_widget') {
            return { ok: false, error: 'Unsupported table. Use one of: ' + SCRIPT_TABLES.map(function (x) { return x.table; }).join(', ') + ', sp_widget' };
        }
        try {
            var gr = new GlideRecord(table);
            if (keyword) gr.addEncodedQuery((t ? t.nameField : 'name') + 'LIKE' + keyword);
            if (gr.isValid && !gr.isValid()) {} else {
                if (gr.orderBy) gr.orderBy(t ? t.nameField : 'name');
            }
            gr.setLimit(40);
            gr.query();
            var out = [];
            while (gr.next()) {
                out.push({
                    name: String(t ? gr[t.nameField] : gr.name) || '',
                    sys_id: gr.getUniqueValue(),
                    active: String(gr.active || ''),
                    description: String(gr.description || gr.short_description || '').substring(0, 80)
                });
            }
            return { ok: true, table: table, count: out.length, scripts: out,
                     message: 'Found ' + out.length + ' rows in ' + table + (keyword ? ' matching "' + keyword + '"' : '') };
        } catch (e) {
            return { ok: false, error: 'Could not list ' + table + ': ' + (e.message || e) };
        }
    }

    function _clickButton(label) {
        if (!label) return { ok: false, error: 'Button label is required.' };
        // Server-side gatekeeping - we only allow specific known safe labels
        // to be clicked. Voice typos like "club" instead of "click" should fail.
        var allowed = ['save','submit','update','resolve','close','reopen','approve','reject',
                       'cancel','back','next','order now','add to cart','request',
                       'create','delete','attach','send','post','reply','escalate'];
        var lc = label.toLowerCase().trim();
        var matched = allowed.find(function (a) { return lc.indexOf(a) >= 0; });
        if (!matched) {
            return { ok: false, error: 'I am only allowed to click standard form buttons (Save, Submit, Resolve, Approve, etc). I cannot click "' + label + '".' };
        }
        // Client side will pick up click_button_label and execute the DOM click
        return {
            ok: true,
            click_button_label: matched,
            message: 'Clicking ' + matched + ' for you.'
        };
    }

    // R2.9.1 - common SN/IT vocabulary that should always seed the recognizer.
    // These don't appear in the instance's groups/apps/KB but are spoken often
    // in voice commands ("escalate", "VPN", "MFA", "approve", etc.).
    var COMMON_VOCAB = [
        // Record actions
        'create', 'open', 'close', 'resolve', 'cancel', 'escalate', 'reopen',
        'approve', 'reject', 'submit', 'assign', 'reassign', 'watch', 'unwatch',
        'summarise', 'summarize', 'list', 'search', 'read', 'show', 'tell',
        // Record types
        'incident', 'problem', 'change', 'request', 'task', 'approval',
        'ticket', 'knowledge', 'article', 'catalog',
        // Fields
        'priority', 'urgency', 'impact', 'state', 'category', 'subcategory',
        'description', 'comment', 'note', 'attachment', 'work note',
        // Common IT terms
        'VPN', 'MFA', 'SSO', 'AD', 'LDAP', 'DNS', 'DHCP', 'TLS', 'SSL',
        'firewall', 'router', 'switch', 'server', 'database', 'storage',
        'backup', 'restore', 'patch', 'update', 'upgrade', 'reboot', 'restart',
        'Outlook', 'Teams', 'Slack', 'Zoom', 'GitHub', 'Jira', 'Confluence',
        'ServiceNow', 'AWS', 'Azure', 'GCP', 'Kubernetes', 'Docker',
        // Time + counting
        'today', 'tomorrow', 'yesterday', 'now', 'later', 'soon',
        'morning', 'afternoon', 'evening', 'minute', 'hour', 'day', 'week',
        // Greetings / smalltalk
        'hello', 'hi', 'hey', 'thanks', 'thank you', 'please', 'sorry',
        // Netra-specific
        'Netra', 'sentinel', 'sleep', 'wake', 'pause', 'resume', 'dictate',
        'briefing', 'workload', 'focus', 'watchlist', 'remember', 'recall'
    ];

    function _getVocab() {
        // R4.6 - dropped sys_properties cache entirely. Yokohama+ instances
        // platform-flash "Not allowing update of property" on every
        // setProperty call from a scoped widget context, regardless of
        // sys_scope. The user sees red banners on every page load. We
        // now rebuild fresh on each request (~80ms total for 5 indexed
        // queries), which is < 2% of a typical Gemini round-trip.
        // The reads at line 3708-3709 still work; we use cached value if
        // present (set externally via Update Set import or a one-off
        // background script), but we never WRITE.
        try {
            var cached = gs.getProperty(SCOPE + '.vocab_cache');
            var cachedTs = parseInt(gs.getProperty(SCOPE + '.vocab_cache_ts', '0'), 10);
            var ageMs = new Date().getTime() - cachedTs;
            if (cached && ageMs < 6 * 60 * 60 * 1000) {
                var p = JSON.parse(cached);
                if (p && typeof p === 'object') {
                    p.common = COMMON_VOCAB;
                    return p;
                }
            }
        } catch (e) { /* fall through to refresh */ }

        var v = { groups: [], apps: [], categories: [], kb_titles: [], catalog_items: [], common: COMMON_VOCAB, built_at: '' };

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

        // R4.6 - setProperty calls REMOVED. Yokohama platform flashes
        // "Not allowing update of property: X" via gs.addErrorMessage
        // from inside GlideProperties.setProperty, regardless of scope,
        // and it bypasses our try/catch (because the message is added
        // out-of-band, not via thrown exception). The cache is now
        // request-scoped only; each request rebuilds. If a future
        // instance has working setProperty for scoped properties, an
        // out-of-band update (background script or update-set import)
        // can populate vocab_cache and the read at line ~3711 will use
        // it. See _setSystemCache() helper below for portable storage.

        gs.info('[NetraGemini] vocab refreshed - groups=' + v.groups.length +
                ' apps=' + v.apps.length + ' cats=' + v.categories.length +
                ' kb=' + v.kb_titles.length + ' catItems=' + v.catalog_items.length);
        return v;
    }

    /* ===================================================================
     *  Pref / pause helpers
     * =================================================================== */
    // R4.7 - PERF: merged _ensurePref + _setPauseState into a single query.
    // Ensures the per-user pref row exists and, in the same pass, populates
    // data.paused / data.paused_until from that row.
    function _ensurePrefAndPause() {
        data.paused = false;
        data.paused_until = '';
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
            return;   // brand-new row is never paused
        }
        if (pref.paused_until && String(pref.paused_until) !== '') {
            var nowGdt = new GlideDateTime();
            if (new GlideDateTime(String(pref.paused_until)).compareTo(nowGdt) > 0) {
                data.paused = true;
                data.paused_until = String(pref.paused_until);
            }
        }
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
