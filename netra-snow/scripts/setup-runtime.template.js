// ============================================================
//   Netra Voice Assistant - One-Shot Install (Background Script)
//
//   USAGE:
//     1. Create a scoped app "Netra Voice Assistant" with scope "x_196061_netra"
//        (System Applications -> My Company Applications -> Create new)
//     2. System Definition -> Scripts - Background
//     3. Paste this entire script. Confirm "Run this script in:" shows your
//        x_196061_netra scope (or "global" if your instance allows cross-scope writes).
//     4. Click Run script.
//
//   IDEMPOTENT - re-running updates records in place, does not duplicate.
//
//   This script creates EVERYTHING for the Netra app:
//     - 2 tables  (x_196061_netra_notification, x_196061_netra_user_pref)
//     - 4 Script Includes  (NetraIntent, NetraTools, NetraResponder, NetraScanner)
//     - 1 Business Rule    (Netra Notify On Comment)
//     - 1 Scheduled Job    (Netra Watch, every 3 minutes)
//     - 1 Scripted REST API + 2 resources (/command, /notifications)
//     - 1 Service Portal Widget (netra-mic)
// ============================================================

(function () {
    'use strict';

    var SCOPE_NAME   = 'x_196061_netra';
    var SCOPE_SYS_ID = 'b16d304f937c4f10936af0a75d03d66f';   // known sys_id (fallback)
    var APP_LABEL    = 'Netra Voice Assistant';

    var log = [];
    function say(msg) {
        log.push(msg);
        // gs.print is fenced in scoped apps; gs.info works cross-scope
        if (typeof gs.print === 'function') {
            try { gs.print(msg); return; } catch (e) {}
        }
        gs.info(msg);
    }

    /* =========================================================
     *  EMBEDDED SOURCE  (populated by the generator)
     * ========================================================= */

    /*__EMBEDDED_SOURCE__*/

    /* =========================================================
     *  HELPERS
     * ========================================================= */

    function lookupScope(name) {
        var gr = new GlideRecord('sys_scope');
        gr.addQuery('scope', name);
        gr.setLimit(1);
        gr.query();
        return gr.next() ? String(gr.sys_id) : null;
    }

    // -------- Tables --------
    function upsertTable(name, label, scopeSysId, columns) {
        var gr = new GlideRecord('sys_db_object');
        gr.addQuery('name', name);
        gr.setLimit(1);
        gr.query();
        if (!gr.next()) {
            gr.initialize();
            gr.name = name;
            gr.label = label;
            gr.sys_scope = scopeSysId;
            gr.super_class = '';
            gr.is_extendable = false;
            gr.access = 'public';
            gr.create_access_controls = true;
            gr.insert();
            say('  + table ' + name);
        } else {
            say('  = table ' + name + ' (exists)');
        }

        columns.forEach(function (col) {
            upsertColumn(name, col, scopeSysId);
        });
    }

    function upsertColumn(tableName, col, scopeSysId) {
        var d = new GlideRecord('sys_dictionary');
        d.addQuery('name', tableName);
        d.addQuery('element', col.name);
        d.setLimit(1);
        d.query();
        if (!d.next()) {
            d.initialize();
            d.name = tableName;
            d.element = col.name;
            d.sys_scope = scopeSysId;
        }
        d.column_label = col.label || col.name;
        d.internal_type = col.type;
        d.max_length = col.length || (col.type === 'boolean' ? 40 : 40);
        if (col.type === 'reference' && col.ref) {
            d.reference = col.ref;
        }
        if (col.default != null) {
            d.default_value = String(col.default);
        }
        d.mandatory = !!col.mandatory;
        d.active = true;
        if (d.isValidRecord() && d.sys_id) d.update();
        else d.insert();
        say('    . column ' + tableName + '.' + col.name + ' (' + col.type + ')');
    }

    // -------- Script Include --------
    function upsertScriptInclude(name, scopeSysId, description, source) {
        var gr = new GlideRecord('sys_script_include');
        gr.addQuery('name', name);
        gr.addQuery('sys_scope', scopeSysId);
        gr.setLimit(1);
        gr.query();
        if (!gr.next()) {
            gr.initialize();
            gr.name = name;
            gr.api_name = SCOPE_NAME + '.' + name;
            gr.sys_scope = scopeSysId;
            gr.access = 'package_private';
            gr.client_callable = false;
            gr.active = true;
        }
        gr.description = description;
        gr.script = source;
        if (gr.sys_id && gr.isValidRecord()) gr.update();
        else gr.insert();
        say('  > script include ' + name);
    }

    // -------- Business Rule --------
    function upsertBusinessRule(name, scopeSysId, description, table, when, opts, source) {
        var gr = new GlideRecord('sys_script');
        gr.addQuery('name', name);
        gr.addQuery('sys_scope', scopeSysId);
        gr.setLimit(1);
        gr.query();
        if (!gr.next()) {
            gr.initialize();
            gr.name = name;
            gr.sys_scope = scopeSysId;
            gr.access = 'package_private';
        }
        gr.description = description;
        gr.collection = table;
        gr.when = when;
        gr.action_insert = !!opts.onInsert;
        gr.action_update = !!opts.onUpdate;
        gr.action_delete = !!opts.onDelete;
        gr.action_query  = !!opts.onQuery;
        gr.advanced = true;
        gr.active = true;
        gr.order = 100;
        gr.script = source;
        if (gr.sys_id && gr.isValidRecord()) gr.update();
        else gr.insert();
        say('  > business rule ' + name + ' on ' + table);
    }

    // -------- Scheduled Job (every N minutes) --------
    function upsertScheduledJob(name, scopeSysId, source, periodHHMMSS) {
        var gr = new GlideRecord('sysauto_script');
        gr.addQuery('name', name);
        gr.addQuery('sys_scope', scopeSysId);
        gr.setLimit(1);
        gr.query();
        if (!gr.next()) {
            gr.initialize();
            gr.name = name;
            gr.sys_scope = scopeSysId;
        }
        gr.active = true;
        gr.run_type = 'periodically';
        gr.run_period = '1970-01-01 ' + periodHHMMSS;
        gr.run_start = new GlideDateTime();
        gr.script = source;
        if (gr.sys_id && gr.isValidRecord()) gr.update();
        else gr.insert();
        say('  > scheduled job ' + name + ' (every ' + periodHHMMSS + ')');
    }

    // -------- Scripted REST API --------
    function upsertScriptedRestService(name, apiId, scopeSysId) {
        var gr = new GlideRecord('sys_ws_definition');
        gr.addQuery('service_id', apiId);
        gr.addQuery('sys_scope', scopeSysId);
        gr.setLimit(1);
        gr.query();
        if (!gr.next()) {
            gr.initialize();
            gr.name = name;
            gr.service_id = apiId;
            gr.sys_scope = scopeSysId;
        }
        gr.short_description = 'Voice command endpoints for Netra.';
        if (gr.sys_id && gr.isValidRecord()) gr.update();
        else gr.insert();
        say('  > scripted REST service ' + name + ' (/api/' + SCOPE_NAME + '/' + apiId + ')');
        return String(gr.sys_id);
    }

    function upsertScriptedRestOp(serviceSysId, name, method, path, scopeSysId, source) {
        var gr = new GlideRecord('sys_ws_operation');
        gr.addQuery('name', name);
        gr.addQuery('web_service_definition', serviceSysId);
        gr.setLimit(1);
        gr.query();
        if (!gr.next()) {
            gr.initialize();
            gr.name = name;
            gr.web_service_definition = serviceSysId;
            gr.sys_scope = scopeSysId;
        }
        gr.http_method = method;
        gr.relative_path = path;
        gr.requires_authentication = true;
        gr.requires_acl_authorization = false;
        gr.active = true;
        gr.produces = 'application/json';
        gr.consumes = 'application/json';
        gr.operation_script = source;
        if (gr.sys_id && gr.isValidRecord()) gr.update();
        else gr.insert();
        say('  > REST resource ' + method + ' ' + path);
    }

    // -------- Service Portal Widget --------
    function upsertWidget(id, name, scopeSysId, template, clientScript, serverScript, css, optionSchema) {
        var gr = new GlideRecord('sp_widget');
        gr.addQuery('id', id);
        gr.setLimit(1);
        gr.query();
        if (!gr.next()) {
            gr.initialize();
            gr.id = id;
            gr.sys_scope = scopeSysId;
        }
        gr.name = name;
        gr.template = template;
        gr.client_script = clientScript;
        gr.script = serverScript;
        gr.css = css;
        gr.option_schema = optionSchema || '[]';
        gr.public = false;
        gr.has_preview = false;
        if (gr.sys_id && gr.isValidRecord()) gr.update();
        else gr.insert();
        say('  > widget ' + id);
    }

    /* =========================================================
     *  MAIN
     * ========================================================= */

    say('=== Netra install starting ===');

    var scope = lookupScope(SCOPE_NAME);
    if (!scope) {
        // Fallback to the known sys_id if name lookup fails (some scopes
        // hide from cross-scope GlideRecord queries).
        var gr = new GlideRecord('sys_scope');
        if (gr.get(SCOPE_SYS_ID)) {
            scope = SCOPE_SYS_ID;
            say('Resolved scope by sys_id ' + SCOPE_SYS_ID);
        }
    }
    if (!scope) {
        say('');
        say('ERROR: scoped app "' + SCOPE_NAME + '" not found.');
        say('       (Also checked sys_id ' + SCOPE_SYS_ID + ' — no record.)');
        say('');
        say('Create it first:');
        say('  System Applications -> My Company Applications -> Create new');
        say('  Name:  ' + APP_LABEL);
        say('  Scope: ' + SCOPE_NAME);
        say('Then re-run this script.');
        return;
    }
    say('Using scope ' + SCOPE_NAME + ' (sys_id ' + scope + ')');

    say('');
    say('Tables...');
    upsertTable('x_196061_netra_notification', 'Netra Notification', scope, [
        { name: 'user',          type: 'reference', ref: 'sys_user', label: 'User' },
        { name: 'ticket_sys_id', type: 'string',    length: 32,   label: 'Ticket sys_id' },
        { name: 'ticket_number', type: 'string',    length: 32,   label: 'Ticket Number' },
        { name: 'kind',          type: 'string',    length: 40,   label: 'Kind' },
        { name: 'message',       type: 'string',    length: 1000, label: 'Message' },
        { name: 'delivered',     type: 'boolean',                 label: 'Delivered', default: 'false' },
        { name: 'delivered_at',  type: 'glide_date_time',         label: 'Delivered At' }
    ]);
    upsertTable('x_196061_netra_user_pref', 'Netra User Pref', scope, [
        { name: 'user',              type: 'reference', ref: 'sys_user', label: 'User' },
        { name: 'active',            type: 'boolean',                 label: 'Active', default: 'true' },
        { name: 'paused_until',      type: 'glide_date_time',         label: 'Paused Until' },
        { name: 'last_scan_time',    type: 'glide_date_time',         label: 'Last Scan' },
        { name: 'watch_assignments', type: 'boolean',                 label: 'Watch Assignments', default: 'true' },
        { name: 'watch_comments',    type: 'boolean',                 label: 'Watch Comments',    default: 'true' },
        { name: 'watch_approvals',   type: 'boolean',                 label: 'Watch Approvals',   default: 'true' }
    ]);

    say('');
    say('Script Includes...');
    upsertScriptInclude('NetraIntent',    scope, 'Regex intent parser with smalltalk + multi-turn.',     SRC.NetraIntent);
    upsertScriptInclude('NetraTools',     scope, 'GlideRecord ops for incidents + user prefs.',           SRC.NetraTools);
    upsertScriptInclude('NetraResponder', scope, 'Composes spoken replies; pause dialogue.',              SRC.NetraResponder);
    upsertScriptInclude('NetraScanner',   scope, 'Periodic scanner for assignments / approvals / tasks.', SRC.NetraScanner);

    say('');
    say('Business Rule...');
    upsertBusinessRule(
        'Netra Notify On Comment', scope,
        'Async after-insert on sys_journal_field; enqueues a notification.',
        'sys_journal_field', 'async', { onInsert: true },
        SRC.netra_notify_on_comment
    );

    say('');
    say('Scheduled Job...');
    upsertScheduledJob('Netra Watch', scope, SRC.netra_watch, '00:03:00');

    say('');
    say('Scripted REST API...');
    var svc = upsertScriptedRestService('Netra Voice', 'voice', scope);
    upsertScriptedRestOp(svc, 'command',       'POST', '/command',       scope, SRC.command);
    upsertScriptedRestOp(svc, 'notifications', 'GET',  '/notifications', scope, SRC.notifications);

    say('');
    say('Service Portal Widget...');
    upsertWidget('netra-mic', 'Netra Mic', scope,
                 SRC.template, SRC.client, SRC.server, SRC.stylesheet, '[]');

    say('');
    say('=== Netra install complete ===');
    say('');
    say('Last step: Service Portal -> Service Portal Configuration -> Designer');
    say('Open the "Service Portal home" page, drag the "Netra Mic" widget onto it, save.');
    say('Then open /sp in Chrome or Edge, allow microphone, and say "Netra".');

})();
