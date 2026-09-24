/**
 * NetraTaskRunner - the part of Netra that acts while you're away. (R17)
 *
 * Standing orders live in x_196061_netra_v1_task: "watch INC0010031 and
 * nudge the assignee if nothing moves in 4 hours", spoken once, authorized
 * once, then executed here - inside the same 5-minute scheduled job that
 * already does the notification scans. No Gemini calls in here, ever: by
 * the time a task row exists the decision was already made in conversation.
 * This just evaluates plain GlideRecord conditions and does the one
 * pre-authorized thing.
 *
 * Trust rules, all enforced in code where the model cant vote:
 *  - the ticket_writes kill switch is re-checked before EVERY write, so
 *    flipping it also stops autonomy, instantly
 *  - nudges: max 1 per person per 24h, max 3 per task, quiet hours
 *    19:00-08:00 (re-armed for morning, not dropped)
 *  - anything that changes a field stores the before-value in undo_json
 *    first, so "undo task twelve" can put it back
 *  - every act lands in action_log AND a notification row, so the away
 *    debrief can read out exactly what happened, numbered
 *  - any parse error or missing record fails CLOSED: state=error plus a
 *    spoken notification, never a guess
 */
var NetraTaskRunner = Class.create();
NetraTaskRunner.prototype = {
    initialize: function () {
        this.SCOPE = 'x_196061_netra_v1';
        this.TASK  = this.SCOPE + '_task';
        this.NOTIF = this.SCOPE + '_notification';
        this.MAX_PER_RUN = 25;
        this.NUDGE_MIN_GAP_H = 24;
        this.NUDGE_MAX_PER_TASK = 3;
        this.QUIET_START = 19;   // 7pm
        this.QUIET_END   = 8;    // 8am
    },

    writesEnabled: function () {
        return String(gs.getProperty(this.SCOPE + '.ticket_writes', 'true')) !== 'false';
    },

    run: function () {
        var fired = 0, checked = 0;
        var now = new GlideDateTime();
        var gr = new GlideRecord(this.TASK);
        gr.addQuery('state', 'active');
        gr.addQuery('next_check_at', '<=', now.toString());
        gr.orderBy('next_check_at');
        gr.setLimit(this.MAX_PER_RUN);
        gr.query();
        while (gr.next()) {
            checked++;
            try {
                fired += this._checkOne(gr) ? 1 : 0;
            } catch (e) {
                this._fail(gr, 'runner threw: ' + (e.message || e));
            }
        }
        if (checked) gs.info('[NetraTaskRunner] checked ' + checked + ' task(s), fired ' + fired);
        return fired;
    },

    _checkOne: function (task) {
        // expiry first - an expired watch reports back too, so silence
        // never means "I forgot"
        if (task.expires_at && new GlideDateTime(String(task.expires_at)).before(new GlideDateTime())) {
            task.state = 'expired';
            this._log(task, 'expired without firing');
            task.update();
            if (String(task.kind) === 'chase_approvals') {
                var sent = 0, lg = this._readLog(task);
                for (var li = 0; li < lg.length; li++) if (lg[li].nudged) sent++;
                var on = task.getValue('target_number') ? 'approvals on ' + task.getValue('target_number') : 'your approvals';
                this._notify(task, String(task.nt_number) + ': my chase of ' + on + ' expired. ' +
                    (sent ? 'I sent ' + sent + ' reminder' + (sent === 1 ? '' : 's') + '.' : 'I did not send any reminders.'));
                return false;
            }
            this._notify(task, String(task.nt_number) + ': my watch on ' + String(task.target_number) +
                ' expired without the condition ever coming true.');
            return false;
        }
        var cond;
        try {
            cond = JSON.parse(String(task.condition_json || '{}'));
        } catch (eP) {
            this._fail(task, 'condition unreadable');
            return false;
        }
        if (String(task.kind) === 'chase_approvals') return this._chaseApprovals(task, cond);
        // R18 - MUST be explicit: _watchTicket starts from met=true, so any
        // new kind that fell through to it would fire on the very first pass
        if (String(task.kind) === 'investigate_watch') return this._investigateWatch(task, cond);
        if (String(task.kind) !== 'watch_ticket') {
            this._fail(task, 'unknown standing order kind ' + task.kind);
            return false;
        }
        return this._watchTicket(task, cond);
    },

    // ---- kind: investigate_watch (R18) --------------------------------
    // "keep digging on this while I'm away". Each pass re-snapshots the
    // ticket and its CI, reports ONLY what is new, checks each theory's
    // signal ("a sibling was fixed by rolling back the patch - that
    // supports theory one"), and when the ticket resolves, grades the
    // theories against the real close notes - including saying plainly
    // when it got it wrong. Zero model calls, like everything in here.
    _investigateWatch: function (task, cond) {
        var num = String(task.target_number);
        var t = new GlideRecord(String(task.target_table || 'incident'));
        if (!t.get(String(task.target_sys_id))) { this._fail(task, 'target record is gone'); return false; }
        var inv = new NetraInvestigator();
        var anchor = inv.resolveAnchor(num);
        if (!anchor || !anchor.ok) { this._fail(task, 'could not re-open the investigation on ' + num); return false; }

        var closed = String(t.state) === '6' || String(t.state) === '7' || String(t.active) === 'false';
        if (closed) {
            // the CI name is in every theory, so it can never tell them apart
            var g = inv.grade(cond.sig || [], String(t.close_notes || ''), { exclude: [String(anchor.ci_name || '')] });
            var verdict = num + ' is resolved, and ' + g.text;
            task.state = 'fired';
            this._log(task, 'graded: ' + g.outcome + (g.n ? ' (theory ' + g.n + ')' : ''), { outcome: g.outcome, theory: g.n || 0 });
            task.update();
            this._notify(task, String(task.nt_number) + ': ' + verdict);
            return true;
        }

        var snapOld = cond.snap || {};
        var track = [];
        for (var tk = 0; cond.sig && tk < cond.sig.length; tk++) if (cond.sig[tk].ref) track.push(cond.sig[tk].ref);
        var snapNew = inv.snapshot(anchor, { since_ms: snapOld.at || 0, track: track });
        if (!snapNew || !snapNew.ok) {
            if (snapNew && snapNew.gone) { this._fail(task, 'the ticket I was watching is gone'); return false; }
            this._rearm(task, 30);   // a flaky read is not news - try again next time
            task.update();
            return false;
        }
        var said = [];
        var facts = inv.diffSnapshot(snapOld, snapNew) || [];
        for (var i = 0; i < facts.length && said.length < 4; i++) said.push(facts[i]);
        var sigs = inv.checkSignals(cond.sig || [], snapOld, snapNew) || [];
        for (var s = 0; s < sigs.length; s++) {
            if (sigs[s].supported) said.push(sigs[s].text);   // already ends "...supports my theory one"
        }
        var compact = inv.compactSnapshot(snapNew, snapOld);
        cond.snap = compact;
        var ser = JSON.stringify(cond);
        // condition_json is a 4000-char column - trim the snapshot lists, never the theories
        while (ser.length > 3900) {
            if (compact.sib && compact.sib.length > 3) compact.sib = compact.sib.slice(-3);
            else if (compact.res && compact.res.length > 3) compact.res = compact.res.slice(-3);
            else if (compact.chg && compact.chg.length > 3) compact.chg = compact.chg.slice(-3);
            else break;
            ser = JSON.stringify(cond);
        }
        task.condition_json = ser;
        var sent = false;
        var fires = parseInt(String(task.fire_count || '0'), 10);
        if (said.length && fires < parseInt(String(task.max_fires || '5'), 10)) {
            task.fire_count = fires + 1;
            this._log(task, 'new on ' + num + ': ' + said.join('; '));
            sent = true;
        }
        this._rearm(task, 30);
        task.update();
        if (sent) this._notify(task, String(task.nt_number) + ': still digging on ' + num + '. ' + said.join('. ') + '.');
        return sent;
    },

    // ---- kind: watch_ticket ------------------------------------------
    _watchTicket: function (task, cond) {
        var t = new GlideRecord(String(task.target_table || 'incident'));
        if (!t.get(String(task.target_sys_id))) {
            this._fail(task, 'target record is gone');
            return false;
        }
        // a resolved ticket stops moving, so "no movement" would come true on
        // it - only a watch for that very state may still fire
        var st = String(t.getValue('state') || ''), act = String(t.getValue('active') || '');
        var wantsState = cond.state_equals !== undefined && cond.state_equals !== null && cond.state_equals !== '';
        if ((act === 'false' || act === '0' || /^(6|7|8)$/.test(st)) && !(wantsState && st === String(cond.state_equals))) {
            task.state = 'expired';
            this._log(task, 'target closed before firing');
            task.update();
            this._notify(task, String(task.nt_number) + ': ' + String(task.target_number) + ' was resolved or closed before your condition came true - I did nothing.');
            return false;
        }
        var met = true;
        if (cond.no_movement_hours) {
            var cutoff = new GlideDateTime();
            cutoff.addSeconds(-3600 * parseInt(cond.no_movement_hours, 10));
            met = met && new GlideDateTime(String(t.sys_updated_on)).before(cutoff);
        }
        if (cond.still_unassigned) met = met && !String(t.assigned_to);
        if (cond.state_equals !== undefined && cond.state_equals !== null && cond.state_equals !== '') {
            met = met && String(t.state) === String(cond.state_equals);
        }
        if (cond.due_at_ms) met = met && new GlideDateTime().getNumericValue() >= parseInt(cond.due_at_ms, 10);
        if (!met) {
            this._rearm(task, 30);   // look again in half an hour
            task.update();
            return false;
        }
        return this._fire(task, t);
    },

    _fire: function (task, t) {
        var action = String(task.action || 'notify_only');
        var params = {};
        try { params = JSON.parse(String(task.action_params || '{}')); } catch (eP) {}
        var num = String(t.number || task.target_number);
        var who = String(task.user);

        if (action !== 'notify_only' && !this.writesEnabled()) {
            this._fail(task, 'ticket writes are switched off, holding fire');
            return false;
        }

        var spoken = '';
        if (action === 'notify_only') {
            spoken = num + ' met your watch condition.';
            this._log(task, spoken);   // the away debrief reads the log, not the notification

        } else if (action === 'add_comment') {
            var msg = String(params.comment || 'Checking in on this one.');
            t.comments = msg + ' (standing order ' + String(task.nt_number) + ' via Netra, authorized by ' + this._name(who) + ')';
            if (!t.update()) { this._fail(task, 'the platform refused the comment on ' + num); return false; }
            this._log(task, 'commented on ' + num);
            spoken = 'I added your comment to ' + num + ' as ordered.';

        } else if (action === 'nudge_assignee') {
            if (this._inQuietHours()) { this._rearmMorning(task); task.update(); return false; }
            var assignee = String(t.assigned_to);
            if (!assignee) {
                spoken = num + ' has no assignee to nudge - the condition fired but there is nobody to poke. You may want to reassign it.';
                this._log(task, spoken);
            } else if (!this._cadenceOk(task, assignee)) {
                this._rearm(task, 60 * 6);
                task.update();
                return false;
            } else {
                t.work_notes = 'Gentle reminder from ' + this._name(who) + ' via Netra: this ticket has been quiet for a while - any update? (standing order ' + String(task.nt_number) + ')';
                if (!t.update()) { this._fail(task, 'the platform refused the reminder note on ' + num); return false; }
                this._notifyUser(assignee, num, this._name(who) + ' asked me to nudge you about ' + num + ' - it has been quiet for a while.');
                this._log(task, 'nudged ' + this._name(assignee) + ' on ' + num, { nudged: assignee });
                spoken = 'I nudged ' + this._name(assignee) + ' about ' + num + '.';
            }

        } else if (action === 'escalate_priority') {
            var pm = String(params.priority || '2').match(/^\D*([1-5])\D*$/);
            var target = pm ? pm[1] : '';
            if (!target) { this._fail(task, 'I do not know which priority to raise ' + num + ' to'); return false; }
            var before = String(t.getValue('priority') || '');
            var bN = parseInt(before, 10);
            if (before === target) {
                spoken = num + ' is already at priority ' + target + ', nothing to escalate.';
                this._log(task, spoken);   // the away debrief reads the log, not the notification
            } else if (bN && bN < parseInt(target, 10)) {
                // 1 is the most urgent: "raising" a P1 to 2 would lower it
                spoken = num + ' is already at priority ' + before + ', more urgent than the ' + target + ' you asked for - I left it alone.';
                this._log(task, spoken);
            } else {
                var res = this.setPriority(t, target);
                if (!res.ok) {
                    var why = 'could not move ' + num + ' to priority ' + target + ' (' + res.why + ')';
                    if (res.restored === false) {
                        // impact/urgency moved and would not go back: say so, keep it undoable
                        task.undo_json = JSON.stringify({ table: t.getTableName(), sys_id: String(t.sys_id),
                                                          restore: res.before, target_was: res.now.priority });
                        this._fail(task, why, 'It is now priority ' + res.now.priority + ', impact ' + res.now.impact + ', urgency ' + res.now.urgency +
                                              ', and I could not put it back - say undo task ' + this._digits(task.nt_number) + ' to try again.');
                    } else {
                        this._fail(task, why);
                    }
                    return false;
                }
                task.undo_json = JSON.stringify({ table: t.getTableName(), sys_id: String(t.sys_id),
                                                  restore: res.before, target_was: target });
                t.work_notes = 'Priority raised ' + before + ' -> ' + target + ' by standing order ' + String(task.nt_number) + ' (authorized in advance by ' + this._name(who) + ' via Netra).';
                t.update();
                this._log(task, 'escalated ' + num + ' priority ' + before + ' -> ' + target, { undoable: true });
                spoken = 'I escalated ' + num + ' from priority ' + before + ' to ' + target + ', as you authorized. Say undo task ' + this._digits(task.nt_number) + ' to put it back.';
            }
        } else {
            this._fail(task, 'unknown action ' + action);
            return false;
        }

        task.fire_count = parseInt(String(task.fire_count || '0'), 10) + 1;
        if (task.fire_count >= parseInt(String(task.max_fires || '1'), 10)) {
            task.state = 'fired';
        } else {
            this._rearm(task, 60 * 4);
        }
        task.update();
        this._notify(task, String(task.nt_number) + ': ' + spoken);
        return true;
    },

    // ---- kind: chase_approvals ---------------------------------------
    _chaseApprovals: function (task, cond) {
        // chase approvals the owner is WAITING ON (their own request),
        // never ones they are supposed to approve - that is scanner turf
        var owner = String(task.user);
        var open = 0, nudged = 0, read = 0, LIMIT = 50;
        var quiet = this._inQuietHours();
        // scoped to the owner's records in the query: a sample of everyone's
        // approvals, filtered afterwards, usually misses theirs
        var sources = cond.source_sys_id ? [String(cond.source_sys_id)] : this._ownerAwaiting(owner);
        var appr = new GlideRecord('sysapproval_approver');
        appr.addQuery('state', 'requested');
        appr.addQuery('sysapproval', 'IN', sources.join(','));
        appr.orderBy('sys_created_on');
        appr.setLimit(LIMIT);
        if (sources.length) appr.query();
        while (sources.length && appr.next()) {
            read++;
            if (!this._isOwners(appr, owner)) continue;
            var approver = String(appr.approver);
            if (approver === owner) continue;   // never chase yourself
            open++;
            if (quiet) continue;
            if (!this._cadenceOk(task, approver)) continue;
            var label = this._approvalLabel(appr);
            this._notifyUser(approver, label, this._name(owner) + ' asked me to remind you: ' + label + ' is still waiting on your approval.');
            this._writeApprovalNote(appr, 'Reminder from ' + this._name(owner) + ' via Netra: still waiting on this approval. (standing order ' + String(task.nt_number) + ')');
            this._log(task, 'nudged approver ' + this._name(approver) + ' about ' + label, { nudged: approver });
            nudged++;
        }
        if (!open && read < LIMIT) {
            task.state = 'fired';
            this._log(task, 'all approvals resolved');
            task.update();
            this._notify(task, String(task.nt_number) + ': good news - nothing is waiting on approval for you anymore.');
            return true;
        }
        // +12h from 19:00 or 07:00 is quiet hours again, every time
        if (quiet) { this._rearmMorning(task); task.update(); return false; }
        if (nudged) this._notify(task, String(task.nt_number) + ': I sent ' + nudged + ' approval reminder' + (nudged === 1 ? '' : 's') + '. ' + open + ' still pending.');
        this._rearm(task, 60 * 12);   // chase cadence: twice a day
        task.update();
        return nudged > 0;
    },

    // the owner's own records waiting for approval: requested by, requested
    // for or opened by them
    _ownerAwaiting: function (owner) {
        var ids = [], seen = {};
        var BY = [['task', 'opened_by'], ['change_request', 'requested_by'], ['sc_request', 'requested_for'], ['sc_req_item', 'requested_for']];
        for (var i = 0; i < BY.length; i++) {
            var g = new GlideRecord(BY[i][0]);
            if (!g.isValid() || !g.isValidField(BY[i][1])) continue;
            g.addQuery(BY[i][1], owner);
            g.addQuery('approval', 'requested');
            g.setLimit(100);
            g.query();
            while (g.next()) {
                var id = String(g.sys_id);
                if (!seen[id]) { seen[id] = true; ids.push(id); }
            }
        }
        return ids;
    },

    _isOwners: function (appr, owner) {
        try {
            var src = new GlideRecord(String(appr.getValue('source_table') || 'task'));
            if (src.get(String(appr.getValue('sysapproval') || ''))) {
                var F = ['requested_by', 'requested_for', 'opened_by'];
                for (var i = 0; i < F.length; i++) if (String(src.getValue(F[i]) || '') === owner) return true;
            }
        } catch (e) {}
        return false;
    },

    _approvalLabel: function (appr) {
        try {
            var src = new GlideRecord(String(appr.source_table || 'change_request'));
            if (src.get(String(appr.sysapproval))) return String(src.number || 'a request');
        } catch (e) {}
        return 'a request';
    },

    _writeApprovalNote: function (appr, note) {
        if (!this.writesEnabled()) return;
        try {
            var src = new GlideRecord(String(appr.source_table || 'change_request'));
            if (src.get(String(appr.sysapproval)) && src.isValidField('work_notes')) {
                src.work_notes = note;
                src.update();
            }
        } catch (e) { gs.warn('[NetraTaskRunner] approval note failed: ' + (e.message || e)); }
    },

    /**
     * Set priority for real, and PROVE it stuck.
     *
     * On stock incident, priority is derived: a data lookup recalculates it
     * from impact x urgency and silently stomps direct writes - the update
     * "succeeds", the work note lands, and priority never moves (found out
     * the hard way on this feature's first live fire). So: try the direct
     * write, re-read, and if the lookup stomped it, drive impact+urgency
     * through the standard matrix instead. Always verify, never trust
     * update(). Returns { ok, before:{...} } with the fields it actually
     * changed, for undo.
     */
    setPriority: function (t, target) {
        var MATRIX = { '1': ['1', '1'], '2': ['1', '2'], '3': ['2', '2'], '4': ['2', '3'], '5': ['3', '3'] };
        var before = { priority: String(t.priority), impact: String(t.impact), urgency: String(t.urgency) };
        var sysId = String(t.sys_id), table = t.getTableName();

        t.priority = target;
        t.update();
        var check = new GlideRecord(table);
        check.get(sysId);
        if (String(check.priority) === String(target)) {
            return { ok: true, before: { priority: before.priority }, via: 'direct' };
        }
        var pair = MATRIX[String(target)];
        if (!pair || !t.isValidField('impact') || !t.isValidField('urgency')) {
            return { ok: false, why: 'priority is recalculated on this table and I have no impact/urgency lever' };
        }
        // write the matrix through the caller's record, so a GlideRecordSecure
        // from the widget keeps the user's field-level ACLs on this step too
        t.impact = pair[0];
        t.urgency = pair[1];
        t.update();
        var check2 = new GlideRecord(table);
        check2.get(sysId);
        if (String(check2.priority) === String(target)) {
            return { ok: true, before: { impact: before.impact, urgency: before.urgency }, via: 'matrix' };
        }
        // missed the target: put impact/urgency back, and say whether that held
        var why = 'wrote impact ' + pair[0] + ' urgency ' + pair[1] + ' but priority read back ' + String(check2.priority);
        t.impact = before.impact;
        t.urgency = before.urgency;
        t.priority = before.priority;
        t.update();
        var check3 = new GlideRecord(table);
        check3.get(sysId);
        var now = { priority: String(check3.priority), impact: String(check3.impact), urgency: String(check3.urgency) };
        var restored = now.priority === before.priority && now.impact === before.impact && now.urgency === before.urgency;
        return { ok: false, why: why + (restored ? ', so I put impact and urgency back' : ''), restored: restored, now: now,
                 before: { impact: before.impact, urgency: before.urgency } };
    },

    // ---- undo (called from the widget, addressed by NT number) --------
    undoTask: function (ntNumber, requestingUser) {
        if (!this.writesEnabled()) return { ok: false, error: 'Ticket writes are switched off by the admin, so I can not undo task ' + this._digits(ntNumber) + ' right now.' };
        var gr = new GlideRecord(this.TASK);
        gr.addQuery('nt_number', String(ntNumber).toUpperCase());
        gr.addQuery('user', requestingUser);
        gr.setLimit(1);
        gr.query();
        if (!gr.next()) return { ok: false, error: 'No standing order ' + ntNumber + ' of yours.' };
        var undo;
        try { undo = JSON.parse(String(gr.undo_json || 'null')); } catch (eP) { undo = null; }
        if (!undo || !undo.restore) {
            return { ok: false, error: ntNumber + ' has nothing reversible recorded - its actions were comments or nudges, which I can only follow up with a correcting note.' };
        }
        var t = new GlideRecord(undo.table);
        if (!t.get(undo.sys_id)) return { ok: false, error: 'The record it changed is gone.' };
        // refuse if a human moved priority again after us - never fight a person
        if (undo.target_was && String(t.priority) !== String(undo.target_was)) {
            return { ok: false, error: 'Someone changed it again after me (priority is now ' + String(t.priority) + ') - not touching it. Check it yourself.' };
        }
        var restored = [];
        for (var f in undo.restore) {
            if (!undo.restore.hasOwnProperty(f)) continue;
            t.setValue(f, undo.restore[f]);
            restored.push(f + ' back to ' + undo.restore[f]);
        }
        t.work_notes = 'Standing order ' + String(gr.nt_number) + ' undone by ' + this._name(requestingUser) + ' via Netra: ' + restored.join(', ') + '.';
        t.update();
        var check = new GlideRecord(undo.table);
        check.get(undo.sys_id);
        var backTo = String(check.priority);
        gr.undo_json = '';
        this._log(gr, 'undone: ' + restored.join(', ') + ' (priority now ' + backTo + ')');
        gr.update();
        return { ok: true, restored: restored.join(', ') + ' on ' + String(t.number || undo.sys_id) + ' - priority reads back ' + backTo };
    },

    // ---- plumbing ------------------------------------------------------
    _cadenceOk: function (task, personSysId) {
        var log = this._readLog(task);
        var count = 0, lastMs = 0;
        for (var i = 0; i < log.length; i++) {
            if (log[i].nudged === personSysId) {
                count++;
                if (log[i].at_ms > lastMs) lastMs = log[i].at_ms;
            }
        }
        if (count >= this.NUDGE_MAX_PER_TASK) return false;
        var gapMs = this.NUDGE_MIN_GAP_H * 3600 * 1000;
        return (new GlideDateTime().getNumericValue() - lastMs) >= gapMs;
    },

    _inQuietHours: function () {
        var h = this._localHour();
        return h >= this.QUIET_START || h < this.QUIET_END;
    },

    // getLocalTime() is already shifted to the session timezone; reading it
    // with getHourOfDayLocalTime() would shift it a second time
    _localHour: function () {
        return parseInt(String(new GlideDateTime().getLocalTime().getHourOfDayUTC()), 10);
    },

    _rearm: function (task, minutes) {
        // epoch write: string assignment to a date field is re-interpreted
        // in the session timezone and lands hours off (bit us on day one)
        var next = new GlideDateTime();
        next.addSeconds(60 * minutes);
        task.next_check_at.setDateNumericValue(next.getNumericValue());
    },

    _rearmMorning: function (task) {
        // the hour quiet time ends, not a fixed offset that can land in it again
        var next = new GlideDateTime();
        next.addSeconds(3600 * ((this.QUIET_END - this._localHour() + 24) % 24));
        task.next_check_at.setDateNumericValue(next.getNumericValue());
    },

    _readLog: function (task) {
        try {
            var l = JSON.parse(String(task.action_log || '[]'));
            return Object.prototype.toString.call(l) === '[object Array]' ? l : [];
        } catch (e) { return []; }
    },

    _log: function (task, what, extra) {
        var log = this._readLog(task);
        var entry = { at: new GlideDateTime().toString(), at_ms: new GlideDateTime().getNumericValue(), what: what };
        if (extra) { for (var k in extra) { if (extra.hasOwnProperty(k)) entry[k] = extra[k]; } }
        log.push(entry);
        if (log.length > 40) log = log.slice(-40);
        task.action_log = JSON.stringify(log);
    },

    // changed: what the failed attempt left on the ticket, when it did
    _fail: function (task, why, changed) {
        task.state = 'error';
        this._log(task, 'ERROR: ' + why + (changed ? '. ' + changed : ''));
        task.update();
        this._notify(task, String(task.nt_number) + ' hit a problem and stopped: ' + why + '. ' + (changed || 'Nothing was changed.'));
        gs.warn('[NetraTaskRunner] ' + task.nt_number + ' failed: ' + why);
    },

    _notify: function (task, message) {
        this._notifyUser(String(task.user), String(task.target_number || ''), message);
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

    type: 'NetraTaskRunner'
};
