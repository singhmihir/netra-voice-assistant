/**
 * NetraResponder — composes natural-language replies for the user to hear.
 *
 * The widget's TTS reads these strings aloud, so every reply is:
 *   • short (1-3 sentences)
 *   • comma-paced (no markdown, no bullet points, no asterisks)
 *   • ticket numbers spaced for clearer pronunciation
 */
var NetraResponder = Class.create();
NetraResponder.prototype = {
    initialize: function () {
        this.tools = new NetraTools();
    },

    /**
     * @param {{action:string, args:Object, original:string}} intent
     * @returns {{ok:boolean, message:string, refresh_tickets?:boolean, data?:Object}}
     */
    handle: function (intent) {
        switch (intent.action) {
            case 'create': return this._create(intent.args.description);
            case 'list': return this._list();
            case 'resolve': return this._resolve(intent.args.ticket_number);
            case 'update': return this._update(intent.args.ticket_number, intent.args.comment);
            case 'status': return this._status(intent.args.ticket_number);
            case 'help': return this._help();
            case 'cancel': return { ok: true, message: 'Okay.', stop: true };
            default:
                return {
                    ok: false,
                    message: "I didn't quite catch that. Try saying: create a ticket for, list my tickets, resolve I N C, or update I N C with."
                };
        }
    },

    // ---------- handlers ----------
    _create: function (description) {
        var r = this.tools.createTicket(description);
        if (!r.ok) return { ok: false, message: "Sorry, I couldn't open the ticket. " + r.error };
        return {
            ok: true,
            message: 'Ticket ' + this._sayNumber(r.ticket.number) +
                     ' opened. Issue recorded: ' + r.ticket.short_description + '.',
            refresh_tickets: true,
            data: r.ticket
        };
    },

    _list: function () {
        var r = this.tools.listMyTickets(5);
        if (!r.ok) return { ok: false, message: 'Sorry, I could not load your tickets.' };
        var tickets = r.tickets || [];
        if (tickets.length === 0) {
            return { ok: true, message: 'You have no open tickets right now.', data: tickets };
        }
        var pieces = tickets.slice(0, 5).map(function (t) {
            return this._sayNumber(t.number) + ', ' + t.short_description + ', state ' + t.state;
        }.bind(this));
        var msg = 'You have ' + tickets.length + ' open ticket' + (tickets.length === 1 ? '' : 's') + '. ';
        msg += pieces.join('. ') + '.';
        return { ok: true, message: msg, data: tickets, refresh_tickets: true };
    },

    _resolve: function (number) {
        if (!number) return { ok: false, message: 'Which ticket should I resolve? Please say the I N C number.' };
        var r = this.tools.resolveTicket(number);
        if (!r.ok) return { ok: false, message: r.error };
        return {
            ok: true,
            message: 'Ticket ' + this._sayNumber(number) + ' marked resolved.',
            refresh_tickets: true
        };
    },

    _update: function (number, comment) {
        if (!number) return { ok: false, message: 'Which ticket should I update?' };
        if (!comment) return { ok: false, message: 'What should I add as the comment?' };
        var r = this.tools.updateTicket(number, comment);
        if (!r.ok) return { ok: false, message: r.error };
        return {
            ok: true,
            message: 'Added your note to ticket ' + this._sayNumber(number) + '.',
            refresh_tickets: true
        };
    },

    _status: function (number) {
        if (!number) return { ok: false, message: 'Which ticket do you want the status of?' };
        var r = this.tools.getStatus(number);
        if (!r.ok) return { ok: false, message: r.error };
        var t = r.ticket;
        var who = t.assigned_to ? ('assigned to ' + t.assigned_to) : 'unassigned';
        return {
            ok: true,
            message: 'Ticket ' + this._sayNumber(t.number) + ': ' + t.short_description + '. ' +
                     'State, ' + t.state + '. Priority, ' + t.priority + '. ' + who + '.',
            data: t
        };
    },

    _help: function () {
        return {
            ok: true,
            message: 'You can ask me to create a ticket, list your tickets, ' +
                     'resolve a ticket by number, update a ticket with a comment, ' +
                     'or ask for the status of a specific ticket. ' +
                     'Say stop at any time to cancel.'
        };
    },

    // "INC0001234" → "I N C zero zero zero one two three four" (slower, clearer for TTS)
    _sayNumber: function (number) {
        if (!number) return '';
        var m = String(number).match(/^([A-Z]+)(\d+)$/);
        if (!m) return number;
        var letters = m[1].split('').join(' ');
        var digitWords = {
            '0':'zero','1':'one','2':'two','3':'three','4':'four',
            '5':'five','6':'six','7':'seven','8':'eight','9':'nine'
        };
        var digits = m[2].split('').map(function (d) { return digitWords[d] || d; }).join(' ');
        return letters + ' ' + digits;
    },

    type: 'NetraResponder'
};
