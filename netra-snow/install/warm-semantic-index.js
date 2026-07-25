/**
 * Netra - warm the semantic index (R16)
 *
 * Run this once after installing Netra (System Definition > Scripts -
 * Background, in the Netra scope, or as a one-shot scheduled job).
 *
 * What it does: embeds your existing incidents with the same Gemini
 * embedding model the widget uses and caches the vectors in
 * x_196061_netra_v1_kb_embedding. After this, "has this happened before"
 * and the triage suggestions work instantly instead of warming up a
 * handful of tickets at a time as you talk.
 *
 * Safe to re-run - it skips anything already indexed. If you have
 * thousands of tickets, run it a few times (BATCH caps each run so the
 * transaction never times out).
 */
(function () {
    var SCOPE       = 'x_196061_netra_v1';
    var EMBED_MODEL = 'gemini-embedding-001';
    var EMBED_DIMS  = 768;
    var CACHE_TABLE = SCOPE + '_kb_embedding';
    var BATCH       = 60;     // embeddings per run
    var TABLE       = 'incident';

    var apiKey = gs.getProperty(SCOPE + '.gemini_api_key');
    if (!apiKey) {
        gs.error('[netra-warm] no API key in ' + SCOPE + '.gemini_api_key - set it first');
        return;
    }

    function embed(text) {
        var url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
                  EMBED_MODEL + ':embedContent?key=' + encodeURIComponent(apiKey);
        var body = {
            model: 'models/' + EMBED_MODEL,
            content: { parts: [{ text: String(text || '').substring(0, 4000) }] },
            taskType: 'RETRIEVAL_DOCUMENT',
            outputDimensionality: EMBED_DIMS
        };
        try {
            var rm = new sn_ws.RESTMessageV2();
            rm.setEndpoint(url);
            rm.setHttpMethod('POST');
            rm.setRequestHeader('Content-Type', 'application/json');
            rm.setRequestBody(JSON.stringify(body));
            rm.setHttpTimeout(15000);
            var r = rm.execute();
            if (r.getStatusCode() !== 200) {
                return { error: 'HTTP ' + r.getStatusCode() + ': ' + String(r.getBody() || '').substring(0, 160) };
            }
            var parsed = JSON.parse(r.getBody() || '{}');
            var v = parsed && parsed.embedding && parsed.embedding.values;
            if (!v || !v.length) return { error: 'empty embedding' };
            // sub-3072 dims come back un-normalised, so do it here - the
            // widget compares with a plain dot product
            var norm = 0, i;
            for (i = 0; i < v.length; i++) norm += v[i] * v[i];
            norm = Math.sqrt(norm);
            if (norm > 0) for (i = 0; i < v.length; i++) v[i] /= norm;
            return { values: v };
        } catch (e) {
            return { error: 'threw: ' + (e.message || e) };
        }
    }

    // what is already indexed
    var have = {};
    var cg = new GlideRecord(CACHE_TABLE);
    cg.addQuery('source_table', TABLE);
    cg.addQuery('model', EMBED_MODEL);
    cg.setLimit(10000);
    cg.query();
    while (cg.next()) have[String(cg.source_sys_id)] = true;

    var done = 0, skipped = 0, failed = 0;
    var gr = new GlideRecord(TABLE);
    gr.orderByDesc('sys_updated_on');
    gr.setLimit(1000);
    gr.query();
    while (gr.next() && done < BATCH) {
        var sysId = String(gr.sys_id);
        if (have[sysId]) { skipped++; continue; }
        var txt = [
            String(gr.short_description || ''),
            String(gr.description || '').substring(0, 900),
            String(gr.category || ''),
            String(gr.subcategory || '')
        ].join(' \n ').replace(/\s+/g, ' ').trim().substring(0, 2000);
        if (!txt) { skipped++; continue; }
        var res = embed(txt);
        if (res.error) {
            failed++;
            gs.warn('[netra-warm] ' + gr.number + ' failed: ' + res.error);
            continue;
        }
        try {
            var row = new GlideRecord(CACHE_TABLE);
            row.initialize();
            row.source_table  = TABLE;
            row.source_sys_id = sysId;
            row.source_number = String(gr.number);
            row.title         = String(gr.short_description || '').substring(0, 240);
            row.body_digest   = txt.substring(0, 1500);
            row.embedding     = JSON.stringify(res.values);
            row.model         = EMBED_MODEL;
            row.embedded_at   = new GlideDateTime().toString();
            row.insert();
            done++;
        } catch (eW) {
            failed++;
            gs.warn('[netra-warm] cache write failed for ' + gr.number + ': ' + (eW.message || eW));
        }
    }

    gs.info('[netra-warm] DONE embedded=' + done + ' already=' + skipped + ' failed=' + failed);
})();
