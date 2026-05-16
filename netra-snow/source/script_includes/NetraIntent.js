/**
 * NetraIntent — regex-based natural-language intent parser.
 *
 * Converts a free-form voice transcript into a structured intent object that
 * NetraTools can act on. Deliberately permissive: tries each pattern in
 * priority order and returns the first match.
 *
 * Returns: { action, args, original }
 *   action: 'create' | 'list' | 'resolve' | 'update' | 'status' | 'help' | 'cancel' | 'unknown'
 *   args:   { description?, ticket_number?, comment? }
 *
 * Sample inputs that all map to action: 'create'
 *   "create a ticket for my email is not working"
 *   "open ticket about VPN keeps dropping"
 *   "log a ticket — printer is jammed"
 *   "I need a ticket for the laptop won't boot"
 *   "report that the wifi is down"
 */
var NetraIntent = Class.create();
NetraIntent.prototype = {
    initialize: function () {},

    /**
     * @param {string} transcript Raw speech-to-text output.
     * @returns {{action:string, args:Object, original:string}}
     */
    parse: function (transcript) {
        var raw = String(transcript || '').trim();
        var t = raw.toLowerCase().replace(/[.!?,;]+$/g, '').trim();

        if (!t) return this._intent('unknown', {}, raw);

        // --- 1. Stop / cancel ---
        if (/^(stop|cancel|quiet|shut up|never mind|nevermind|forget it)\b/.test(t)) {
            return this._intent('cancel', {}, raw);
        }

        // --- 2. Help ---
        if (/^(help|what can you do|how does this work|what are my options)/.test(t)) {
            return this._intent('help', {}, raw);
        }

        // --- 3. Resolve / close ---
        //   resolve INC0001234
        //   close out ticket INC0001234
        //   mark INC0001234 as resolved
        var resolveMatch = t.match(/(resolve|close|mark.*resolved|close out)\s+(ticket\s+)?(inc\d{4,})/i)
                       || t.match(/(inc\d{4,})\s+is\s+(resolved|done|fixed|closed)/i);
        if (resolveMatch) {
            var num = this._extractTicketNumber(resolveMatch[3] || resolveMatch[1]);
            if (num) return this._intent('resolve', { ticket_number: num }, raw);
        }

        // --- 4. Update / comment on ---
        //   update INC0001234 with I have rebooted
        //   comment on INC0001234 — still not working
        //   add a note to INC0001234 that ...
        var updateMatch = t.match(/(update|comment on|add (a )?(note|comment) to|note on)\s+(inc\d{4,})[,:\-\s]*(?:with\s+|that\s+|saying\s+)?(.+)/i);
        if (updateMatch) {
            var unum = this._extractTicketNumber(updateMatch[4]);
            var comment = (updateMatch[5] || '').trim();
            if (unum && comment) return this._intent('update', { ticket_number: unum, comment: comment }, raw);
        }

        // --- 5. Status of a specific ticket ---
        //   status of INC0001234
        //   what's INC0001234
        //   tell me about INC0001234
        //   how's INC0001234 going
        var statusMatch = t.match(/(status of|what(?:'s| is)|tell me about|how(?:'s| is)|details (?:on|for))\s+(?:ticket\s+)?(inc\d{4,})/i)
                      || t.match(/(inc\d{4,})\s+(status|what.*about)/i);
        if (statusMatch) {
            var snum = this._extractTicketNumber(statusMatch[2] || statusMatch[1]);
            if (snum) return this._intent('status', { ticket_number: snum }, raw);
        }

        // --- 6. List my tickets ---
        //   list my tickets
        //   show me my tickets
        //   what are my open tickets
        //   what's on my plate
        //   any new tickets
        if (/(list|show|tell me|what(?:'s| are| is))(.*?)(my |open |all my )?tickets?\b/i.test(t)
            || /what(?:'s| is) on my plate/i.test(t)
            || /any (?:new |open )?tickets?/i.test(t)) {
            return this._intent('list', {}, raw);
        }

        // --- 7. Create / open ticket ---
        //   create a ticket for X
        //   open a ticket about X
        //   log a ticket — X
        //   report X
        //   I need a ticket for X
        //   raise a ticket for X
        //   submit a ticket for X
        var createMatch = t.match(/(?:create|open|log|raise|submit|file|i (?:need|want) (?:a |to (?:create|open|log) (?:a )?))?\s*(?:a |an )?(?:new )?ticket\s+(?:for|about|that|on|regarding)?[,:\-\s]+(.+)/i);
        if (createMatch && createMatch[1] && createMatch[1].trim().length > 2) {
            return this._intent('create', { description: this._cleanDescription(createMatch[1]) }, raw);
        }
        // "report that X" / "report X"
        var reportMatch = t.match(/^(?:please\s+)?report\s+(?:that\s+)?(.+)/i);
        if (reportMatch && reportMatch[1].trim().length > 2) {
            return this._intent('create', { description: this._cleanDescription(reportMatch[1]) }, raw);
        }
        // "ticket: X" / "ticket — X"
        var bareTicketMatch = t.match(/^(?:please\s+)?ticket[:\-\s]+(.+)/i);
        if (bareTicketMatch && bareTicketMatch[1].trim().length > 2) {
            return this._intent('create', { description: this._cleanDescription(bareTicketMatch[1]) }, raw);
        }

        return this._intent('unknown', {}, raw);
    },

    // Normalises "i n c zero zero zero one two three four", "INC1234", "inc 1234" → "INC0001234"
    _extractTicketNumber: function (s) {
        if (!s) return null;
        var compact = String(s).toUpperCase().replace(/\s+/g, '');
        var m = compact.match(/INC(\d+)/);
        if (!m) return null;
        // pad to 7 digits, the ServiceNow convention
        var digits = m[1];
        while (digits.length < 7) digits = '0' + digits;
        return 'INC' + digits;
    },

    _cleanDescription: function (s) {
        return String(s)
            .replace(/^[—\-:,\s]+/, '')
            .replace(/^(that |saying |with )/i, '')
            .replace(/\s+/g, ' ')
            .trim();
    },

    _intent: function (action, args, original) {
        return { action: action, args: args || {}, original: original };
    },

    type: 'NetraIntent'
};
