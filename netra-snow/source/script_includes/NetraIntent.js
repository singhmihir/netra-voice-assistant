/**
 * NetraIntent — natural-language intent parser.
 *
 * v2.0 — expanded vocabulary, smalltalk, pause/resume, partial intents.
 *
 * Returns: { action, args, original, pending? }
 *
 *   action: one of
 *     'create'        | 'list'      | 'resolve'    | 'update'        | 'status'
 *     'pause_ask'     | 'pause_for' | 'resume'
 *     'greet'         | 'thanks'    | 'smalltalk'  | 'repeat'        | 'affirm' | 'negate'
 *     'help'          | 'cancel'    | 'unknown'
 *     'partial_create'                                    -- "open a ticket" with no description
 *     'partial_resolve'                                   -- "resolve a ticket" with no number
 *
 *   pending: if set, the widget should hold the conversation in a state where
 *            the next utterance is interpreted as the answer to a question.
 *            Possible values: 'pause_duration' | 'ticket_description' | 'resolve_number'
 */
var NetraIntent = Class.create();
NetraIntent.prototype = {
    initialize: function () {},

    /**
     * @param {string} transcript            free-form transcribed text
     * @param {string} [pendingContext]      one of 'pause_duration', 'ticket_description', 'resolve_number'
     */
    parse: function (transcript, pendingContext) {
        var raw = String(transcript || '').trim();
        var t = raw.toLowerCase().replace(/[.!?,;]+$/g, '').trim();
        if (!t) return this._intent('unknown', {}, raw);

        // ============================================================
        // Multi-turn continuation: interpret based on pending question
        // ============================================================
        if (pendingContext === 'pause_duration') {
            var dur = this._extractDuration(t);
            if (dur !== null) return this._intent('pause_for', { hours: dur }, raw);
            if (/^(cancel|never mind|nevermind|forget it|no)/.test(t)) return this._intent('cancel', {}, raw);
            // Couldn't parse — re-ask
            return this._intent('pause_ask', { reprompt: true }, raw);
        }
        if (pendingContext === 'ticket_description') {
            if (/^(cancel|never mind|nevermind)/.test(t)) return this._intent('cancel', {}, raw);
            // Whatever they said is the description
            return this._intent('create', { description: this._cleanDescription(raw) }, raw);
        }
        if (pendingContext === 'resolve_number') {
            var num = this._extractTicketNumber(t);
            if (num) return this._intent('resolve', { ticket_number: num }, raw);
            if (/^(cancel|never mind|nevermind)/.test(t)) return this._intent('cancel', {}, raw);
            return this._intent('partial_resolve', { reprompt: true }, raw);
        }

        // ============================================================
        // Cancel / stop  (highest priority — interrupts everything)
        // ============================================================
        if (/^(stop|cancel|quiet|shut up|never mind|nevermind|forget it|enough|silence|hush)\b/.test(t)) {
            return this._intent('cancel', {}, raw);
        }

        // ============================================================
        // Pause / resume notifications
        // ============================================================
        // "pause for two hours" / "be quiet for an hour" / "mute for 30 minutes"
        var pauseForMatch = t.match(/(pause|mute|silence|hush|hold off|be quiet)\s+(notifications?\s+)?(for\s+)?(.+)/i);
        if (pauseForMatch) {
            var d = this._extractDuration(pauseForMatch[4]);
            if (d !== null) return this._intent('pause_for', { hours: d }, raw);
        }
        // bare "pause" / "be quiet" — ask follow-up
        if (/^(pause|mute|silence(?:\s+yourself)?|be quiet|hold on|hold off|don't bother me|leave me alone)\b/.test(t)) {
            return this._intent('pause_ask', {}, raw);
        }
        // resume
        if (/^(resume|unpause|un-pause|wake up|come back|start (?:listening|talking) again|i'?m back)\b/.test(t)) {
            return this._intent('resume', {}, raw);
        }

        // ============================================================
        // Smalltalk & social
        // ============================================================
        if (/^(hi|hey|hello|hiya|greetings|good (?:morning|afternoon|evening|day))\b/.test(t)
            || /^(?:hi|hey|hello)\s+netra\b/.test(t)) {
            return this._intent('greet', {}, raw);
        }
        if (/^(thanks|thank you|thx|ty|appreciate it|cheers|much obliged)\b/.test(t)
            || /^(good job|nice work|well done|you'?re (?:awesome|great|the best))/.test(t)) {
            return this._intent('thanks', {}, raw);
        }
        if (/^(how are you|how'?s it going|how are things|what'?s up|sup|how do you do)/.test(t)) {
            return this._intent('smalltalk', { kind: 'how_are_you' }, raw);
        }
        if (/^(what'?s your name|who are you|tell me about yourself)/.test(t)) {
            return this._intent('smalltalk', { kind: 'who_are_you' }, raw);
        }
        if (/(can you (?:please )?)?(repeat|say (?:that|it) again|what did you say|come again|pardon)/.test(t)) {
            return this._intent('repeat', {}, raw);
        }
        if (/^(yes|yeah|yep|yup|sure|okay|ok|please do|go ahead|sounds good|that'?s right|correct)\b/.test(t)) {
            return this._intent('affirm', {}, raw);
        }
        if (/^(no|nope|nah|not now|don'?t|negative)\b/.test(t)) {
            return this._intent('negate', {}, raw);
        }

        // ============================================================
        // Help
        // ============================================================
        if (/^(help|what can you do|how does this work|what are my options|what can i ask|commands|menu)/.test(t)) {
            return this._intent('help', {}, raw);
        }

        // ============================================================
        // Resolve / close
        // ============================================================
        var resolveMatch = t.match(/(resolve|close|mark.*resolved|close out)\s+(ticket\s+)?(inc\d{4,})/i)
                       || t.match(/(inc\d{4,})\s+is\s+(resolved|done|fixed|closed)/i);
        if (resolveMatch) {
            var rnum = this._extractTicketNumber(resolveMatch[3] || resolveMatch[1]);
            if (rnum) return this._intent('resolve', { ticket_number: rnum }, raw);
        }
        // bare "resolve a ticket" / "close my ticket" → ask which
        if (/^(resolve|close|finish|complete)\s+(a |the |my )?ticket/i.test(t)) {
            return this._intent('partial_resolve', {}, raw);
        }

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
        // Status of a specific ticket
        // ============================================================
        var statusMatch = t.match(/(status of|what(?:'s| is)|tell me about|how(?:'s| is)|details (?:on|for))\s+(?:ticket\s+)?(inc\d{4,})/i)
                      || t.match(/(inc\d{4,})\s+(status|what.*about)/i);
        if (statusMatch) {
            var snum = this._extractTicketNumber(statusMatch[2] || statusMatch[1]);
            if (snum) return this._intent('status', { ticket_number: snum }, raw);
        }

        // ============================================================
        // List my tickets / "what's new"
        // ============================================================
        if (/(list|show|tell me|what(?:'s| are| is))(.*?)(my |open |all my )?tickets?\b/i.test(t)
            || /what(?:'s| is) on my plate/i.test(t)
            || /any (?:new |open )?tickets?/i.test(t)
            || /what(?:'s| is) new\b/.test(t)) {
            return this._intent('list', {}, raw);
        }

        // ============================================================
        // Create / open ticket
        // ============================================================
        var createMatch = t.match(/(?:create|open|log|raise|submit|file|i (?:need|want) (?:a |to (?:create|open|log) (?:a )?))?\s*(?:a |an )?(?:new )?ticket\s+(?:for|about|that|on|regarding)?[,:\-\s]+(.+)/i);
        if (createMatch && createMatch[1] && createMatch[1].trim().length > 2) {
            return this._intent('create', { description: this._cleanDescription(createMatch[1]) }, raw);
        }
        var reportMatch = t.match(/^(?:please\s+)?report\s+(?:that\s+)?(.+)/i);
        if (reportMatch && reportMatch[1].trim().length > 2) {
            return this._intent('create', { description: this._cleanDescription(reportMatch[1]) }, raw);
        }
        var bareTicketMatch = t.match(/^(?:please\s+)?ticket[:\-\s]+(.+)/i);
        if (bareTicketMatch && bareTicketMatch[1].trim().length > 2) {
            return this._intent('create', { description: this._cleanDescription(bareTicketMatch[1]) }, raw);
        }
        // "open a ticket" / "I need a ticket" with no body — ask for description
        if (/^(create|open|raise|log|file|submit|i (?:need|want))(?:\s+(?:a|an|the|me|to (?:open|log|file)))?\s+(?:new\s+)?ticket\b/i.test(t)) {
            return this._intent('partial_create', {}, raw);
        }

        return this._intent('unknown', {}, raw);
    },

    // -------------------------------------------------------------
    //  Helpers
    // -------------------------------------------------------------

    // Parse durations like "2 hours", "an hour", "30 minutes", "1.5 hours",
    // "until 5pm", "until tomorrow", "two and a half hours".
    // Returns hours (float) or null if not parseable.
    _extractDuration: function (s) {
        if (!s) return null;
        var t = String(s).toLowerCase().trim();

        // numeric word→digit conversion for small numbers
        var words = {
            'an': 1, 'a': 1, 'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5,
            'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10,
            'eleven': 11, 'twelve': 12, 'half': 0.5, 'quarter': 0.25
        };

        // "for the rest of the day" / "rest of the day"
        if (/(rest of (?:the )?day|all day|today|end of day)/.test(t)) return 8;
        if (/(until|till) (?:tomorrow|the morning)/.test(t)) return 12;
        if (/(forever|indefinitely|until i say|till i say)/.test(t)) return 24 * 7;

        // "two and a half hours" / "one and a quarter"
        var compound = t.match(/(\w+)\s+and\s+(?:a\s+)?(half|quarter)\s+hours?/);
        if (compound) {
            var base = words[compound[1]] != null ? words[compound[1]] : parseFloat(compound[1]);
            var frac = words[compound[2]] || 0;
            if (!isNaN(base)) return base + frac;
        }

        // "X hours", "X hrs", "X h"
        var hMatch = t.match(/(\d+(?:\.\d+)?|\w+)\s*(?:hours?|hrs?|h)\b/);
        if (hMatch) {
            var h = words[hMatch[1]] != null ? words[hMatch[1]] : parseFloat(hMatch[1]);
            if (!isNaN(h)) return h;
        }

        // "X minutes" / "X mins" / "X m"
        var mMatch = t.match(/(\d+(?:\.\d+)?|\w+)\s*(?:minutes?|mins?|m)\b/);
        if (mMatch) {
            var m = words[mMatch[1]] != null ? words[mMatch[1]] : parseFloat(mMatch[1]);
            if (!isNaN(m)) return m / 60;
        }

        // Just a bare number — assume hours
        var n = parseFloat(t);
        if (!isNaN(n) && n > 0 && n < 24) return n;
        if (words[t.split(/\s+/)[0]] != null) return words[t.split(/\s+/)[0]];

        return null;
    },

    _extractTicketNumber: function (s) {
        if (!s) return null;
        var compact = String(s).toUpperCase().replace(/\s+/g, '');
        var m = compact.match(/INC(\d+)/);
        if (!m) return null;
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
