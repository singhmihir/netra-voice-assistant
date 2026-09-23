/**
 * NetraMissionRunner - missions: a durable queue worker with a to-do board. (R18)
 *
 * "Work through the unassigned queue" - read back, one yes, then this
 * grinds through it a few tickets per scanner pass while the user does
 * something else. Template triage_unassigned: for each unassigned active
 * incident, oldest first, propose a group / category / priority from how
 * lookalike tickets were actually handled, flag a likely open duplicate,
 * and dig out the closest resolved lookalike with its fix. Review never
 * writes a ticket. Writes happen only after a second, separate "apply the
 * confident ones" + yes, and every one of them is verified and undoable.
 *
 * Where things live:
 *  - header: one row in x_196061_netra_v1_task, kind 'mission'. state is
 *    running|paused|awaiting_apply|applying|done|cancelled|expired|error,
 *    NEVER 'active' - NetraTaskRunner.run only picks up 'active', and its
 *    _checkOne falls through to _watchTicket (which starts met=true) for
 *    any kind it doesnt know, so an 'active' mission would fire on sight
 *  - condition_json holds caps, counts, phase, wait and the header lease
 *  - action_log holds milestones only, same format as NetraTaskRunner._log,
 *    so the away debrief and the Lab card read them unchanged
 *  - items: x_196061_netra_v1_mission_item. NOT the task table - _ntNext
 *    counts every task row, 50 items would eat 50 NT numbers
 *
 * Trust rules, enforced here:
 *  - no text-model calls anywhere, embeddings only (via NetraSemantic)
 *  - the ticket_writes kill switch is re-checked before EVERY ticket write
 *  - an item whose sys_mod_count moved since review is skipped, never
 *    overwritten - a human got there first, we dont fight them
 *  - every write is re-read; a write that didnt stick is reported as such
 *  - undo only touches tickets nobody has touched since we did
 *  - duplicates are reported, never merged
 *  - 48h expiry, reported out loud, never silent
 *
 * Concurrency: header lease (write-then-reread token in condition_json) so
 * two scanner runs cant work one mission; item leases so a pass that dies
 * mid-item gets reaped back to queued; 45 s pass deadline, 5 items max.
 */
var NetraMissionRunner = Class.create();
NetraMissionRunner.prototype = {
    initialize: function () {
        this.SCOPE = 'x_196061_netra_v1';
        this.TASK  = this.SCOPE + '_task';
        this.ITEM  = this.SCOPE + '_mission_item';
        this.NOTIF = this.SCOPE + '_notification';
        this.TEMPLATE = 'triage_unassigned';
        this.QUEUE_TABLE = 'incident';
        this.QUEUE_QUERY = 'active=true^assignment_groupISEMPTY^assigned_toISEMPTY';
        this.LIVE_STATES = ['running', 'paused', 'awaiting_apply', 'applying'];

        this.MAX_ITEMS = 50;            // snapshot cap per mission
        this.PER_PASS = 5;              // reviews per scanner pass
        this.APPLY_PER_PASS = 5;        // writes per scanner pass
        this.LIVE_EMBEDS_PER_ITEM = 2;  // plus one query embed = 3 calls max per item
        this.PASS_DEADLINE_MS = 45000;  // the scheduled job has other work to do
        this.HEADER_LEASE_MS = 150000;  // > a worst-case pass, < the scan interval
        this.ITEM_LEASE_MS = 120000;
        this.MAX_ATTEMPTS = 3;
        this.EXPIRY_H = 48;
        this.PAGE_SIZE = 5;
        this.FIX_THRESHOLD = 0.75;      // stricter than find_similar_resolved's 0.62: we quote the fix
        this.APPLY_SHARE = 0.5;         // category/priority only written with a majority behind them
        this.MIN_VOTERS = 3;            // lookalikes WITH a group needed before a routing counts as confident
        this.MIN_WAIT_MS = 20000;
        this.EMBED_TROUBLE_WAIT_MS = 2 * 60 * 1000;
        this.WRITES_OFF_RECHECK_MS = 5 * 60 * 1000;
        this.SCAN_MINUTES = parseInt(gs.getProperty(this.SCOPE + '.mission_scan_minutes', '5'), 10) || 5;
        this._t0 = 0;
    },

    writesEnabled: function () {
        return String(gs.getProperty(this.SCOPE + '.ticket_writes', 'true')) !== 'false';
    },

    /* ===================================================================
     *  conversational surface - all zero model calls
     * =================================================================== */

    /**
     * preview(userSysId) -> { ok, count, will_review, oldest:{number,
     *   short_description, age_hours}|null, eta_minutes, per_pass, message,
     *   existing?, sources }
     * message is the ready-to-speak read-back ("... Shall I?")
     */
    preview: function (userSysId) {
        if (!this._itemTableOk()) {
            return { ok: false, count: 0, oldest: null, eta_minutes: 0,
                     message: 'Missions are not installed yet - the ' + this.ITEM + ' table is missing, so I cannot start one.' };
        }
        var live = this._liveMission(userSysId);
        if (live) {
            return { ok: false, existing: String(live.nt_number), count: 0, oldest: null, eta_minutes: 0,
                     message: this._missionName(live.nt_number) + ' is already working the unassigned queue (' +
                              String(live.state).replace('_', ' ') + '). Ask how it is going, or cancel it first.' };
        }
        var q = this._queue(this.MAX_ITEMS);
        if (!q.ok) return { ok: false, count: 0, oldest: null, eta_minutes: 0, sources: q.sources, message: q.message };
        var will = Math.min(q.total, this.MAX_ITEMS);
        var eta = this.etaMinutes(will);
        var oldest = null;
        if (q.rows.length) {
            var o = q.rows[0];
            oldest = { number: o.number, short_description: o.short_description,
                       age_hours: o.opened_ms ? Math.max(0, Math.round((this._now() - o.opened_ms) / 3600000)) : null };
        }
        return { ok: true, count: q.total, will_review: will, oldest: oldest, eta_minutes: eta,
                 per_pass: this.PER_PASS, sources: q.sources, message: this.readBack(q.total, will, eta) };
    },

    /**
     * launch(userSysId, utterance) -> { ok, nt_number, items, eta_minutes, message }
     * call ONLY after the user said yes to the preview read-back.
     */
    launch: function (userSysId, utterance) {
        if (!userSysId) return { ok: false, error: 'No user to run the mission for.' };
        if (!this._itemTableOk()) return { ok: false, error: 'Missions are not installed yet - the ' + this.ITEM + ' table is missing. Nothing started.' };
        var live = this._liveMission(userSysId);
        if (live) return { ok: false, existing: String(live.nt_number), error: this._missionName(live.nt_number) + ' is already on the unassigned queue.' };
        var q = this._queue(this.MAX_ITEMS);
        if (!q.ok) return { ok: false, error: q.message, sources: q.sources };
        if (!q.rows.length) return { ok: false, items: 0, error: 'The unassigned queue is empty - nothing to work through.' };

        var now = this._now();
        var h = new GlideRecord(this.TASK);
        h.initialize();
        h.user = userSysId;
        h.nt_number = this._ntNext();
        h.kind = 'mission';
        h.action = this.TEMPLATE;
        h.state = 'running';
        h.target_table = this.QUEUE_TABLE;
        h.target_number = 'unassigned queue';   // the Lab card shows target; empty reads as "approvals"
        h.authorized_utterance = String(utterance || '').substring(0, 1000);
        h.action_params = JSON.stringify({ template: this.TEMPLATE });
        h.fire_count = 0;
        h.max_fires = 1;
        // epoch writes - a date string would be re-read in the session timezone
        h.next_check_at.setDateNumericValue(now);
        h.expires_at.setDateNumericValue(now + this.EXPIRY_H * 3600000);
        var counts = this.countsFrom([]);
        counts.total = q.rows.length;
        counts.queued = q.rows.length;
        var cond = {
            tpl: this.TEMPLATE,
            caps: { max_items: this.MAX_ITEMS, per_pass: this.PER_PASS, apply_per_pass: this.APPLY_PER_PASS,
                    live_embeds_per_item: this.LIVE_EMBEDS_PER_ITEM },
            counts: counts, phase: 'review', wait: null,
            // born holding its own lease: the header is 'running' the moment
            // it is inserted, and a scanner pass landing mid-way through the
            // item inserts would otherwise see 3 items, review them, and flip
            // the mission to done while items 4..50 are still being written
            lease_until_ms: now + this.HEADER_LEASE_MS, lease_owner: 'launch',
            started_ms: now, passes: 0, queue_total: q.total
        };
        h.condition_json = JSON.stringify(cond);
        h.action_log = '[]';
        h.undo_json = '';
        this._log(h, 'mission started: reviewing ' + this._plural(q.rows.length, 'unassigned incident') + ', oldest first');
        var hid = h.insert();
        if (!hid) return { ok: false, error: 'I could not create the mission record, so nothing started.' };
        hid = String(hid);

        var made = 0;
        for (var i = 0; i < q.rows.length; i++) {
            var it = new GlideRecord(this.ITEM);
            it.initialize();
            it.mission = hid;
            it.seq = i + 1;
            it.target_table = this.QUEUE_TABLE;
            it.target_sys_id = q.rows[i].sys_id;
            it.target_number = q.rows[i].number;
            it.state = 'queued';
            it.attempts = 0;
            it.findings_json = '';
            it.undo_json = '';
            if (it.insert()) made++;
        }
        var nt = String(h.nt_number);
        if (!made) {
            this._failMission(hid, 'could not write any mission items (is the ' + this.ITEM + ' table installed?)', null);
            return { ok: false, nt_number: nt, items: 0, error: 'I could not write the mission items, so the mission stopped before it started.' };
        }
        // always: this also releases the launch lease so the scanner can start
        this._commit(hid, 'launch', function (fresh, c) { c.counts = c.counts || {}; c.counts.total = made; c.counts.queued = made; });
        var eta = this.etaMinutes(made);
        return { ok: true, nt_number: nt, items: made, eta_minutes: eta,
                 message: this._missionName(nt) + ' is running: ' + this._plural(made, 'incident') +
                          ' queued, about ' + this.PER_PASS + ' every scan, roughly ' + eta + ' minutes. ' +
                          'Ask how the mission is going any time.' };
    },

    /**
     * board(userSysId) -> [{ nt_number, state, phase, counts:{total, processed,
     *   reviewed, skipped, confident, duplicates, known_fix, applied, error, ...},
     *   wait:{reason, until_ms, minutes_left}|null, expires_ms, sentence }]
     * newest first, max 5. zero writes, one query.
     */
    board: function (userSysId) {
        var out = [];
        var now = this._now();
        var gr = new GlideRecord(this.TASK);
        gr.addQuery('user', userSysId);
        gr.addQuery('kind', 'mission');
        gr.orderByDesc('sys_created_on');
        gr.setLimit(5);
        gr.query();
        while (gr.next()) {
            var c = this._cond(gr);
            var wait = (c.wait && c.wait.until_ms > now)
                ? { reason: c.wait.reason, until_ms: c.wait.until_ms, minutes_left: Math.max(1, Math.ceil((c.wait.until_ms - now) / 60000)) }
                : null;
            var st = String(gr.state);
            out.push({
                nt_number: String(gr.nt_number), state: st, phase: c.phase || 'review',
                counts: c.counts || this.countsFrom([]), wait: wait,
                expires_ms: this._ms(gr, 'expires_at'),
                sentence: this.boardSentence(String(gr.nt_number), st, c.phase, c.counts || {}, wait)
            });
        }
        return out;
    },

    /**
     * control(nt, userSysId, 'pause'|'resume'|'cancel') -> { ok, state?, message | error }
     */
    control: function (nt, userSysId, action) {
        var m = this._findMission(nt, userSysId);
        if (!m) return { ok: false, error: 'No mission ' + this._digits(this._ntKey(nt) || nt) + ' of yours.' };
        var name = this._missionName(m.nt_number);
        var st = String(m.state);
        var act = String(action || '').toLowerCase();
        var self = this;
        var c = this._cond(m);
        var counts = c.counts || {};

        if (act === 'pause') {
            if (st !== 'running' && st !== 'applying') {
                return { ok: false, state: st, error: st === 'paused' ? name + ' is already paused.'
                    : (st === 'awaiting_apply' ? name + ' is not doing anything right now - it is waiting for you to say apply.'
                                               : name + ' is ' + st + ', there is nothing to pause.') };
            }
            this._commit(m.getUniqueValue(), null, function (fresh, cond) {
                cond.paused_from = String(fresh.state);
                fresh.state = 'paused';
                self._log(fresh, 'paused by ' + self._name(userSysId));
            });
            return { ok: true, state: 'paused',
                     message: name + ' paused at ' + (counts.processed || 0) + ' of ' + (counts.total || 0) + ' reviewed' +
                              (st === 'applying' ? ', ' + (counts.applied || 0) + ' applied' : '') +
                              '. Say resume mission ' + this._digits(m.nt_number) + ' to carry on.' };
        }
        if (act === 'resume') {
            if (st !== 'paused') return { ok: false, state: st, error: name + ' is ' + st.replace('_', ' ') + ', not paused.' };
            var back = 'running';
            this._commit(m.getUniqueValue(), null, function (fresh, cond) {
                back = cond.paused_from || (cond.phase === 'apply' ? 'applying' : 'running');
                delete cond.paused_from;
                fresh.state = back;
                self._log(fresh, 'resumed by ' + self._name(userSysId));
            });
            return { ok: true, state: back, message: name + ' is back on - it picks up on the next scan.' };
        }
        if (act === 'cancel') {
            if (!this._isLive(st)) return { ok: false, state: st, error: name + ' is already ' + st + '.' };
            this._commit(m.getUniqueValue(), null, function (fresh, cond) {
                fresh.state = 'cancelled';
                cond.lease_until_ms = 0;
                cond.lease_owner = '';
                self._log(fresh, 'cancelled by ' + self._name(userSysId));
            });
            var applied = counts.applied || 0;
            return { ok: true, state: 'cancelled',
                     message: name + ' cancelled. ' + (applied
                        ? this._plural(applied, 'routing') + ' it already applied stay as they are - say undo mission ' + this._digits(m.nt_number) + ' if you want those back.'
                        : 'It never changed a ticket.') };
        }
        return { ok: false, error: 'I can pause, resume or cancel a mission.' };
    },

    /**
     * requestApply(nt, userSysId) -> { ok, confident_count, message | error }
     * call ONLY after the user said yes to "apply the confident ones".
     * the writes themselves happen in later scanner passes.
     */
    requestApply: function (nt, userSysId) {
        var m = this._findMission(nt, userSysId);
        if (!m) return { ok: false, confident_count: 0, error: 'No mission ' + this._digits(this._ntKey(nt) || nt) + ' of yours.' };
        var name = this._missionName(m.nt_number);
        var st = String(m.state);
        var c = this._cond(m);
        var counts = c.counts || {};
        if (st === 'running' || (st === 'paused' && c.phase === 'review')) {
            return { ok: false, confident_count: counts.confident || 0,
                     error: name + ' is still reviewing (' + (counts.processed || 0) + ' of ' + (counts.total || 0) +
                            '). I will tell you when it is ready to apply.' };
        }
        if (st === 'applying') return { ok: true, already: true, confident_count: counts.confident_pending || 0, message: name + ' is already applying.' };
        if (st === 'paused' && c.phase === 'apply') {
            return { ok: false, confident_count: counts.confident_pending || 0,
                     error: name + ' is paused part-way through applying. Say resume mission ' + this._digits(m.nt_number) + ' to carry on.' };
        }
        if (st !== 'awaiting_apply') return { ok: false, confident_count: 0, error: name + ' is ' + st + ', there is nothing left to apply.' };
        if (!this.writesEnabled()) {
            return { ok: false, confident_count: 0, error: 'Ticket writes are switched off right now, so I cannot apply anything. Nothing changed.' };
        }
        var fresh = this._recount(m.getUniqueValue());
        var n = fresh.confident_pending;
        if (!n) return { ok: false, confident_count: 0, error: name + ' has nothing confident enough to apply.' };
        var self = this;
        this._commit(m.getUniqueValue(), null, function (h, cond) {
            h.state = 'applying';
            cond.phase = 'apply';
            cond.apply = { by: String(userSysId), at_ms: self._now(), count: n };
            cond.counts = fresh;
            cond.wait = null;
            self._log(h, 'apply authorised by ' + self._name(userSysId) + ' for ' + self._plural(n, 'confident routing'));
        });
        return { ok: true, confident_count: n,
                 message: 'Applying ' + this._plural(n, 'confident routing') + ' over the next few scans, about ' + this.APPLY_PER_PASS +
                          ' each. Every change is re-read to confirm it stuck and gets a work note. Say undo mission ' +
                          this._digits(m.nt_number) + ' to reverse them.' };
    },

    /**
     * report(nt, userSysId, page) -> { ok, nt_number, page, pages, total,
     *   items:[{number, short_description, state, proposal, duplicate_of,
     *           known_fix, skip_reason, applied, error}], lines:[..], message }
     * five items a page; message is ready to speak.
     */
    report: function (nt, userSysId, page) {
        var m = this._findMission(nt, userSysId);
        if (!m) return { ok: false, error: 'No mission ' + this._digits(this._ntKey(nt) || nt) + ' of yours.' };
        var rows = this._itemRows(m.getUniqueValue());
        var done = [];
        for (var i = 0; i < rows.length; i++) {
            if (rows[i].state !== 'queued' && rows[i].state !== 'working') done.push(rows[i]);
        }
        var pages = Math.max(1, Math.ceil(done.length / this.PAGE_SIZE));
        var p = Math.min(pages, Math.max(1, parseInt(page, 10) || 1));
        var slice = done.slice((p - 1) * this.PAGE_SIZE, p * this.PAGE_SIZE);
        var items = [], lines = [];
        for (var j = 0; j < slice.length; j++) {
            var f = slice[j].findings || {};
            var item = {
                number: slice[j].target_number, short_description: f.sd || '', state: slice[j].state,
                proposal: f.proposal || null, duplicate_of: f.duplicate_of || null, known_fix: f.known_fix || null,
                skip_reason: f.skip_reason || '', applied: f.applied || null, error: f.error || f.apply_error || '',
                undone: !!f.undone
            };
            items.push(item);
            lines.push(this.reportLine(item));
        }
        var c = this._cond(m);
        var head = (p === 1) ? this.boardSentence(String(m.nt_number), String(m.state), c.phase, c.counts || {}, null) + ' ' : '';
        var msg = done.length
            ? head + lines.join(' ') + (p < pages ? ' That is page ' + p + ' of ' + pages + ' - say next for more.' : '')
            : this._missionName(m.nt_number) + ' has not finished reviewing anything yet.';
        return { ok: true, nt_number: String(m.nt_number), page: p, pages: pages, total: done.length,
                 items: items, lines: lines, message: msg };
    },

    /**
     * undo(nt, userSysId) -> { ok, restored, skipped_touched, failed, details:[..], message | error }
     * restores every applied item nobody has touched since. a mission that
     * is mid-apply gets cancelled first so it cant re-apply behind us; one
     * still reviewing or awaiting apply is left alone (it changed nothing).
     */
    undo: function (nt, userSysId) {
        var m = this._findMission(nt, userSysId);
        if (!m) return { ok: false, restored: 0, skipped_touched: 0, error: 'No mission ' + this._digits(this._ntKey(nt) || nt) + ' of yours.' };
        var name = this._missionName(m.nt_number);
        var ntNum = String(m.nt_number);
        if (!this.writesEnabled()) {
            return { ok: false, restored: 0, skipped_touched: 0, error: 'Ticket writes are switched off, so I cannot undo right now. Nothing changed.' };
        }
        var self = this;
        var mid = m.getUniqueValue();
        var st0 = String(m.state), c0 = this._cond(m);
        // only a mission that could still WRITE gets stopped first; one still
        // reviewing (or waiting for apply) has changed nothing, keep its work
        if (st0 === 'applying' || (st0 === 'paused' && c0.phase === 'apply')) {
            this._commit(mid, null, function (fresh) {
                fresh.state = 'cancelled';
                self._log(fresh, 'stopped for undo by ' + self._name(userSysId));
            });
        }
        var who = this._name(userSysId);
        var rows = this._itemRows(mid);
        var restored = 0, touched = 0, failed = 0, details = [];
        for (var i = 0; i < rows.length; i++) {
            if (!rows[i].undo) continue;
            var u = this._parse(rows[i].undo);
            if (!u || !u.restore) continue;
            if (u.pending) {
                // a scan stopped between parking the undo and finishing the
                // write - we cant tell a half-write from a human, so dont guess
                failed++;
                details.push(rows[i].target_number + ' was mid-write when a scan stopped, check it yourself');
                continue;
            }
            // kill switch per write, not per batch
            if (!this.writesEnabled()) { details.push('stopped: ticket writes were switched off'); break; }
            var r = this._undoItem(rows[i], u, ntNum, who);
            if (r === 'restored') restored++;
            else if (r === 'touched') { touched++; details.push(rows[i].target_number + ' changed since, left alone'); }
            else { failed++; details.push(rows[i].target_number + ': ' + r); }
        }
        this._commit(mid, null, function (fresh, cond) {
            cond.counts = self._recount(mid);
            if (!cond.counts.applied) fresh.undo_json = '';
            self._log(fresh, 'undone by ' + who + ': ' + self._plural(restored, 'routing') + ' restored' +
                             (touched ? ', ' + touched + ' left alone because someone changed them after me' : '') +
                             (failed ? ', ' + failed + ' failed' : ''));
        });
        var msg;
        if (!restored && !touched && !failed) msg = name + ' never changed a ticket, so there is nothing to undo.';
        else msg = 'I put back ' + this._plural(restored, 'ticket') + ' from ' + name + '.' +
                   (touched ? ' ' + touched + (touched === 1 ? ' was' : ' were') + ' changed by someone after me, so I left ' + (touched === 1 ? 'it' : 'them') + ' alone.' : '') +
                   (failed ? ' ' + failed + ' could not be restored - check ' + (failed === 1 ? 'it' : 'them') + ' yourself.' : '');
        return { ok: true, restored: restored, skipped_touched: touched, failed: failed, details: details, message: msg };
    },

    _undoItem: function (row, u, ntNum, who) {
        var t = this._get(u.t || row.target_table || this.QUEUE_TABLE, u.id || row.target_sys_id);
        if (!t) return 'the ticket is gone';
        // never fight a person: any update after ours means hands off
        if (this._int(t.getValue('sys_mod_count')) !== this._int(u.mod_after)) return 'touched';
        var what = [];
        for (var f in u.restore) {
            if (!u.restore.hasOwnProperty(f)) continue;
            t.setValue(f, u.restore[f]);
            what.push(f.replace('_', ' ') + (u.restore[f] ? '' : ' cleared'));
        }
        t.work_notes = 'Netra mission ' + ntNum + ' routing undone by ' + who + ': ' + what.join(', ') + ' put back as it was.';
        t.update();
        // verify by re-reading every field we put back
        var chk = this._get(u.t || row.target_table || this.QUEUE_TABLE, u.id || row.target_sys_id);
        var it = this._get(this.ITEM, row.sys_id);
        var fnd = this._parse(it ? it.getValue('findings_json') : '') || {};
        var off = [];
        for (var v in u.restore) {
            if (!u.restore.hasOwnProperty(v)) continue;
            if (!chk || String(chk.getValue(v) || '') !== String(u.restore[v] || '')) off.push(v.replace('_', ' '));
        }
        if (off.length) {
            var why = off.join(' and ') + ' did not read back as restored';
            if (it) {
                fnd.undo_error = why;
                it.findings_json = this._fit(fnd, 4000);
                // our own undo write bumped sys_mod_count: re-baseline, or a
                // retry would blame "someone changed it after me" for our edit
                if (chk) { u.mod_after = this._int(chk.getValue('sys_mod_count')); it.undo_json = this._fit(u, 1000); }
                it.update();
            }
            return why;
        }
        if (it) {
            fnd.undone = { at_ms: this._now(), by: who };
            delete fnd.applied;
            it.findings_json = this._fit(fnd, 4000);
            it.undo_json = '';
            it.state = 'reviewed';
            it.update();
        }
        return 'restored';
    },

    /* ===================================================================
     *  the scanner hook
     * =================================================================== */

    /**
     * advance() - call from NetraScanner.run() right after NetraTaskRunner.
     * -> { missions, reviewed, skipped, requeued, errors, applied, notified,
     *      embed_calls, waits }   (add .notified to the scanner's enqueued)
     */
    advance: function () {
        this._t0 = this._now();
        var out = { missions: 0, reviewed: 0, skipped: 0, requeued: 0, errors: 0, applied: 0,
                    notified: 0, embed_calls: 0, waits: 0 };
        // working missions, least recently worked first so two take turns.
        // idle ones (paused / awaiting apply) are queried apart, soonest
        // expiry first - they never get updated, so mixed into one
        // oldest-first list they would crowd the working ones out
        var busy = this._missionIds(['running', 'applying'], 'sys_updated_on', 10);
        var idle = this._missionIds(['paused', 'awaiting_apply'], 'expires_at', 20);

        for (var i = 0; i < busy.length; i++) {
            if (this._overDeadline()) break;
            var m = this._get(this.TASK, busy[i]);
            if (!m) continue;
            try {
                this._advanceOne(m, out);
            } catch (e) {
                this._failMission(busy[i], 'mission runner threw: ' + (e.message || e), out);
            }
        }
        var now = this._now();
        for (var j = 0; j < idle.length; j++) {
            var im = this._get(this.TASK, idle[j]);
            if (!im) continue;
            var exp = this._ms(im, 'expires_at');
            // empty expiry sorts FIRST ascending - skip it, dont let it end the loop
            if (!exp) continue;
            if (exp > now) break;   // sorted by expiry: the rest are later
            try { this._expire(im, out); } catch (eX) { gs.warn('[NetraMission] expiry failed: ' + (eX.message || eX)); }
        }
        if (out.missions) {
            gs.info('[NetraMission] pass: ' + out.missions + ' mission(s), reviewed ' + out.reviewed + ', skipped ' + out.skipped +
                    ', applied ' + out.applied + ', errors ' + out.errors + ', embedContent calls ' + out.embed_calls +
                    ', generateContent 0, ' + (this._now() - this._t0) + ' ms');
        }
        return out;
    },

    _advanceOne: function (m, out) {
        var st = String(m.state);
        var cond = this._cond(m);
        var now = this._now();
        var exp = this._ms(m, 'expires_at');
        if (exp && now >= exp) { this._expire(m, out); return; }
        if (st === 'paused' || st === 'awaiting_apply') return;
        if (cond.wait && cond.wait.until_ms > now) { out.waits++; return; }
        var token = this._takeLease(m);
        if (!token) return;
        out.missions++;
        if (st === 'running') this._reviewPass(m, token, out);
        else if (st === 'applying') this._applyPass(m, token, out);
    },

    // ---- review phase -------------------------------------------------
    _reviewPass: function (m, token, out) {
        var mid = m.getUniqueValue();
        var rows = this._itemRows(mid);
        var now = this._now();
        var inMission = {}, queued = [];
        for (var i = 0; i < rows.length; i++) {
            inMission[rows[i].target_sys_id] = true;
            // reaper: a pass that died mid-item left it 'working'
            if (rows[i].state === 'working' && rows[i].lease_ms <= now) this._reap(rows[i]);
        }
        rows = this._itemRows(mid);
        for (var q = 0; q < rows.length; q++) if (rows[q].state === 'queued') queued.push(rows[q].sys_id);

        var sem = new NetraSemantic({ memoScans: true });
        var wait = null, fatal = null, n = 0;
        for (var k = 0; k < queued.length && n < this.PER_PASS; k++) {
            if (this._overDeadline()) break;
            if (this._freshState(mid) !== 'running') break;   // paused or cancelled under us
            var r = this._reviewItem(queued[k], sem, inMission);
            if (r.status === 'noop') continue;
            n++;
            if (r.status === 'reviewed') out.reviewed++;
            else if (r.status === 'skipped') out.skipped++;
            else if (r.status === 'error') out.errors++;
            else if (r.status === 'requeued') out.requeued++;
            if (r.wait) { wait = r.wait; out.waits++; break; }
            if (r.fatal) { fatal = r.fatal; break; }
        }
        out.embed_calls += sem.embedCalls;
        this._finishReview(mid, token, wait, fatal, out);
    },

    _reviewItem: function (itemId, sem, inMission) {
        var it = this._get(this.ITEM, itemId);
        if (!it || String(it.state) !== 'queued') return { status: 'noop' };
        var attempts = this._int(it.getValue('attempts'));
        var now = this._now();
        it.state = 'working';
        it.lease_until.setDateNumericValue(now + this.ITEM_LEASE_MS);
        it.update();
        var f = this._parse(it.getValue('findings_json')) || {};
        try {
            var tk = this._ticket(String(it.target_table || this.QUEUE_TABLE), String(it.target_sys_id));
            if (tk.blocked) return this._itemFailed(it, f, attempts, { why: tk.blocked, fatal: true });
            var t = tk.gr;
            if (!t) return this._skipItem(it, f, 'the ticket no longer exists');
            f.sd = String(t.short_description || '').substring(0, 120);
            if (!this._isTrue(t.getValue('active'))) return this._skipItem(it, f, 'it was resolved or closed before I got to it');
            var grp = String(t.getValue('assignment_group') || ''), who = String(t.getValue('assigned_to') || '');
            if (grp || who) {
                var by = grp ? String(t.assignment_group.getDisplayValue()) : String(t.assigned_to.getDisplayValue());
                return this._skipItem(it, f, 'someone already picked it up' + (by ? ' (' + by + ')' : ''));
            }
            var modCount = this._int(t.getValue('sys_mod_count'));
            var text = sem.incTextFor(t);
            if (!text) return this._skipItem(it, f, 'there is nothing written on it to compare');
            var sysId = String(t.sys_id);

            // one query embed (memoised across the three), max 2 live doc embeds total
            var budget = this.LIVE_EMBEDS_PER_ITEM;
            var tri = sem.triageVotes(text, { excludeSysId: sysId, maxLive: budget });
            var bad = this._semFailure(tri);
            if (bad) return this._itemFailed(it, f, attempts, bad);
            budget -= this._liveUsed(tri);
            var dup = sem.checkDuplicates(text, sysId, { maxLive: Math.max(0, budget) });
            bad = this._semFailure(dup);
            if (bad) return this._itemFailed(it, f, attempts, bad);
            budget -= this._liveUsed(dup);
            var fix = sem.findSimilarResolved(text, 3, { maxLive: Math.max(0, budget), excludeSysId: sysId });
            bad = this._semFailure(fix);
            if (bad) return this._itemFailed(it, f, attempts, bad);

            var nf = this.buildFindings(f.sd, tri, dup, fix, inMission, this._now());
            nf.embeds = { live: this.LIVE_EMBEDS_PER_ITEM - budget + this._liveUsed(fix) };
            nf.src = this._srcSummary({ tri: tri, dup: dup, fix: fix });
            var degraded = this._degraded([tri, dup, fix]);
            if (degraded) nf.degraded = degraded;
            it.findings_json = this._fit(nf, 4000);
            it.mod_count_at_review = modCount;
            it.state = 'reviewed';
            it.update();
            return { status: 'reviewed' };
        } catch (e) {
            return this._itemFailed(it, f, attempts, { why: 'review threw: ' + String(e.message || e).substring(0, 160) });
        }
    },

    _finishReview: function (mid, token, wait, fatal, out) {
        var self = this;
        var counts = this._recount(mid);
        var notify = null, userId = '', ntNum = '';
        var ok = this._commit(mid, token, function (h, cond) {
            userId = String(h.user);
            ntNum = String(h.nt_number);
            cond.counts = counts;
            cond.passes = (cond.passes || 0) + 1;
            if (wait) {
                if (!cond.wait) self._log(h, 'waiting on the ' + wait.reason + ', back in about ' + Math.max(1, Math.ceil((wait.until_ms - self._now()) / 60000)) + ' min');
                cond.wait = wait;
            } else {
                cond.wait = null;
            }
            if (fatal) {
                h.state = 'error';
                self._log(h, 'ERROR: ' + fatal);
                notify = self._missionName(ntNum) + ' hit a problem and stopped: ' + fatal + '. Nothing was changed.';
                return;
            }
            if (String(h.state) === 'running' && !counts.queued && !counts.working) {
                if (counts.confident_pending) {
                    h.state = 'awaiting_apply';
                    cond.phase = 'awaiting_apply';
                } else {
                    h.state = 'done';
                    cond.phase = 'done';
                }
                self._log(h, 'finished reviewing ' + self._plural(counts.total, 'incident') + ': ' + self._findingsPhrase(counts));
                notify = self.reviewDoneMessage(ntNum, counts);
            }
        });
        if (ok && notify) {
            this._notifyUser(userId, ntNum, notify);
            out.notified++;
        }
    },

    // ---- apply phase ----------------------------------------------------
    _applyPass: function (m, token, out) {
        var mid = m.getUniqueValue();
        var cond = this._cond(m);
        var auth = (cond.apply && cond.apply.by) || String(m.user);
        var authName = this._name(auth);
        var ntNum = String(m.nt_number);
        var rows = this._itemRows(mid);
        var todo = [];
        for (var i = 0; i < rows.length; i++) {
            var f = rows[i].findings || {};
            if (rows[i].state === 'reviewed' && f.proposal && f.proposal.confident && !f.undone) todo.push(rows[i].sys_id);
        }
        var hold = null, fatal = null, n = 0;
        for (var k = 0; k < todo.length && n < this.APPLY_PER_PASS; k++) {
            if (this._overDeadline()) break;
            if (this._freshState(mid) !== 'applying') break;
            if (!this.writesEnabled()) { hold = this._writesOffWait(); break; }
            var r = this._applyItem(todo[k], ntNum, authName);
            if (r.hold) { hold = this._writesOffWait(); break; }
            if (r.fatal) { fatal = r.fatal; break; }
            if (r.status === 'noop') continue;
            n++;
            if (r.status === 'applied') out.applied++;
            else if (r.status === 'skipped') out.skipped++;
            else if (r.status === 'error') out.errors++;
        }
        this._finishApply(mid, token, hold, fatal, out);
    },

    _applyItem: function (itemId, ntNum, authName) {
        var it = this._get(this.ITEM, itemId);
        if (!it || String(it.state) !== 'reviewed') return { status: 'noop' };
        var f = this._parse(it.getValue('findings_json')) || {};
        var p = f.proposal || {};
        // fresh read: only an unreverted confident proposal is ever written
        if (!p.confident || f.undone) return { status: 'noop' };
        var table = String(it.target_table || this.QUEUE_TABLE), sysId = String(it.target_sys_id);
        var tk = this._ticket(table, sysId);
        if (tk.blocked) return { status: 'noop', fatal: tk.blocked };
        var t = tk.gr;
        if (!t) return this._applySkip(it, f, 'the ticket no longer exists');
        var cur = this._int(t.getValue('sys_mod_count'));
        var atReview = this._int(it.getValue('mod_count_at_review'));

        // a previous pass died between the ticket write and the bookkeeping:
        // if our group is on the ticket, that was us - finish the paperwork
        var pend = this._parse(it.getValue('undo_json'));
        if (pend && pend.pending && pend.set && String(t.getValue('assignment_group') || '') === pend.set.assignment_group) {
            if (cur !== atReview + 1) {
                // our write is ONE update. anything more means a person (or a
                // rule) also touched it - cant tell our change from theirs, so
                // no undo record that could later stomp their edit
                return this._applyError(it, f, 'a scan stopped mid-write and the ticket shows more changes than my one write, so I cannot tell my change from anyone else\'s - check it yourself', null);
            }
            delete pend.pending;
            pend.mod_after = cur;
            pend.recovered = true;
            f.applied = { at_ms: this._now(), group: p.group, verified: true, recovered: true };
            it.undo_json = this._fit(pend, 1000);
            it.findings_json = this._fit(f, 4000);
            it.state = 'applied';
            it.update();
            return { status: 'applied' };
        }
        if (cur !== atReview) return this._applySkip(it, f, 'someone changed it after my review');
        if (!this._isTrue(t.getValue('active'))) return this._applySkip(it, f, 'it was closed after my review');

        var gid = String(p.group_id || '');
        var g = gid ? this._get('sys_user_group', gid) : null;
        if (!g) return this._applyError(it, f, 'the group ' + (p.group || '?') + ' is not there any more', null);
        if (g.isValidField('active') && !this._isTrue(g.getValue('active'))) return this._applyError(it, f, 'the group ' + p.group + ' is inactive', null);

        var before = { assignment_group: String(t.getValue('assignment_group') || ''), category: String(t.getValue('category') || '') };
        var setCat = !!(p.category && p.category_share >= this.APPLY_SHARE && p.category !== before.category && t.isValidField('category'));
        var undo = { t: table, id: sysId, n: String(it.target_number), restore: { assignment_group: before.assignment_group },
                     set: { assignment_group: gid }, pending: true };
        if (setCat) { undo.restore.category = before.category; undo.set.category = p.category; }
        // park the before-values FIRST, so a pass dying mid-write can still be undone
        it.undo_json = this._fit(undo, 1000);
        it.update();

        if (!this.writesEnabled()) { it.undo_json = ''; it.update(); return { status: 'noop', hold: true }; }
        t.setValue('assignment_group', gid);
        if (setCat) t.setValue('category', p.category);
        t.update();

        var chk = this._get(table, sysId);
        var gotG = chk ? String(chk.getValue('assignment_group') || '') : '';
        var gotC = chk ? String(chk.getValue('category') || '') : '';
        if (gotG !== gid) {
            // didnt stick - a rule stomped it or we lack write. say so, and
            // keep an undo for whatever DID change
            delete undo.pending;
            var partial = setCat && gotC === p.category && gotC !== before.category;
            if (partial) {
                undo.restore = { category: before.category };
                undo.set = { category: p.category };
                undo.mod_after = chk ? this._int(chk.getValue('sys_mod_count')) : 0;
            }
            return this._applyError(it, f, 'I set the group to ' + p.group + ' but it read back as ' +
                                    (gotG && chk ? String(chk.assignment_group.getDisplayValue()) : 'empty'), partial ? undo : null);
        }
        var notes = [];
        var catDone = setCat && gotC === p.category;
        if (setCat && !catDone) notes.push('category did not stick (reads ' + (gotC || 'empty') + ')');

        var prioDone = '';
        if (p.priority && p.priority_share >= this.APPLY_SHARE && String(chk.priority) !== String(p.priority)) {
            if (String(p.priority) === '1') {
                notes.push('left priority 1 for a person to decide');
            } else if (!this.writesEnabled()) {
                notes.push('priority held: ticket writes were switched off');
            } else {
                var PF = ['priority', 'impact', 'urgency'];
                var pBefore = {};
                for (var pb = 0; pb < PF.length; pb++) if (chk.isValidField(PF[pb])) pBefore[PF[pb]] = String(chk.getValue(PF[pb]) || '');
                var pr = new NetraTaskRunner().setPriority(chk, String(p.priority));
                var pc = this._get(table, sysId);
                if (pr.ok) {
                    for (var k in pr.before) {
                        if (!pr.before.hasOwnProperty(k)) continue;
                        undo.restore[k] = pr.before[k];
                        if (pc) undo.set[k] = String(pc.getValue(k) || '');
                    }
                    undo.set.priority = String(p.priority);
                    prioDone = String(p.priority);
                } else {
                    // setPriority can give up AFTER moving impact/urgency (the
                    // matrix route) and returns no before-values then. whatever
                    // moved is still our write, so it must stay undoable
                    var moved = [];
                    for (var pk in pBefore) {
                        if (!pBefore.hasOwnProperty(pk) || !pc) continue;
                        var nowV = String(pc.getValue(pk) || '');
                        if (nowV !== pBefore[pk]) { undo.restore[pk] = pBefore[pk]; undo.set[pk] = nowV; moved.push(pk); }
                    }
                    notes.push('priority not changed: ' + pr.why + (moved.length ? ' (' + moved.join(' and ') + ' did move - undo puts ' + (moved.length === 1 ? 'it' : 'them') + ' back)' : ''));
                }
            }
        }
        if (this.writesEnabled()) {
            var w = this._get(table, sysId);
            if (w) {
                w.work_notes = this.workNote(ntNum, p, f, catDone, prioDone, authName);
                w.update();
            }
        } else {
            notes.push('work note held: ticket writes were switched off');
        }
        var fin = this._get(table, sysId);
        delete undo.pending;
        undo.mod_after = fin ? this._int(fin.getValue('sys_mod_count')) : 0;
        var finalG = fin ? String(fin.getValue('assignment_group') || '') : '';
        if (finalG !== gid) {
            // someone (or a rule) re-routed it right after us. restoring the
            // group now would stomp THEIR choice - never fight a person. keep
            // only restores for fields that still hold exactly what we set
            var keep = {}, kept = 0;
            for (var rf in undo.restore) {
                if (!undo.restore.hasOwnProperty(rf) || rf === 'assignment_group' || !fin) continue;
                if (undo.set.hasOwnProperty(rf) && String(fin.getValue(rf) || '') === String(undo.set[rf])) { keep[rf] = undo.restore[rf]; kept++; }
            }
            undo.restore = keep;
            return this._applyError(it, f, 'the group changed again right after my write (now ' +
                                    (finalG && fin ? String(fin.assignment_group.getDisplayValue()) : 'empty') + '), so I left the group alone', kept ? undo : null);
        }
        f.applied = { at_ms: this._now(), group: p.group, category: catDone ? p.category : '', priority: prioDone,
                      verified: true, notes: notes };
        it.undo_json = this._fit(undo, 1000);
        it.findings_json = this._fit(f, 4000);
        it.state = 'applied';
        it.update();
        return { status: 'applied' };
    },

    _finishApply: function (mid, token, hold, fatal, out) {
        var self = this;
        var counts = this._recount(mid);
        var notify = null, userId = '', ntNum = '';
        var ok = this._commit(mid, token, function (h, cond) {
            userId = String(h.user);
            ntNum = String(h.nt_number);
            cond.counts = counts;
            cond.passes = (cond.passes || 0) + 1;
            if (counts.applied) h.undo_json = JSON.stringify({ mission: ntNum, applied: counts.applied, undo: 'undo mission' });
            if (fatal) {
                h.state = 'error';
                self._log(h, 'ERROR: ' + fatal);
                notify = self._missionName(ntNum) + ' hit a problem and stopped: ' + fatal + '. ' +
                         (counts.applied ? self._plural(counts.applied, 'routing') + ' it already applied stay - say undo mission ' + self._digits(ntNum) + ' to reverse them.'
                                         : 'Nothing was changed.');
                return;
            }
            if (hold) {
                if (!cond.wait) {
                    self._log(h, 'holding: ticket writes are switched off');
                    notify = self._missionName(ntNum) + ' is holding: ticket writes are switched off, so I stopped applying. ' +
                             self._plural(counts.applied, 'routing') + ' done so far. I will carry on if they come back on.';
                }
                cond.wait = hold;
            } else {
                cond.wait = null;
            }
            if (String(h.state) === 'applying' && !counts.confident_pending) {
                h.state = 'done';
                cond.phase = 'done';
                self._log(h, 'applied ' + self._plural(counts.applied, 'routing') +
                             (counts.apply_skipped ? ', ' + counts.apply_skipped + ' skipped because someone changed them after my review' : ''),
                          counts.applied ? { undoable: true } : null);
                notify = self.applyDoneMessage(ntNum, counts);
            }
        });
        if (ok && notify) {
            this._notifyUser(userId, ntNum, notify);
            out.notified++;
        }
    },

    // ---- item outcomes ---------------------------------------------------
    _skipItem: function (it, f, reason) {
        f.skip_reason = reason;
        it.findings_json = this._fit(f, 4000);
        it.state = 'skipped';
        it.update();
        return { status: 'skipped' };
    },

    _applySkip: function (it, f, reason) {
        f.skip_reason = reason;
        f.apply_skip = reason;
        it.findings_json = this._fit(f, 4000);
        it.undo_json = '';
        it.state = 'skipped';
        it.update();
        return { status: 'skipped' };
    },

    _applyError: function (it, f, why, undo) {
        f.apply_error = why;
        it.findings_json = this._fit(f, 4000);
        it.undo_json = undo ? this._fit(undo, 1000) : '';
        it.state = 'error';
        it.update();
        return { status: 'error' };
    },

    _itemFailed: function (it, f, attempts, bad) {
        f.last_error = String(bad.why || 'unknown').substring(0, 200);
        if (bad.fatal) {
            // config problem, not this ticket's fault - dont burn its attempts
            it.state = 'queued';
            it.findings_json = this._fit(f, 4000);
            it.update();
            return { status: 'requeued', fatal: bad.why };
        }
        attempts++;
        it.attempts = attempts;
        var status = 'requeued';
        if (attempts >= this.MAX_ATTEMPTS) {
            it.state = 'error';
            f.error = 'gave up after ' + attempts + ' tries: ' + f.last_error;
            status = 'error';
        } else {
            it.state = 'queued';
        }
        it.findings_json = this._fit(f, 4000);
        it.update();
        return { status: status, wait: bad.wait || null };
    },

    _reap: function (row) {
        var it = this._get(this.ITEM, row.sys_id);
        if (!it || String(it.state) !== 'working') return;
        var a = this._int(it.getValue('attempts')) + 1;
        var f = this._parse(it.getValue('findings_json')) || {};
        f.last_error = 'a pass stopped while working on it';
        it.attempts = a;
        if (a >= this.MAX_ATTEMPTS) {
            it.state = 'error';
            f.error = 'it stalled the runner ' + a + ' times';
        } else {
            it.state = 'queued';
        }
        it.findings_json = this._fit(f, 4000);
        it.update();
    },

    _semFailure: function (r) {
        if (!r) return { why: 'no result from the semantic engine' };
        var st = r.stats || {};
        if (!r.ok) {
            if (r.code === 429) return { why: 'embedding quota (HTTP 429)', wait: this._quotaWait(r.retry_ms, r.quota_kind) };
            if (r.fatal || r.blocked) return { why: String(r.error), fatal: true };
            if (r.embed_failed) {
                // 5xx / timeout on the query embed is the service, not this
                // ticket - back off instead of burning every item's attempts
                return { why: String(r.error || 'embedding failed'),
                         wait: { reason: 'embedding service', until_ms: this._now() + this.EMBED_TROUBLE_WAIT_MS } };
            }
            return { why: String(r.error || 'semantic search failed') };
        }
        // a 429 on a doc embed mid-search leaves thin results - redo the item later
        if (st.rate_limited) return { why: 'embedding quota hit mid-search (HTTP 429)', wait: this._quotaWait(st.rate_limited.retry_ms, st.rate_limited.quota_kind) };
        if (st.fatal) return { why: String(st.fatal), fatal: true };
        // a blind search must not be stored as "nothing similar in the
        // history": an unreadable vector cache stops the mission (config),
        // a failed read is retried like any other transient error
        var vc = st.sources && st.sources.vector_cache;
        if (vc && vc.status === 'blocked') return { why: 'the embedding cache is not readable (' + (vc.error || 'blocked') + ')', fatal: true };
        if (vc && vc.status === 'error') {
            return { why: 'embedding cache read failed: ' + String(vc.error || 'error'),
                     wait: { reason: 'embedding cache', until_ms: this._now() + this.EMBED_TROUBLE_WAIT_MS } };
        }
        return null;
    },

    _liveUsed: function (r) {
        var st = (r && r.stats) || {};
        return st.live_attempts || 0;
    },

    // "tri:ok/ok dup:ok/ok fix:ok/empty" - candidates/vector cache per search,
    // so a thin finding can be told apart from a blind one
    _srcSummary: function (named) {
        var bits = [];
        for (var k in named) {
            if (!named.hasOwnProperty(k)) continue;
            var s = (named[k] && named[k].stats && named[k].stats.sources) || {};
            bits.push(k + ':' + ((s.candidates && s.candidates.status) || '?') + '/' + ((s.vector_cache && s.vector_cache.status) || '?'));
        }
        return bits.join(' ');
    },

    _degraded: function (results) {
        var bits = [], failedEmbeds = 0, skipped = 0;
        for (var i = 0; i < results.length; i++) {
            var st = (results[i] && results[i].stats) || {};
            failedEmbeds += st.embed_errors || 0;
            skipped += st.skipped_uncached || 0;
        }
        // uncached lookalikes past the live-embed budget were never scored
        if (failedEmbeds) bits.push(this._plural(failedEmbeds, 'lookalike embed') + ' failed');
        if (skipped) bits.push(skipped + ' uncached tickets not scored');
        return bits.join(', ');
    },

    _quotaWait: function (retryMs, kind) {
        var now = this._now();
        var until = now + Math.max(this.MIN_WAIT_MS, retryMs || 0);
        var reason = 'embedding quota';
        if (kind === 'per_day') {
            // the daily bucket refills at midnight Pacific; a 30 s RetryInfo would just 429 again
            until = Math.max(until, this.nextPtMidnightMs(now));
            reason = 'daily embedding quota';
        }
        return { reason: reason, until_ms: until };
    },

    _writesOffWait: function () {
        return { reason: 'ticket writes switched off', until_ms: this._now() + this.WRITES_OFF_RECHECK_MS };
    },

    _expire: function (m, out) {
        var self = this, notify = null, userId = '', ntNum = '';
        var ok = this._commit(m.getUniqueValue(), null, function (h, cond) {
            if (!self._isLive(String(h.state))) return;
            userId = String(h.user);
            ntNum = String(h.nt_number);
            var c = cond.counts || {};
            h.state = 'expired';
            cond.lease_until_ms = 0;
            cond.lease_owner = '';
            self._log(h, 'expired after ' + self.EXPIRY_H + ' hours at ' + (c.processed || 0) + ' of ' + (c.total || 0) + ' reviewed, ' + (c.applied || 0) + ' applied');
            notify = self._missionName(ntNum) + ' ran out of time after ' + self.EXPIRY_H + ' hours, at ' + (c.processed || 0) + ' of ' +
                     (c.total || 0) + ' reviewed and ' + (c.applied || 0) + ' applied. It will not do anything else.' +
                     (c.applied ? ' Say undo mission ' + self._digits(ntNum) + ' if you want those back.' : '');
        });
        if (ok && notify) {
            this._notifyUser(userId, ntNum, notify);
            if (out) out.notified++;
        }
    },

    _failMission: function (mid, why, out) {
        var self = this, notify = null, userId = '', ntNum = '';
        try {
            var ok = this._commit(mid, null, function (h, cond) {
                userId = String(h.user);
                ntNum = String(h.nt_number);
                var applied = (cond.counts && cond.counts.applied) || 0;
                h.state = 'error';
                cond.lease_until_ms = 0;
                cond.lease_owner = '';
                self._log(h, 'ERROR: ' + why);
                notify = self._missionName(ntNum) + ' hit a problem and stopped: ' + why + '. ' +
                         (applied ? self._plural(applied, 'routing') + ' it already applied stay - say undo mission ' + self._digits(ntNum) + ' to reverse them.'
                                  : 'Nothing was changed.');
            });
            if (ok && notify) {
                this._notifyUser(userId, ntNum, notify);
                if (out) out.notified++;
            }
        } catch (e) {}
        if (out) out.errors++;
        gs.warn('[NetraMission] ' + (ntNum || mid) + ' failed: ' + why);
    },

    /* ===================================================================
     *  pure bits - no GlideRecord, unit tested in node
     * =================================================================== */

    /**
     * rows: [{ state, findings:{...} }] -> counts. "reviewed" means the
     * review finished (findings carry a proposal), whatever happened next.
     */
    countsFrom: function (rows) {
        var c = { total: 0, processed: 0, reviewed: 0, skipped: 0, confident: 0, duplicates: 0, known_fix: 0,
                  applied: 0, error: 0, queued: 0, working: 0, apply_skipped: 0, confident_pending: 0 };
        for (var i = 0; i < rows.length; i++) {
            var st = rows[i].state;
            var f = rows[i].findings || {};
            c.total++;
            if (st === 'queued') c.queued++;
            else if (st === 'working') c.working++;
            else c.processed++;
            if (st === 'skipped') c.skipped++;
            if (st === 'error') c.error++;
            if (st === 'applied') c.applied++;
            if (f.proposal) {
                c.reviewed++;
                if (f.proposal.confident) c.confident++;
                if (f.duplicate_of) c.duplicates++;
                if (f.known_fix) c.known_fix++;
                if (st === 'reviewed' && f.proposal.confident && !f.undone) c.confident_pending++;
            }
            if (f.apply_skip) c.apply_skipped++;
        }
        return c;
    },

    buildFindings: function (sd, tri, dup, fix, inMission, nowMs) {
        var f = { v: 1, sd: sd || '', reviewed_ms: nowMs };
        var p = { group: '', group_id: '', group_share: 0, category: '', category_share: 0,
                  priority: '', priority_share: 0, confident: false, sample_size: (tri && tri.sample_size) || 0, evidence: [] };
        if (tri && tri.instance_pick) {
            p.group = tri.instance_pick.value;
            p.group_share = tri.instance_pick.share;
            p.group_id = (tri.group_ids && tri.group_ids[p.group]) || '';
        }
        if (tri && tri.category && tri.category.length) { p.category = tri.category[0].value; p.category_share = tri.category[0].share; }
        if (tri && tri.priority && tri.priority.length) { p.priority = tri.priority[0].value; p.priority_share = tri.priority[0].share; }
        if (tri && tri.pick_evidence && tri.pick_evidence.length) {
            p.evidence = tri.pick_evidence.slice(0, 3);
        } else if (tri && tri.evidence) {
            for (var e = 0; e < tri.evidence.length && e < 3; e++) p.evidence.push(tri.evidence[e].number);
        }
        // no sys_id for the group = nothing we could safely write. and
        // "confident" here authorises a WRITE: triage's own flag counts
        // unassigned lookalikes (often this very queue) toward its 3-match
        // minimum, so one assigned ticket could route a whole batch. require
        // three lookalikes that actually carry a group
        p.voters = (tri && typeof tri.voters === 'number') ? tri.voters : 0;
        p.confident = !!(tri && tri.confident && p.group_id && p.voters >= this.MIN_VOTERS);
        f.proposal = p;

        var dups = (dup && dup.duplicates) || [];
        var d = this.pickDuplicate(dups, inMission || {});
        f.duplicate_of = d ? { number: d.number, sys_id: d.sys_id, similarity: d.similarity,
                               sd: String(d.short_description || '').substring(0, 100), in_mission: !!(inMission && inMission[d.sys_id]) } : null;
        f.dup_numbers = [];
        for (var i = 0; i < dups.length && i < 4; i++) f.dup_numbers.push(dups[i].number);

        var kf = null, ms = (fix && fix.matches) || [];
        for (var j = 0; j < ms.length; j++) {
            // matches come back with-fix first, each half in score order
            if (ms[j].close_notes && ms[j].similarity >= this.FIX_THRESHOLD) { kf = ms[j]; break; }
        }
        f.known_fix = kf ? { number: kf.number, similarity: kf.similarity, close_notes: String(kf.close_notes).substring(0, 300),
                             resolved_at: kf.resolved_at || '' } : null;
        return f;
    },

    // prefer a duplicate that is NOT another ticket in this same queue: two
    // fresh unassigned copies of one outage should both point at the ticket
    // someone is already working, not at each other
    pickDuplicate: function (dups, inMission) {
        if (!dups || !dups.length) return null;
        for (var i = 0; i < dups.length; i++) if (!inMission[dups[i].sys_id]) return dups[i];
        return dups[0];
    },

    workNote: function (ntNum, p, f, catDone, prioDone, authName) {
        var bits = [];
        if (catDone) bits.push('category ' + p.category);
        if (prioDone) bits.push('priority ' + prioDone);
        var s = 'Netra mission ' + ntNum + ' (triage of the unassigned queue) routed this to ' + p.group +
                (bits.length ? ' (' + bits.join(', ') + ')' : '') + ', authorised by ' + authName + '.';
        if (p.evidence && p.evidence.length) {
            s += ' Evidence: similar tickets ' + this._list(p.evidence) + ' were handled by ' + p.group + '.';
        }
        if (f.duplicate_of) s += ' Possible duplicate of ' + f.duplicate_of.number + ' - reported only, nothing merged.';
        // quote the lookalike's close notes as ITS resolution - never as the
        // cause or the fix of this ticket
        if (f.known_fix) {
            var cn = String(f.known_fix.close_notes).substring(0, 200).replace(/\s+$/, '');
            s += ' Similar resolved ticket ' + f.known_fix.number + ' was closed with the note: "' + cn + '".';
        }
        s += ' To reverse, say "undo mission ' + this._digits(ntNum) + '" in Netra.';
        return s;
    },

    readBack: function (total, willReview, etaMin) {
        if (!total) return 'The unassigned queue is empty - there is nothing for a mission to do.';
        var what = (total > willReview)
            ? 'There are ' + total + ' unassigned incidents. I\'ll review the oldest ' + willReview
            : 'I\'ll review ' + (total === 1 ? 'the one unassigned incident' : 'the ' + total + ' unassigned incidents') + ', oldest first';
        return what + ', about ' + this.PER_PASS + ' every scan, roughly ' + etaMin + ' minutes. ' +
               'I only propose; nothing changes until you say apply. Shall I?';
    },

    etaMinutes: function (n) {
        return Math.max(1, Math.ceil((n || 0) / this.PER_PASS)) * this.SCAN_MINUTES;
    },

    boardSentence: function (nt, state, phase, c, wait) {
        c = c || {};
        var name = this._missionName(nt);
        var total = c.total || 0, processed = c.processed || 0, applied = c.applied || 0;
        var s;
        if (state === 'running') {
            s = name + ': ' + processed + ' of ' + total + ' reviewed; ' + this._findingsPhrase(c) + '.';
            // skips are not all pickups: closed, deleted and blank tickets too
            if (c.skipped) s += ' ' + c.skipped + ' skipped - picked up, closed or gone before I got to ' + (c.skipped === 1 ? 'it' : 'them') + '.';
            if (c.error) s += ' ' + c.error + ' I could not review.';
        } else if (state === 'awaiting_apply') {
            s = name + ' finished reviewing all ' + total + ': ' + this._findingsPhrase(c) +
                '. Nothing has changed yet - say apply the confident ones when you are ready.';
        } else if (state === 'applying') {
            s = name + ' is applying: ' + applied + ' of ' + (applied + (c.confident_pending || 0)) + ' confident routings done' +
                (c.apply_skipped ? ', ' + c.apply_skipped + ' skipped because someone changed them after my review' : '') + '.';
        } else if (state === 'paused') {
            s = name + ' is paused at ' + processed + ' of ' + total + ' reviewed' + (phase === 'apply' ? ', ' + applied + ' applied' : '') +
                '. Say resume mission ' + this._digits(nt) + ' to carry on.';
        } else if (state === 'done') {
            s = name + ' is done: ' + (applied ? this._plural(applied, 'routing') + ' applied' : 'reviewed ' + (c.reviewed || 0) + ', nothing applied') +
                (c.apply_skipped ? ', ' + c.apply_skipped + ' skipped because someone changed ' + (c.apply_skipped === 1 ? 'it' : 'them') + ' after my review' : '') + '.';
        } else if (state === 'cancelled') {
            s = name + ' was cancelled at ' + processed + ' of ' + total + ' reviewed' + (applied ? ', ' + applied + ' applied' : '') + '.';
        } else if (state === 'expired') {
            s = name + ' expired after ' + this.EXPIRY_H + ' hours at ' + processed + ' of ' + total + ' reviewed' + (applied ? ', ' + applied + ' applied' : '') + '.';
        } else {
            s = name + ' stopped with an error at ' + processed + ' of ' + total + ' reviewed.';
        }
        if (wait && wait.until_ms) {
            var mins = wait.minutes_left || 1;
            if (String(wait.reason).indexOf('ticket writes') === 0) {
                // no ETA to give: it resumes whenever someone flips the switch back
                s += ' Right now it is holding because ticket writes are switched off.';
            } else {
                s += ' Right now it is waiting on the ' + wait.reason + ' - about ' +
                     (mins > 90 ? this._plural(Math.round(mins / 60), 'more hour') : this._plural(mins, 'more minute')) + '.';
            }
        }
        return s;
    },

    reviewDoneMessage: function (nt, c) {
        var name = this._missionName(nt);
        var s = name + ' finished reviewing ' + this._plural(c.total || 0, 'unassigned incident') + ': ' + this._findingsPhrase(c) +
                (c.skipped ? ', ' + c.skipped + ' skipped - picked up, closed or gone before I got to ' + (c.skipped === 1 ? 'it' : 'them') : '') +
                (c.error ? ', ' + c.error + ' I could not review' : '') + '.';
        if (c.confident_pending) s += ' Nothing has changed yet. Say read the mission report, or apply the confident ones.';
        else s += ' Nothing is confident enough to apply, so it is done. Say read the mission report to hear the proposals.';
        return s;
    },

    applyDoneMessage: function (nt, c) {
        var name = this._missionName(nt);
        var s = name + ' applied ' + this._plural(c.applied || 0, 'confident routing') + ', each re-read to confirm it stuck.';
        if (c.apply_skipped) s += ' ' + c.apply_skipped + ' skipped because someone changed ' + (c.apply_skipped === 1 ? 'it' : 'them') + ' after my review.';
        if (c.applied) s += ' Say undo mission ' + this._digits(nt) + ' to put them back.';
        return s;
    },

    reportLine: function (item) {
        var head = item.number + (item.short_description ? ', ' + item.short_description : '');
        if (item.state === 'skipped') return head + ': skipped - ' + (item.skip_reason || 'no reason recorded') + '.';
        if (item.state === 'error' && !item.proposal) return head + ': I could not review it - ' + (item.error || 'unknown error') + '.';
        var p = item.proposal || {};
        var s;
        if (item.state === 'applied' && item.applied) {
            s = head + ': routed to ' + item.applied.group + ', checked and it stuck.';
        } else if (!p.group) {
            s = head + (p.sample_size
                ? ': the lookalikes I found were never assigned to a group, so no routing guess.'
                : ': nothing similar in the history, so no routing guess.');
        } else if (p.confident) {
            s = head + ': send to ' + p.group + (p.category && p.category_share >= this.APPLY_SHARE ? ', category ' + p.category : '') +
                (p.evidence && p.evidence.length ? ', like ' + this._list(p.evidence) : '') + '.';
        } else {
            // not confident = split votes OR too few lookalikes with a group
            s = head + ': best guess ' + p.group + ', but the history behind it is too thin or too split to route it blind.';
        }
        if (item.undone) s += ' I routed it, then put it back when you said undo.';
        if (item.state === 'error' && item.error) s += ' Applying it failed: ' + item.error + '.';
        if (item.duplicate_of) s += ' Looks like a duplicate of ' + item.duplicate_of.number + '.';
        if (item.known_fix) s += ' A similar resolved one, ' + item.known_fix.number + ', was closed with: ' + String(item.known_fix.close_notes).substring(0, 160);
        return s;
    },

    /**
     * Next midnight in US Pacific, as epoch ms. DST from the second Sunday
     * of March 02:00 local to the first Sunday of November 02:00 local.
     */
    nextPtMidnightMs: function (nowMs) {
        var H = 3600000, D = 24 * H;
        var self = this;
        function offsetAt(ms) { return self._isPdt(ms) ? 7 * H : 8 * H; }
        var off = offsetAt(nowMs);
        var localMidnight = Math.floor((nowMs - off) / D) * D + D;   // next local midnight, as if UTC
        var utc = localMidnight + off;
        var off2 = offsetAt(utc);
        if (off2 !== off) utc = localMidnight + off2;
        return utc;
    },

    _isPdt: function (ms) {
        var y = new Date(ms).getUTCFullYear();
        function nthSunday(month, n) {
            var first = new Date(Date.UTC(y, month, 1)).getUTCDay();
            return 1 + ((7 - first) % 7) + (n - 1) * 7;
        }
        var start = Date.UTC(y, 2, nthSunday(2, 2), 10);    // 02:00 PST = 10:00 UTC
        var end = Date.UTC(y, 10, nthSunday(10, 1), 9);     // 02:00 PDT = 09:00 UTC
        return ms >= start && ms < end;
    },

    _findingsPhrase: function (c) {
        return this._plural(c.confident || 0, 'confident routing') + ', ' + this._plural(c.duplicates || 0, 'likely duplicate') +
               ', ' + (c.known_fix || 0) + ' with a known fix';
    },

    _plural: function (n, word) {
        return n + ' ' + word + (n === 1 ? '' : 's');
    },

    _list: function (arr) {
        if (arr.length <= 1) return arr.join('');
        return arr.slice(0, -1).join(', ') + ' and ' + arr[arr.length - 1];
    },

    _missionName: function (nt) {
        return 'Mission ' + this._digits(nt);
    },

    /* ===================================================================
     *  plumbing
     * =================================================================== */

    _queue: function (limit) {
        var sources = {}, rows = [], total = -1;
        var self = this;
        var srcCount = this._source(sources, 'queue_count', function (src) {
            var ga = new GlideAggregate(self.QUEUE_TABLE);
            ga.addEncodedQuery(self.QUEUE_QUERY);
            ga.addAggregate('COUNT');   // one row back; scoped GlideAggregate has no setLimit
            ga.query();
            total = ga.next() ? parseInt(ga.getAggregate('COUNT'), 10) : 0;
            src.rows = 1;
        });
        var srcRows = this._source(sources, 'queue_rows', function (src) {
            var gr = new GlideRecord(self.QUEUE_TABLE);
            if (!gr.isValid()) { src.status = 'blocked'; src.error = self.QUEUE_TABLE + ' not readable'; return; }
            gr.addEncodedQuery(self.QUEUE_QUERY);
            gr.orderBy('opened_at');
            gr.setLimit(limit);
            gr.query();
            while (gr.next()) {
                rows.push({ sys_id: String(gr.sys_id), number: String(gr.number),
                            short_description: String(gr.short_description || ''), opened_ms: self._ms(gr, 'opened_at') });
            }
            src.rows = rows.length;
            if (!rows.length && self._looksBlocked(gr)) src.status = 'blocked';
        });
        if (srcRows.status === 'blocked' || srcRows.status === 'error') {
            return { ok: false, rows: [], total: 0, sources: sources,
                     message: 'I could not read the incident queue from here (' + srcRows.status + (srcRows.error ? ': ' + srcRows.error : '') +
                              '), so I cannot tell you what is unassigned. That is an access problem, not an empty queue.' };
        }
        if (srcCount.status !== 'ok' || total < rows.length || isNaN(total)) {
            // count failed or disagrees - fall back to what we actually read
            total = rows.length;
        }
        return { ok: true, rows: rows, total: total, sources: sources };
    },

    _source: function (sources, name, fn) {
        var t0 = new Date().getTime();
        var src = { rows: 0, ms: 0, status: 'ok' };
        try { fn(src); } catch (e) { src.status = 'error'; src.error = String(e.message || e).substring(0, 200); }
        src.ms = new Date().getTime() - t0;
        if (src.status === 'ok' && !src.rows) src.status = 'empty';
        sources[name] = src;
        return src;
    },

    _looksBlocked: function (gr) {
        try { if (!gr.isValid()) return true; } catch (e) { return true; }
        try { if (typeof gr.canRead === 'function' && !gr.canRead()) return true; } catch (e2) { return true; }
        return false;
    },

    _itemRows: function (mid) {
        var out = [];
        var it = new GlideRecord(this.ITEM);
        it.addQuery('mission', mid);
        it.orderBy('seq');
        it.setLimit(this.MAX_ITEMS + 10);
        it.query();
        while (it.next()) {
            out.push({
                sys_id: String(it.sys_id), seq: this._int(it.getValue('seq')), state: String(it.state),
                target_table: String(it.target_table || this.QUEUE_TABLE), target_sys_id: String(it.target_sys_id),
                target_number: String(it.target_number), attempts: this._int(it.getValue('attempts')),
                lease_ms: this._ms(it, 'lease_until'), findings: this._parse(it.getValue('findings_json')) || {},
                undo: String(it.getValue('undo_json') || '')
            });
        }
        return out;
    },

    _recount: function (mid) {
        return this.countsFrom(this._itemRows(mid));
    },

    _takeLease: function (m) {
        var cond = this._cond(m);
        var now = this._now();
        if (cond.lease_until_ms && cond.lease_until_ms > now) return null;
        var token = String(gs.generateGUID());
        cond.lease_until_ms = now + this.HEADER_LEASE_MS;
        cond.lease_owner = token;
        m.condition_json = JSON.stringify(cond);
        m.update();
        // write-then-reread: if another runner wrote after us, it owns it
        var chk = this._get(this.TASK, m.getUniqueValue());
        if (!chk || this._cond(chk).lease_owner !== token) return null;
        return token;
    },

    /**
     * Re-read the header, check we still own the lease (when a token is
     * given), let fn mutate the fresh row + its parsed condition, release
     * the lease, write. Mutating a FRESH read means a pause/cancel that
     * landed mid-pass is kept, not clobbered. -> true if written
     */
    _commit: function (mid, token, fn) {
        var h = this._get(this.TASK, mid);
        if (!h) return false;
        var cond = this._cond(h);
        if (token && cond.lease_owner !== token) {
            gs.warn('[NetraMission] ' + String(h.nt_number) + ' lease lost mid-pass, not writing back');
            return false;
        }
        fn(h, cond);
        if (token) { cond.lease_until_ms = 0; cond.lease_owner = ''; }
        h.condition_json = this._fit(cond, 4000);
        h.update();
        return true;
    },

    _itemTableOk: function () {
        try { return new GlideRecord(this.ITEM).isValid(); } catch (e) { return false; }
    },

    _missionIds: function (states, orderField, limit) {
        var ids = [];
        var h = new GlideRecord(this.TASK);
        h.addQuery('kind', 'mission');
        h.addQuery('state', 'IN', states.join(','));
        h.orderBy(orderField);
        h.setLimit(limit);
        h.query();
        while (h.next()) ids.push(String(h.sys_id));
        return ids;
    },

    _freshState: function (mid) {
        var h = this._get(this.TASK, mid);
        return h ? String(h.state) : '';
    },

    _liveMission: function (userSysId) {
        var gr = new GlideRecord(this.TASK);
        gr.addQuery('user', userSysId);
        gr.addQuery('kind', 'mission');
        gr.addQuery('action', this.TEMPLATE);
        gr.addQuery('state', 'IN', this.LIVE_STATES.join(','));
        gr.setLimit(1);
        gr.query();
        return gr.next() ? gr : null;
    },

    _findMission: function (nt, userSysId) {
        var key = this._ntKey(nt);
        if (!key) return null;
        var gr = new GlideRecord(this.TASK);
        gr.addQuery('user', userSysId);
        gr.addQuery('kind', 'mission');
        gr.addQuery('nt_number', key);
        gr.setLimit(1);
        gr.query();
        return gr.next() ? gr : null;
    },

    // same normalisation as the widget's standing-order lookups: 14, "nt14", "NT0014" -> NT0014
    _ntKey: function (nt) {
        var d = String(nt || '').replace(/\D/g, '');
        if (!d) return '';
        d = String(parseInt(d, 10));   // "00014" -> "14", or NT00014 never matches NT0014
        var key = 'NT' + d;
        while (key.length < 6) key = key.substring(0, 2) + '0' + key.substring(2);
        return key;
    },

    // copy of the widget's _ntNext: counts EVERY task row, so items must
    // never live in the task table
    _ntNext: function () {
        var gr = new GlideAggregate(this.TASK);
        gr.addAggregate('COUNT');
        gr.query();
        var n = gr.next() ? parseInt(gr.getAggregate('COUNT'), 10) : 0;
        var s = String(n + 1);
        while (s.length < 4) s = '0' + s;
        return 'NT' + s;
    },

    _get: function (table, sysId) {
        if (!sysId) return null;
        var gr = new GlideRecord(table);
        return gr.get(sysId) ? gr : null;
    },

    // a ticket we cant load is either gone or we are not allowed to see it.
    // those need different answers: "skipped, deleted" vs "stopped, access"
    _ticket: function (table, sysId) {
        var gr = new GlideRecord(table);
        if (sysId && gr.get(sysId)) return { gr: gr, blocked: '' };
        if (this._looksBlocked(gr)) {
            return { gr: null, blocked: 'I could not read ' + table + ' from the background job (access looks blocked)' };
        }
        return { gr: null, blocked: '' };
    },

    _cond: function (gr) {
        var c = this._parse(gr.getValue('condition_json'));
        return (c && typeof c === 'object') ? c : {};
    },

    _parse: function (s) {
        if (!s) return null;
        try { return JSON.parse(String(s)); } catch (e) { return null; }
    },

    // keep a JSON blob under its column size - shed the chatty bits first,
    // never cut the string (half a JSON object is worse than none)
    _fit: function (obj, max) {
        var s = JSON.stringify(obj);
        if (s.length <= max) return s;
        var shed = ['src', 'embeds', 'dup_numbers', 'degraded', 'last_error'];
        for (var i = 0; i < shed.length && s.length > max; i++) {
            if (obj.hasOwnProperty(shed[i])) { delete obj[shed[i]]; s = JSON.stringify(obj); }
        }
        if (s.length > max && obj.known_fix) { obj.known_fix.close_notes = String(obj.known_fix.close_notes).substring(0, 80); s = JSON.stringify(obj); }
        if (s.length > max && obj.duplicate_of) { obj.duplicate_of.sd = ''; s = JSON.stringify(obj); }
        if (s.length > max && obj.sd) { obj.sd = String(obj.sd).substring(0, 40); s = JSON.stringify(obj); }
        if (s.length > max) gs.warn('[NetraMission] blob still ' + s.length + ' chars after shedding (cap ' + max + ')');
        return s;
    },

    _now: function () {
        return new GlideDateTime().getNumericValue();
    },

    _ms: function (gr, field) {
        var v = gr.getValue(field);   // UTC internal string, no session timezone involved
        if (!v) return 0;
        return new GlideDateTime(String(v)).getNumericValue();
    },

    _int: function (v) {
        var n = parseInt(String(v === null || v === undefined ? '' : v), 10);
        return isNaN(n) ? 0 : n;
    },

    _isTrue: function (v) {
        var s = String(v);
        return s === 'true' || s === '1';
    },

    _isLive: function (state) {
        for (var i = 0; i < this.LIVE_STATES.length; i++) if (this.LIVE_STATES[i] === state) return true;
        return false;
    },

    _overDeadline: function () {
        return (this._now() - this._t0) >= this.PASS_DEADLINE_MS;
    },

    // same shape NetraTaskRunner._log writes, so the away debrief reads it
    _readLog: function (task) {
        try {
            var l = JSON.parse(String(task.action_log || '[]'));
            return Object.prototype.toString.call(l) === '[object Array]' ? l : [];
        } catch (e) { return []; }
    },

    _log: function (task, what, extra) {
        var log = this._readLog(task);
        var entry = { at: new GlideDateTime().toString(), at_ms: new GlideDateTime().getNumericValue(), what: String(what).substring(0, 300) };
        if (extra) { for (var k in extra) { if (extra.hasOwnProperty(k)) entry[k] = extra[k]; } }
        log.push(entry);
        if (log.length > 40) log = log.slice(-40);
        // action_log is an 8000-char column: 40 long entries overflow it, the
        // DB cuts the JSON mid-object and the next _readLog wipes the history
        var s = JSON.stringify(log);
        while (s.length > 7800 && log.length > 1) { log.shift(); s = JSON.stringify(log); }
        task.action_log = s;
    },

    _notifyUser: function (userSysId, ticketNumber, message) {
        if (!userSysId) return;
        var n = new GlideRecord(this.NOTIF);
        n.initialize();
        n.user = userSysId;
        n.kind = 'task_report';
        n.ticket_number = ticketNumber;
        n.ticket_sys_id = '';
        n.message = String(message).substring(0, 1000);
        n.delivered = false;
        n.insert();
    },

    _name: function (sysId) {
        try {
            var u = new GlideRecord('sys_user');
            if (u.get(sysId)) return String(u.first_name) || String(u.name);
        } catch (e) {}
        return 'your colleague';
    },

    _digits: function (nt) {
        var m = String(nt || '').match(/(\d+)/);
        return m ? String(parseInt(m[1], 10)) : String(nt);
    },

    type: 'NetraMissionRunner'
};
