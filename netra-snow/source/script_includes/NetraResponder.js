/**
 * NetraResponder — composes spoken replies (v3).
 *
 * Orchestrates NetraTools + NetraKnowledge + NetraChat + NetraContext +
 * NetraNavigator + NetraSummarizer to satisfy every intent surfaced by
 * NetraIntent.
 *
 * Returns:
 *   { ok, message, pending?, clear_pending?, navigate?, stop?, paused?, data? }
 */
var NetraResponder = Class.create();
NetraResponder.prototype = {

    initialize: function () {
        this.tools     = new NetraTools();
        this.kb        = new NetraKnowledge();
        this.chat      = new NetraChat();
        this.ctx       = new NetraContext();
        this.nav       = new NetraNavigator();
        this.summ      = new NetraSummarizer();
    },

    handle: function (intent) {
        var r;
        switch (intent.action) {
            // ---- tickets ----
            case 'create':            r = this._create(intent.args.description); break;
            case 'partial_create':    r = this._askForDescription(); break;
            case 'list':              r = this._list(); break;
            case 'resolve':           r = this._resolve(intent.args.ticket_number); break;
            case 'resolve_context':   r = this._resolveContext(); break;
            case 'partial_resolve':   r = this._askWhichTicketToResolve(intent.args.reprompt); break;
            case 'update':            r = this._update(intent.args.ticket_number, intent.args.comment); break;
            case 'status':            r = this._status(intent.args.ticket_number); break;
            case 'read':              r = this._read(intent.args.ticket_number); break;
            case 'read_context':      r = this._readContext(); break;
            case 'search_tickets':    r = this._search(intent.args.query); break;

            // ---- briefing ----
            case 'briefing':          r = this._briefing(); break;

            // ---- approvals ----
            case 'list_approvals':    r = this._listApprovals(); break;
            case 'approve':           r = this._decideApproval(intent.args.ref_number, true); break;
            case 'reject':            r = this._decideApproval(intent.args.ref_number, false); break;

            // ---- knowledge ----
            case 'kb_search':         r = this._kbSearch(intent.args.query); break;
            case 'partial_kb':        r = this._askKbQuery(); break;
            case 'kb_read':           r = this._kbRead(intent.args.article); break;

            // ---- chat ----
            case 'chat_read':         r = this._chatRead(); break;
            case 'chat_send':         r = this._chatSend(intent.args.body); break;

            // ---- navigation ----
            case 'navigate':          r = this._navigate(intent.args.destination); break;

            // ---- watchlist ----
            case 'watch':             r = this._watch(intent.args.ticket_number); break;
            case 'watch_context':     r = this._watchContext(); break;
            case 'unwatch':           r = this._unwatch(intent.args.ticket_number); break;
            case 'list_watched':      r = this._listWatched(); break;

            // ---- pause / resume / mode ----
            case 'pause_ask':         r = this._askPauseDuration(intent.args.reprompt); break;
            case 'pause_for':         r = this._pause(intent.args.hours); break;
            case 'resume':            r = this._resume(); break;
            case 'voice_mode':        r = this._setMode(intent.args.mode); break;

            // ---- context ----
            case 'forget_context':    this.ctx.clear(); r = this._reply('Okay, context cleared.'); break;

            // ---- smalltalk ----
            case 'greet':             r = this._greet(); break;
            case 'thanks':            r = this._reply(this._pickOne(["You're welcome.","Anytime.","Happy to help.","Glad to be useful."])); break;
            case 'smalltalk':         r = this._smalltalk(intent.args.kind); break;
            case 'repeat':            r = { ok: true, message: '__REPEAT__' }; break;
            case 'help':              r = this._help(); break;
            case 'cancel':            r = { ok: true, message: this._pickOne(["Okay.","Cancelled.","No problem."]), stop: true, clear_pending: true }; break;

            default:
                r = { ok: false, message: this._pickOne([
                    "I didn't quite catch that. You can ask me to create a ticket, list, resolve, or search.",
                    "Sorry, that didn't match anything I know. Say help to hear my options.",
                    "Hmm, not sure I followed. Try saying help."
                ])};
        }

        // Record last utterance for "repeat that"
        if (r && r.message && r.message !== '__REPEAT__') {
            try { this.ctx.setLastUtterance(r.message); } catch (e) {}
        }
        return r;
    },

    // ===== handlers =====
    _create: function (description) {
        // R8 — Netra opens tickets again. If the user already described the
        // issue, create the incident right away and read the number back;
        // otherwise ask for the description first.
        if (description && String(description).trim().length >= 3) {
            var r = this.tools.createTicket(description, '3');
            if (!r.ok && r.read_only) return this._ok(r.message);
            if (!r.ok) return this._fail(r.error);
            this.ctx.setFocus('incident', r.sys_id, r.number);
            return this._ok(this._pickOne([
                'Done — I opened ' + this._sayNumber(r.number) + ' for that. I\'ll keep it in focus.',
                'Ticket ' + this._sayNumber(r.number) + ' is raised. Say update or resolve any time.',
                'Raised ' + this._sayNumber(r.number) + ' for you.'
            ]), { refresh_tickets: true });
        }
        return this._askForDescription();
    },

    _askForDescription: function () {
        // The follow-up "what's the issue?" flow feeds ticket creation.
        return { ok: true, message: this._pickOne([
            "Sure, what's the issue? One sentence and I'll raise the ticket.",
            'Happy to. Describe the problem in a sentence and I\'ll open the incident.'
        ]), pending: 'ticket_description' };
    },

    _askWhichTicketToResolve: function (reprompt) {
        return { ok: true, message: reprompt
            ? "I didn't catch the ticket number. Say something like I N C zero zero zero one two three four."
            : this._pickOne(["Which ticket should I resolve?", "Sure. Which I N C number?"]),
            pending: 'resolve_number' };
    },

    _list: function () {
        var r = this.tools.listMyTickets(5);
        if (!r.ok) return this._fail('Sorry, I could not load your tickets.');
        var ts = r.tickets || [];
        if (!ts.length) return this._ok(this._pickOne(["Good news — you have no open tickets right now.", "All clear, no open tickets.", "Your queue is empty."]), { data: ts });
        var pieces = ts.slice(0, 5).map(function (t) {
            return this._sayNumber(t.number) + ', ' + t.short_description + ', state ' + t.state;
        }.bind(this));
        return this._ok('You have ' + ts.length + ' open ticket' + (ts.length === 1 ? '' : 's') + '. ' + pieces.join('. ') + '.', { data: ts, refresh_tickets: true });
    },

    _resolve: function (number) {
        if (!number) return this._askWhichTicketToResolve(false);
        var r = this.tools.resolveTicket(number);
        if (!r.ok && r.read_only) return this._ok(r.message);
        if (!r.ok) return this._fail(r.error);
        this.ctx.setFocus('incident', '', number);
        return this._ok(this._pickOne([
            'Ticket ' + this._sayNumber(number) + ' is marked resolved.',
            'Done — ' + this._sayNumber(number) + ' is now resolved.',
            'Resolved ' + this._sayNumber(number) + '.'
        ]), { refresh_tickets: true });
    },

    _resolveContext: function () {
        var f = this.ctx.getFocus();
        if (!f || !f.number) return this._fail("I don't have a recent ticket in mind. Please say the I N C number.");
        return this._resolve(f.number);
    },

    _update: function (number, comment) {
        if (!number) return this._fail('Which ticket should I update?');
        if (!comment) return this._fail('What should I add as the comment?');
        var r = this.tools.updateTicket(number, comment);
        if (!r.ok && r.read_only) return this._ok(r.message);
        if (!r.ok) return this._fail(r.error);
        return this._ok(this._pickOne([
            'Added your note to ticket ' + this._sayNumber(number) + '.',
            'Comment posted on ' + this._sayNumber(number) + '.'
        ]), { refresh_tickets: true });
    },

    _status: function (number) {
        if (!number) return this._fail('Which ticket?');
        var r = this.tools.getStatus(number);
        if (!r.ok) return this._fail(r.error);
        var t = r.ticket;
        this.ctx.setFocus('incident', t.sys_id, t.number);
        var who = t.assigned_to ? ('assigned to ' + t.assigned_to) : 'unassigned';
        return this._ok('Ticket ' + this._sayNumber(t.number) + ': ' + t.short_description + '. State, ' + t.state + '. Priority, ' + t.priority + '. ' + who + '.', { data: t });
    },

    _read: function (number) {
        var r = this.tools.readTicket(number);
        if (!r.ok) return this._fail(r.error);
        var t = r.ticket;
        this.ctx.setFocus('incident', t.sys_id, t.number);
        var body = String(t.description || t.short_description || '').trim();
        if (body.length > 600) body = this.summ.summarise(body, 3);
        var commentCount = (t.recent_comments || []).length;
        var msg = 'Ticket ' + this._sayNumber(t.number) + '. ' + t.short_description + '. ';
        msg += 'State, ' + t.state + '. ' + (t.assigned_to ? 'Assigned to ' + t.assigned_to + '. ' : '');
        if (body && body !== t.short_description) msg += 'Description: ' + body + ' ';
        if (commentCount) {
            var lc = t.recent_comments[0];
            msg += 'Most recent ' + lc.element.replace('_', ' ') + ' from ' + lc.author + ': ' + lc.body.substring(0, 240) + '.';
        }
        return this._ok(msg, { data: t });
    },

    _readContext: function () {
        var f = this.ctx.getFocus();
        if (!f || !f.number) return this._fail("I don't have a ticket in mind.");
        return this._read(f.number);
    },

    _search: function (query) {
        var r = this.tools.searchTickets(query);
        if (!r.ok) return this._fail(r.error || 'I could not search.');
        var ts = r.tickets || [];
        if (!ts.length) return this._ok('I found no tickets matching ' + query + '.');
        var msg = 'I found ' + ts.length + ' matching ' + (ts.length === 1 ? 'ticket' : 'tickets') + '. ';
        ts.slice(0, 3).forEach(function (t) {
            msg += this._sayNumber(t.number) + ', ' + t.short_description + '. ';
        }.bind(this));
        if (ts[0]) this.ctx.setFocus('incident', ts[0].sys_id, ts[0].number);
        return this._ok(msg, { data: ts });
    },

    _briefing: function () {
        var tickets = this.tools.listMyTickets(3).tickets || [];
        var approvals = this.tools.listPendingApprovals().approvals || [];
        var chatMsgs = this.chat.isEnabled() ? (this.chat.listUnread().messages || []) : [];

        var parts = [];
        if (tickets.length) parts.push('You have ' + tickets.length + ' open ticket' + (tickets.length === 1 ? '' : 's') + ', most recent ' + this._sayNumber(tickets[0].number) + ' about ' + tickets[0].short_description);
        else parts.push('No open tickets');
        if (approvals.length) parts.push(approvals.length + ' approval' + (approvals.length === 1 ? '' : 's') + ' waiting on you');
        if (chatMsgs.length) parts.push(chatMsgs.length + ' unread chat message' + (chatMsgs.length === 1 ? '' : 's'));
        var hour = new Date().getHours();
        var greet = hour < 12 ? 'Good morning.' : hour < 18 ? 'Good afternoon.' : 'Good evening.';
        return this._ok(greet + ' ' + parts.join('. ') + '.', { refresh_tickets: true });
    },

    // ---- approvals ----
    _listApprovals: function () {
        var r = this.tools.listPendingApprovals();
        var apps = r.approvals || [];
        if (!apps.length) return this._ok('No approvals waiting on you.');
        var pieces = apps.slice(0, 5).map(function (a) { return a.subject || 'one approval'; });
        return this._ok('You have ' + apps.length + ' approval' + (apps.length === 1 ? '' : 's') + ' waiting. ' + pieces.join('. ') + '.', { data: apps });
    },

    _decideApproval: function (refNumber, approve) {
        if (!refNumber) return this._fail('Which one should I ' + (approve ? 'approve' : 'reject') + '?');
        var r = this.tools.decideApproval(refNumber, approve);
        if (!r.ok) return this._fail(r.error);
        return this._ok((approve ? 'Approved ' : 'Rejected ') + this._sayNumber(refNumber) + '.', { refresh_tickets: true });
    },

    // ---- knowledge ----
    _askKbQuery: function () {
        return { ok: true, message: 'Sure. What would you like to look up?', pending: 'kb_query' };
    },

    _kbSearch: function (query) {
        var r = this.kb.search(query, 3);
        var arts = r.articles || [];
        if (!arts.length) return this._ok('I could not find any knowledge articles about ' + query + '.');
        var msg = 'I found ' + arts.length + ' article' + (arts.length === 1 ? '' : 's') + '. ';
        arts.forEach(function (a, i) {
            msg += (i === 0 ? 'Top result, ' : 'Also, ') + a.number + ', ' + a.title + '. ';
        });
        msg += 'Say read ' + arts[0].number + ' to hear the first one.';
        return this._ok(msg, { data: arts });
    },

    _kbRead: function (numberOrSysId) {
        var r = this.kb.read(numberOrSysId);
        if (!r.ok) return this._fail(r.error);
        var a = r.article;
        var body = this.summ.summarise(a.body, 4);
        return this._ok('Article ' + a.number + '. ' + a.title + '. ' + body, { data: a });
    },

    // ---- chat ----
    _chatRead: function () {
        if (!this.chat.isEnabled()) return this._fail('Chat is not available on this instance.');
        var r = this.chat.listUnread();
        var msgs = r.messages || [];
        if (!msgs.length) return this._ok('No new chat messages.');
        var pieces = msgs.slice(0, 3).map(function (m) { return 'From ' + m.author + ': ' + m.body.substring(0, 200); });
        return this._ok('You have ' + msgs.length + ' unread chat message' + (msgs.length === 1 ? '' : 's') + '. ' + pieces.join('. '), { data: msgs });
    },

    _chatSend: function (body) {
        if (!this.chat.isEnabled()) return this._fail('Chat is not available.');
        if (!body || !body.trim()) return this._fail('What should I send?');
        var r = this.chat.replyToLast(body);
        if (!r.ok) return this._fail(r.error);
        return this._ok('Sent.');
    },

    // ---- navigation ----
    _navigate: function (destination) {
        var r = this.nav.resolve(destination);
        if (!r.ok) return this._fail(r.error);
        return this._ok('Opening ' + r.label + '.', { navigate: r.url });
    },

    // ---- watchlist ----
    _watch: function (number) {
        var s = this.tools.getStatus(number);
        if (!s.ok) return this._fail(s.error);
        var t = s.ticket;
        var r = this.tools.addWatch('incident', t.sys_id, t.number);
        if (r.already) return this._ok('You are already watching ' + this._sayNumber(t.number) + '.');
        return this._ok("Okay, I'll watch " + this._sayNumber(t.number) + ' and let you know if anything changes.');
    },

    _watchContext: function () {
        var f = this.ctx.getFocus();
        if (!f || !f.number) return this._fail("I don't have a ticket in mind.");
        return this._watch(f.number);
    },

    _unwatch: function (number) {
        var s = this.tools.getStatus(number);
        if (!s.ok) return this._fail(s.error);
        this.tools.removeWatch('incident', s.ticket.sys_id);
        return this._ok('Removed ' + this._sayNumber(number) + ' from your watchlist.');
    },

    _listWatched: function () {
        var r = this.tools.listWatched();
        var w = r.watched || [];
        if (!w.length) return this._ok('Your watchlist is empty.');
        return this._ok('You are watching ' + w.length + ' record' + (w.length === 1 ? '' : 's') + ': ' + w.slice(0, 5).map(function (x) { return this._sayNumber(x.number); }.bind(this)).join(', ') + '.');
    },

    // ---- pause / resume / mode ----
    _askPauseDuration: function (reprompt) {
        return { ok: true, message: reprompt
            ? "I didn't catch a duration. Try two hours, thirty minutes, or rest of the day."
            : this._pickOne([
                "Sure. For how many hours should I pause notifications?",
                "Okay. How long would you like me quiet? Say something like one hour or thirty minutes.",
                "Got it. How long should I hold off — an hour, two, the rest of the day?"
            ]), pending: 'pause_duration' };
    },
    _pause: function (hours) {
        var r = this.tools.pauseNotifications(hours);
        if (!r.ok) return this._fail(r.error);
        var nice = this._spokenDuration(hours);
        var until = this._spokenClockTime(r.paused_until);
        return this._ok(this._pickOne([
            "Okay. Pausing for " + nice + ". I'll be back around " + until + ".",
            "Got it — " + nice + " of quiet. See you at " + until + "."
        ]), { paused: true });
    },
    _resume: function () {
        this.tools.resumeNotifications();
        return this._ok(this._pickOne(["Welcome back. Notifications are on again.", "Resumed. I'll let you know when things come up."]), { paused: false });
    },
    _setMode: function (mode) {
        var m = String(mode || '').toLowerCase();
        var canon = m === 'brief' || m === 'short' ? 'terse'
                  : m === 'chatty' || m === 'detailed' ? 'verbose'
                  : m;
        if (canon !== 'terse' && canon !== 'normal' && canon !== 'verbose')
            return this._fail('I support terse, normal, or verbose mode.');
        this.tools.setVoiceMode(canon);
        return this._ok('Switched to ' + canon + ' mode.');
    },

    // ---- smalltalk ----
    _greet: function () {
        var hour = new Date().getHours();
        var g = hour < 12 ? this._pickOne(["Good morning.", "Morning."]) :
                hour < 18 ? this._pickOne(["Good afternoon.", "Hi there."]) :
                            this._pickOne(["Good evening.", "Evening."]);
        return this._ok(g + " " + this._pickOne(["What can I do?", "How can I help?", "Ready when you are."]));
    },
    _smalltalk: function (kind) {
        if (kind === 'how_are_you')
            return this._ok(this._pickOne(["Doing well, thank you. Ready when you are.", "All systems normal. What can I do for you?"]));
        return this._ok("I'm Netra, your ServiceNow voice assistant. I can open tickets, list, resolve, update them, search knowledge, handle approvals, read chats, and more.");
    },
    _help: function () {
        return this._ok(
            "You can say: create a ticket for, list my tickets, resolve I N C, update I N C, status of I N C, search tickets for, read I N C, " +
            "search knowledge for, read article K B, open my approvals, approve, reject, " +
            "read new messages, reply with, watch I N C, list my watchlist, " +
            "pause, resume, switch to terse mode, briefing, navigate to my profile, or say help anytime."
        );
    },

    // ===== utilities =====
    _ok: function (text, extra) {
        var out = { ok: true, message: text, clear_pending: true };
        if (extra) for (var k in extra) out[k] = extra[k];
        return out;
    },
    _fail: function (msg) { return { ok: false, message: msg }; },
    _reply: function (text, extra) { return this._ok(text, extra); },

    _pickOne: function (arr) { return arr[Math.floor(Math.random() * arr.length)]; },

    _sayNumber: function (number) {
        if (!number) return '';
        var m = String(number).match(/^([A-Z]+)(\d+)$/);
        if (!m) return number;
        var letters = m[1].split('').join(' ');
        var dw = { '0':'zero','1':'one','2':'two','3':'three','4':'four','5':'five','6':'six','7':'seven','8':'eight','9':'nine' };
        return letters + ' ' + m[2].split('').map(function (d) { return dw[d] || d; }).join(' ');
    },

    _spokenDuration: function (h) {
        if (h == null) return '';
        if (h < 1) { var m = Math.round(h * 60); return m + ' minute' + (m === 1 ? '' : 's'); }
        if (h === 1) return 'an hour';
        return h + ' hours';
    },

    _spokenClockTime: function (gdtString) {
        try {
            var gdt = new GlideDateTime(gdtString);
            var local = gdt.getDisplayValue();
            var m = local.match(/(\d{1,2}):(\d{2})/);
            if (!m) return local;
            var hh = parseInt(m[1], 10), mm = m[2];
            var ampm = hh >= 12 ? 'PM' : 'AM';
            var h12 = ((hh + 11) % 12) + 1;
            return h12 + ':' + mm + ' ' + ampm;
        } catch (e) { return gdtString; }
    },

    type: 'NetraResponder'
};
