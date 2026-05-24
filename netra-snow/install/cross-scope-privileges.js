/**
 * Netra — cross-scope privilege bootstrapper
 *
 * Run this once via Scripts - Background (System Definition > Scripts -
 * Background) after installing the Netra widget on a fresh instance.
 *
 * Why: ServiceNow scoped apps default to NO cross-scope privileges. Every
 * GlideRecord call from x_196061_netra_v1 to an OOB table (incident,
 * sysapproval_approver, kb_knowledge, sys_journal_field, etc.) silently
 * returns an empty result set until the matching sys_scope_privilege row
 * is created with status="allowed".
 *
 * Symptom on missing privileges: "you have no pending approvals" when in
 * fact the user has 15. Lists return empty. Tools degrade with no error.
 *
 * This script idempotently creates every privilege Netra needs. Re-runs
 * are safe — existing rows are skipped.
 *
 * Tested on dev373407 (Yokohama Patch 6, May 2026). Run as admin.
 */
(function () {
    var SCOPE_SYS_ID = 'cbb86f0f93b0cf10936af0a75d03d662';   // x_196061_netra_v1

    // table_name -> array of operations
    var rules = {
        // tables Netra READS
        'incident'                        : ['read'],
        'change_request'                  : ['read'],
        'problem'                         : ['read'],
        'sc_req_item'                     : ['read'],
        'sc_task'                         : ['read'],
        'kb_knowledge'                    : ['read'],
        'sys_user'                        : ['read'],
        'sys_user_group'                  : ['read'],
        'sysapproval_approver'            : ['read'],
        'sys_journal_field'               : ['read'],
        'sys_attachment'                  : ['read'],
        'sys_dictionary'                  : ['read'],
        'sys_dictionary_override'         : ['read'],
        'sys_data_policy_rule'            : ['read'],
        'sys_ui_policy'                   : ['read'],
        'sys_ui_policy_action'            : ['read'],
        'sys_db_object'                   : ['read'],
        'sys_app'                         : ['read'],
        'sys_script_include'              : ['read'],
        'sys_script'                      : ['read'],
        'sysauto_script'                  : ['read'],
        'sys_ws_definition'               : ['read'],
        'sys_ws_operation'                : ['read'],
        'sp_widget'                       : ['read'],
        'sys_sidebar_discussion'          : ['read'],
        'sys_sidebar_discussion_participant' : ['read'],
        'sys_sidebar_discussion_message'  : ['read'],
        'sys_cs_message'                  : ['read'],
        'sys_cs_session'                  : ['read'],
        'sys_cs_session_member'           : ['read'],
        'live_group'                      : ['read'],
        'live_group_profile'              : ['read'],
        'live_message'                    : ['read'],
        'cmdb_ci_appl'                    : ['read'],
        'sys_choice'                      : ['read'],
        'sc_cat_item'                     : ['read'],
        'sys_user_preference'             : ['read'],

        // tables Netra WRITES / CREATES
        'incident'                        : ['read', 'write', 'create'],
        'change_request'                  : ['read', 'write', 'create'],
        'problem'                         : ['read', 'write', 'create'],
        'sysapproval_approver'            : ['read', 'write'],
        'sys_journal_field'               : ['read', 'write', 'create'],
        'sys_sidebar_discussion'          : ['read', 'write', 'create'],
        'sys_sidebar_discussion_participant' : ['read', 'write', 'create'],
        'sys_sidebar_discussion_message'  : ['read', 'write', 'create'],
        'live_group'                      : ['read', 'write', 'create'],
        'live_group_profile'              : ['read', 'write', 'create'],
        'live_message'                    : ['read', 'write', 'create'],
        'sys_properties'                  : ['read', 'write'],
        'sys_user_preference'             : ['read', 'write', 'create', 'delete']
    };

    var created = 0, skipped = 0, failed = 0;

    Object.keys(rules).forEach(function (table) {
        rules[table].forEach(function (op) {
            // Idempotency check
            var existing = new GlideRecord('sys_scope_privilege');
            existing.addQuery('source', SCOPE_SYS_ID);
            existing.addQuery('target_type', 'sys_db_object');
            existing.addQuery('target_name', table);
            existing.addQuery('operation', op);
            existing.setLimit(1);
            existing.query();
            if (existing.next()) { skipped++; return; }

            var gr = new GlideRecord('sys_scope_privilege');
            gr.initialize();
            gr.source = SCOPE_SYS_ID;
            gr.target_type = 'sys_db_object';
            gr.target_name = table;
            gr.operation = op;
            gr.status = 'allowed';
            var sid = gr.insert();
            if (sid) { created++; }
            else { failed++; gs.warn('[Netra install] failed to create ' + table + '/' + op); }
        });
    });

    gs.info('[Netra install] cross-scope privileges - created=' + created +
            ' skipped(existing)=' + skipped + ' failed=' + failed);
})();
