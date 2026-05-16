/**
 * NetraResponder — composes spoken replies.
 *
 * v2.0 — varied phrasing, smalltalk, pause flow with two-turn dialogue,
 * gentle nudges for partial intents.
 *
 * Returned shape:
 *   { ok, message, refresh_tickets?, data?, stop?, pending? }
 *
 * `pending` echoes back to the widget so the next utterance is interpreted
 * as the answer to a follow-up question.
 */
var NetraResponder = Class.create();
NetraResponder.prototype = {

    initialize: function () {
        this.tools = new NetraTools();
    },

    handle: function (intent) {
        switch (intent.action) {
            case 'create':            return this._create(intent.args.description);
            case 'partial_create':    return this._askForDescription();
            case 'list':              return this._list();
            case 'resolve':           return this._resolve(intent.args.ticket_number);
            case 'partial_resolve':   return this._askWhichTicketToResolve(intent.args.reprompt);
            case 'update':            return this._update(intent.args.ticket_number, intent.args.comment);
            case 'status':            return this._status(intent.args.ticket_number);

            case 'pause_ask':         return this._askPauseDuration(intent.args.reprompt);
            case 'pause_for':         return this._pause(intent.args.hours);
            case 'resume':            return this._resume();

            case 'greet':             return this._greet();
            case 'thanks':            return this._reply(this._pickOne([
                                          "You're welcome.",
                                          "Anytime.",
                                          "Happy to help.",
                                          "Glad to be useful.",
                                          "Sure thing."
                                      ]));
            case 'smalltalk':
                if (intent.args.kind === 'how_are_you') {
                    return this._reply(this._pickOne([
                        "Doing well, thank you. Ready when you are.",
                        "All systems normal. What can I do for you?",
                        "I'm good. How can I help?"
                    ]));
                }
                return this._reply("I'm Netra, your ServiceNow voice assistant. I can open tickets, list them, resolve them, or update them. Just say the word.");

            case 'repeat':            return { ok: true, message: '__REPEAT__' }; // widget handles this
            case 'affirm':            return this._reply(this._pickOne(["Okay.", "Got it.", "Understood."]));
            case 'negate':            return this._reply(this._pickOne(["Okay, never mind.", "Understood.", "Got it."]));

            case 'help':              return this._help();
            case 'cancel':            return { ok: true, message: this._pickOne(["Okay.", "Cancelled.", "No problem."]), stop: true, clear_pending: true };

            default:
                return {
                    ok: false,
                    message: this._pickOne([
                        "I didn't quite catch that. You can ask me to create a ticket, list your tickets, resolve one, or update one.",
                        "Sorry, that didn't match anything I know. Try: open a ticket for, list my tickets, or status of I N C.",
                        "Hmm, not sure I followed. Say help to hear what I can do."
                    ])
                };
        }
    },

    // ============================================================
    //  Handlers
    // ============================================================
    _create: function (description) {
        var r = this.tools.createTicket(description);
        if (!r.ok) return this._fail("Sorry, I couldn't open the ticket. " + r.error);
        return {
            ok: true,
            message: this._pickOne([
                'Done. Ticket ' + this._sayNumber(r.ticket.number) + ' opened. Issue recorded: ' + r.ticket.short_description + '.',
                'Got it — ' + this._sayNumber(r.ticket.number) + ' is now open for ' + r.ticket.short_description + '.',
                "I've opened " + this._sayNumber(r.ticket.number) + ' for you. Issue noted as: ' + r.ticket.short_description + '.'
            ]),
            refresh_tickets: true,
            data: r.ticket,
            clear_pending: true
        };
    },

    _askForDescription: function () {
        return {
            ok: true,
            message: this._pickOne([
                "Sure. What's the issue?",
                "Of course. Tell me what's going on.",
                "Right. What should I report?"
            ]),
            pending: 'ticket_description'
        };
    },

    _askWhichTicketToResolve: function (reprompt) {
        if (reprompt) {
            return {
                ok: true,
                message: "I didn't catch the ticket number. Say something like I N C zero zero zero one two three four.",
                pending: 'resolve_number'
            };
        }
        return {
            ok: true,
            message: this._pickOne([
                "Which ticket should I resolve?",
                "Sure. Which I N C number?"
            ]),
            pending: 'resolve_number'
        };
    },

    _list: function () {
        var r = this.tools.listMyTickets(5);
        if (!r.ok) return this._fail('Sorry, I could not load your tickets.');
        var tickets = r.tickets || [];
        if (tickets.length === 0) {
            return {
                ok: true,
                message: this._pickOne([
                    "Good news — you have no open tickets right now.",
                    "All clear, no open tickets.",
                    "Your queue is empty."
                ]),
                data: tickets,
                clear_pending: true
            };
        }
        var pieces = tickets.slice(0, 5).map(function (t) {
            return this._sayNumber(t.number) + ', ' + t.short_description + ', state ' + t.state;
        }.bind(this));
        var msg = 'You have ' + tickets.length + ' open ticket' + (tickets.length === 1 ? '' : 's') + '. ';
        msg += pieces.join('. ') + '.';
        return { ok: true, message: msg, data: tickets, refresh_tickets: true, clear_pending: true };
    },

    _resolve: function (number) {
        if (!number) return this._askWhichTicketToResolve(false);
        var r = this.tools.resolveTicket(number);
        if (!r.ok) return this._fail(r.error);
        return {
            ok: true,
            message: this._pickOne([
                'Ticket ' + this._sayNumber(number) + ' is marked resolved.',
                'Done — ' + this._sayNumber(number) + ' is now resolved.',
                'Resolved ' + this._sayNumber(number) + '.'
            ]),
            refresh_tickets: true,
            clear_pending: true
        };
    },

    _update: function (number, comment) {
        if (!number) return this._fail('Which ticket should I update?');
        if (!comment) return this._fail('What should I add as the comment?');
        var r = this.tools.updateTicket(number, comment);
        if (!r.ok) return this._fail(r.error);
        return {
            ok: true,
            message: this._pickOne([
                'Added your note to ticket ' + this._sayNumber(number) + '.',
                'Comment posted on ' + this._sayNumber(number) + '.',
                'Done. The note is now on ' + this._sayNumber(number) + '.'
            ]),
            refresh_tickets: true,
            clear_pending: true
        };
    },

    _status: function (number) {
        if (!number) return this._fail('Which ticket do you want the status of?');
        var r = this.tools.getStatus(number);
        if (!r.ok) return this._fail(r.error);
        var t = r.ticket;
        var who = t.assigned_to ? ('assigned to ' + t.assigned_to) : 'unassigned';
        return {
            ok: true,
            message: 'Ticket ' + this._sayNumber(t.number) + ': ' + t.short_description + '. State, ' + t.state + '. Priority, ' + t.priority + '. ' + who + '.',
            data: t,
            clear_pending: true
        };
    },

    // ============================================================
    //  Pause / resume flow
    // ============================================================
    _askPauseDuration: function (reprompt) {
        if (reprompt) {
            return {
                ok: true,
                message: "I didn't catch a duration. Try saying something like two hours, thirty minutes, or rest of the day.",
                pending: 'pause_duration'
            };
        }
        return {
            ok: true,
            message: this._pickOne([
                "Sure. For how many hours should I pause notifications?",
                "Okay. How long would you like me quiet? Say something like one hour or thirty minutes.",
                "Got it. How long should I hold off — an hour, two, the rest of the day?"
            ]),
            pending: 'pause_duration'
        };
    },

    _pause: function (hours) {
        var r = this.tools.pauseNotifications(hours);
        if (!r.ok) return this._fail(r.error);
        var nice = this._spokenDuration(hours);
        var until = this._spokenClockTime(r.paused_until);
        return {
            ok: true,
            message: this._pickOne([
                "Okay. Pausing for " + nice + ". I'll be back around " + until + ".",
                "Got it — " + nice + " of quiet. See you at " + until + ".",
                "Done. Notifications paused for " + nice + ". I'll resume at " + until + "."
            ]),
            clear_pending: true,
            paused: true
        };
    },

    _resume: function () {
        this.tools.resumeNotifications();
        return {
            ok: true,
            message: this._pickOne([
                "Welcome back. Notifications are on again.",
                "Resumed. I'll let you know when things come up.",
                "Got it. I'm back to listening."
            ]),
            clear_pending: true,
            paused: false
        };
    },

    // ============================================================
    //  Smalltalk
    // ============================================================
    _greet: function () {
        var hour = new Date().getHours();
        var greet =
            hour < 12 ? this._pickOne(["Good morning.", "Morning.", "Hi, good morning."]) :
            hour < 18 ? this._pickOne(["Good afternoon.", "Hi there.", "Afternoon."]) :
                        this._pickOne(["Good evening.", "Evening.", "Hi."]);
        return this._reply(greet + " " + this._pickOne([
            "What can I do?",
            "How can I help?",
            "Ready when you are."
        ]));
    },

    _help: function () {
        return this._reply(
            "You can ask me to create a ticket, list your tickets, " +
            "resolve a ticket by number, update a ticket with a comment, " +
            "ask for the status of a specific ticket, or pause notifications. " +
            "Say stop at any time."
        );
    },

    // ============================================================
    //  Tiny utilities
    // ============================================================
    _reply: function (text, extra) {
        var r = { ok: true, message: text, clear_pending: true };
        if (extra) for (var k in extra) r[k] = extra[k];
        return r;
    },

    _fail: function (msg) {
        return { ok: false, message: msg };
    },

    _pickOne: function (arr) {
        return arr[Math.floor(Math.random() * arr.length)];
    },

    // "INC0001234" → "I N C zero zero zero one two three four"
    _sayNumber: function (number) {
        if (!number) return '';
        var m = String(number).match(/^([A-Z]+)(\d+)$/);
        if (!m) return number;
        var letters = m[1].split('').join(' ');
        var digitWords = { '0':'zero','1':'one','2':'two','3':'three','4':'four','5':'five','6':'six','7':'seven','8':'eight','9':'nine' };
        var digits = m[2].split('').map(function (d) { return digitWords[d] || d; }).join(' ');
        return letters + ' ' + digits;
    },

    _spokenDuration: function (hours) {
        if (hours == null) return '';
        if (hours < 1) {
            var m = Math.round(hours * 60);
            return m + ' minute' + (m === 1 ? '' : 's');
        }
        if (hours === 1) return 'an hour';
        if (Math.round(hours) === hours) return hours + ' hours';
        return hours + ' hours';
    },

    _spokenClockTime: function (gdtString) {
        // Render "HH:MM AM/PM" from a "YYYY-MM-DD HH:MM:SS" GlideDateTime string
        try {
            var gdt = new GlideDateTime(gdtString);
            var localStr = gdt.getDisplayValue(); // user's TZ
            // Likely "MM-DD-YYYY HH:MM:SS" depending on system format — extract HH:MM
            var m = localStr.match(/(\d{1,2}):(\d{2})/);
            if (!m) return localStr;
            var hh = parseInt(m[1], 10);
            var mm = m[2];
            var ampm = hh >= 12 ? 'PM' : 'AM';
            var h12 = ((hh + 11) % 12) + 1;
            return h12 + ':' + mm + ' ' + ampm;
        } catch (e) {
            return gdtString;
        }
    },

    type: 'NetraResponder'
};
