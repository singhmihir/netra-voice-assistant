// ============================================================================
//   Cross-Scope Privilege Restorer + Auto-Healer  (run once, TEMPORARY)
//
//   WHY: an earlier maintenance script queried a nonexistent 'source' column
//   on sys_scope_privilege. GlideRecord silently ignores unknown fields, so a
//   dedupe pass matched — and deleted — 'allowed' grant rows belonging to many
//   apps on this instance (not just Netra). Symptom: red banners like
//   "Execute operation on API 'Glide API: properties' from scope
//   'Now Assist Admin Console' was denied" and Service Portal panels showing
//   "Requested record not found" (e.g. the ticket page Activity tab).
//
//   WHAT THIS DOES (idempotent, safe to re-run):
//     1. Restores the 2 grants the Now Assist Admin Console needs.
//     2. Scans the recent denial log and recreates every missing grant it
//        finds, for ANY app, with the correct source_scope.
//     3. Installs a global scheduled job "Cross-Scope Privilege Auto-Healer
//        (temporary)" that repeats step 2 every 5 minutes, so grants heal as
//        features get exercised.
//
//   HOW TO RUN:
//     System Definition > Scripts - Background  ->  paste  ->  Run script
//     (Run in scope: global)
//
//   CLEANUP (after a few quiet days):
//     System Definition > Scheduled Jobs -> open "Cross-Scope Privilege
//     Auto-Healer (temporary)" -> Delete (or set Active = false).
//     Confirm it is quiet first: filter syslog for "[PrivHealer]".
// ============================================================================

(function () {
    var out = { nowassist: [], healer_job: '', healed_now: [], log: [] };

    function ensureGrant(scopeSysId, targetType, targetName, operation) {
        var ex = new GlideRecord('sys_scope_privilege');
        ex.addQuery('source_scope', scopeSysId);
        ex.addQuery('target_name', targetName);
        ex.addQuery('operation', operation);
        ex.addQuery('status', 'allowed');
        ex.setLimit(1); ex.query();
        if (ex.next()) return 'existed';
        var gr = new GlideRecord('sys_scope_privilege');
        gr.initialize();
        gr.setValue('source_scope', scopeSysId);
        gr.setValue('sys_scope', scopeSysId);
        gr.setValue('target_scope', 'global');
        gr.setValue('target_type', targetType);
        gr.setValue('target_name', targetName);
        gr.setValue('operation', operation);
        gr.setValue('status', 'allowed');
        return gr.insert() ? 'created' : 'FAILED';
    }

    // ---- 1. the two Now Assist Admin Console grants (user-approved) ----
    var sc = new GlideRecord('sys_scope');
    sc.addQuery('scope', 'sn_nowassist_admin');
    sc.setLimit(1); sc.query();
    if (sc.next()) {
        var naId = String(sc.sys_id);
        out.nowassist.push('Glide API: properties -> ' + ensureGrant(naId, 'scriptable', 'Glide API: properties', 'execute'));
        out.nowassist.push('Glide API: string utilities -> ' + ensureGrant(naId, 'scriptable', 'Glide API: string utilities', 'execute'));
    } else out.nowassist.push('scope sn_nowassist_admin NOT FOUND');

    // ---- 2. the healer logic (also embedded in the scheduled job below) ----
    function healFromSyslog(hoursBack) {
        var healed = [];
        var seen = {};
        var lg = new GlideRecord('syslog');
        lg.addEncodedQuery('sys_created_on>javascript:gs.hoursAgoStart(' + hoursBack + ')^messageLIKECrossScopeAccessNotAllowed^ORmessageLIKEwas denied. The application^ORmessageLIKEnot allowed:');
        lg.orderByDesc('sys_created_on');
        lg.setLimit(400);
        lg.query();
        while (lg.next()) {
            var msg = String(lg.message);
            var m, scopeToken = null, target = null, ttype = 'scriptable', op = 'execute';
            m = msg.match(/Access to (.+?) from scope ([\w.]+) not allowed/);
            if (m) { target = m[1]; scopeToken = m[2]; }
            if (!target) {
                m = msg.match(/Execute operation on API '(.+?)' from scope '(.+?)' was denied/);
                if (m) { target = m[1]; scopeToken = m[2]; }
            }
            if (!target) {
                m = msg.match(/(Read|Write|Create|Delete) operation on table '([\w_]+)' from scope '?([\w.]+)'?/i);
                if (m) { op = m[1].toLowerCase(); target = m[2]; ttype = 'sys_db_object'; scopeToken = m[3]; }
            }
            if (!target || !scopeToken) continue;
            var key = scopeToken + '|' + target + '|' + op;
            if (seen[key]) continue;
            seen[key] = true;
            // resolve requesting scope by scope string, then by name
            var rs = new GlideRecord('sys_scope');
            rs.addQuery('scope', scopeToken);
            rs.setLimit(1); rs.query();
            if (!rs.next()) {
                rs = new GlideRecord('sys_scope');
                rs.addQuery('name', scopeToken);
                rs.setLimit(1); rs.query();
                if (!rs.next()) continue;
            }
            var res = ensureGrant(String(rs.sys_id), ttype, target, op);
            if (res === 'created') healed.push(scopeToken + ': ' + target + '/' + op);
        }
        return healed;
    }

    // first pass over the backlog since the damage window
    out.healed_now = healFromSyslog(6);

    // ---- 3. install the scheduled job (global, every 5 minutes) ----
    var JOB = 'Cross-Scope Privilege Auto-Healer (temporary)';
    var jobScript = "// TEMPORARY - recreates cross-scope privilege grants deleted on 2026-07-09.\n" +
        "// Watches the denial log and re-adds 'allowed' rows for any app as errors surface.\n" +
        "// Safe to disable/delete once no new '[PrivHealer]' entries appear in syslog for a few days.\n" +
        "(function () {\n" +
        "    function ensureGrant(scopeSysId, targetType, targetName, operation) {\n" +
        "        var ex = new GlideRecord('sys_scope_privilege');\n" +
        "        ex.addQuery('source_scope', scopeSysId);\n" +
        "        ex.addQuery('target_name', targetName);\n" +
        "        ex.addQuery('operation', operation);\n" +
        "        ex.addQuery('status', 'allowed');\n" +
        "        ex.setLimit(1); ex.query();\n" +
        "        if (ex.next()) return false;\n" +
        "        var gr = new GlideRecord('sys_scope_privilege');\n" +
        "        gr.initialize();\n" +
        "        gr.setValue('source_scope', scopeSysId);\n" +
        "        gr.setValue('sys_scope', scopeSysId);\n" +
        "        gr.setValue('target_scope', 'global');\n" +
        "        gr.setValue('target_type', targetType);\n" +
        "        gr.setValue('target_name', targetName);\n" +
        "        gr.setValue('operation', operation);\n" +
        "        gr.setValue('status', 'allowed');\n" +
        "        return !!gr.insert();\n" +
        "    }\n" +
        "    var seen = {};\n" +
        "    var lg = new GlideRecord('syslog');\n" +
        "    lg.addEncodedQuery('sys_created_on>javascript:gs.minutesAgoStart(10)^messageLIKECrossScopeAccessNotAllowed^ORmessageLIKEwas denied. The application^ORmessageLIKEnot allowed:');\n" +
        "    lg.orderByDesc('sys_created_on');\n" +
        "    lg.setLimit(200);\n" +
        "    lg.query();\n" +
        "    while (lg.next()) {\n" +
        "        var msg = String(lg.message);\n" +
        "        var m, scopeToken = null, target = null, ttype = 'scriptable', op = 'execute';\n" +
        "        m = msg.match(/Access to (.+?) from scope ([\\w.]+) not allowed/);\n" +
        "        if (m) { target = m[1]; scopeToken = m[2]; }\n" +
        "        if (!target) { m = msg.match(/Execute operation on API '(.+?)' from scope '(.+?)' was denied/); if (m) { target = m[1]; scopeToken = m[2]; } }\n" +
        "        if (!target) { m = msg.match(/(Read|Write|Create|Delete) operation on table '([\\w_]+)' from scope '?([\\w.]+)'?/i); if (m) { op = m[1].toLowerCase(); target = m[2]; ttype = 'sys_db_object'; scopeToken = m[3]; } }\n" +
        "        if (!target || !scopeToken) continue;\n" +
        "        var key = scopeToken + '|' + target + '|' + op;\n" +
        "        if (seen[key]) continue;\n" +
        "        seen[key] = true;\n" +
        "        var rs = new GlideRecord('sys_scope');\n" +
        "        rs.addQuery('scope', scopeToken); rs.setLimit(1); rs.query();\n" +
        "        if (!rs.next()) { rs = new GlideRecord('sys_scope'); rs.addQuery('name', scopeToken); rs.setLimit(1); rs.query(); if (!rs.next()) continue; }\n" +
        "        if (ensureGrant(String(rs.sys_id), ttype, target, op))\n" +
        "            gs.info('[PrivHealer] restored ' + scopeToken + ' -> ' + target + '/' + op);\n" +
        "    }\n" +
        "})();";

    var job = new GlideRecord('sysauto_script');
    job.addQuery('name', JOB);
    job.setLimit(1); job.query();
    if (!job.next()) { job.initialize(); job.setValue('name', JOB); }
    job.setValue('sys_scope', 'global');
    job.setValue('active', true);
    job.setValue('run_type', 'periodically');
    job.setValue('run_period', '1970-01-01 00:05:00');
    job.setValue('run_start', new GlideDateTime());
    job.setValue('script', jobScript);
    if (job.sys_id && job.isValidRecord()) { job.update(); out.healer_job = 'updated ' + String(job.sys_id); }
    else { out.healer_job = 'created ' + String(job.insert()); }

    gs.print('RESULT=' + JSON.stringify(out));
})();
