/**
 * NetraInvestigator - evidence first, theories second. (R18)
 *
 * Pure GlideRecord, no chat model anywhere in here, so the widget, the
 * scanner and the task runner can all call it (the background never gets
 * a text-model call - that is a release rule, not a preference).
 *
 *   resolveAnchor(text)            "INC0010013" / "netra-lab-web01" -> anchor
 *   firstTicketMs(ci, openedMs)    earliest incident on the CI in the 24h up to the anchor
 *   suspectChanges(ci, t0, opts)   scored changes on the CI + 1-hop neighbours (F3)
 *   gatherDossier(anchor, opts)    numbered evidence E1..En + sources ledger (F4)
 *   appendItem(dossier, item)      widget adds its similar-resolved items here
 *   ruleHypotheses(dossier)        deterministic theories, every one cited (F4)
 *   validateHypotheses(h, dossier) the code-side check for model output (F4)
 *   snapshot / diffSnapshot / checkSignals / grade   the away watch (F6)
 *
 * House rules for this file:
 *  - dates are READ with getValue() (utc internal) -> GlideDateTime ->
 *    getNumericValue(), and compared as epoch ms only. nothing here writes a
 *    date field. (string assignment to a date lands hours off - the
 *    NetraTaskRunner day-one lesson)
 *  - base tables (task, cmdb_ci) wherever possible: the cross-scope read
 *    privilege is per table, and every subclass would need its own row
 *  - every source is timed and wrapped: {rows, ms, status ok|empty|blocked|
 *    error|skipped}. a denied read mostly shows up as zero rows, never an
 *    exception, so "no rows" gets a probe before we call it "nothing there"
 *  - wording is correlation only. a change "finished 40 minutes before the
 *    first ticket", it never "caused" anything
 */
var NetraInvestigator = Class.create();
NetraInvestigator.prototype = {
    initialize: function () {
        this.MAX_ITEMS = 25;
        this.RESERVE = 3;            // slots left for the widget's similar-resolved items
        this.H = 3600000;
        this.LOOKBACK_H = 72;
        this.AFTER_H = 1;
        this.TOP_SUSPECTS = 5;
        this.MIN_SCORE = 0.2;
        this.CANDIDATE_CAP = 25;

        this.LINK_W = { direct: 1.0, affected_ci: 0.9, change_task: 0.85, upstream: 0.6, downstream: 0.4 };
        this.LINK_LABEL = { direct: 'direct CI', affected_ci: 'affected CI', change_task: 'change task',
                            upstream: 'upstream dependency', downstream: 'downstream dependant' };
        this.TYPE_W = { emergency: 1.2, normal: 1.0, standard: 0.85 };
        this.RISK_BY_VALUE = { '1': 'very high', '2': 'high', '3': 'moderate', '4': 'low' };
        this.CLOSE_LABEL = { successful: 'closed successful', successful_issues: 'closed successful with issues',
                             unsuccessful: 'closed unsuccessful' };
        // which field gave us the activity time decides the verb - planned
        // dates never get to say "work finished"
        this.TIME_FIELDS = ['work_end', 'work_start', 'closed_at', 'end_date', 'start_date'];
        this.VERB = { work_end: 'work finished', work_start: 'work started', closed_at: 'it was closed',
                      end_date: 'it was scheduled to end', start_date: 'it was scheduled to start' };
        this.VERB_SHORT = { work_end: 'finished', work_start: 'started', closed_at: 'was closed',
                            end_date: 'was scheduled to end', start_date: 'was scheduled to start' };
        // relationship types whose PARENT is the provider. everything else
        // (depends on, runs on, hosted on, uses...) has the child as provider
        this.PROVIDER_FIRST = { 'contains': 1, 'hosts': 1, 'provides': 1, 'powers': 1, 'feeds': 1,
                                'serves': 1, 'manages': 1, 'sends data to': 1, 'impacts': 1 };
        this.AUDIT_FIELDS = ['state', 'priority', 'assignment_group', 'assigned_to', 'cmdb_ci', 'category'];
        this.AUDIT_REF = { assignment_group: 'sys_user_group', assigned_to: 'sys_user', cmdb_ci: 'cmdb_ci' };
        this.INC_STATE = { '1': 'New', '2': 'In Progress', '3': 'On Hold', '6': 'Resolved', '7': 'Closed', '8': 'Canceled' };
        this.PRIORITY = { '1': '1 - Critical', '2': '2 - High', '3': '3 - Moderate', '4': '4 - Low', '5': '5 - Planning' };
        this.SIGNAL_TYPES = { change_backed_out: 1, sibling_resolved_with: 1, new_siblings: 1, ci_status_change: 1, none: 1 };
        this.ORD = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
        this.DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        this.MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        this.ROLLBACK_RE = /roll(?:ed|ing|s)?[\s\-]*back|revert|back(?:ed|ing)?[\s\-]*out|backout|\bund(?:o|id|one)\b/i;
        this.REC_RE = /\b(INC|CHG|PRB|KB|RITM)\d+\b/gi;

        // words that never discriminate between theories. kept on the
        // instance on purpose: NetraKnowledge already owns a global STOP_WORDS
        this.STOP = this._set(('the a an and or of to in on at for with by from is are was were be been being it its ' +
            'this that these those as after before may might could would should can will not no yes which who what ' +
            'when where why how then than rather there here has have had do does did done so but if into onto up ' +
            'down out over under again also just only very more most some any all each other our their them they ' +
            'you your we me my she her he his i about via per while since until still now back off new old ' +
            'ticket tickets incident incidents issue issues problem problems user users resolved resolve resolution ' +
            'fixed fix fixes working work works worked confirmed confirm closed close closing change changes ' +
            'server servers application service services system systems minute minutes hour hours first one two three ' +
            'trouble linked link timing started start finished finish look looks like seem seems same caller team ' +
            'please thanks thank ok okay test note notes update updated per restored restore normal normally ' +
            'apply applied applies ' +
            'what\'s whats going happening happened investigate diagnose tell check before these those').split(' '));
        // lighter list for CI-name candidate tokens: "netra" and "lab" must survive
        this.CI_STOP = this._set(('the a an and or of to in on at for with by from is are was were be it its this that ' +
            'these those what whats what\'s why how going happening happened happen investigate diagnose root cause ' +
            'changed change changes tickets ticket before after any me my tell about check look into up down broke ' +
            'broken hours hour last past since please hey wrong server going on with there here is it\'s its ' +
            'did do does has have had been which who when where you your our can could would should dig digging ' +
            'keep while away doing today yesterday now just').split(' '));
    },

    // =================================================================
    //  anchor resolution
    // =================================================================

    /**
     * text -> {ok, kind:'ticket'|'ci', table, sys_id, number, short_description,
     *          opened_ms, ci_sys_id, ci_name, [ci_class, state, active, no_ci, message]}
     *       | {ok:false, reason:'empty'|'not_found'|'no_match'|'blocked', message, [tried]}
     * a ticket with no CI still comes back ok:true, with no_ci:true - the
     * caller must say so rather than guess the server from the text.
     */
    resolveAnchor: function (text) {
        // the mic appends a prosody tag to the utterance - never match on it
        var raw = String(text || '').replace(/\s*\[voice delivery:[^\]]*\]\s*/gi, ' ').replace(/^\s+|\s+$/g, '');
        if (!raw) return { ok: false, reason: 'empty', message: 'Tell me a ticket number or the exact name of the server.' };

        var m = raw.toUpperCase().match(/\b(INC|CHG|PRB|RITM|REQ|SCTASK)\d{5,}\b/);
        if (m) return this._ticketAnchor(m[0], m[1]);

        var cands = this._ciCandidates(raw);
        if (!cands.length) return { ok: false, reason: 'no_match', message: 'I could not find a ticket number or a server name in that.', tried: [] };
        var best = null, hits = 0;
        try {
            var q = [];
            for (var i = 0; i < cands.length; i++) {
                q.push(cands[i]);
                if (cands[i] !== cands[i].toLowerCase()) q.push(cands[i].toLowerCase());
            }
            var gr = new GlideRecord('cmdb_ci');   // base table on purpose (privilege lives there)
            gr.addQuery('name', 'IN', q.join(','));
            gr.setLimit(10);
            gr.query();
            var lc = {};
            for (var j = 0; j < cands.length; j++) lc[cands[j].toLowerCase()] = 1;
            while (gr.next()) {
                var name = this._str(gr, 'name');
                if (!lc[name.toLowerCase()]) continue;   // IN is collation-dependent - check it ourselves
                hits++;
                if (!best || name.length > best.name.length) {
                    best = { sys_id: this._str(gr, 'sys_id'), name: name, cls: this._str(gr, 'sys_class_name') };
                }
            }
        } catch (e) {
            return { ok: false, reason: 'blocked', message: 'I could not read the CMDB to look that name up (' + this._err(e) + ').' };
        }
        if (!best) {
            return { ok: false, reason: 'no_match', tried: cands.slice(0, 10),
                     message: 'I could not find a ticket number or an exact configuration item name in that. Tell me the ticket number, or the server name exactly as it is in the CMDB.' };
        }
        var out = { ok: true, kind: 'ci', table: 'cmdb_ci', sys_id: best.sys_id, number: '',
                    short_description: best.name, opened_ms: this._nowMs(),
                    ci_sys_id: best.sys_id, ci_name: best.name, ci_class: best.cls };
        if (hits > 1) out.ambiguous = hits;
        return out;
    },

    _ticketAnchor: function (number, prefix) {
        var BY_PREFIX = { INC: 'incident', CHG: 'change_request', PRB: 'problem', RITM: 'sc_req_item',
                          REQ: 'sc_request', SCTASK: 'sc_task' };
        var gr = null, err = '';
        try {
            var t = new GlideRecord('task');
            t.addQuery('number', number);
            t.setLimit(1);
            t.query();
            if (t.next()) gr = t;
        } catch (e) { err = this._err(e); }
        if (!gr && BY_PREFIX[prefix]) {
            // task read refused or odd install - try the concrete table once
            try {
                var c = new GlideRecord(BY_PREFIX[prefix]);
                c.addQuery('number', number);
                c.setLimit(1);
                c.query();
                if (c.next()) gr = c;
            } catch (e2) { err = err || this._err(e2); }
        }
        if (!gr) {
            return { ok: false, reason: err ? 'blocked' : 'not_found', number: number,
                     message: err ? 'I could not read ' + number + ' (' + err + ').' : 'I could not find ' + number + '.' };
        }
        var table = this._str(gr, 'sys_class_name') || BY_PREFIX[prefix] || 'task';
        var ciId = this._str(gr, 'cmdb_ci');
        var ciName = ciId ? this._dv(gr, 'cmdb_ci') : '';
        if (ciId && !ciName) ciName = this._ciName(ciId);
        var out = {
            ok: true, kind: 'ticket', table: table, sys_id: this._str(gr, 'sys_id'), number: this._str(gr, 'number') || number,
            short_description: this._str(gr, 'short_description'),
            opened_ms: this._ms(gr, 'opened_at') || this._ms(gr, 'sys_created_on'),
            ci_sys_id: ciId, ci_name: ciName,
            state: this._dv(gr, 'state'), active: this._bool(gr, 'active')
        };
        if (!ciId) {
            out.no_ci = true;
            out.message = 'this ticket has no configuration item, tell me the server name';
        }
        return out;
    },

    _ciCandidates: function (text) {
        var words = String(text).split(/\s+/), clean = [];
        for (var i = 0; i < words.length; i++) {
            var w = words[i].replace(/^[^A-Za-z0-9]+/, '').replace(/[^A-Za-z0-9]+$/, '').replace(/'s$/i, '');
            if (w) clean.push(w);
        }
        var out = [], seen = {};
        var add = function (s) {
            if (!s || s.indexOf(',') >= 0 || s.indexOf('^') >= 0 || s.length > 100) return;
            var k = s.toLowerCase();
            if (seen[k]) return;
            seen[k] = 1;
            out.push(s);
        };
        add(clean.join(' '));
        for (var n = Math.min(5, clean.length); n >= 1; n--) {
            for (var s = 0; s + n <= clean.length; s++) {
                var first = clean[s].toLowerCase(), last = clean[s + n - 1].toLowerCase();
                if (this.CI_STOP[first] || this.CI_STOP[last]) continue;
                if (n === 1 && (first.length < 3 || /^[A-Za-z]{2,6}\d{5,}$/.test(first))) continue;
                add(clean.slice(s, s + n).join(' '));
            }
        }
        return out.slice(0, 40);
    },

    /**
     * earliest opened_at (ms) among incidents on the CI in the 24h up to
     * and including the anchor. no incidents -> the anchor time itself.
     */
    firstTicketMs: function (ciSysId, anchorOpenedMs) {
        var anchor = (typeof anchorOpenedMs === 'number' && anchorOpenedMs > 0) ? anchorOpenedMs : this._nowMs();
        if (!ciSysId) return anchor;
        var lo = anchor - 24 * this.H, best = null;
        try {
            var gr = new GlideRecord('task');
            gr.addQuery('sys_class_name', 'incident');
            gr.addQuery('cmdb_ci', ciSysId);
            gr.addQuery('opened_at', '>=', this._gdt(lo - 60000));
            gr.addQuery('opened_at', '<=', this._gdt(anchor + 60000));
            gr.orderBy('opened_at');
            gr.setLimit(50);
            gr.query();
            while (gr.next()) {
                var ms = this._ms(gr, 'opened_at');
                if (ms === null || ms < lo || ms > anchor) continue;   // exact window in epoch ms
                if (best === null || ms < best) best = ms;
            }
        } catch (e) {
            gs.warn('[NetraInvestigator] firstTicketMs failed: ' + this._err(e));
        }
        return best === null ? anchor : best;
    },

    // =================================================================
    //  F3 - suspect changes
    // =================================================================

    /**
     * opts = { hours:72, after_hours:1, top:5, min_score:0.2, deadline_at:epochMs,
     *          ticket_count:n, tz_offset_ms:n }
     * -> { ok, ci:{sys_id,name,cls,noun}, t0_ms, ticket_count, candidates,
     *      ci_set:[{sys_id,name,link,rel_type,url}],
     *      suspects:[{number, sys_id, short_description, link, url, delta_minutes,
     *                 activity_ms, time_basis, type, risk, close_code, state, state_value,
     *                 implementing, via_ci:{sys_id,name}, via_task, score, factors,
     *                 sentence, spoken, brief}],
     *      sources:{rel_ci, change_request, task_ci, change_task}, [reason, message] }
     * delta_minutes > 0 means before t0, < 0 after it.
     */
    suspectChanges: function (ciSysId, t0Ms, opts) {
        opts = opts || {};
        var self = this;
        ciSysId = this._safeId(ciSysId);
        var nowMs = this._nowMs();
        var t0 = (typeof t0Ms === 'number' && t0Ms > 0) ? t0Ms : nowMs;
        var hours = Math.max(1, Math.min(168, parseInt(opts.hours, 10) || this.LOOKBACK_H));
        var afterH = (typeof opts.after_hours === 'number') ? opts.after_hours : this.AFTER_H;
        var top = parseInt(opts.top, 10) || this.TOP_SUSPECTS;
        var minScore = (typeof opts.min_score === 'number') ? opts.min_score : this.MIN_SCORE;
        var deadlineAt = opts.deadline_at || 0;
        this._tzFixed = (typeof opts.tz_offset_ms === 'number') ? opts.tz_offset_ms : null;

        var res = { ok: true, ci: null, t0_ms: t0, window_hours: hours, ticket_count: null, candidates: 0, ci_set: [],
                    suspects: [], sources: {} };
        var names = ['rel_ci', 'change_request', 'task_ci', 'change_task'];
        if (!ciSysId) {
            for (var n0 = 0; n0 < names.length; n0++) res.sources[names[n0]] = { rows: 0, ms: 0, status: 'skipped', note: 'no CI' };
            res.ok = false;
            res.reason = 'no_ci';
            res.message = 'this ticket has no configuration item, tell me the server name';
            return res;
        }

        var ci = this._ciRecord(ciSysId);
        if (!ci.ok) {
            for (var n1 = 0; n1 < names.length; n1++) res.sources[names[n1]] = { rows: 0, ms: 0, status: 'skipped', note: 'CI unreadable' };
            res.ok = false;
            res.reason = ci.blocked ? 'ci_unreadable' : 'ci_not_found';
            res.message = ci.blocked ? 'I could not read that configuration item.' : 'That configuration item no longer exists.';
            return res;
        }
        res.ci = { sys_id: ciSysId, name: ci.name, cls: ci.cls, noun: this._noun(ci.cls) };

        // 1. the CI set: target + 1-hop neighbours, with direction
        var set = this._ciSet(ciSysId, ci.name, res.sources, deadlineAt);
        res.ci_set = set.list;

        var lo = this._gdt(t0 - hours * this.H);
        var pool = {};   // change sys_id -> best candidate
        var consider = function (chg, link, viaId, viaTaskNum, timeOverride) {
            var c = self._scoreCandidate(chg, link, t0, hours, afterH, timeOverride);
            if (!c) return;
            var via = set.byId[viaId] || set.byId[ciSysId];
            c.via_ci = { sys_id: via.sys_id, name: via.name };
            c.via_task = viaTaskNum || '';
            var prev = pool[c.sys_id];
            if (!prev || c.score > prev.score) pool[c.sys_id] = c;
        };
        var linkFor = function (viaId, targetLink) {
            var v = set.byId[viaId];
            if (!v || v.link === 'direct') return targetLink;
            return v.link;   // on a neighbour, the mechanism doesn't matter - it is upstream/downstream
        };

        // 2a. change_request.cmdb_ci IN set
        this._run(res.sources, 'change_request', 'change_request', deadlineAt, function (src) {
            var gr = new GlideRecord('change_request');
            gr.addQuery('cmdb_ci', 'IN', set.ids.join(','));
            self._changeWindow(gr, lo);
            gr.orderByDesc('sys_updated_on');
            gr.setLimit(40);
            gr.query();
            while (gr.next()) {
                src.rows++;
                var chg = self._readChange(gr);
                consider(chg, linkFor(chg.cmdb_ci, 'direct'), chg.cmdb_ci, '', null);
            }
        });

        // 2b. task_ci.ci_item IN set, only where the task is a change
        this._run(res.sources, 'task_ci', 'task_ci', deadlineAt, function (src) {
            var rows = self._taskCiRows(set.ids, true);
            if (!rows.length) rows = self._taskCiRows(set.ids, false);   // dot-walk refused -> post-filter instead
            src.rows = rows.length;
            if (!rows.length) return;
            var byTask = {}, taskIds = [];
            for (var i = 0; i < rows.length; i++) {
                if (!byTask[rows[i].task]) { byTask[rows[i].task] = []; taskIds.push(rows[i].task); }
                byTask[rows[i].task].push(rows[i].ci);
            }
            var gr = new GlideRecord('change_request');   // only changes come back, whatever task_ci held
            gr.addQuery('sys_id', 'IN', taskIds.slice(0, 60).join(','));
            self._changeWindow(gr, lo);
            gr.setLimit(40);
            gr.query();
            while (gr.next()) {
                var chg = self._readChange(gr);
                var cis = byTask[chg.sys_id] || [];
                for (var k = 0; k < cis.length; k++) consider(chg, linkFor(cis[k], 'affected_ci'), cis[k], '', null);
            }
        });

        // 2c. change_task.cmdb_ci IN set, mapped to the parent change. the
        // task's own actual times win when it has them - that is when
        // someone actually touched this CI
        this._run(res.sources, 'change_task', 'change_task', deadlineAt, function (src) {
            var gr = new GlideRecord('change_task');
            gr.addQuery('cmdb_ci', 'IN', set.ids.join(','));
            var qc = gr.addQuery('sys_updated_on', '>=', lo);
            qc.addOrCondition('active', true);
            gr.orderByDesc('sys_updated_on');
            gr.setLimit(40);
            gr.query();
            var byParent = {}, parents = [];
            while (gr.next()) {
                src.rows++;
                var p = self._str(gr, 'change_request');
                if (!p) continue;
                var tt = self._activity(gr, ['work_end', 'work_start', 'closed_at']);
                if (!byParent[p]) { byParent[p] = []; parents.push(p); }
                byParent[p].push({ ci: self._str(gr, 'cmdb_ci'), number: self._str(gr, 'number'), time: tt });
            }
            if (!parents.length) return;
            var cr = new GlideRecord('change_request');
            cr.addQuery('sys_id', 'IN', parents.join(','));
            cr.setLimit(40);
            cr.query();
            while (cr.next()) {
                var chg = self._readChange(cr);
                var tasks = byParent[chg.sys_id] || [];
                for (var k = 0; k < tasks.length; k++) {
                    consider(chg, linkFor(tasks[k].ci, 'change_task'), tasks[k].ci, tasks[k].number,
                             tasks[k].time.ms !== null ? tasks[k].time : null);
                }
            }
        });

        // 3. dedupe (done in the pool), cap, score filter, top N
        var all = [];
        for (var id in pool) { if (pool.hasOwnProperty(id)) all.push(pool[id]); }
        all.sort(function (a, b) { return (b.score - a.score) || ((a.abs_delta || 0) - (b.abs_delta || 0)); });
        all = all.slice(0, this.CANDIDATE_CAP);
        res.candidates = all.length;

        res.ticket_count = (typeof opts.ticket_count === 'number') ? opts.ticket_count : this._ticketCount(ciSysId, t0, nowMs);
        var ctx = { ci_name: ci.name, noun: res.ci.noun, ticket_count: res.ticket_count, t0_ms: t0, now_ms: nowMs,
                    t0_is_now: Math.abs(nowMs - t0) < 120000 };
        for (var i = 0; i < all.length && res.suspects.length < top; i++) {
            var s = all[i];
            if (s.score < minScore - 1e-9) continue;
            delete s.abs_delta;
            s.url = '/change_request.do?sys_id=' + s.sys_id;
            s.sentence = this._suspectSentence(s, ctx);
            s.brief = this._suspectBrief(s, ctx, false);
            s.spoken = this._shortRef(s.number) + (s.short_description ? ', ' + s.short_description + ',' : '') + ' ' +
                       this._suspectBrief(s, ctx, true);
            res.suspects.push(s);
        }
        return res;
    },

    /** convenience for the fast lane / tool: text in, suspects out, honest when there's no CI */
    suspectChangesFor: function (text, opts) {
        var a = (text && typeof text === 'object') ? text : this.resolveAnchor(text);
        if (!a.ok) return { ok: false, reason: a.reason, message: a.message, anchor: a, suspects: [], sources: {} };
        if (!a.ci_sys_id) {
            return { ok: false, reason: 'no_ci', anchor: a, suspects: [], sources: {},
                     message: 'this ticket has no configuration item, tell me the server name' };
        }
        var t0 = this.firstTicketMs(a.ci_sys_id, a.kind === 'ticket' ? a.opened_ms : this._nowMs());
        var r = this.suspectChanges(a.ci_sys_id, t0, opts);
        r.anchor = a;
        return r;
    },

    /**
     * deterministic spoken summary of a suspectChanges result (0 calls).
     * uses the R8.2 short form "the change ending 0 4 2"; opts.stress wraps
     * the refs in ** for the TTS.
     */
    describeSuspects: function (r, opts) {
        opts = opts || {};
        var st = opts.stress ? '**' : '';
        if (!r) return 'I could not check for changes.';
        if (!r.ok) return r.message || 'I could not check for changes.';
        var ci = r.ci ? r.ci.name : 'that configuration item';
        var gaps = this._gapNames(r.sources, { rel_ci: 'relationships', change_request: 'change requests',
                                               task_ci: 'affected-CI lists', change_task: 'change tasks' });
        var nb = Math.max(0, (r.ci_set || []).length - 1);
        var scope = ci + (nb ? ' or the ' + this._num(nb) + ' thing' + (nb === 1 ? '' : 's') + ' it is linked to' : '');
        if (!r.suspects.length) {
            if (gaps.length) return 'I found no changes on ' + scope + ', but I could not read the ' + this._list(gaps) +
                                    ', so I cannot rule changes out.';
            var hrs = r.window_hours || this.LOOKBACK_H;
            return 'Nothing changed on ' + scope + (r.ticket_count ? ' in the ' + hrs + ' hours before the first ticket.' : ' in the last ' + hrs + ' hours.');
        }
        var s0 = r.suspects[0];
        var out = 'I found ' + this._num(r.suspects.length) + ' change' + (r.suspects.length === 1 ? '' : 's') +
                  ' near the trouble on ' + ci + '. Closest: ' + st + this._shortRef(s0.number) + st +
                  (s0.short_description ? ', ' + s0.short_description + ',' : '') + ' ' + this._suspectBrief(s0, { noun: r.ci.noun, ticket_count: r.ticket_count }, true) + '.';
        if (r.suspects.length > 1) {
            var s1 = r.suspects[1];
            out += ' Next: ' + st + this._shortRef(s1.number) + st + ', ' + this._suspectBrief(s1, { noun: r.ci.noun, ticket_count: r.ticket_count }, true) + '.';
        }
        out += ' That is timing, not proof.';
        if (gaps.length) out += ' I could not read the ' + this._list(gaps) + ', so there may be more.';
        return out;
    },

    _scoreCandidate: function (chg, link, t0, hours, afterH, timeOverride) {
        var t = timeOverride || { ms: chg.activity_ms, field: chg.time_basis };
        // a cancelled change that never started did nothing to anyone
        if (chg.state_value === '4' && !chg.started) return null;
        var tf = this._timeFactor(t.ms, t0, chg.implementing, hours, afterH);
        if (!tf.in_window) return null;
        var lw = this.LINK_W[link] || 0.4;
        var yw = this.TYPE_W[chg.type] || 1.0;
        var rw = (chg.risk === 'high' || chg.risk === 'very high') ? 1.15 : (chg.risk === 'low' ? 0.9 : 1.0);
        var ow = (chg.close_code === 'unsuccessful' || chg.close_code === 'successful_issues') ? 1.3 : 1.0;
        var score = lw * tf.f * yw * rw * ow;
        var delta = t.ms === null ? null : Math.round((t0 - t.ms) / 60000);
        return {
            number: chg.number, sys_id: chg.sys_id, short_description: chg.short_description,
            link: link, delta_minutes: delta, activity_ms: t.ms, time_basis: t.field,
            type: chg.type, risk: chg.risk, close_code: chg.close_code, state: chg.state, state_value: chg.state_value,
            implementing: chg.implementing,
            score: Math.round(score * 1000) / 1000,
            factors: { link: lw, time: tf.f, type: yw, risk: rw, outcome: ow },
            abs_delta: delta === null ? 0 : Math.abs(delta)
        };
    },

    _timeFactor: function (actMs, t0, implementing, hours, afterH) {
        var H = this.H;
        if (actMs === null || actMs === undefined) return implementing ? { f: 0.7, in_window: true } : { f: 0, in_window: false };
        var d = t0 - actMs;
        if (d >= 0) {
            if (d > hours * H) return implementing ? { f: 0.25, in_window: true } : { f: 0, in_window: false };
            if (d <= 2 * H) return { f: 1.0, in_window: true };
            if (d <= 6 * H) return { f: 0.8, in_window: true };
            if (d <= 24 * H) return { f: 0.5, in_window: true };
            return { f: 0.25, in_window: true };
        }
        if (implementing) return { f: 0.7, in_window: true };
        if (-d > afterH * H) return { f: 0, in_window: false };
        return { f: 0.2, in_window: true };
    },

    _changeWindow: function (gr, lo) {
        // anything with a date in the window, or still in Implement. the
        // upper bound and the "first non-empty field" rule are applied in
        // code, in epoch ms
        var qc = gr.addQuery('work_end', '>=', lo);
        qc.addOrCondition('work_start', '>=', lo);
        qc.addOrCondition('closed_at', '>=', lo);
        qc.addOrCondition('end_date', '>=', lo);
        qc.addOrCondition('start_date', '>=', lo);
        qc.addOrCondition('state', '-1');
    },

    _readChange: function (gr) {
        var act = this._activity(gr, this.TIME_FIELDS);
        var riskV = this._str(gr, 'risk');
        var risk = this._dv(gr, 'risk').toLowerCase() || this.RISK_BY_VALUE[riskV] || '';
        if (risk === 'none') risk = '';
        var state = this._str(gr, 'state');
        return {
            sys_id: this._str(gr, 'sys_id'), number: this._str(gr, 'number'),
            short_description: this._str(gr, 'short_description'),
            type: this._str(gr, 'type').toLowerCase(), risk: risk,
            close_code: this._str(gr, 'close_code').toLowerCase(),
            state: this._dv(gr, 'state') || state, state_value: state,
            implementing: state === '-1',
            started: !!(this._str(gr, 'work_start') || this._str(gr, 'work_end')),
            cmdb_ci: this._str(gr, 'cmdb_ci'),
            activity_ms: act.ms, time_basis: act.field
        };
    },

    _activity: function (gr, fields) {
        for (var i = 0; i < fields.length; i++) {
            var ms = this._ms(gr, fields[i]);
            if (ms !== null) return { ms: ms, field: fields[i] };
        }
        return { ms: null, field: '' };
    },

    _taskCiRows: function (ids, onlyChanges) {
        var out = [];
        var tc = new GlideRecord('task_ci');
        tc.addQuery('ci_item', 'IN', ids.join(','));
        if (onlyChanges) {
            try { tc.addQuery('task.sys_class_name', 'change_request'); } catch (eDw) { return out; }
        }
        tc.orderByDesc('sys_created_on');
        tc.setLimit(60);
        try { tc.query(); } catch (eQ) { if (onlyChanges) return out; throw eQ; }
        while (tc.next()) {
            var t = this._str(tc, 'task'), c = this._str(tc, 'ci_item');
            if (t && c) out.push({ task: t, ci: c });
        }
        return out;
    },

    _ciSet: function (ciId, ciName, ledger, deadlineAt) {
        var self = this;
        var set = { ids: [ciId], byId: {}, list: [] };
        set.byId[ciId] = { sys_id: ciId, name: ciName, link: 'direct', rel_type: '', url: '/cmdb_ci.do?sys_id=' + ciId };
        set.list.push(set.byId[ciId]);
        this._run(ledger, 'rel_ci', 'cmdb_rel_ci', deadlineAt, function (src) {
            var r = new GlideRecord('cmdb_rel_ci');
            r.addEncodedQuery('parent=' + ciId + '^ORchild=' + ciId);
            r.setLimit(15);
            r.query();
            while (r.next()) {
                src.rows++;
                var p = self._str(r, 'parent'), c = self._str(r, 'child');
                var isParent = (p === ciId);
                var other = isParent ? c : p;
                if (!other || other === ciId) continue;
                var relType = self._dv(r, 'type');
                var desc = relType.split('::')[0].toLowerCase().replace(/^\s+|\s+$/g, '');
                var pf = self.PROVIDER_FIRST[desc] === 1;
                // "A depends on B" with A as parent: B is upstream of A
                var link = isParent ? (pf ? 'downstream' : 'upstream') : (pf ? 'upstream' : 'downstream');
                var prev = set.byId[other];
                if (prev) {
                    if (prev.link === 'downstream' && link === 'upstream') { prev.link = 'upstream'; prev.rel_type = relType; }
                    continue;
                }
                var nm = self._dv(r, isParent ? 'child' : 'parent') || self._ciName(other) || 'a linked CI';
                set.byId[other] = { sys_id: other, name: nm, link: link, rel_type: relType, url: '/cmdb_ci.do?sys_id=' + other };
                set.ids.push(other);
                set.list.push(set.byId[other]);
            }
        });
        return set;
    },

    _ticketCount: function (ciId, t0, nowMs) {
        try {
            var gr = new GlideRecord('task');
            gr.addQuery('sys_class_name', 'incident');
            gr.addQuery('cmdb_ci', ciId);
            gr.addQuery('opened_at', '>=', this._gdt(t0 - 60000));
            gr.setLimit(50);
            gr.query();
            var n = 0;
            while (gr.next()) {
                var ms = this._ms(gr, 'opened_at');
                if (ms !== null && ms >= t0 - 1000 && ms <= nowMs + 60000) n++;
            }
            return n;
        } catch (e) { return null; }
    },

    _suspectSentence: function (s, ctx) {
        var where = (s.via_ci && s.via_ci.name) || ctx.ci_name || 'the CI';
        var head = s.number + (s.short_description ? " '" + s.short_description + "'" : '') + ': ';
        var body;
        if (s.activity_ms === null) {
            body = 'it is still being implemented on ' + where;
        } else {
            body = (this.VERB[s.time_basis] || 'activity') + ' on ' + where + ' ' + this._when(s.activity_ms, ctx.now_ms) +
                   ', ' + this._relToT0(s.delta_minutes, ctx);
        }
        var tags = [];
        var lbl = this.LINK_LABEL[s.link] || s.link;
        if (s.link === 'change_task' && s.via_task) lbl += ' ' + s.via_task;
        if (s.link === 'upstream') lbl = 'upstream of ' + ctx.ci_name;
        if (s.link === 'downstream') lbl = 'depends on ' + ctx.ci_name;
        tags.push(lbl);
        tags.push((s.type ? s.type + ' ' : '') + 'change');
        if (s.risk) tags.push(s.risk + ' risk');
        if (this.CLOSE_LABEL[s.close_code]) tags.push(this.CLOSE_LABEL[s.close_code]);
        if (s.implementing) tags.push('still implementing');
        return head + body + ' (' + tags.join(', ') + ')';
    },

    // "finished on that server 40 minutes before the first ticket" - no
    // clock time, so it reads the same whenever it is spoken
    _suspectBrief: function (s, ctx, spoken) {
        var noun = ctx.noun || 'CI';
        var viaName = (s.via_ci && s.via_ci.name) || ctx.ci_name || 'it';
        var where;
        if (s.link === 'upstream') where = 'on ' + viaName + ', which that ' + noun + ' depends on,';
        else if (s.link === 'downstream') where = 'on ' + viaName + ', which depends on that ' + noun + ',';
        else where = spoken ? 'on that ' + noun : 'on ' + viaName;
        if (s.activity_ms === null) return 'is still being implemented ' + where.replace(/,$/, '');
        var verb = spoken ? (this.VERB_SHORT[s.time_basis] || 'happened') : (this.VERB[s.time_basis] || 'activity');
        var ref = (ctx.ticket_count === 1) ? 'the ticket' : 'the first ticket';
        var d = s.delta_minutes;
        var rel = d >= 0 ? this._span(d) + ' before ' + ref : this._span(-d) + ' after ' + ref;
        var tail = s.implementing ? ', and it is still in progress' : '';
        return verb + ' ' + where + ' ' + rel + tail;
    },

    _relToT0: function (d, ctx) {
        var noun = ctx.noun || 'CI';
        var ref;
        if (ctx.ticket_count >= 2) ref = 'the first of ' + ctx.ticket_count + ' tickets on that ' + noun;
        else if (ctx.ticket_count === 1) ref = 'the ticket on that ' + noun;
        else if (ctx.ticket_count === 0 && ctx.t0_is_now) return d >= 0 ? this._span(d) + ' ago' : 'in ' + this._span(-d);
        else if (ctx.ticket_count === 0) ref = 'the time in question';
        else ref = 'the first ticket on that ' + noun;
        return d >= 0 ? this._span(d) + ' before ' + ref : this._span(-d) + ' after ' + ref;
    },

    // =================================================================
    //  F4 - the dossier
    // =================================================================

    /**
     * anchor = a resolveAnchor() result (or the raw text).
     * opts = { deadlineMs:6000, reserve:3, tz_offset_ms:n }
     * -> { anchor, t0_ms, items:[{id,kind,ref,at_ms,text,weight,...}], suspects, ci_set,
     *      sources:{journal,audit,ci,changes,siblings,problem,neighbours,kb}, facts,
     *      missing:[string], thin, fingerprint, gathered_ms, elapsed_ms, dropped }
     * the fingerprint covers what this gathered, NOT the similar items the
     * widget appends afterwards - so the cache can be checked before
     * spending any embedding quota.
     */
    gatherDossier: function (anchor, opts) {
        opts = opts || {};
        var self = this;
        var start = this._clock();
        var deadlineAt = start + (parseInt(opts.deadlineMs, 10) || 6000);
        this._tzFixed = (typeof opts.tz_offset_ms === 'number') ? opts.tz_offset_ms : null;
        if (!anchor || typeof anchor === 'string') anchor = this.resolveAnchor(anchor || '');
        var nowMs = this._nowMs();
        var d = { anchor: anchor, t0_ms: null, items: [], suspects: [], ci_set: [], sources: {}, facts: {},
                  missing: [], thin: false, fingerprint: '', gathered_ms: nowMs, elapsed_ms: 0, dropped: 0 };
        if (!anchor || !anchor.ok) {
            d.thin = true;
            d.missing.push('a ticket number or the exact name of the configuration item');
            d.fingerprint = this._hash('none|' + (anchor && anchor.message || ''));
            return d;
        }

        var isTicket = anchor.kind === 'ticket';
        var ciId = anchor.ci_sys_id || '';
        var ciName = anchor.ci_name || '';
        var cands = [];
        var add = function (group, prio, kind, ref, atMs, text, weight, extra) {
            var it = { kind: kind, ref: ref || '', at_ms: (typeof atMs === 'number') ? atMs : null,
                       text: self._cut(text, 200), weight: weight, _g: group, _p: prio, _i: cands.length };
            if (extra) { for (var k in extra) { if (extra.hasOwnProperty(k)) it[k] = extra[k]; } }
            cands.push(it);
            return it;
        };

        d.t0_ms = ciId ? this.firstTicketMs(ciId, isTicket ? anchor.opened_ms : nowMs) : (anchor.opened_ms || nowMs);
        var t0 = d.t0_ms;
        var f = d.facts;
        f.ci_name = ciName;
        f.noun = 'CI';

        // ---- ticket core (the anchor itself - not a ledger source) ----
        var core = null, coreRec = null;
        if (isTicket) {
            try {
                coreRec = new GlideRecord(anchor.table || 'task');
                if (!coreRec.get(anchor.sys_id)) coreRec = null;
            } catch (eC) { coreRec = null; }
            if (coreRec) {
                var assignee = this._dv(coreRec, 'assigned_to');
                var group = this._dv(coreRec, 'assignment_group');
                var active = this._bool(coreRec, 'active');
                var opened = anchor.opened_ms;
                f.state = this._dv(coreRec, 'state');
                f.active = active;
                f.mod_count = parseInt(this._str(coreRec, 'sys_mod_count'), 10) || 0;
                f.reassignments = parseInt(this._str(coreRec, 'reassignment_count'), 10) || 0;
                f.unassigned_hours = (!assignee && active && opened) ? Math.floor((nowMs - opened) / this.H) : 0;
                f.awaiting_caller = (anchor.table === 'incident' && this._str(coreRec, 'state') === '3' &&
                                     this._str(coreRec, 'hold_reason') === '1');
                f.problem_id = coreRec.isValidField('problem_id') ? this._str(coreRec, 'problem_id') : '';
                var txt = anchor.number + " '" + anchor.short_description + "'" + (opened ? ', opened ' + this._when(opened, nowMs) : '') +
                          ', ' + (f.state || 'state unknown') +
                          ', priority ' + (this._dv(coreRec, 'priority') || '?') +
                          ', ' + (assignee ? 'assigned to ' + assignee : 'unassigned') + (group ? ' (' + group + ')' : '') +
                          (ciName ? ', CI ' + ciName : ', no CI set') +
                          (f.awaiting_caller ? ', on hold awaiting caller' : '');
                core = add(1, 0, 'ticket', anchor.number, opened, txt, 'medium', { sys_id: anchor.sys_id });
            } else {
                d.missing.push('the ticket record itself (could not re-read ' + anchor.number + ')');
            }
        }

        // ---- CI record ----
        if (ciId) {
            this._run(d.sources, 'ci', null, deadlineAt, function (src) {
                var c = new GlideRecord('cmdb_ci');
                c.addQuery('sys_id', ciId);
                c.setLimit(1);
                c.query();
                if (!c.next()) {
                    if (self._canSeeAny('cmdb_ci')) { src.note = 'the CI record is gone'; return; }
                    src.status = 'blocked';
                    src.note = 'could not read ' + (ciName || 'the CI');
                    return;
                }
                src.rows = 1;
                var op = self._str(c, 'operational_status'), inst = self._str(c, 'install_status');
                var cls = self._str(c, 'sys_class_name');
                var info = {
                    sys_id: ciId, name: self._str(c, 'name') || ciName, cls: cls, cls_label: self._dv(c, 'sys_class_name') || cls,
                    op: op, op_label: self._dv(c, 'operational_status') || op,
                    install: inst, install_label: self._dv(c, 'install_status') || inst,
                    support_group: self._dv(c, 'support_group'), used_for: self._dv(c, 'used_for')
                };
                // non-operational, repair in progress, retired / in maintenance, pending repair, retired, absent
                info.not_operational = (op === '2' || op === '3' || op === '6' ||
                                        inst === '3' || inst === '5' || inst === '7' || inst === '100');
                f.ci = info;
                f.ci_name = ciName = info.name;
                f.noun = self._noun(cls);
                var t = info.name + ' (' + info.cls_label + '): operational status ' + (info.op_label || 'not set') +
                        ', install status ' + (info.install_label || 'not set') +
                        (info.support_group ? ', support group ' + info.support_group : '') +
                        (info.used_for ? ', used for ' + info.used_for : '');
                info.item = add(3, 2, 'ci', info.name, null, t, info.not_operational ? 'strong' : 'medium', { sys_id: ciId });
            });
        } else {
            d.sources.ci = { rows: 0, ms: 0, status: 'skipped', note: 'no CI on the ticket' };
            d.missing.push('the configuration item - set the CI so I can check changes, neighbours and other tickets on it');
        }

        // ---- suspect changes (F3) ----
        if (ciId) {
            var cStart = this._clock();
            var sc = null;
            if (this._clock() > deadlineAt) {
                d.sources.changes = { rows: 0, ms: 0, status: 'skipped', note: 'out of time' };
            } else {
                try {
                    sc = this.suspectChanges(ciId, t0, { deadline_at: deadlineAt, tz_offset_ms: this._tzFixed });
                } catch (eS) {
                    d.sources.changes = { rows: 0, ms: this._clock() - cStart, status: 'error', note: this._err(eS) };
                }
            }
            if (sc) {
                d.suspects = sc.suspects || [];
                d.ci_set = sc.ci_set || [];
                f.ticket_count = sc.ticket_count;
                var worst = this._worst(sc.sources);
                var gaps = this._gapNames(sc.sources, { rel_ci: 'relationships', change_request: 'change requests',
                                                        task_ci: 'affected-CI lists', change_task: 'change tasks' });
                d.sources.changes = { rows: sc.candidates, ms: this._clock() - cStart,
                                      status: sc.candidates > 0 ? 'ok' : (worst === 'ok' ? 'empty' : worst),
                                      detail: sc.sources };
                if (gaps.length) d.sources.changes.note = 'could not read the ' + this._list(gaps);
                for (var si = 0; si < d.suspects.length; si++) {
                    var s = d.suspects[si];
                    var w = s.score >= 0.7 ? 'strong' : (s.score >= 0.4 ? 'medium' : 'weak');
                    s.item = add(2, 1 + si * 0.01, 'change', s.number, s.activity_ms, s.sentence, w,
                                 { sys_id: s.sys_id, score: s.score, link: s.link });
                }
            }
        } else {
            d.sources.changes = { rows: 0, ms: 0, status: 'skipped', note: 'no CI' };
        }

        // ---- siblings: other open incidents on the CI ----
        f.siblings = [];
        f.cluster = 0;
        if (ciId) {
            this._run(d.sources, 'siblings', 'task', deadlineAt, function (src) {
                var g = new GlideRecord('task');
                g.addQuery('sys_class_name', 'incident');
                g.addQuery('cmdb_ci', ciId);
                g.addQuery('active', true);
                g.orderBy('opened_at');
                g.setLimit(30);
                g.query();
                var anchorIn = false;
                while (g.next()) {
                    var sid = self._str(g, 'sys_id');
                    if (sid === anchor.sys_id) { anchorIn = true; continue; }
                    src.rows++;
                    f.siblings.push({ number: self._str(g, 'number'), sys_id: sid,
                                      short_description: self._cut(self._str(g, 'short_description'), 80),
                                      opened_ms: self._ms(g, 'opened_at') });
                }
                // cluster = tickets on the CI opened inside [t0, t0+2h], the
                // anchor included - same "3 on one CI" bar the scanner uses
                var cl = (anchorIn && anchor.opened_ms !== null && anchor.opened_ms <= t0 + 2 * self.H) ? 1 : 0, nums = [];
                for (var i = 0; i < f.siblings.length; i++) {
                    var om = f.siblings[i].opened_ms;
                    if (om !== null && om >= t0 - 1000 && om <= t0 + 2 * self.H) cl++;
                    if (nums.length < 6) nums.push(f.siblings[i].number);
                }
                f.cluster = cl;
                if (!f.siblings.length) return;
                var span = '';
                var fo = f.siblings[0].opened_ms, lo2 = f.siblings[f.siblings.length - 1].opened_ms;
                if (fo !== null && lo2 !== null) span = ', opened between ' + self._hhmm(fo) + ' and ' + self._hhmm(lo2);
                var t = f.siblings.length + ' other open ticket' + (f.siblings.length === 1 ? '' : 's') + ' on ' + ciName + ': ' +
                        nums.join(', ') + (f.siblings.length > nums.length ? ' and more' : '') + span +
                        (cl >= 3 ? '; ' + cl + ' tickets within 2 hours of the first' : '');
                f.siblings_item = add(5, 4, 'siblings', f.siblings[0].number, fo, t, cl >= 3 ? 'strong' : 'medium',
                                      { refs: nums, count: f.siblings.length, cluster: cl });
            });
        } else {
            d.sources.siblings = { rows: 0, ms: 0, status: 'skipped', note: 'no CI' };
        }

        // ---- problem: the ticket's own problem link, then open problems on the CI ----
        f.problems = [];
        if (ciId || f.problem_id) {
            this._run(d.sources, 'problem', 'task', deadlineAt, function (src) {
                var seen = {};
                var take = function (g, linked) {
                    var sid = self._str(g, 'sys_id');
                    if (seen[sid]) return;
                    seen[sid] = 1;
                    src.rows++;
                    var p = { number: self._str(g, 'number'), sys_id: sid, short_description: self._cut(self._str(g, 'short_description'), 100),
                              state: self._dv(g, 'state'), linked: linked };
                    var t = p.number + " '" + p.short_description + "' " + (linked ? 'is linked to ' + anchor.number : 'is open on ' + ciName) +
                            (p.state ? ' (' + p.state + ')' : '');
                    p.item = add(4, 3, 'problem', p.number, self._ms(g, 'opened_at'), t, linked ? 'strong' : 'medium', { sys_id: sid });
                    f.problems.push(p);
                };
                if (f.problem_id) {
                    var pl = new GlideRecord('task');
                    pl.addQuery('sys_id', f.problem_id);
                    pl.setLimit(1);
                    pl.query();
                    if (pl.next()) take(pl, true);
                }
                if (ciId) {
                    var pg = new GlideRecord('task');
                    pg.addQuery('sys_class_name', 'problem');
                    pg.addQuery('cmdb_ci', ciId);
                    pg.addQuery('active', true);
                    pg.orderByDesc('opened_at');
                    pg.setLimit(5);
                    pg.query();
                    while (pg.next()) take(pg, false);
                }
            });
        } else {
            d.sources.problem = { rows: 0, ms: 0, status: 'skipped', note: 'no CI and no problem link' };
        }

        // ---- neighbours: 1-hop CIs and their tickets around t0 ----
        f.neighbours = [];
        var nbs = [];
        for (var ni = 0; ni < d.ci_set.length; ni++) { if (d.ci_set[ni].link !== 'direct') nbs.push(d.ci_set[ni]); }
        if (!nbs.length) {
            // no neighbours is only "empty" if we could actually read the relationships
            var relSt = (d.sources.changes && d.sources.changes.detail && d.sources.changes.detail.rel_ci) ?
                        d.sources.changes.detail.rel_ci.status : 'skipped';
            if (!ciId) d.sources.neighbours = { rows: 0, ms: 0, status: 'skipped', note: 'no CI' };
            else if (relSt === 'blocked' || relSt === 'error' || relSt === 'skipped') {
                d.sources.neighbours = { rows: 0, ms: 0, status: relSt, note: "couldn't read the CI's relationships" };
            } else d.sources.neighbours = { rows: 0, ms: 0, status: 'empty', note: 'no 1-hop neighbours' };
        } else {
            this._run(d.sources, 'neighbours', 'task', deadlineAt, function (src) {
                var ids = [], by = {};
                for (var i = 0; i < nbs.length; i++) {
                    ids.push(nbs[i].sys_id);
                    by[nbs[i].sys_id] = { sys_id: nbs[i].sys_id, name: nbs[i].name, link: nbs[i].link, rel_type: nbs[i].rel_type,
                                          open: 0, before: 0, first_ms: null, first_number: '', first_sd: '', numbers: [] };
                }
                var g = new GlideRecord('task');
                g.addQuery('sys_class_name', 'incident');
                g.addQuery('cmdb_ci', 'IN', ids.join(','));
                var qc = g.addQuery('active', true);
                qc.addOrCondition('opened_at', '>=', self._gdt(t0 - 24 * self.H));
                g.orderBy('opened_at');
                g.setLimit(100);
                g.query();
                while (g.next()) {
                    src.rows++;
                    var nb = by[self._str(g, 'cmdb_ci')];
                    if (!nb) continue;
                    var om = self._ms(g, 'opened_at');
                    if (self._bool(g, 'active')) nb.open++;
                    if (om !== null && om < t0 && om >= t0 - 24 * self.H) {
                        nb.before++;
                        if (nb.first_ms === null || om < nb.first_ms) {
                            nb.first_ms = om; nb.first_number = self._str(g, 'number');
                            nb.first_sd = self._cut(self._str(g, 'short_description'), 80);
                        }
                    }
                    if (nb.numbers.length < 3) nb.numbers.push(self._str(g, 'number'));
                }
                var quiet = [];
                for (var j = 0; j < nbs.length; j++) {
                    var n = by[nbs[j].sys_id];
                    f.neighbours.push(n);
                    if (!n.open && !n.before) { quiet.push(n.name + ' (' + n.link + ')'); continue; }
                    var dir = n.link === 'upstream' ? ', which ' + ciName + ' depends on' : ', which depends on ' + ciName;
                    var t = n.name + dir + ': ' + n.open + ' open ticket' + (n.open === 1 ? '' : 's');
                    if (n.before) {
                        t += '; ' + n.before + ' opened before the first ticket here, starting with ' + n.first_number + ' ' +
                             self._span(Math.round((t0 - n.first_ms) / 60000)) + ' earlier';
                    }
                    t += ' (' + (n.numbers.join(', ')) + ')';
                    var w = (n.before && n.link === 'upstream') ? 'strong' : (n.before ? 'medium' : 'weak');
                    n.item = add(6, 5, 'neighbour', n.first_number || n.numbers[0] || n.name, n.first_ms, t, w,
                                 { sys_id: n.sys_id, refs: n.numbers, link: n.link });
                }
                if (quiet.length) add(6, 11, 'neighbour', '', null, 'Linked CIs with no recent tickets: ' + quiet.join(', '), 'weak');
            });
        }

        // ---- audit: field history on the ticket ----
        f.audit_reassign = 0;
        if (isTicket) {
            this._run(d.sources, 'audit', null, deadlineAt, function (src) {
                var a = new GlideRecord('sys_audit');
                a.addQuery('tablename', anchor.table);
                a.addQuery('documentkey', anchor.sys_id);
                a.addQuery('fieldname', 'IN', self.AUDIT_FIELDS.join(','));
                a.orderByDesc('sys_created_on');
                a.setLimit(30);
                a.query();
                var rows = [];
                while (a.next()) {
                    rows.push({ field: self._str(a, 'fieldname'), old: self._str(a, 'oldvalue'), nu: self._str(a, 'newvalue'),
                                user: self._str(a, 'user'), at_ms: self._ms(a, 'sys_created_on') });
                }
                src.rows = rows.length;
                if (!rows.length) {
                    // a record touched twice or more with zero audit rows is a
                    // read we were refused, not a quiet ticket
                    if ((f.mod_count || 0) >= 2) {
                        src.status = 'blocked';
                        src.note = 'the ticket was updated ' + f.mod_count + ' times but no audit rows came back';
                    }
                    return;
                }
                var cache = {};
                for (var i = 0; i < rows.length; i++) {
                    var r = rows[i];
                    if (r.field === 'assignment_group' && r.old) f.audit_reassign++;
                    if (i >= 8) continue;
                    var t = self._auditLabel(r.field) + ' ' + self._auditValue(anchor.table, r.field, r.old, cache) +
                            ' -> ' + self._auditValue(anchor.table, r.field, r.nu, cache) +
                            (r.user ? ' by ' + r.user : '') + (r.at_ms !== null ? ' ' + self._when(r.at_ms, nowMs) : '');
                    add(7, i < 3 ? 6 : 9, 'audit', anchor.number, r.at_ms, t, 'medium', { field: r.field });
                }
            });
        } else {
            d.sources.audit = { rows: 0, ms: 0, status: 'skipped', note: 'not a ticket' };
        }
        f.reassignments = Math.max(f.reassignments || 0, f.audit_reassign || 0);

        // ---- journal: last 8 comments / work notes (same query as NetraTools._recentJournal) ----
        if (isTicket) {
            this._run(d.sources, 'journal', 'sys_journal_field', deadlineAt, function (src) {
                var j = new GlideRecord('sys_journal_field');
                j.addQuery('element_id', anchor.sys_id);
                j.addQuery('element', 'IN', 'comments,work_notes');
                j.orderByDesc('sys_created_on');
                j.setLimit(8);
                j.query();
                while (j.next()) {
                    var body = self._str(j, 'value').replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
                    var at = self._ms(j, 'sys_created_on');
                    var el = self._str(j, 'element') === 'work_notes' ? 'work note' : 'comment';
                    add(8, src.rows < 4 ? 7 : 10, 'journal', anchor.number, at,
                        el + ' by ' + self._str(j, 'sys_created_by') + (at !== null ? ' ' + self._when(at, nowMs) : '') + ': ' + body,
                        'weak');
                    src.rows++;
                }
            });
            if (d.sources.journal && d.sources.journal.status === 'empty') d.missing.push('any work notes or comments on the ticket');
        } else {
            d.sources.journal = { rows: 0, ms: 0, status: 'skipped', note: 'not a ticket' };
        }

        // ---- KB keyword hits ----
        var kbq = anchor.short_description && isTicket ? anchor.short_description :
                  (f.siblings.length ? f.siblings[0].short_description : ciName);
        this._run(d.sources, 'kb', null, deadlineAt, function (src) {
            if (typeof NetraKnowledge === 'undefined') { src.status = 'error'; src.note = 'NetraKnowledge not available'; return; }
            var r = new NetraKnowledge().search(kbq, 3);
            if (!r || !r.ok) { src.status = 'skipped'; src.note = 'nothing to search on'; return; }
            var arts = r.articles || [];
            for (var i = 0; i < arts.length && i < 3; i++) {
                src.rows++;
                add(9, 8, 'kb', arts[i].number, null, arts[i].number + " '" + arts[i].title + "': " + (arts[i].snippet || ''), 'weak',
                    { sys_id: arts[i].sys_id });
            }
        });

        // ---- pick, order, number ----
        var budget = this.MAX_ITEMS - (typeof opts.reserve === 'number' ? opts.reserve : this.RESERVE);
        var byPrio = cands.slice(0);
        byPrio.sort(function (a, b) { return (a._p - b._p) || (a._i - b._i); });
        var keep = byPrio.slice(0, budget);
        d.dropped = cands.length - keep.length;
        keep.sort(function (a, b) { return (a._g - b._g) || (a._i - b._i); });
        for (var ki = 0; ki < keep.length; ki++) {
            keep[ki].id = 'E' + (ki + 1);
            delete keep[ki]._g; delete keep[ki]._p; delete keep[ki]._i;
            d.items.push(keep[ki]);
        }
        // swap the internal item handles for plain ids so the whole thing is JSON-safe
        var idOf = function (it) { return (it && it.id) ? it.id : ''; };
        for (var sj = 0; sj < d.suspects.length; sj++) { d.suspects[sj].item = idOf(d.suspects[sj].item); }
        if (f.ci) f.ci.item = idOf(f.ci.item);
        f.siblings_item = idOf(f.siblings_item);
        f.core_item = idOf(core);
        for (var pj = 0; pj < f.problems.length; pj++) f.problems[pj].item = idOf(f.problems[pj].item);
        for (var nj = 0; nj < f.neighbours.length; nj++) f.neighbours[nj].item = idOf(f.neighbours[nj].item);

        // anything we could not read or ran out of time for goes in "missing"
        var LBL = { ci: 'the CI record', changes: 'changes', siblings: 'other tickets on the CI', problem: 'problem records',
                    neighbours: 'linked CIs', audit: 'the audit history', journal: 'the work notes', kb: 'the knowledge base' };
        for (var k in d.sources) {
            if (!d.sources.hasOwnProperty(k)) continue;
            var st = d.sources[k].status;
            if (st === 'blocked' || st === 'error') d.missing.push((LBL[k] || k) + " (couldn't read it)");
            else if (st === 'skipped' && d.sources[k].note === 'out of time') d.missing.push((LBL[k] || k) + ' (ran out of time)');
        }

        d.thin = this._isThin(d);
        var fp = [anchor.sys_id, String(t0)];
        for (var fi = 0; fi < d.items.length; fi++) fp.push(d.items[fi].kind + '|' + d.items[fi].ref + '|' + d.items[fi].at_ms);
        d.fingerprint = this._hash(fp.join(';'));
        d.elapsed_ms = this._clock() - start;
        return d;
    },

    /**
     * the widget adds its own evidence (similar resolved incidents) here.
     * item = {kind, ref, at_ms, text, weight, [score|similarity, close_notes, sys_id, refs]}
     * -> the stored item with its E-id, or null when the dossier is full.
     */
    appendItem: function (dossier, item) {
        if (!dossier || !item) return null;
        if (!dossier.items) dossier.items = [];
        if (dossier.items.length >= this.MAX_ITEMS) { dossier.dropped = (dossier.dropped || 0) + 1; return null; }
        var max = 0;
        for (var i = 0; i < dossier.items.length; i++) {
            var n = parseInt(String(dossier.items[i].id || '').replace(/^E/, ''), 10);
            if (n > max) max = n;
        }
        var score = (typeof item.score === 'number') ? item.score : ((typeof item.similarity === 'number') ? item.similarity : null);
        var w = String(item.weight || '');
        if (w !== 'strong' && w !== 'medium' && w !== 'weak') {
            // similarity is a lookalike, never proof - it tops out at medium
            w = (score !== null && score >= 0.85) ? 'medium' : 'weak';
        }
        var it = { id: 'E' + (max + 1), kind: String(item.kind || 'note'), ref: String(item.ref || ''),
                   at_ms: (typeof item.at_ms === 'number') ? item.at_ms : null,
                   text: this._cut(String(item.text || ''), 200), weight: w };
        if (score !== null) it.score = Math.round(score * 1000) / 1000;
        if (item.close_notes) it.close_notes = this._cut(String(item.close_notes), 300);
        if (item.sys_id) it.sys_id = String(item.sys_id);
        if (item.refs && item.refs.length) it.refs = item.refs.slice(0, 6);
        dossier.items.push(it);
        dossier.thin = this._isThin(dossier);
        return it;
    },

    /** "E3 (change, strong, 14:20): ..." lines for the model payload or a spoken evidence answer */
    evidenceLines: function (dossier) {
        var out = [];
        var items = (dossier && dossier.items) || [];
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            out.push(it.id + ' (' + it.kind + ', ' + it.weight + (it.at_ms !== null ? ', ' + this._hhmm(it.at_ms) : '') + '): ' + it.text);
        }
        return out;
    },

    _isThin: function (d) {
        // substantive = anything beyond the ticket's own description, the
        // CI's static record and keyword KB hits
        var items = d.items || [];
        for (var i = 0; i < items.length; i++) {
            var k = items[i].kind;
            if (k === 'ticket' || k === 'kb') continue;
            if (k === 'ci' && items[i].weight !== 'strong') continue;
            if (k === 'neighbour' && !items[i].ref) continue;
            return false;
        }
        // a process story needs no CI - an ignored ticket is evidence too
        var f = d.facts || {};
        if (f.unassigned_hours >= 4 || f.reassignments >= 3 || f.awaiting_caller) return false;
        return true;
    },

    // =================================================================
    //  F4 - rule hypotheses + validator
    // =================================================================

    /**
     * -> [{n, statement, confidence:'low'|'medium'|'high', cites:['E3'], confirm_by,
     *      rule_out_by, signal:{type, ref, keywords:[]}, rule}]
     * best first. opts.max (default 3) - pass a bigger max to hand every
     * candidate to the model as input.
     */
    ruleHypotheses: function (dossier, opts) {
        opts = opts || {};
        var max = parseInt(opts.max, 10) || 3;
        if (!dossier || !dossier.items || this._isThin(dossier)) return [];
        var f = dossier.facts || {};
        var ci = f.ci_name || (dossier.anchor && dossier.anchor.ci_name) || 'the CI';
        var noun = f.noun || 'CI';
        var nowMs = dossier.gathered_ms || this._nowMs();
        var H = [];
        var order = { change: 1, problem: 2, shared_outage: 3, upstream: 4, recurrence: 5, ci_status: 6, process: 7 };

        // change: top suspect scoring 0.5 or more
        var top = dossier.suspects && dossier.suspects[0];
        if (top && top.score >= 0.5 && this._itemById(dossier, top.item)) {
            var via = (top.via_ci && top.via_ci.name) || ci;
            var ctx = { noun: noun, ticket_count: f.ticket_count, ci_name: ci };
            var clock = top.activity_ms !== null ? this._hhmm(top.activity_ms) : '';
            H.push({
                rule: 'change',
                statement: 'The trouble may be linked to ' + top.number + " '" + top.short_description + "': " +
                           this._suspectBrief(top, ctx, false) + '.',
                confidence: top.score >= 0.9 ? 'high' : (top.score >= 0.7 ? 'medium' : 'low'),
                cites: [top.item],
                confirm_by: 'Ask whoever implemented ' + top.number + ' what it touched on ' + via +
                            ', and check whether the errors began right after its work window' +
                            (top.close_code === 'unsuccessful' ? ' - it was closed unsuccessful' : '') + '.',
                rule_out_by: 'If the errors started before ' + (clock || 'that change') + ', or ' + top.number + ' never touched ' + via +
                             ', the timing is a coincidence.',
                signal: { type: 'change_backed_out', ref: top.number, keywords: this._kwMerge(this._kw(top.short_description, 3), ['rollback']) },
                _score: top.score
            });
        }

        // known problem
        if (f.problems && f.problems.length && f.problems[0].item) {
            var p = f.problems[0];
            H.push({
                rule: 'problem',
                statement: 'This may be the known problem ' + p.number + " '" + p.short_description + "'" +
                           (p.linked ? ', which this ticket is already linked to.' : ', still open on ' + ci + '.'),
                confidence: p.linked ? 'high' : 'medium',
                cites: [p.item],
                confirm_by: 'Read the workaround and analysis notes on ' + p.number + ' and compare its symptoms with this ticket.',
                rule_out_by: 'If ' + p.number + " describes different symptoms, it's a separate issue on the same " + noun + '.',
                signal: { type: 'sibling_resolved_with', ref: p.number, keywords: this._kw(p.short_description, 4) }
            });
        }

        // shared outage: 3 or more tickets on the CI inside 2h
        if (f.cluster >= 3 && f.siblings_item) {
            var sds = [];
            for (var i = 0; i < f.siblings.length; i++) sds.push(f.siblings[i].short_description);
            if (dossier.anchor && dossier.anchor.short_description) sds.push(dossier.anchor.short_description);
            H.push({
                rule: 'shared_outage',
                statement: f.cluster + ' tickets hit ' + ci + ' within 2 hours of each other, which looks like one shared outage on that ' +
                           noun + ' rather than separate faults.',
                confidence: f.cluster >= 5 ? 'high' : 'medium',
                cites: [f.siblings_item],
                confirm_by: 'Check whether the tickets on ' + ci + ' describe the same symptom, and look at the ' + noun + "'s own health.",
                rule_out_by: 'If the tickets describe unrelated symptoms, they only share the ' + noun + '.',
                signal: { type: 'new_siblings', ref: ci, keywords: this._commonKw(sds, 3) }
            });
        }

        // upstream: a neighbour had tickets before t0
        var nbBest = null;
        for (var ni = 0; f.neighbours && ni < f.neighbours.length; ni++) {
            var nb = f.neighbours[ni];
            if (!nb.before || !nb.item) continue;
            if (!nbBest || (nb.link === 'upstream' && nbBest.link !== 'upstream') ||
                (nb.link === nbBest.link && nb.first_ms < nbBest.first_ms)) nbBest = nb;
        }
        if (nbBest) {
            var mins = Math.round(((dossier.t0_ms || nowMs) - nbBest.first_ms) / 60000);
            var up = nbBest.link === 'upstream';
            H.push({
                rule: 'upstream',
                statement: 'The trouble may have started on ' + nbBest.name + (up ? ', which ' + ci + ' depends on' : ', which depends on ' + ci) +
                           ': it had ' + this._num(nbBest.before) + ' ticket' + (nbBest.before === 1 ? '' : 's') + ' starting ' +
                           this._span(mins) + ' before the first ticket here, beginning with ' + nbBest.first_number + '.',
                confidence: up ? 'medium' : 'low',
                cites: [nbBest.item],
                confirm_by: 'Check ' + nbBest.name + "'s health and read " + nbBest.first_number + '.',
                rule_out_by: 'If ' + nbBest.name + ' was healthy when these tickets started, the link is a bystander.',
                signal: { type: 'none', ref: nbBest.first_number, keywords: this._kw(nbBest.first_sd, 4) }
            });
        }

        // recurrence: a similar resolved incident (widget-appended) at 0.75+ with close notes
        var sim = null;
        for (var s2 = 0; s2 < dossier.items.length; s2++) {
            var it = dossier.items[s2];
            if (it.kind !== 'similar' || !it.close_notes || typeof it.score !== 'number' || it.score < 0.75) continue;
            if (!sim || it.score > sim.score) sim = it;
        }
        if (sim) {
            H.push({
                rule: 'recurrence',
                statement: 'This looks like ' + sim.ref + ", which was fixed with: '" + this._cut(sim.close_notes, 110) + "'.",
                confidence: sim.score >= 0.85 ? 'medium' : 'low',
                cites: [sim.id],
                confirm_by: 'Check whether the fix from ' + sim.ref + ' applies here before repeating it.',
                rule_out_by: 'If what went wrong in ' + sim.ref + " can't happen on this " + noun + ", it's only a lookalike.",
                signal: { type: 'sibling_resolved_with', ref: sim.ref, keywords: this._kw(sim.close_notes, 4) }
            });
        }

        // CI not operational / in maintenance
        if (f.ci && f.ci.not_operational && f.ci.item) {
            var lbl = (f.ci.op === '2' || f.ci.op === '3' || f.ci.op === '6') ? f.ci.op_label : f.ci.install_label;
            H.push({
                rule: 'ci_status',
                statement: ci + ' is marked ' + lbl + ' in the CMDB, so this may be planned or known work on it rather than a new fault.',
                confidence: 'medium',
                cites: [f.ci.item],
                confirm_by: 'Ask ' + (f.ci.support_group || 'its support group') + ' whether ' + ci + ' is in planned work right now.',
                rule_out_by: 'If the CMDB status is just stale and the ' + noun + ' was running normally, this is not it.',
                signal: { type: 'ci_status_change', ref: ci, keywords: this._kwMerge(['maintenance'], this._kw(lbl, 2)) }
            });
        }

        // process: unassigned 4h+, 3+ reassignments, or waiting on the caller
        if (f.core_item) {
            var why = [];
            if (f.unassigned_hours >= 4) why.push('it has been unassigned for ' + f.unassigned_hours + ' hours');
            if (f.reassignments >= 3) why.push('it has been reassigned ' + f.reassignments + ' times');
            if (f.awaiting_caller) why.push('it is on hold waiting for the caller');
            if (why.length) {
                var pc = [f.core_item];
                for (var ai = 0; ai < dossier.items.length && pc.length < 3; ai++) {
                    if (dossier.items[ai].kind === 'audit' && dossier.items[ai].field === 'assignment_group') pc.push(dossier.items[ai].id);
                }
                H.push({
                    rule: 'process',
                    statement: 'This may be stuck in process rather than a technical mystery: ' + why.join('; ') + '.',
                    confidence: why.length >= 2 ? 'medium' : 'low',
                    cites: pc,
                    confirm_by: 'Check who owns it now and when anyone last worked it.',
                    rule_out_by: 'If someone is actively working it, the delay is expected.',
                    signal: { type: 'none', ref: dossier.anchor ? dossier.anchor.number : '', keywords: ['assign', 'caller'] }
                });
            }
        }

        var RANK = { high: 3, medium: 2, low: 1 };
        for (var c = 0; c < H.length; c++) {
            H[c].confidence = this.capConfidence(H[c].confidence, H[c].cites, dossier);
            H[c]._o = order[H[c].rule] || 9;
        }
        H.sort(function (a, b) {
            return (RANK[b.confidence] - RANK[a.confidence]) || ((b._score || 0) - (a._score || 0)) || (a._o - b._o);
        });
        H = H.slice(0, max);
        for (var z = 0; z < H.length; z++) { delete H[z]._o; delete H[z]._score; H[z].n = z + 1; }
        return H;
    },

    /** weak-only cites cap at low; high needs at least one strong cite */
    capConfidence: function (conf, cites, dossier) {
        var c = (conf === 'high' || conf === 'medium' || conf === 'low') ? conf : 'low';
        var strong = false, medium = false;
        for (var i = 0; cites && i < cites.length; i++) {
            var it = this._itemById(dossier, cites[i]);
            if (!it) continue;
            if (it.weight === 'strong') strong = true;
            if (it.weight === 'medium') medium = true;
        }
        if (!strong && !medium) return 'low';
        if (c === 'high' && !strong) return 'medium';
        return c;
    },

    /**
     * the code-side check on model hypotheses. drops anything with no
     * cites, an unknown cite, or a record number that isn't in the dossier;
     * caps confidence; cleans the signal.
     * -> {hypotheses:[...<=3, n set], dropped:[{statement, why}]}
     */
    validateHypotheses: function (hyps, dossier) {
        var out = [], dropped = [];
        var known = this._knownRefs(dossier);
        for (var i = 0; hyps && i < hyps.length && out.length < 3; i++) {
            var h = hyps[i] || {};
            var st = this._cut(String(h.statement || ''), 300);
            var cites = (h.cites && h.cites.length) ? h.cites : [];
            if (!st) { dropped.push({ statement: '', why: 'empty statement' }); continue; }
            if (!cites.length) { dropped.push({ statement: st, why: 'no cites' }); continue; }
            var bad = '';
            var clean = [];
            for (var c = 0; c < cites.length; c++) {
                var id = String(cites[c]).toUpperCase().replace(/\s+/g, '');
                if (!this._itemById(dossier, id)) { bad = id; break; }
                if (clean.indexOf(id) < 0) clean.push(id);
            }
            if (bad) { dropped.push({ statement: st, why: 'unknown cite ' + bad }); continue; }
            var txt = st + ' ' + (h.confirm_by || '') + ' ' + (h.rule_out_by || '');
            var m, unknown = '';
            var re = new RegExp(this.REC_RE.source, 'gi');
            while ((m = re.exec(txt)) !== null) {
                if (!known[m[0].toUpperCase()]) { unknown = m[0].toUpperCase(); break; }
            }
            if (unknown) { dropped.push({ statement: st, why: 'names ' + unknown + ', which is not in the evidence' }); continue; }
            var sig = h.signal || {};
            var type = this.SIGNAL_TYPES[sig.type] ? sig.type : 'none';
            var kws = [];
            for (var k = 0; sig.keywords && k < sig.keywords.length && kws.length < 4; k++) {
                var kw = String(sig.keywords[k] || '').toLowerCase().replace(/^\s+|\s+$/g, '').substring(0, 30);
                if (kw && kws.indexOf(kw) < 0) kws.push(kw);
            }
            out.push({
                n: out.length + 1, statement: st,
                confidence: this.capConfidence(String(h.confidence || 'low').toLowerCase(), clean, dossier),
                cites: clean,
                confirm_by: this._cut(String(h.confirm_by || ''), 200),
                rule_out_by: this._cut(String(h.rule_out_by || ''), 200),
                signal: { type: type, ref: this._cut(String(sig.ref || ''), 40), keywords: kws }
            });
        }
        return { hypotheses: out, dropped: dropped };
    },

    /** the persisted form for an investigate_watch order: sig[<=3] {n, type, ref, kw, s} */
    watchSignals: function (hypotheses) {
        var out = [];
        for (var i = 0; hypotheses && i < hypotheses.length && out.length < 3; i++) {
            var h = hypotheses[i];
            if (!h || !h.signal || !this.SIGNAL_TYPES[h.signal.type]) continue;
            var kw = [];
            for (var k = 0; h.signal.keywords && k < h.signal.keywords.length && kw.length < 4; k++) {
                if (typeof h.signal.keywords[k] === 'string' && h.signal.keywords[k]) kw.push(h.signal.keywords[k].substring(0, 30));
            }
            out.push({ n: h.n || (i + 1), type: h.signal.type, ref: String(h.signal.ref || '').substring(0, 40), kw: kw,
                       s: this._cut(String(h.statement || ''), 120) });
        }
        return out;
    },

    _knownRefs: function (d) {
        var known = {};
        var grab = function (s) {
            var m, re = /\b(INC|CHG|PRB|KB|RITM)\d+\b/gi;
            while ((m = re.exec(String(s || ''))) !== null) known[m[0].toUpperCase()] = 1;
        };
        if (!d) return known;
        if (d.anchor) grab(d.anchor.number);
        for (var i = 0; d.items && i < d.items.length; i++) {
            grab(d.items[i].ref);
            grab(d.items[i].text);
            if (d.items[i].refs) grab(d.items[i].refs.join(' '));
        }
        for (var s = 0; d.suspects && s < d.suspects.length; s++) grab(d.suspects[s].number);
        return known;
    },

    _itemById: function (d, id) {
        if (!d || !d.items || !id) return null;
        for (var i = 0; i < d.items.length; i++) { if (d.items[i].id === id) return d.items[i]; }
        return null;
    },

    // =================================================================
    //  F6 - the away watch: snapshot, diff, signals, grading
    // =================================================================

    /**
     * anchor = {table, sys_id, number, ci_sys_id?}
     * opts   = { since_ms: previous snapshot's at, track:[change numbers from the signals] }
     * -> {ok:true, v, at, tbl, id, num, ci, ci_n, ci_k, sib:[num], res:[num], chg:[{n,s,cc}],
     *     ci_st, st, sv, done, jc, err:[], x:{sib:{}, res:{}, chg:{}, cn}}
     *  | {ok:false, gone:true|false, error}
     * x holds the bulky bits (descriptions, close notes) for this pass
     * only - compactSnapshot() drops it before it goes into condition_json.
     */
    snapshot: function (anchor, opts) {
        opts = opts || {};
        var self = this;
        var now = this._nowMs();
        var since = (typeof opts.since_ms === 'number' && opts.since_ms > 0) ? opts.since_ms - 5 * 60000 : now - 24 * this.H;
        var tbl = (anchor && anchor.table) || 'incident';
        var id = anchor && anchor.sys_id;
        if (!id) return { ok: false, gone: true, error: 'no target' };
        var snap = { ok: true, v: 1, at: now, tbl: tbl, id: id, num: anchor.number || '', ci: '', ci_n: '', ci_k: 'CI',
                     sib: null, res: null, chg: null, ci_st: null, st: null, sv: null, done: false, jc: null, err: [],
                     x: { sib: {}, res: {}, chg: {}, cn: '' } };
        var t;
        try {
            t = new GlideRecord(tbl);
            if (!t.get(id)) return { ok: false, gone: true, error: 'target record is gone' };
        } catch (eT) {
            return { ok: false, gone: false, error: 'could not read the target: ' + this._err(eT) };
        }
        snap.num = this._str(t, 'number') || snap.num;
        snap.st = this._dv(t, 'state') || this._str(t, 'state');
        snap.sv = this._str(t, 'state');
        snap.done = this._isDone(tbl, t);
        snap.x.cn = this._cut(this._str(t, 'close_notes').replace(/\s+/g, ' '), 400);
        snap.ci = this._safeId(this._str(t, 'cmdb_ci') || anchor.ci_sys_id || '');   // follow the live CI if someone fixed it
        var ciId = snap.ci;

        var tryPart = function (name, fn) {
            try { fn(); } catch (e) { snap.err.push(name); gs.warn('[NetraInvestigator] snapshot ' + name + ' failed: ' + self._err(e)); }
        };

        var setIds = ciId ? [ciId] : [];
        if (ciId) {
            tryPart('ci', function () {
                var c = new GlideRecord('cmdb_ci');
                c.addQuery('sys_id', ciId);
                c.setLimit(1);
                c.query();
                if (c.next()) {
                    snap.ci_n = self._str(c, 'name');
                    snap.ci_k = self._noun(self._str(c, 'sys_class_name'));
                    snap.ci_st = self._dv(c, 'operational_status') || self._str(c, 'operational_status');
                } else {
                    snap.err.push('ci');
                }
            });
            tryPart('rel', function () {
                var r = new GlideRecord('cmdb_rel_ci');
                r.addEncodedQuery('parent=' + ciId + '^ORchild=' + ciId);
                r.setLimit(15);
                r.query();
                while (r.next()) {
                    var o = self._str(r, 'parent') === ciId ? self._str(r, 'child') : self._str(r, 'parent');
                    if (o && setIds.indexOf(o) < 0) setIds.push(o);
                }
            });
            tryPart('sib', function () {
                var g = new GlideRecord('task');
                g.addQuery('sys_class_name', 'incident');
                g.addQuery('cmdb_ci', ciId);
                g.addQuery('active', true);
                g.addQuery('sys_id', '!=', id);
                g.orderByDesc('opened_at');
                g.setLimit(15);
                g.query();
                var sib = [];
                while (g.next()) {
                    var n = self._str(g, 'number');
                    sib.push(n);
                    snap.x.sib[n] = self._cut(self._str(g, 'short_description'), 80);
                }
                snap.sib = sib;
            });
            tryPart('res', function () {
                // updated-since rather than resolved_at: a resolve done with
                // workflow off never stamps resolved_at
                var g = new GlideRecord('task');
                g.addQuery('sys_class_name', 'incident');
                g.addQuery('cmdb_ci', ciId);
                g.addQuery('state', 'IN', '6,7');
                g.addQuery('sys_id', '!=', id);
                g.addQuery('sys_updated_on', '>=', self._gdt(since));
                g.orderByDesc('sys_updated_on');
                g.setLimit(8);
                g.query();
                var res = [];
                while (g.next()) {
                    var n = self._str(g, 'number');
                    res.push(n);
                    snap.x.res[n] = self._cut(self._str(g, 'close_notes').replace(/\s+/g, ' '), 200);
                }
                snap.res = res;
            });
        } else {
            snap.sib = []; snap.res = []; snap.ci_st = '';
        }

        tryPart('chg', function () {
            var chg = [], seen = {};
            var take = function (g) {
                var n = self._str(g, 'number');
                if (seen[n] || chg.length >= 8) return;
                seen[n] = 1;
                chg.push({ n: n, s: self._dv(g, 'state') || self._str(g, 'state'), cc: self._str(g, 'close_code') });
                snap.x.chg[n] = { d: self._cut(self._str(g, 'short_description'), 60) };
            };
            var track = [];
            for (var i = 0; opts.track && i < opts.track.length; i++) {
                if (/^CHG\d+$/i.test(String(opts.track[i]))) track.push(String(opts.track[i]).toUpperCase());
            }
            if (track.length) {
                var a = new GlideRecord('change_request');
                a.addQuery('number', 'IN', track.join(','));
                a.setLimit(8);
                a.query();
                while (a.next()) take(a);
            }
            if (setIds.length) {
                var b = new GlideRecord('change_request');
                b.addQuery('cmdb_ci', 'IN', setIds.join(','));
                b.addQuery('sys_updated_on', '>=', self._gdt(since));
                b.orderByDesc('sys_updated_on');
                b.setLimit(8);
                b.query();
                while (b.next()) take(b);
            }
            snap.chg = chg;
        });

        tryPart('jc', function () {
            var j = new GlideRecord('sys_journal_field');
            j.addQuery('element_id', id);
            j.addQuery('element', 'IN', 'comments,work_notes');
            j.setLimit(200);
            j.query();
            var n = 0;
            while (j.next()) n++;
            snap.jc = n;
        });
        return snap;
    },

    /**
     * what goes back into condition_json: no x, no ok/err, failed parts
     * carry the old value forward, and res keeps everything already
     * reported so a later touch on a resolved ticket can't re-announce it
     */
    compactSnapshot: function (newSnap, oldSnap) {
        var o = oldSnap || {};
        var out = {};
        for (var k in newSnap) {
            if (!newSnap.hasOwnProperty(k) || k === 'x' || k === 'ok' || k === 'err') continue;
            out[k] = newSnap[k];
            if (out[k] === null && o[k] !== undefined) out[k] = o[k];
        }
        if (out.res && o.res) {
            var merged = out.res.slice(0);
            for (var i = 0; i < o.res.length; i++) { if (merged.indexOf(o.res[i]) < 0) merged.push(o.res[i]); }
            out.res = merged.slice(0, 20);
        }
        return out;
    },

    /** -> [string] facts that are new since the old snapshot, nothing else */
    diffSnapshot: function (oldSnap, newSnap) {
        var facts = [];
        if (!oldSnap || !newSnap) return facts;
        var ci = newSnap.ci_n || oldSnap.ci_n || 'the same ' + (newSnap.ci_k || 'CI');
        var x = newSnap.x || { sib: {}, res: {}, chg: {} };

        var added = this._newSiblings(oldSnap, newSnap);
        if (added.length) {
            var shown = [];
            for (var i = 0; i < added.length && i < 3; i++) {
                shown.push(added[i] + (x.sib[added[i]] ? " '" + x.sib[added[i]] + "'" : ''));
            }
            facts.push((added.length === 1 ? 'one more ticket' : this._num(added.length) + ' more tickets') + ' on ' + ci + ': ' +
                       shown.join(', ') + (added.length > 3 ? ' and more' : ''));
        }
        var resolved = this._newResolved(oldSnap, newSnap);
        for (var r = 0; r < resolved.length; r++) {
            var cn = x.res[resolved[r]];
            facts.push(resolved[r] + ' on ' + ci + ' was resolved' + (cn ? ": '" + this._cut(cn, 120) + "'" : ', with no close notes'));
        }
        if (oldSnap.chg && newSnap.chg) {
            for (var c = 0; c < newSnap.chg.length; c++) {
                var nc = newSnap.chg[c], oc = this._findChg(oldSnap.chg, nc.n);
                var desc = x.chg[nc.n] && x.chg[nc.n].d;
                if (!oc) {
                    facts.push('a new change touches ' + ci + ': ' + nc.n + (desc ? " '" + desc + "'" : '') + (nc.s ? ' (' + nc.s + ')' : ''));
                } else if (oc.cc !== nc.cc && nc.cc) {
                    facts.push('the change ' + nc.n + ' was ' + (this.CLOSE_LABEL[nc.cc] || 'closed ' + nc.cc));
                } else if (oc.s !== nc.s) {
                    facts.push('the change ' + nc.n + ' moved from ' + oc.s + ' to ' + nc.s);
                }
            }
        }
        if (oldSnap.ci_st && newSnap.ci_st && oldSnap.ci_st !== newSnap.ci_st) {
            facts.push(ci + ' is now ' + newSnap.ci_st + ' (it was ' + oldSnap.ci_st + ')');
        }
        if (oldSnap.st && newSnap.st && oldSnap.st !== newSnap.st) {
            facts.push((newSnap.num || 'the ticket') + ' moved from ' + oldSnap.st + ' to ' + newSnap.st);
        }
        if (typeof oldSnap.jc === 'number' && typeof newSnap.jc === 'number' && newSnap.jc > oldSnap.jc && oldSnap.jc < 200) {
            var dj = newSnap.jc - oldSnap.jc;
            facts.push((dj === 1 ? 'one new work note or comment' : this._num(dj) + ' new work notes or comments') + ' on ' +
                       (newSnap.num || 'the ticket'));
        }
        return facts;
    },

    /**
     * signals = sig[] as stored ({n, type, ref, kw|keywords}).
     * -> [{n, supported:true, text}] - one entry per signal at most, and
     * only the ones this pass actually supports.
     */
    checkSignals: function (signals, oldSnap, newSnap) {
        var out = [];
        if (!signals || !oldSnap || !newSnap) return out;
        var x = newSnap.x || { sib: {}, res: {}, chg: {} };
        var noun = newSnap.ci_k || 'CI';
        var ci = newSnap.ci_n || 'the same ' + noun;
        var added = this._newSiblings(oldSnap, newSnap);
        var resolved = this._newResolved(oldSnap, newSnap);
        for (var i = 0; i < signals.length && i < 3; i++) {
            var sg = signals[i] || {};
            var n = parseInt(sg.n, 10) || (i + 1);
            var tail = '; that supports my theory ' + this._num(n);
            var ref = String(sg.ref || '').toUpperCase();
            var kw = this._stems((sg.kw || sg.keywords || []).join(' '));
            var text = '';
            var k, cn;

            if (sg.type === 'change_backed_out') {
                var nc = ref ? this._findChg(newSnap.chg, ref) : null;
                var oc = ref ? this._findChg(oldSnap.chg, ref) : null;
                if (nc && nc.cc === 'unsuccessful' && (!oc || oc.cc !== 'unsuccessful')) {
                    text = 'the change ' + ref + ' was closed unsuccessful' + tail;
                }
                for (k = 0; !text && newSnap.chg && k < newSnap.chg.length; k++) {
                    var c2 = newSnap.chg[k];
                    var d2 = (x.chg[c2.n] && x.chg[c2.n].d) || '';
                    if (!this._findChg(oldSnap.chg, c2.n) && this.ROLLBACK_RE.test(d2)) {
                        text = "a new change on " + ci + ", " + c2.n + " '" + d2 + "', looks like a rollback" + tail;
                    }
                }
                for (k = 0; !text && k < resolved.length; k++) {
                    cn = x.res[resolved[k]] || '';
                    if (this.ROLLBACK_RE.test(cn) && ((ref && cn.toUpperCase().indexOf(ref) >= 0) || this._hits(kw, cn) >= 1)) {
                        text = 'a ticket on the same ' + noun + ', ' + resolved[k] + ", was resolved with '" + this._cut(cn, 120) + "'" + tail;
                    }
                }
            } else if (sg.type === 'sibling_resolved_with') {
                for (k = 0; !text && k < resolved.length; k++) {
                    cn = x.res[resolved[k]] || '';
                    if ((ref && cn.toUpperCase().indexOf(ref) >= 0) || this._hits(kw, cn) >= 1) {
                        text = 'a ticket on the same ' + noun + ', ' + resolved[k] + ", was resolved with '" + this._cut(cn, 120) + "'" + tail;
                    }
                }
            } else if (sg.type === 'new_siblings') {
                if (added.length) {
                    text = (added.length === 1 ? 'one more ticket' : this._num(added.length) + ' more tickets') + ' on ' + ci +
                           ' since my last look' + tail;
                }
            } else if (sg.type === 'ci_status_change') {
                if (oldSnap.ci_st && newSnap.ci_st && oldSnap.ci_st !== newSnap.ci_st && !/^operational$/i.test(newSnap.ci_st)) {
                    text = ci + ' is now ' + newSnap.ci_st + tail;
                }
            }
            if (text) out.push({ n: n, supported: true, text: text });
        }
        return out;
    },

    /**
     * grade the theories against the real close notes.
     * hypotheses: validated ones ({statement, signal:{keywords}}) or the
     * stored sig form ({n, s, kw}). opts.exclude = extra tokens to ignore.
     * -> {outcome:'matched'|'missed'|'unclear', n, snippet, hits:[], text}
     */
    grade: function (hypotheses, closeNotes, opts) {
        opts = opts || {};
        var notes = String(closeNotes || '').replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
        var snippet = this._cut(notes, 140);
        var count = hypotheses ? hypotheses.length : 0;
        var closeTerms = this._stems(notes);
        var closeCount = 0;
        for (var ck in closeTerms) { if (closeTerms.hasOwnProperty(ck)) closeCount++; }
        if (notes.length < 15 || closeCount < 2 || !count) {
            return { outcome: 'unclear', n: 0, snippet: snippet, hits: [],
                     text: "I can't tell whether my theories were right - the close notes are too thin" + (snippet ? " ('" + snippet + "')" : '') + '.' };
        }
        var exclude = this._stems((opts.exclude || []).join(' '));
        var sets = [];
        for (var i = 0; i < count; i++) {
            var h = hypotheses[i] || {};
            var kws = (h.signal && h.signal.keywords) || h.kw || h.keywords || [];
            var terms = this._stems((h.statement || h.s || '') + ' ' + kws.join(' '));
            sets.push(terms);
        }
        // a term every theory shares (usually the CI) can't tell them apart
        if (count > 1) {
            for (var t in sets[0]) {
                if (!sets[0].hasOwnProperty(t)) continue;
                var everywhere = true;
                for (var j = 1; j < count; j++) { if (!sets[j][t]) { everywhere = false; break; } }
                if (everywhere) { for (var j2 = 0; j2 < count; j2++) delete sets[j2][t]; }
            }
        }
        var best = -1, bestHits = [];
        for (var a = 0; a < count; a++) {
            var hits = [];
            for (var term in sets[a]) {
                if (sets[a].hasOwnProperty(term) && closeTerms[term] && !exclude[term]) hits.push(term);
            }
            if (hits.length >= 2 && hits.length > bestHits.length) { best = a; bestHits = hits; }
        }
        if (best < 0) {
            return { outcome: 'missed', n: 0, snippet: snippet, hits: [],
                     text: "it doesn't match " + (count === 1 ? 'my theory' : 'any of my ' + this._num(count) + ' theories') +
                           ", I got this one wrong. The close notes say '" + snippet + "'." };
        }
        var n = parseInt((hypotheses[best] && hypotheses[best].n), 10) || (best + 1);
        return { outcome: 'matched', n: n, snippet: snippet, hits: bestHits,
                 text: "that matches my theory " + this._num(n) + ". The close notes say '" + snippet + "'." };
    },

    _newSiblings: function (o, nw) {
        var out = [];
        if (!o || !nw || !o.sib || !nw.sib) return out;
        for (var i = 0; i < nw.sib.length; i++) {
            if (o.sib.indexOf(nw.sib[i]) < 0 && (!o.res || o.res.indexOf(nw.sib[i]) < 0)) out.push(nw.sib[i]);
        }
        return out;
    },

    _newResolved: function (o, nw) {
        var out = [];
        if (!o || !nw || !o.res || !nw.res) return out;
        for (var i = 0; i < nw.res.length; i++) { if (o.res.indexOf(nw.res[i]) < 0) out.push(nw.res[i]); }
        return out;
    },

    _findChg: function (list, num) {
        for (var i = 0; list && i < list.length; i++) { if (String(list[i].n).toUpperCase() === String(num).toUpperCase()) return list[i]; }
        return null;
    },

    _isDone: function (tbl, t) {
        var sv = this._str(t, 'state');
        if (tbl === 'incident' && (sv === '6' || sv === '7' || sv === '8')) return true;
        if (tbl === 'problem' && (sv === '106' || sv === '107')) return true;
        return !this._bool(t, 'active');
    },

    // =================================================================
    //  text helpers (pure - unit tested in node)
    // =================================================================

    _canon: function (s) {
        return String(s || '').toLowerCase()
            .replace(/\broll(?:ed|ing|s)?[\s\-]*backs?\b/g, ' rollback ')
            .replace(/\bback(?:ed|ing)?[\s\-]*out\b/g, ' rollback ')
            .replace(/\bbackouts?\b/g, ' rollback ')
            .replace(/\brevert(?:ed|ing|s)?\b/g, ' rollback ')
            .replace(/\bund(?:o|id|one)\b/g, ' rollback ')
            .replace(/\brollbacks\b/g, ' rollback ');
    },

    _tokens: function (s) {
        var raw = this._canon(s).split(/[^a-z0-9\-_\.']+/);
        var out = [];
        for (var i = 0; i < raw.length; i++) {
            var w = raw[i].replace(/^[\-_\.']+|[\-_\.']+$/g, '').replace(/'s$/, '');
            if (w) out.push(w);
        }
        return out;
    },

    _stem: function (w) {
        if (w.length > 5 && /ing$/.test(w)) w = w.slice(0, -3);
        else if (w.length > 4 && /ed$/.test(w)) w = w.slice(0, -2);
        else if (w.length > 4 && /(ches|shes|xes|sses|zes)$/.test(w)) w = w.slice(0, -2);
        else if (w.length > 4 && /ies$/.test(w)) w = w.slice(0, -3) + 'y';
        else if (w.length > 3 && /s$/.test(w) && !/ss$/.test(w)) w = w.slice(0, -1);
        if (w.length > 4 && /e$/.test(w)) w = w.slice(0, -1);
        return w;
    },

    // content terms, stemmed, as a set. hostnames, record numbers and
    // anything else with a digit in it never counts
    _stems: function (s) {
        var t = this._tokens(s), set = {};
        for (var i = 0; i < t.length; i++) {
            var w = t[i];
            if (w.length < 3 || /\d/.test(w) || this.STOP[w]) continue;
            var st = this._stem(w);
            if (st.length < 3 || this.STOP[st]) continue;
            set[st] = 1;
        }
        return set;
    },

    _hits: function (termSet, text) {
        var ts = this._stems(text), n = 0;
        for (var k in termSet) { if (termSet.hasOwnProperty(k) && ts[k]) n++; }
        return n;
    },

    // readable keywords (not stemmed - grade() stems them itself)
    _kw: function (s, max) {
        var t = this._tokens(s), out = [], seen = {};
        for (var i = 0; i < t.length && out.length < (max || 4); i++) {
            var w = t[i];
            if (w.length < 3 || /\d/.test(w) || this.STOP[w]) continue;
            var st = this._stem(w);
            if (seen[st] || this.STOP[st]) continue;
            seen[st] = 1;
            out.push(w);
        }
        return out;
    },

    _kwMerge: function (a, b) {
        var out = [], seen = {};
        var all = (a || []).concat(b || []);
        for (var i = 0; i < all.length && out.length < 4; i++) {
            var st = this._stem(all[i]);
            if (seen[st]) continue;
            seen[st] = 1;
            out.push(all[i]);
        }
        return out;
    },

    // keywords shared by at least two of the descriptions, most common first
    _commonKw: function (texts, max) {
        var count = {}, word = {}, order = [];
        for (var i = 0; i < texts.length; i++) {
            var ks = this._kw(texts[i], 8);
            for (var k = 0; k < ks.length; k++) {
                var st = this._stem(ks[k]);
                if (!count[st]) { count[st] = 0; word[st] = ks[k]; order.push(st); }
                count[st]++;
            }
        }
        order.sort(function (a, b) { return count[b] - count[a]; });
        var out = [];
        for (var j = 0; j < order.length && out.length < (max || 3); j++) { if (count[order[j]] >= 2) out.push(word[order[j]]); }
        return out;
    },

    _span: function (mins) {
        var m = Math.round(Math.abs(mins));
        if (m < 1) return 'less than a minute';
        if (m === 1) return '1 minute';
        if (m < 120) return m + ' minutes';
        if (m < 48 * 60) {
            var h = Math.floor(m / 60), r = m % 60;
            return h + ' hours' + (r ? ' and ' + r + ' minute' + (r === 1 ? '' : 's') : '');
        }
        var dd = Math.floor(m / 1440), hh = Math.round((m % 1440) / 60);
        return dd + ' days' + (hh ? ' and ' + hh + ' hour' + (hh === 1 ? '' : 's') : '');
    },

    _num: function (n) {
        return (n >= 0 && n < this.ORD.length) ? this.ORD[n] : String(n);
    },

    _list: function (a) {
        if (a.length <= 1) return a.join('');
        return a.slice(0, -1).join(', ') + ' or the ' + a[a.length - 1];
    },

    // R8.2 short form: "the change ending 0 4 2"
    _shortRef: function (num) {
        var m = String(num || '').match(/^([A-Z]+)(\d+)$/);
        if (!m) return String(num || '');
        var KIND = { CHG: 'the change', INC: 'incident', PRB: 'problem', RITM: 'request item', REQ: 'request',
                     SCTASK: 'catalog task', CTASK: 'change task', KB: 'article' };
        var last = m[2].slice(-3).split('').join(' ');
        return (KIND[m[1]] || m[1]) + ' ending ' + last;
    },

    _noun: function (cls) {
        var c = String(cls || '').toLowerCase();
        if (/app_server|appl/.test(c)) return 'application';
        if (/database|_db_|_db$/.test(c)) return 'database';
        if (/server|linux|win|unix|esx|solaris|aix|hpux|vm_instance|_host/.test(c)) return 'server';
        if (/computer/.test(c)) return 'computer';
        if (/service/.test(c)) return 'service';
        if (/router|switch|netgear|network|ip_|firewall|lb/.test(c)) return 'network device';
        if (/storage|san|nas|disk/.test(c)) return 'storage device';
        return 'CI';
    },

    _auditLabel: function (f) {
        var L = { state: 'state', priority: 'priority', assignment_group: 'assignment group', assigned_to: 'assigned to',
                  cmdb_ci: 'CI', category: 'category' };
        return L[f] || f;
    },

    _auditValue: function (table, field, val, cache) {
        if (!val) return 'empty';
        var key = field + '|' + val;
        if (cache[key]) return cache[key];
        var out = val;
        try {
            var refTable = this.AUDIT_REF[field];
            if (refTable) {
                var r = new GlideRecord(refTable);
                r.addQuery('sys_id', val);
                r.setLimit(1);
                r.query();
                if (r.next()) out = this._str(r, 'name') || val;
            } else if (field === 'state' && table === 'incident' && this.INC_STATE[val]) {
                out = this.INC_STATE[val];
            } else if (field === 'priority' && this.PRIORITY[val]) {
                out = this.PRIORITY[val];
            }
        } catch (e) { out = val; }
        cache[key] = out;
        return out;
    },

    _gapNames: function (sources, labels) {
        var out = [];
        for (var k in sources) {
            if (!sources.hasOwnProperty(k)) continue;
            var st = sources[k].status;
            if (st === 'blocked' || st === 'error') out.push(labels[k] || k);
        }
        return out;
    },

    _worst: function (sources) {
        var RANK = { error: 4, blocked: 3, skipped: 2, empty: 1, ok: 0 };
        var w = 'ok';
        for (var k in sources) {
            if (sources.hasOwnProperty(k) && (RANK[sources[k].status] || 0) > RANK[w]) w = sources[k].status;
        }
        return w;
    },

    _hash: function (s) {
        var h = 5381;
        s = String(s);
        for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
        return 'fp' + (h >>> 0).toString(16);
    },

    _cut: function (s, n) {
        s = String(s === null || s === undefined ? '' : s);
        return s.length <= n ? s : s.substring(0, n - 3) + '...';
    },

    // =================================================================
    //  time helpers
    // =================================================================

    _nowMs: function () { return Number(new GlideDateTime().getNumericValue()); },

    _clock: function () { return new Date().getTime(); },

    _gdt: function (ms) {
        var g = new GlideDateTime();
        g.setNumericValue(ms);
        return g;
    },

    _tzOffset: function (ms) {
        if (typeof this._tzFixed === 'number') return this._tzFixed;
        try {
            var g = new GlideDateTime();
            g.setNumericValue(ms);
            return parseInt(String(g.getTZOffset()), 10) || 0;
        } catch (e) { return 0; }
    },

    _hhmm: function (ms) {
        var loc = new Date(ms + this._tzOffset(ms));
        var p = function (n) { return (n < 10 ? '0' : '') + n; };
        return p(loc.getUTCHours()) + ':' + p(loc.getUTCMinutes());
    },

    // "at 14:20" / "yesterday at 14:20" / "on Monday at 14:20" in the
    // session's timezone (the user's in the widget, the system's in the job)
    _when: function (ms, nowMs) {
        if (ms === null || ms === undefined) return '';
        var now = nowMs || this._nowMs();
        var loc = new Date(ms + this._tzOffset(ms));
        var nl = new Date(now + this._tzOffset(now));
        var dayA = Date.UTC(loc.getUTCFullYear(), loc.getUTCMonth(), loc.getUTCDate());
        var dayN = Date.UTC(nl.getUTCFullYear(), nl.getUTCMonth(), nl.getUTCDate());
        var diff = Math.round((dayN - dayA) / 86400000);
        var at = 'at ' + this._hhmm(ms);
        if (diff === 0) return at;
        if (diff === 1) return 'yesterday ' + at;
        if (diff === -1) return 'tomorrow ' + at;
        if (diff > 1 && diff < 7) return 'on ' + this.DAYS[loc.getUTCDay()] + ' ' + at;
        return 'on ' + this.MONTHS[loc.getUTCMonth()] + ' ' + loc.getUTCDate() + ' ' + at;
    },

    // =================================================================
    //  glide plumbing
    // =================================================================

    /**
     * time + wrap one source. fn(src) bumps src.rows and may set
     * status 'blocked' itself. zero rows gets a probe: a table where we
     * can't see a single row is a refused read (or genuinely empty) - either
     * way we say "couldn't read", never "nothing there".
     */
    _run: function (ledger, name, probeTable, deadlineAt, fn) {
        var src = { rows: 0, ms: 0, status: 'empty' };
        ledger[name] = src;
        if (deadlineAt && this._clock() > deadlineAt) {
            src.status = 'skipped';
            src.note = 'out of time';
            return;
        }
        var start = this._clock();
        try {
            fn(src);
            if (src.status !== 'blocked' && src.status !== 'error' && src.status !== 'skipped') {
                src.status = src.rows > 0 ? 'ok' : 'empty';
            }
            if (src.status === 'empty' && probeTable && !this._canSeeAny(probeTable)) {
                src.status = 'blocked';
                src.note = "couldn't read " + probeTable + ' (no rows visible at all - privilege missing?)';
            }
        } catch (e) {
            src.status = 'error';
            src.note = this._err(e);
            gs.warn('[NetraInvestigator] ' + name + ' failed: ' + src.note);
        }
        src.ms = this._clock() - start;
    },

    _canSeeAny: function (table) {
        try {
            var p = new GlideRecord(table);
            if (typeof p.isValid === 'function' && !p.isValid()) return false;
            p.setLimit(1);
            p.query();
            return p.next();
        } catch (e) { return false; }
    },

    _ciRecord: function (ciId) {
        try {
            var c = new GlideRecord('cmdb_ci');
            c.addQuery('sys_id', ciId);
            c.setLimit(1);
            c.query();
            if (c.next()) return { ok: true, name: this._str(c, 'name'), cls: this._str(c, 'sys_class_name') };
            return { ok: false, blocked: !this._canSeeAny('cmdb_ci') };
        } catch (e) { return { ok: false, blocked: true }; }
    },

    _ciName: function (ciId) {
        var r = this._ciRecord(ciId);
        return r.ok ? r.name : '';
    },

    _str: function (gr, field) {
        try {
            var v = gr.getValue(field);
            return (v === null || v === undefined) ? '' : String(v);
        } catch (e) { return ''; }
    },

    _dv: function (gr, field) {
        try {
            var v = gr.getDisplayValue(field);
            return (v === null || v === undefined) ? '' : String(v);
        } catch (e) { return ''; }
    },

    _bool: function (gr, field) {
        var v = this._str(gr, field);
        return v === '1' || v === 'true';
    },

    // read a date: getValue (utc internal) -> GlideDateTime -> epoch ms
    _ms: function (gr, field) {
        var v = this._str(gr, field);
        if (!v) return null;
        try {
            var n = Number(new GlideDateTime(v).getNumericValue());
            return n > 0 ? n : null;
        } catch (e) { return null; }
    },

    // ids end up inside encoded queries - never let one carry a ^ or a comma
    _safeId: function (id) {
        return String(id || '').replace(/[\^,=\s]/g, '');
    },

    _set: function (arr) {
        var o = {};
        for (var i = 0; i < arr.length; i++) { if (arr[i]) o[arr[i]] = 1; }
        return o;
    },

    _err: function (e) {
        return String((e && e.message) || e).substring(0, 160);
    },

    type: 'NetraInvestigator'
};
