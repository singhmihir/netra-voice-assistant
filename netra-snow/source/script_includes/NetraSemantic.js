/**
 * NetraSemantic - the ticket semantic engine, out of the widget. (R18)
 *
 * Same engine the widget has used since R16 (resolution memory, predictive
 * triage, duplicate guard), moved into a script include so background work
 * - the mission runner, the scanner - can use it too. The widget functions
 * are meant to become thin wrappers over this, so thresholds, text
 * building, the cache table and the return shapes are kept identical on
 * purpose. If you tune a number here, you are tuning the widget as well.
 *
 * What changed vs the widget copy, and why:
 *  - no 5000-row vector preload. candidates are scanned first, then only
 *    THEIR vectors are pulled from the cache (source_sys_id IN ..., chunked)
 *  - opts.maxLive caps live embeds per search (missions give each item 2)
 *    and counts attempts, not just successes - a dead endpoint used to get
 *    one HTTP call per uncached ticket
 *  - an HTTP 429 comes back as { error, code: 429, retry_ms } with the delay
 *    read from RetryInfo in the FULL body, and this instance stops calling
 *    the endpoint until that delay is up
 *  - query embeds are memoised per instance, so triage + duplicates +
 *    resolved lookalike on the same text cost ONE query embed
 *  - every data source reports { rows, ms, status } so a blocked or broken
 *    read says so instead of looking like "no lookalikes"
 *  - cache rows are written with setDateNumericValue, never a date string
 *
 * Embedding calls (embedContent) only. Nothing in here talks to a text
 * model, so it is safe to run from a scheduled job.
 */
var NetraSemantic = Class.create();
NetraSemantic.prototype = {
    initialize: function (options) {
        options = options || {};
        this.SCOPE = 'x_196061_netra_v1';
        this.EMBED_MODEL = 'gemini-embedding-001';
        this.EMBED_DIMS  = 768;
        this.EMBED_CACHE_TABLE = this.SCOPE + '_kb_embedding';
        this.INC_SIM_THRESHOLD  = 0.62;   // a bit stricter than KB (0.55): ticket text is short and noisy
        this.INC_EMBED_MAX_LIVE = 6;      // live embed calls per search, keeps a chat turn snappy
        this.INC_SCAN_LIMIT     = 400;    // how many tickets we will consider in one pass
        this.CACHE_CHUNK        = 100;    // ids per IN query - keeps the encoded query well under URL/SQL limits
        this.VEC_MEMO_MAX       = 1500;   // parsed vectors kept per instance (768 doubles each)
        this.QUERY_MEMO_MAX     = 30;
        this.DEFAULT_RETRY_MS   = 60000;  // 429 with no RetryInfo: back off a minute

        // memoScans: reuse candidate scans inside ONE instance. the mission
        // runner builds one instance per pass and nothing writes tickets
        // during review, so re-querying 400 rows per item is pure waste.
        // the widget leaves it off (one instance per request anyway).
        this.memoScans = !!options.memoScans;

        this.embedCalls = 0;       // HTTP calls actually sent, for accounting
        this.embedErrors = 0;
        this._restUntilMs = 0;     // set by a 429; no HTTP before this
        this._restInfo = null;
        this._queryMemo = {};
        this._queryMemoKeys = [];
        this._vecs = {};
        this._vecCount = 0;
        this._scanMemo = {};
    },

    // ---- embedding ------------------------------------------------------

    /**
     * embedText(text, taskType) -> { values:[768 floats, L2-normalised] }
     *                            | { error, code?, retry_ms?, quota_kind? }
     */
    embedText: function (text, taskType) {
        var type = taskType || 'RETRIEVAL_QUERY';
        var clipped = String(text || '').substring(0, 4000);
        var memoKey = type + '|' + clipped;
        if (type === 'RETRIEVAL_QUERY' && this._queryMemo.hasOwnProperty(memoKey)) {
            return { values: this._queryMemo[memoKey], memo: true };
        }
        var nowMs = new Date().getTime();
        if (this._restUntilMs && nowMs < this._restUntilMs) {
            // already told 429 in this instance - dont hammer it again
            return { error: 'Embedding quota is resting (HTTP 429 earlier in this run)', code: 429,
                     retry_ms: this._restUntilMs - nowMs,
                     quota_kind: this._restInfo ? this._restInfo.quota_kind : 'unknown',
                     no_http: true };
        }
        var apiKey = gs.getProperty(this.SCOPE + '.gemini_api_key');
        if (!apiKey) return { error: 'API key not configured', fatal: true };
        var url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
                  this.EMBED_MODEL + ':embedContent?key=' + encodeURIComponent(apiKey);
        var body = {
            model: 'models/' + this.EMBED_MODEL,
            content: { parts: [{ text: clipped }] },
            taskType: type,
            outputDimensionality: this.EMBED_DIMS
        };
        try {
            var rm = new sn_ws.RESTMessageV2();
            rm.setEndpoint(url);
            rm.setHttpMethod('POST');
            rm.setRequestHeader('Content-Type', 'application/json');
            rm.setRequestBody(JSON.stringify(body));
            rm.setHttpTimeout(15000);
            this.embedCalls++;
            var r = rm.execute();
            var code = parseInt(String(r.getStatusCode()), 10);
            if (code !== 200) {
                this.embedErrors++;
                // read the FULL body before trimming it for the message - the
                // RetryInfo block sits at the end and a 200-char cut loses it
                var full = String(r.getBody() || '');
                var out = { error: 'HTTP ' + code + ' from embed endpoint: ' + full.substring(0, 200), code: code };
                if (code === 429) {
                    var q = this.parseRetry(full);
                    out.retry_ms = q.retry_ms || this.DEFAULT_RETRY_MS;
                    out.retry_source = q.retry_ms ? 'RetryInfo' : 'default';
                    out.quota_kind = q.quota_kind;
                    out.quota_id = q.quota_id;
                    this._restUntilMs = new Date().getTime() + out.retry_ms;
                    this._restInfo = { quota_kind: q.quota_kind };
                }
                return out;
            }
            var parsed = JSON.parse(r.getBody() || '{}');
            var values = parsed && parsed.embedding && parsed.embedding.values;
            if (!values || !values.length) { this.embedErrors++; return { error: 'Empty embedding returned' }; }
            // sub-3072 dimensions are NOT auto-normalised; L2-normalise here
            var norm = 0;
            for (var i = 0; i < values.length; i++) norm += values[i] * values[i];
            norm = Math.sqrt(norm);
            if (norm > 0) for (var j = 0; j < values.length; j++) values[j] /= norm;
            if (type === 'RETRIEVAL_QUERY') this._rememberQuery(memoKey, values);
            return { values: values };
        } catch (e) {
            this.embedErrors++;
            return { error: 'Embedding call threw: ' + (e.message || e) };
        }
    },

    /**
     * Pull the back-off out of a Gemini 429 body. Pure, no HTTP.
     * -> { retry_ms (0 if absent), quota_kind: per_day|per_minute|unknown, quota_id }
     */
    parseRetry: function (bodyString) {
        var out = { retry_ms: 0, quota_kind: 'unknown', quota_id: '' };
        var txt = String(bodyString || '');
        var parsed = null;
        try { parsed = JSON.parse(txt); } catch (e) { parsed = null; }
        var details = parsed && parsed.error && parsed.error.details;
        if (details && details.length) {
            for (var i = 0; i < details.length; i++) {
                var d = details[i] || {};
                if (String(d['@type'] || '').indexOf('RetryInfo') !== -1 && d.retryDelay) {
                    out.retry_ms = this._durationMs(d.retryDelay);
                }
                var v = d.violations || [];
                for (var j = 0; j < v.length; j++) {
                    var qid = String((v[j] && v[j].quotaId) || '');
                    if (!qid) continue;
                    if (qid.indexOf('PerDay') !== -1) {
                        out.quota_kind = 'per_day';
                        out.quota_id = qid;
                    } else if (qid.indexOf('PerMinute') !== -1 && out.quota_kind !== 'per_day') {
                        out.quota_kind = 'per_minute';
                        out.quota_id = qid;
                    } else if (!out.quota_id) {
                        out.quota_id = qid;
                    }
                }
            }
        }
        // body that isnt clean JSON (proxy wrapped, whatever) - regex it
        if (!out.retry_ms) {
            var m = txt.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
            if (m) out.retry_ms = Math.ceil(parseFloat(m[1]) * 1000);
        }
        if (out.quota_kind === 'unknown') {
            if (txt.indexOf('PerDay') !== -1) out.quota_kind = 'per_day';
            else if (txt.indexOf('PerMinute') !== -1) out.quota_kind = 'per_minute';
        }
        return out;
    },

    _durationMs: function (d) {
        if (d && typeof d === 'object') {
            var s = parseFloat(d.seconds || 0) || 0;
            var n = parseFloat(d.nanos || 0) || 0;
            return Math.ceil(s * 1000 + n / 1000000);
        }
        var m = String(d || '').match(/^\s*(\d+(?:\.\d+)?)\s*s\s*$/);
        return m ? Math.ceil(parseFloat(m[1]) * 1000) : 0;
    },

    _rememberQuery: function (key, values) {
        if (this._queryMemoKeys.length >= this.QUERY_MEMO_MAX) {
            delete this._queryMemo[this._queryMemoKeys.shift()];
        }
        this._queryMemo[key] = values;
        this._queryMemoKeys.push(key);
    },

    cosineSim: function (a, b) {
        if (!a || !b || a.length !== b.length) return 0;
        var dot = 0;
        for (var i = 0; i < a.length; i++) dot += a[i] * b[i];
        return dot;   // both vectors already L2-normalised so cosine === dot
    },

    // ---- ticket text + cache ------------------------------------------

    incTextFor: function (gr) {
        // what actually carries the meaning of a ticket: the one-liner, the
        // detail, and the category words. keep it short - embeddings dont
        // need the whole novel and short text scores cleaner.
        // works on a GlideRecord OR a buffered row with the same field names
        var bits = [
            String(gr.short_description || ''),
            String(gr.description || '').substring(0, 900),
            String(gr.category || ''),
            String(gr.subcategory || '')
        ];
        return bits.join(' \n ').replace(/\s+/g, ' ').trim().substring(0, 2000);
    },

    lazyEmbedIncident: function (gr, cacheMap) {
        var sysId = String(gr.sys_id);
        var hit = cacheMap ? cacheMap[sysId] : null;
        if (hit) {
            try { return { ok: true, vec: JSON.parse(hit.embedding), cached: true }; } catch (eP) {}
        }
        var txt = this.incTextFor(gr);
        if (!txt) return { ok: false, error: 'nothing to embed' };
        var res = this.embedText(txt, 'RETRIEVAL_DOCUMENT');
        if (res.error) {
            return { ok: false, error: res.error, code: res.code, retry_ms: res.retry_ms,
                     quota_kind: res.quota_kind, fatal: res.fatal };
        }
        try {
            var row = new GlideRecord(this.EMBED_CACHE_TABLE);
            row.initialize();
            row.source_table  = (typeof gr.getTableName === 'function') ? gr.getTableName() : String(gr._table || 'incident');
            row.source_sys_id = sysId;
            row.source_number = String(gr.number);
            row.title         = String(gr.short_description || '').substring(0, 240);
            row.body_digest   = txt.substring(0, 1500);
            row.embedding     = JSON.stringify(res.values);
            row.model         = this.EMBED_MODEL;
            // epoch write: a date string gets re-read in the session timezone.
            // guarded: a missing column must not cost us the cached vector
            if (row.isValidField('embedded_at')) row.embedded_at.setDateNumericValue(new GlideDateTime().getNumericValue());
            row.insert();
        } catch (eW) { gs.warn('[NetraSemantic] embed cache write failed: ' + (eW.message || eW)); }
        this._keepVec(sysId, res.values);
        return { ok: true, vec: res.values, cached: false };
    },

    /**
     * Targeted replacement for the old 5000-row preload: only the vectors
     * for the ids we are about to score. Parsed vectors are memoised on the
     * instance, so a second search in the same pass reads nothing.
     * -> { map: {sys_id: vec}, src: { rows, ms, status } }
     *    (src is also written to stats.sources.vector_cache)
     */
    loadVectors: function (table, ids, stats) {
        var t0 = new Date().getTime();
        var src = { rows: 0, ms: 0, status: 'ok', asked: 0 };
        var map = {};
        var need = [];
        for (var i = 0; i < ids.length; i++) {
            if (this._vecs.hasOwnProperty(ids[i])) map[ids[i]] = this._vecs[ids[i]];
            else need.push(ids[i]);
        }
        src.asked = need.length;
        try {
            for (var c = 0; c < need.length; c += this.CACHE_CHUNK) {
                var chunk = need.slice(c, c + this.CACHE_CHUNK);
                var cg = new GlideRecord(this.EMBED_CACHE_TABLE);
                if (!cg.isValid()) { src.status = 'blocked'; src.error = 'cache table not readable'; break; }
                cg.addQuery('source_table', table || 'incident');
                cg.addQuery('model', this.EMBED_MODEL);
                cg.addQuery('source_sys_id', 'IN', chunk.join(','));
                cg.setLimit(chunk.length * 2);   // a race can leave a duplicate row; either is fine
                cg.query();
                while (cg.next()) {
                    src.rows++;
                    var sid = String(cg.source_sys_id);
                    if (map.hasOwnProperty(sid)) continue;
                    try {
                        var v = JSON.parse(String(cg.embedding));
                        if (v && v.length) { map[sid] = v; this._keepVec(sid, v); }
                    } catch (eP) { /* unreadable row: treated as uncached, re-embedded if budget allows */ }
                }
            }
            if (src.status === 'ok' && need.length && !src.rows) src.status = 'empty';
        } catch (e) {
            src.status = 'error';
            src.error = String(e.message || e).substring(0, 200);
            gs.warn('[NetraSemantic] vector cache read failed: ' + src.error);
        }
        src.ms = new Date().getTime() - t0;
        if (stats && stats.sources) stats.sources.vector_cache = src;
        return { map: map, src: src };
    },

    _keepVec: function (sysId, vec) {
        if (!vec || !vec.length) return;
        if (!this._vecs.hasOwnProperty(sysId)) {
            if (this._vecCount >= this.VEC_MEMO_MAX) return;   // cap memory, just stop memoising
            this._vecCount++;
        }
        this._vecs[sysId] = vec;
    },

    /**
     * Candidate tickets, buffered as plain rows so the cache lookup can be
     * targeted at exactly these ids. -> { ok, rows:[...], src:{rows,ms,status} }
     */
    _scanCandidates: function (table, opts) {
        var limit = opts.scanLimit || this.INC_SCAN_LIMIT;
        var key = table + '|' + (opts.resolved ? 'resolved' : (opts.openOnly ? 'open' : 'all')) + '|' +
                  (opts.days ? parseInt(opts.days, 10) : '') + '|' + limit;
        if (this.memoScans && this._scanMemo[key]) {
            var m = this._scanMemo[key];
            return { ok: true, rows: m.rows, src: { rows: m.rows.length, ms: 0, status: m.rows.length ? 'ok' : 'empty', memo: true } };
        }
        var t0 = new Date().getTime();
        var src = { rows: 0, ms: 0, status: 'ok' };
        var rows = [];
        try {
            var gr = new GlideRecord(table);
            if (!gr.isValid()) {
                src.status = 'blocked';
                src.error = 'table ' + table + ' is not readable from this scope';
            } else {
                if (opts.resolved) {
                    // resolved or closed. addQuery, not the widget's 'state IN 6,7'
                    // encoded string: a space-padded operator can be dropped as an
                    // invalid term, which would silently scan open tickets too
                    gr.addQuery('state', 'IN', '6,7');
                } else if (opts.openOnly) {
                    gr.addActiveQuery();
                }
                if (opts.days) {
                    gr.addEncodedQuery('sys_created_on>=javascript:gs.daysAgoStart(' + parseInt(opts.days, 10) + ')');
                }
                gr.orderByDesc('sys_updated_on');
                gr.setLimit(limit);
                gr.query();
                while (gr.next()) {
                    rows.push({
                        sys_id:   String(gr.sys_id),
                        number:   String(gr.number),
                        short_description: String(gr.short_description || ''),
                        description: String(gr.description || '').substring(0, 900),
                        state:    String(gr.state.getDisplayValue ? gr.state.getDisplayValue() : gr.state),
                        priority: String(gr.priority),
                        category: String(gr.category || ''),
                        subcategory: String(gr.subcategory || ''),
                        assignment_group: String(gr.assignment_group.getDisplayValue ? gr.assignment_group.getDisplayValue() : ''),
                        assigned_to: String(gr.assigned_to.getDisplayValue ? gr.assigned_to.getDisplayValue() : ''),
                        close_notes: String(gr.close_notes || '').replace(/\s+/g, ' ').substring(0, 600),
                        // getValue, not the element: a GlideElement is always truthy,
                        // so `gr.resolved_at || gr.closed_at` never fell back
                        resolved_at: String(gr.getValue('resolved_at') || gr.getValue('closed_at') || ''),
                        opened: String(gr.sys_created_on || ''),
                        _gid: String(gr.getValue('assignment_group') || ''),
                        _table: table
                    });
                }
                src.rows = rows.length;
                if (!rows.length) src.status = this._looksBlocked(gr) ? 'blocked' : 'empty';
            }
        } catch (e) {
            src.status = 'error';
            src.error = String(e.message || e).substring(0, 200);
        }
        src.ms = new Date().getTime() - t0;
        var ok = src.status === 'ok' || src.status === 'empty';
        if (ok && this.memoScans) this._scanMemo[key] = { rows: rows };
        return { ok: ok, rows: rows, src: src };
    },

    _looksBlocked: function (gr) {
        // a cross-scope denial mostly shows up as zero rows plus a syslog
        // line, not an exception. canRead() is the best cheap tell we have.
        try { if (!gr.isValid()) return true; } catch (e) { return true; }
        try { if (typeof gr.canRead === 'function' && !gr.canRead()) return true; } catch (e2) { return true; }
        return false;
    },

    /**
     * The engine behind every intelligence tool: embed the query, walk a
     * filtered set of tickets, score by cosine, hand back the winners.
     * opts = { resolved:bool, openOnly:bool, limit:int, threshold:float,
     *          excludeSysId:string, table:string, days:int, scanLimit:int,
     *          maxLive:int, queryVec:[..], withGroupIds:bool }
     * -> { ok, matches:[{sys_id, number, short_description, state, priority,
     *      category, subcategory, assignment_group, assigned_to, close_notes,
     *      resolved_at, opened, score}], count, stats }
     *  | { ok:false, error, embed_failed?, code?, retry_ms?, blocked?, stats? }
     */
    semanticIncidents: function (query, opts) {
        opts = opts || {};
        var table = opts.table || 'incident';
        if (!query) return { ok: false, error: 'Give me something to look for.' };
        var stats = { scanned: 0, cached: 0, embedded_now: 0, skipped_uncached: 0, best_score: 0,
                      live_attempts: 0, sources: {} };

        var qVec = opts.queryVec || null;
        var tq = new Date().getTime();
        if (!qVec) {
            var qRes = this.embedText(query, 'RETRIEVAL_QUERY');
            stats.sources.query_embed = { rows: qRes.error ? 0 : 1, ms: new Date().getTime() - tq,
                                          status: qRes.error ? 'error' : 'ok', memo: !!qRes.memo };
            if (qRes.error) {
                return { ok: false, error: qRes.error, embed_failed: true, code: qRes.code,
                         retry_ms: qRes.retry_ms, quota_kind: qRes.quota_kind, fatal: qRes.fatal, stats: stats };
            }
            qVec = qRes.values;
        } else {
            stats.sources.query_embed = { rows: 1, ms: 0, status: 'ok', memo: true };
        }

        var scan = this._scanCandidates(table, opts);
        stats.sources.candidates = scan.src;
        if (!scan.ok) {
            // never pretend "nothing similar" when we simply could not look
            return { ok: false, blocked: scan.src.status === 'blocked',
                     error: 'I could not read ' + table + ' (' + scan.src.status + (scan.src.error ? ': ' + scan.src.error : '') + ').',
                     stats: stats };
        }
        var rows = scan.rows;
        var ids = [];
        for (var i = 0; i < rows.length; i++) {
            if (opts.excludeSysId && rows[i].sys_id === opts.excludeSysId) continue;
            ids.push(rows[i].sys_id);
        }
        var cacheMap = this.loadVectors(table, ids, stats).map;

        var maxLive = (typeof opts.maxLive === 'number') ? Math.max(0, opts.maxLive) : this.INC_EMBED_MAX_LIVE;
        var scored = [], groupIds = {}, rested = false;
        for (var r = 0; r < rows.length; r++) {
            var row = rows[r];
            stats.scanned++;
            if (opts.excludeSysId && row.sys_id === opts.excludeSysId) continue;
            var vec = cacheMap.hasOwnProperty(row.sys_id) ? cacheMap[row.sys_id] : null;
            if (vec) {
                stats.cached++;
            } else {
                if (rested || stats.live_attempts >= maxLive) { stats.skipped_uncached++; continue; }
                stats.live_attempts++;
                var er = this.lazyEmbedIncident(row, null);
                if (!er.ok) {
                    if (er.code === 429) {
                        // quota said stop - the rest of this list would just 429 too
                        rested = true;
                        stats.rate_limited = { retry_ms: er.retry_ms, quota_kind: er.quota_kind };
                    }
                    if (er.fatal) stats.fatal = er.error;
                    stats.embed_errors = (stats.embed_errors || 0) + 1;
                    stats.last_embed_error = String(er.error || '').substring(0, 160);
                    continue;
                }
                vec = er.vec;
                stats.embedded_now++;
            }
            if (row._gid && row.assignment_group) groupIds[row.assignment_group] = row._gid;
            scored.push({
                sys_id:   row.sys_id,
                number:   row.number,
                short_description: row.short_description,
                state:    row.state,
                priority: row.priority,
                category: row.category,
                subcategory: row.subcategory,
                assignment_group: row.assignment_group,
                assigned_to: row.assigned_to,
                close_notes: row.close_notes,
                resolved_at: row.resolved_at,
                opened: row.opened,
                score: this.cosineSim(qVec, vec)
            });
        }
        scored.sort(function (a, b) { return b.score - a.score; });
        var thr = (typeof opts.threshold === 'number') ? opts.threshold : this.INC_SIM_THRESHOLD;
        var top = [];
        for (var s = 0; s < scored.length && top.length < (opts.limit || 5); s++) {
            if (scored[s].score >= thr) top.push(scored[s]);
        }
        stats.best_score = scored.length ? Number(scored[0].score.toFixed(3)) : 0;
        var out = { ok: true, matches: top, count: top.length, stats: stats };
        if (opts.withGroupIds) out.group_ids = groupIds;
        return out;
    },

    // ---- 1. RESOLUTION MEMORY -------------------------------------------
    // "has this happened before, and what fixed it"
    findSimilarResolved: function (query, limit, opts) {
        var o = this._pass(opts, ['maxLive', 'excludeSysId', 'queryVec', 'scanLimit', 'table']);
        o.resolved = true;
        o.limit = Math.min(5, limit || 3);
        var r = this.semanticIncidents(query, o);
        if (!r.ok) return r;
        var withFix = [], noFix = [];
        for (var i = 0; i < r.matches.length; i++) {
            var m = r.matches[i];
            m.similarity = Number(m.score.toFixed(3));
            delete m.score;
            if (m.close_notes) withFix.push(m); else noFix.push(m);
        }
        var all = withFix.concat(noFix);
        if (!all.length) {
            return { ok: true, count: 0, matches: [], stats: r.stats,
                     message: 'Nothing in the history looks like that one. This may genuinely be new - say so, and offer to raise it.' };
        }
        return {
            ok: true, count: all.length, matches: all, stats: r.stats,
            has_fixes: withFix.length,
            message: 'Read the closest 1-2 out loud: what the old ticket was, and CRUCIALLY what the close notes say fixed it. Mention how long ago it was. Do not read the similarity numbers aloud.'
        };
    },

    // ---- 2. PREDICTIVE TRIAGE (instance vote only) ------------------------
    // the personal prior stays in the widget: it reads the per-user blob,
    // which a background job has no business touching. personal_pick is
    // always null here; the widget wrapper fills it and rewrites message.
    triageVotes: function (description, opts) {
        if (!description) return { ok: false, error: 'I need the ticket wording to work from.' };
        var o = this._pass(opts, ['maxLive', 'excludeSysId', 'queryVec', 'table']);
        o.limit = 12;
        o.threshold = 0.55;
        o.scanLimit = this.INC_SCAN_LIMIT;
        o.withGroupIds = true;
        var r = this.semanticIncidents(description, o);
        if (!r.ok) return r;
        if (!r.matches.length) {
            return { ok: true, confident: false, sample_size: 0, stats: r.stats,
                     message: 'No lookalikes in the history, so I have nothing solid to base a routing guess on. Say that honestly rather than guessing.' };
        }
        var groups = this._tally(r.matches, 'assignment_group');
        var cats   = this._tally(r.matches, 'category');
        var prios  = this._tally(r.matches, 'priority');
        var top = groups[0];
        var pickEvidence = [];
        if (top) {
            for (var i = 0; i < r.matches.length && pickEvidence.length < 3; i++) {
                if (String(r.matches[i].assignment_group || '').trim() === top.value) pickEvidence.push(r.matches[i].number);
            }
        }
        // how many lookalikes actually carry a group. sample_size counts
        // unassigned lookalikes too (they cast no vote), so "confident" can
        // rest on a single voter; callers that WRITE should check this
        var voters = 0;
        for (var vi = 0; vi < r.matches.length; vi++) {
            if (String(r.matches[vi].assignment_group || '').trim()) voters++;
        }
        var evidence = [];
        for (var e = 0; e < r.matches.length && e < 3; e++) {
            var m = r.matches[e];
            evidence.push({ number: m.number, short_description: m.short_description,
                            assignment_group: m.assignment_group, priority: m.priority });
        }
        return {
            ok: true,
            confident: !!(top && top.share >= 0.5 && r.matches.length >= 3),
            sample_size: r.matches.length,
            voters: voters,
            assignment_group: groups,
            category: cats,
            priority: prios,
            instance_pick: top || null,
            personal_pick: null,
            evidence: evidence,
            pick_evidence: pickEvidence,
            group_ids: r.group_ids || {},
            stats: r.stats,
            message: 'Say it like a colleague would: "tickets like this usually go to X" with the share as a rough word (most / about half / some), name one example ticket, then ASK before actually assigning anything.'
        };
    },

    // weight each vote by how similar that ticket actually is
    _tally: function (matches, field) {
        var bag = {};
        for (var i = 0; i < matches.length; i++) {
            var v = String(matches[i][field] || '').trim();
            if (!v) continue;
            bag[v] = (bag[v] || 0) + matches[i].score;
        }
        var out = [];
        for (var k in bag) if (bag.hasOwnProperty(k)) out.push({ value: k, weight: bag[k] });
        out.sort(function (a, b) { return b.weight - a.weight; });
        var total = 0;
        for (var j = 0; j < out.length; j++) total += out[j].weight;
        var res = [];
        for (var n = 0; n < out.length && n < 3; n++) {
            res.push({ value: out[n].value, share: total ? Number((out[n].weight / total).toFixed(2)) : 0 });
        }
        return res;
    },

    // ---- 3. DUPLICATE GUARD ---------------------------------------------
    // stop the 4th ticket for one outage before it exists
    checkDuplicates: function (description, excludeSysId, opts) {
        if (!description) return { ok: false, error: 'I need the wording to compare against.' };
        var o = this._pass(opts, ['maxLive', 'queryVec', 'scanLimit', 'table']);
        o.openOnly = true;
        o.limit = 4;
        o.threshold = 0.68;
        o.excludeSysId = excludeSysId || '';
        var r = this.semanticIncidents(description, o);
        if (!r.ok) return r;
        if (!r.matches.length) {
            return { ok: true, duplicates: [], count: 0, clear: true, stats: r.stats,
                     message: 'Nothing open looks like this - safe to raise a fresh one.' };
        }
        for (var i = 0; i < r.matches.length; i++) {
            r.matches[i].similarity = Number(r.matches[i].score.toFixed(3));
            delete r.matches[i].score;
        }
        return {
            ok: true, clear: false, count: r.matches.length, duplicates: r.matches, stats: r.stats,
            message: 'There is already an open ticket that looks like the same thing. Tell them the number and what it says, then ASK: add to that one, or still raise a new one? Do not create anything until they choose.'
        };
    },

    // only the knobs a caller may turn - the thresholds that define each
    // tool stay fixed so a wrapper cant quietly change what "duplicate" means
    _pass: function (opts, keys) {
        var o = {};
        if (!opts) return o;
        for (var i = 0; i < keys.length; i++) {
            if (opts.hasOwnProperty(keys[i]) && opts[keys[i]] !== undefined && opts[keys[i]] !== null) o[keys[i]] = opts[keys[i]];
        }
        return o;
    },

    type: 'NetraSemantic'
};
