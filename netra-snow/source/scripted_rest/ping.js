/**
 * Scripted REST resource: GET /api/__NETRA_SCOPE__/voice/ping
 *
 * Debug-only. Returns a small JSON document that proves:
 *   - the Scripted REST API is reachable
 *   - authentication worked
 *   - the script in this resource is being executed
 *
 * Use this any time the widget reports a 400. If /ping ALSO 400s, the
 * problem is the API plumbing (scope, ACL, resource not active, etc.).
 * If /ping succeeds but /command 400s, the problem is somewhere in
 * NetraIntent / NetraResponder / one of the helper Script Includes.
 *
 * Try it in the browser address bar:
 *   https://YOUR-INSTANCE.service-now.com/api/__NETRA_SCOPE__/voice/ping
 *
 * Expected:
 *   { "ok": true, "now": "2026-...", "scope": "__NETRA_SCOPE__",
 *     "user": "<your sys_id>", "user_name": "<your username>",
 *     "scripts": { "NetraIntent": true, "NetraResponder": true, ... } }
 */
(function process(request, response) {

    var out = {
        ok: true,
        now: String(new GlideDateTime()),
        scope: '__NETRA_SCOPE__',
        user: '',
        user_name: '',
        scripts: {}
    };

    try { out.user = String(gs.getUserID()); } catch (e) {}
    try { out.user_name = String(gs.getUserName()); } catch (e) {}

    // Probe each Script Include - true if the constructor doesn't throw
    [
        'NetraIntent', 'NetraTools', 'NetraResponder', 'NetraScanner',
        'NetraKnowledge', 'NetraChat', 'NetraSummarizer', 'NetraContext',
        'NetraNavigator', 'NetraVulnerability', 'NetraPerformance'
    ].forEach(function (name) {
        try {
            var ctor = (typeof __NETRA_SCOPE__ !== 'undefined' && __NETRA_SCOPE__[name]) ||
                       (typeof global !== 'undefined' && global[name]);
            // Fall back: evaluate by name in this scope
            if (!ctor) {
                /*jshint evil:true */
                ctor = eval(name);
            }
            new ctor();
            out.scripts[name] = true;
        } catch (e) {
            out.scripts[name] = String(e.message || e);
        }
    });

    // Probe each table
    out.tables = {};
    ['notification', 'user_pref', 'context', 'watchlist', 'kb_embedding'].forEach(function (suffix) {
        var tableName = '__NETRA_SCOPE___' + suffix;
        try {
            var gr = new GlideRecord(tableName);
            out.tables[tableName] = gr.isValid();
        } catch (e) {
            out.tables[tableName] = String(e.message || e);
        }
    });

    return out;

})(request, response);
