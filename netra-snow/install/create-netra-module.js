/**
 * Netra - Application Navigator menu + modules (idempotent)
 *
 * Run as: System Definition > Scripts - Background (global scope)
 *
 * Creates the "Netra Voice Assistant" application menu with modules:
 *   - Netra Live (voice stage)      -> /sp?id=netra_live
 *   - Service Portal (floating orb) -> /sp
 *   - Notifications / Watchlist / User Preferences / Context & Memory
 *     (LIST modules on the Netra tables)
 *   - Netra Properties (sys_properties filtered to the Netra scope)
 *
 * Safe to re-run: existing menu/modules are detected by title and skipped.
 */
(function () {
    var MENU_TITLE = 'Netra Voice Assistant';

    var menuId = null;
    var mgr = new GlideRecord('sys_app_application');
    mgr.addQuery('title', MENU_TITLE);
    mgr.query();
    if (mgr.next()) {
        menuId = String(mgr.sys_id);
        gs.info('[netra-module] menu exists: ' + menuId);
    } else {
        mgr.initialize();
        mgr.title = MENU_TITLE;
        mgr.active = true;
        mgr.order = 100;
        mgr.hint = 'Voice-first assistant for blind and low-vision users - live stage, telemetry tables, and configuration.';
        mgr.category = 'Custom Applications';
        menuId = String(mgr.insert());
        gs.info('[netra-module] menu created: ' + menuId);
    }

    var MODULES = [
        { title: 'Netra Live (voice stage)',      order: 100, link_type: 'DIRECT', query: '/sp?id=netra_live',
          hint: 'Full-screen voice surface with the prism orb and Netra Lab diagnostics. Netra lives ONLY on this page.' },
        { title: 'Notifications',    order: 300, link_type: 'LIST', name: 'x_196061_netra_v1_notification' },
        { title: 'Watchlist',        order: 400, link_type: 'LIST', name: 'x_196061_netra_v1_watchlist' },
        { title: 'User Preferences', order: 500, link_type: 'LIST', name: 'x_196061_netra_v1_user_pref' },
        { title: 'Context & Memory', order: 600, link_type: 'LIST', name: 'x_196061_netra_v1_context' },
        { title: 'Netra Properties', order: 700, link_type: 'LIST', name: 'sys_properties',
          filter: 'nameSTARTSWITHx_196061_netra_v1' }
    ];

    for (var i = 0; i < MODULES.length; i++) {
        var def = MODULES[i];
        var mod = new GlideRecord('sys_app_module');
        mod.addQuery('application', menuId);
        mod.addQuery('title', def.title);
        mod.query();
        if (mod.next()) {
            gs.info('[netra-module] module exists: ' + def.title);
            continue;
        }
        mod.initialize();
        mod.application = menuId;
        mod.active = true;
        for (var k in def) {
            if (def.hasOwnProperty(k)) mod.setValue(k, def[k]);
        }
        var sid = mod.insert();
        gs.info('[netra-module] module created: ' + def.title + ' (' + sid + ')');
    }
    gs.info('[netra-module] done - refresh the browser to see the menu in the Application Navigator.');
})();
