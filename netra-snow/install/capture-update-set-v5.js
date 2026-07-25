/**
 * Netra - v5.0 master update-set capture (idempotent-ish; safe to re-run,
 * it rebuilds the same sets).
 *
 * Run as: System Definition > Scripts - Background (GLOBAL scope), or let
 * the one-shot scheduled job created by the deploy tooling fire it.
 *
 * What it does:
 *   1. creates the parent update set "Netra - v5.0" plus six children
 *      (tables, script includes, portal/widget, REST, automation, shell)
 *   2. walks EVERY sys_metadata record in the x_196061_netra_v1 scope and
 *      writes it into the right child via GlideUpdateManager2 - so nothing
 *      gets missed and every payload carries its real scope/application
 *   3. adds the non-metadata extras by hand: the scoped app record, the
 *      Netra system properties, and the (global-scope) navigator menu +
 *      modules
 *   4. marks everything complete so the batch is ready to export as one
 *      XML ("Export to XML" on the parent, children ride along)
 */
(function () {
    var SCOPE_NAME = 'x_196061_netra_v1';
    var VERSION    = 'Netra - v5.0';

    var app = new GlideRecord('sys_app');
    if (!app.get('scope', SCOPE_NAME)) {
        gs.error('[netra-v5-capture] scoped app not found: ' + SCOPE_NAME);
        return;
    }
    var appId = String(app.sys_id);

    function ensureSet(name, desc, parentId) {
        var us = new GlideRecord('sys_update_set');
        us.addQuery('name', name);
        us.query();
        if (us.next()) {
            us.state = 'in progress';
            if (parentId) us.parent = parentId;
            us.description = desc;
            us.update();
            return String(us.sys_id);
        }
        us.initialize();
        us.name = name;
        us.description = desc;
        us.state = 'in progress';
        us.application = 'global';   // sets live in global; payloads keep their own scope
        if (parentId) us.parent = parentId;
        return String(us.insert());
    }

    var parentId = ensureSet(VERSION,
        'BATCH PARENT. Commit this one update set to deploy the entire Netra Voice Assistant app - ' +
        'tables, script includes, REST API, portal page + widget, automation, properties and the ' +
        'navigator menu. Children commit automatically in hierarchy order.', null);

    var CHILDREN = [
        { key: 'tables',  name: VERSION + ' - 01 Tables & Dictionary',    desc: 'Custom tables, dictionary, labels, choices and ACLs.' },
        { key: 'si',      name: VERSION + ' - 02 Script Includes',        desc: 'All Netra script includes (intent, tools, responder, scanner, knowledge, chat, context, navigator, summarizer, vulnerability).' },
        { key: 'portal',  name: VERSION + ' - 03 Portal & Widget',        desc: 'Netra Mic widget, Netra Live page and instances.' },
        { key: 'rest',    name: VERSION + ' - 04 REST API',               desc: 'Scripted REST service + resources (command, notifications, ping).' },
        { key: 'auto',    name: VERSION + ' - 05 Automation',             desc: 'Scheduled jobs and business rules.' },
        { key: 'shell',   name: VERSION + ' - 06 App Shell & Everything Else', desc: 'App record, properties, navigator menu/modules and any remaining scoped artifacts.' }
    ];
    var childIds = {};
    for (var i = 0; i < CHILDREN.length; i++) {
        childIds[CHILDREN[i].key] = ensureSet(CHILDREN[i].name, CHILDREN[i].desc, parentId);
    }

    function childFor(className) {
        if (/^sys_db_object$|^sys_dictionary$|^sys_choice$|^sys_documentation$|^sys_security_acl|^sys_number$/.test(className)) return 'tables';
        if (className === 'sys_script_include') return 'si';
        if (/^sp_/.test(className)) return 'portal';
        if (/^sys_ws_/.test(className)) return 'rest';
        if (/^sysauto|^sys_script$|^sysevent/.test(className)) return 'auto';
        return 'shell';
    }

    var updateSetApi = new GlideUpdateSet();
    var originalSet  = updateSetApi.get();
    var mgr = new GlideUpdateManager2();
    var counts = {};

    function capture(gr, childKey) {
        try {
            updateSetApi.set(childIds[childKey]);
            mgr.saveRecord(gr);
            counts[childKey] = (counts[childKey] || 0) + 1;
        } catch (e) {
            gs.warn('[netra-v5-capture] failed ' + gr.getRecordClassName() + ':' + gr.getUniqueValue() + ' - ' + e);
        }
    }

    // 1. every scoped metadata artifact, routed by class
    var meta = new GlideRecord('sys_metadata');
    meta.addQuery('sys_scope', appId);
    meta.query();
    var seen = 0;
    while (meta.next()) {
        var cls = String(meta.sys_class_name);
        var real = new GlideRecord(cls);
        if (!real.isValid() || !real.get(meta.sys_id)) continue;
        capture(real, childFor(cls));
        seen++;
    }

    // 2. extras that are not sys_metadata
    capture(app, 'shell');   // the scoped app record itself

    var prop = new GlideRecord('sys_properties');
    prop.addQuery('name', 'STARTSWITH', SCOPE_NAME);
    prop.query();
    while (prop.next()) capture(prop, 'shell');

    var menu = new GlideRecord('sys_app_application');
    menu.addQuery('title', 'Netra Voice Assistant');
    menu.query();
    while (menu.next()) {
        capture(menu, 'shell');
        var mod = new GlideRecord('sys_app_module');
        mod.addQuery('application', String(menu.sys_id));
        mod.query();
        while (mod.next()) capture(mod, 'shell');
    }

    updateSetApi.set(originalSet);

    // 3. close the sets so the batch is exportable/commit-ready
    var totals = [];
    for (var k in childIds) {
        if (!childIds.hasOwnProperty(k)) continue;
        var cs = new GlideRecord('sys_update_set');
        if (cs.get(childIds[k])) { cs.state = 'complete'; cs.update(); }
        totals.push(k + '=' + (counts[k] || 0));
    }
    var ps = new GlideRecord('sys_update_set');
    if (ps.get(parentId)) { ps.state = 'complete'; ps.update(); }

    gs.info('[netra-v5-capture] DONE parent=' + parentId + ' metadata=' + seen + ' by-child: ' + totals.join(', '));
})();
