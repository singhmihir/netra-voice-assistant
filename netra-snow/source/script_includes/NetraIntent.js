/**
 * NetraIntent — natural-language intent parser (v3).
 *
 * Pure regex, scoped GlideRecord-friendly. No external API.
 *
 * Intents:
 *   - Tickets: create, list, resolve, update, status, read, search,
 *              partial_create, partial_resolve
 *   - Approvals: list_approvals, approve, reject
 *   - Knowledge: kb_search, kb_read
 *   - Navigation: navigate
 *   - Watchlist: watch, unwatch, list_watched
 *   - Context: focus_that, forget_context
 *   - Pause / resume / voice mode
 *   - Smalltalk, help, cancel, repeat
 */
var NetraIntent = Class.create();
NetraIntent.prototype = {
    initialize: function () {},

    parse: function (transcript, pendingContext) {
        var raw = String(transcript || '').trim();
        var t = raw.toLowerCase().replace(/[.!?,;]+$/g, '').trim();
        if (!t) return this._intent('unknown', {}, raw);

        // ============================================================
        // Multi-turn continuation
        // ============================================================
        if (pendingContext === 'pause_duration') {
            var dur = this._extractDuration(t);
            if (dur !== null) return this._intent('pause_for', { hours: dur }, raw);
            if (/^(cancel|never mind|nevermind|forget it|no)/.test(t)) return this._intent('cancel', {}, raw);
            return this._intent('pause_ask', { reprompt: true }, raw);
        }
        if (pendingContext === 'ticket_description') {
            if (/^(cancel|never mind|nevermind)/.test(t)) return this._intent('cancel', {}, raw);
            return this._intent('create', { description: this._cleanDescription(raw) }, raw);
        }
        if (pendingContext === 'resolve_number') {
            var num = this._extractTicketNumber(t);
            if (num) return this._intent('resolve', { ticket_number: num }, raw);
            if (/^(cancel|never mind|nevermind)/.test(t)) return this._intent('cancel', {}, raw);
            return this._intent('partial_resolve', { reprompt: true }, raw);
        }
        if (pendingContext === 'confirm_destructive') {
            if (/^(yes|yeah|yep|confirm|do it|go ahead|proceed)/.test(t)) return this._intent('confirm_yes', {}, raw);
            return this._intent('confirm_no', {}, raw);
        }
        if (pendingContext === 'chat_reply_body') {
            if (/^(cancel|never mind|nevermind)/.test(t)) return this._intent('cancel', {}, raw);
            return this._intent('chat_send', { body: raw }, raw);
        }
        if (pendingContext === 'kb_query') {
            if (/^(cancel|never mind|nevermind)/.test(t)) return this._intent('cancel', {}, raw);
            return this._intent('kb_search', { query: raw }, raw);
        }

        // ============================================================
        // Cancel / stop
        // ============================================================
        if (/^(stop|cancel|quiet|shut up|never mind|nevermind|forget it|enough|silence|hush)\b/.test(t)) {
            return this._intent('cancel', {}, raw);
        }

        // ============================================================
        // Pause / resume / voice mode
        // ============================================================
        var pauseFor = t.match(/(pause|mute|silence|hush|hold off|be quiet)\s+(notifications?\s+)?(for\s+)?(.+)/i);
        if (pauseFor) {
            var d = this._extractDuration(pauseFor[4]);
            if (d !== null) return this._intent('pause_for', { hours: d }, raw);
        }
        if (/^(pause|mute|silence(?:\s+yourself)?|be quiet|hold on|hold off|don't bother me|leave me alone)\b/.test(t))
            return this._intent('pause_ask', {}, raw);
        if (/^(resume|unpause|un-pause|wake up|come back|start (?:listening|talking) again|i'?m back)\b/.test(t))
            return this._intent('resume', {}, raw);
        var modeMatch = t.match(/(switch to|use|set)\s+(terse|brief|short|normal|verbose|chatty|detailed)\s+(mode|voice)?/);
        if (modeMatch) return this._intent('voice_mode', { mode: modeMatch[2] }, raw);

        // ============================================================
        // Smalltalk
        // ============================================================
        if (/^(hi|hey|hello|hiya|greetings|good (?:morning|afternoon|evening|day))\b/.test(t)
            || /^(?:hi|hey|hello)\s+netra\b/.test(t))
            return this._intent('greet', {}, raw);
        if (/^(thanks|thank you|thx|ty|appreciate it|cheers|much obliged)\b/.test(t)
            || /^(good job|nice work|well done|you'?re (?:awesome|great|the best))/.test(t))
            return this._intent('thanks', {}, raw);
        if (/^(how are you|how'?s it going|how are things|what'?s up|sup|how do you do)/.test(t))
            return this._intent('smalltalk', { kind: 'how_are_you' }, raw);
        if (/^(what'?s your name|who are you|tell me about yourself)/.test(t))
            return this._intent('smalltalk', { kind: 'who_are_you' }, raw);
        if (/(can you (?:please )?)?(repeat|say (?:that|it) again|what did you say|come again|pardon)/.test(t))
            return this._intent('repeat', {}, raw);

        // ============================================================
        // Help
        // ============================================================
        if (/^(help|what can you do|how does this work|what are my options|what can i ask|commands|menu)/.test(t))
            return this._intent('help', {}, raw);

        // ============================================================
        // Navigation
        // ============================================================
        var navMatch = t.match(/^(?:open|go to|take me to|navigate to|show me)\s+(.+)/i);
        if (navMatch) {
            var dest = navMatch[1].trim();
            // If destination is a ticket number, route to record viewer
            var ticketInNav = this._extractTicketNumber(dest);
            if (ticketInNav) return this._intent('status', { ticket_number: ticketInNav }, raw);
            // Otherwise it's a named destination
            return this._intent('navigate', { destination: dest }, raw);
        }

        // ============================================================
        // Approvals
        // ============================================================
        if (/^(any|list|show|tell me)\s*(?:my\s+)?(?:pending\s+)?approvals?\b/.test(t)
            || /what'?s waiting for (?:my )?approval/.test(t))
            return this._intent('list_approvals', {}, raw);
        var approveMatch = t.match(/^(approve|reject|deny|decline)\s+(?:approval\s+)?(?:for\s+)?([a-z]{3,5}\d{4,})/i);
        if (approveMatch) {
            return this._intent(/^(approve)/i.test(approveMatch[1]) ? 'approve' : 'reject',
                                { ref_number: approveMatch[2].toUpperCase() }, raw);
        }

        // ============================================================
        // Knowledge base
        // ============================================================
        var kbReadMatch = t.match(/^(read|open)\s+(?:knowledge\s+)?(?:article\s+)?(kb\d{4,})/i);
        if (kbReadMatch) return this._intent('kb_read', { article: kbReadMatch[2].toUpperCase() }, raw);
        var kbSearchMatch = t.match(/^(?:search|look up|find)\s+(?:knowledge|kb|articles?)\s+(?:about\s+|for\s+|on\s+)?(.+)/i)
                         || t.match(/^how (?:do|to)\s+(.+)/i)
                         || t.match(/^(?:knowledge|kb)\s+(?:about|on|for)\s+(.+)/i);
        if (kbSearchMatch) return this._intent('kb_search', { query: kbSearchMatch[1] }, raw);
        if (/^(?:search|look up|find)\s+(?:in\s+)?(?:knowledge|kb)$/i.test(t))
            return this._intent('partial_kb', {}, raw);

        // ============================================================
        // Chat
        // ============================================================
        if (/^(?:any|read|check)\s*(?:new\s+)?(?:chat\s+)?messages?\b/.test(t)
            || /^(?:any|read)\s+chat\b/.test(t)
            || /any new messages/i.test(t))
            return this._intent('chat_read', {}, raw);
        var chatReplyMatch = t.match(/^(?:reply|respond)\s+(?:to\s+(?:chat|message|last)\s+)?(?:with\s+|saying\s+)?(.+)/i);
        if (chatReplyMatch && chatReplyMatch[1].trim().length > 2) {
            return this._intent('chat_send', { body: chatReplyMatch[1].trim() }, raw);
        }

        // ============================================================
        // Watchlist
        // ============================================================
        var watchMatch = t.match(/^(?:watch|follow|track)\s+(?:ticket\s+)?(inc\d{4,})/i);
        if (watchMatch) {
            var wn = this._extractTicketNumber(watchMatch[1]);
            if (wn) return this._intent('watch', { ticket_number: wn }, raw);
        }
        var unwatchMatch = t.match(/^(?:unwatch|stop watching|stop tracking|stop following)\s+(?:ticket\s+)?(inc\d{4,})/i);
        if (unwatchMatch) {
            var uwn = this._extractTicketNumber(unwatchMatch[1]);
            if (uwn) return this._intent('unwatch', { ticket_number: uwn }, raw);
        }
        if (/^(?:what am i watching|list watched|my watchlist)/.test(t))
            return this._intent('list_watched', {}, raw);

        // ============================================================
        // Resolve / close
        // ============================================================
        var resolveMatch = t.match(/(resolve|close|mark.*resolved|close out)\s+(ticket\s+)?(inc\d{4,})/i)
                       || t.match(/(inc\d{4,})\s+is\s+(resolved|done|fixed|closed)/i);
        if (resolveMatch) {
            var rnum = this._extractTicketNumber(resolveMatch[3] || resolveMatch[1]);
            if (rnum) return this._intent('resolve', { ticket_number: rnum }, raw);
        }
        if (/^(resolve|close|finish|complete)\s+(a |the |my )?ticket/i.test(t))
            return this._intent('partial_resolve', {}, raw);

        // ============================================================
        // Update / comment on
        // ============================================================
        var updateMatch = t.match(/(update|comment on|add (a )?(note|comment) to|note on)\s+(inc\d{4,})[,:\-\s]*(?:with\s+|that\s+|saying\s+)?(.+)/i);
        if (updateMatch) {
            var unum = this._extractTicketNumber(updateMatch[4]);
            var comment = (updateMatch[5] || '').trim();
            if (unum && comment) return this._intent('update', { ticket_number: unum, comment: comment }, raw);
        }

        // ============================================================
        // Status / read of a specific ticket
        // ============================================================
        var statusMatch = t.match(/(status of|what(?:'s| is)|tell me about|how(?:'s| is)|details (?:on|for))\s+(?:ticket\s+)?(inc\d{4,})/i)
                      || t.match(/(inc\d{4,})\s+(status|what.*about)/i);
        if (statusMatch) {
            var snum = this._extractTicketNumber(statusMatch[2] || statusMatch[1]);
            if (snum) return this._intent('status', { ticket_number: snum }, raw);
        }
        var readMatch = t.match(/^(?:read|read me|read out|read aloud)\s+(?:ticket\s+|incident\s+)?(inc\d{4,})/i);
        if (readMatch) {
            var rdnum = this._extractTicketNumber(readMatch[1]);
            if (rdnum) return this._intent('read', { ticket_number: rdnum }, raw);
        }

        // ============================================================
        // Context "that / it" — works only if context is set
        // ============================================================
        if (/^(?:resolve|close|finish)\s+(?:that|it|this)\b/.test(t))
            return this._intent('resolve_context', {}, raw);
        if (/^(?:read|read me|read it|read that)(?:\s+(?:that|it))?$/.test(t))
            return this._intent('read_context', {}, raw);
        if (/^(?:watch|follow)\s+(?:that|it|this)\b/.test(t))
            return this._intent('watch_context', {}, raw);
        if (/^forget\s+(?:context|that|where i am)/.test(t))
            return this._intent('forget_context', {}, raw);

        // ============================================================
        // Search tickets
        // ============================================================
        var searchMatch = t.match(/^(?:search|find)\s+(?:my\s+)?tickets?\s+(?:about|for|on|regarding)?\s*(.+)/i);
        if (searchMatch && searchMatch[1].trim().length > 1) {
            return this._intent('search_tickets', { query: searchMatch[1].trim() }, raw);
        }

        // ============================================================
        // List my tickets
        // ============================================================
        if (/(list|show|tell me|what(?:'s| are| is))(.*?)(my |open |all my )?tickets?\b/i.test(t)
            || /what(?:'s| is) on my plate/i.test(t)
            || /any (?:new |open )?tickets?/i.test(t)
            || /what(?:'s| is) new\b/.test(t))
            return this._intent('list', {}, raw);

        // ============================================================
        // Daily briefing
        // ============================================================
        if (/(?:morning|daily)\s+briefing/i.test(t)
            || /^(?:what(?:'s| is)\s+(?:on\s+)?today)/.test(t)
            || /^brief me\b/.test(t))
            return this._intent('briefing', {}, raw);

        // ============================================================
        // Create ticket
        // ============================================================
        var createMatch = t.match(/(?:create|open|log|raise|submit|file|i (?:need|want) (?:a |to (?:create|open|log) (?:a )?))?\s*(?:a |an )?(?:new )?ticket\s+(?:for|about|that|on|regarding)?[,:\-\s]+(.+)/i);
        if (createMatch && createMatch[1] && createMatch[1].trim().length > 2)
            return this._intent('create', { description: this._cleanDescription(createMatch[1]) }, raw);
        var reportMatch = t.match(/^(?:please\s+)?report\s+(?:that\s+)?(.+)/i);
        if (reportMatch && reportMatch[1].trim().length > 2)
            return this._intent('create', { description: this._cleanDescription(reportMatch[1]) }, raw);
        if (/^(create|open|raise|log|file|submit|i (?:need|want))(?:\s+(?:a|an|the|me|to (?:open|log|file)))?\s+(?:new\s+)?ticket\b/i.test(t))
            return this._intent('partial_create', {}, raw);

        return this._intent('unknown', {}, raw);
    },

    // -------------------------------------------------------------
    //  Helpers
    // -------------------------------------------------------------
    _extractDuration: function (s) {
        if (!s) return null;
        var t = String(s).toLowerCase().trim();
        var w = { 'an':1,'a':1,'one':1,'two':2,'three':3,'four':4,'five':5,'six':6,'seven':7,'eight':8,'nine':9,'ten':10,'eleven':11,'twelve':12,'half':0.5,'quarter':0.25 };
        if (/(rest of (?:the )?day|all day|today|end of day)/.test(t)) return 8;
        if (/(until|till) (?:tomorrow|the morning)/.test(t)) return 12;
        if (/(forever|indefinitely|until i say|till i say)/.test(t)) return 24 * 7;
        var compound = t.match(/(\w+)\s+and\s+(?:a\s+)?(half|quarter)\s+hours?/);
        if (compound) {
            var b = w[compound[1]] != null ? w[compound[1]] : parseFloat(compound[1]);
            var f = w[compound[2]] || 0;
            if (!isNaN(b)) return b + f;
        }
        var h = t.match(/(\d+(?:\.\d+)?|\w+)\s*(?:hours?|hrs?|h)\b/);
        if (h) { var v = w[h[1]] != null ? w[h[1]] : parseFloat(h[1]); if (!isNaN(v)) return v; }
        var m = t.match(/(\d+(?:\.\d+)?|\w+)\s*(?:minutes?|mins?|m)\b/);
        if (m) { var v2 = w[m[1]] != null ? w[m[1]] : parseFloat(m[1]); if (!isNaN(v2)) return v2 / 60; }
        var n = parseFloat(t); if (!isNaN(n) && n > 0 && n < 24) return n;
        var firstWord = t.split(/\s+/)[0]; if (w[firstWord] != null) return w[firstWord];
        return null;
    },

    _extractTicketNumber: function (s) {
        if (!s) return null;
        var compact = String(s).toUpperCase().replace(/\s+/g, '');
        var m = compact.match(/(INC|CHG|RITM|REQ|SCTASK|KB)(\d+)/);
        if (!m) return null;
        var prefix = m[1];
        var digits = m[2];
        var pad = prefix === 'KB' ? 7 : 7;
        while (digits.length < pad) digits = '0' + digits;
        return prefix + digits;
    },

    _cleanDescription: function (s) {
        return String(s).replace(/^[—\-:,\s]+/, '').replace(/^(that |saying |with )/i, '').replace(/\s+/g, ' ').trim();
    },

    _intent: function (action, args, original) {
        return { action: action, args: args || {}, original: original };
    },

    type: 'NetraIntent'
};
