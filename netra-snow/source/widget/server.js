/**
 * Service Portal widget server script - netra-mic.
 *
 * Ensures the current user has an __NETRA_SCOPE___user_pref row so the
 * scheduled scanner picks them up, and returns initial state to the client.
 *
 * Scope notes:
 *   - gs.getUser().isPublic() is NOT available in scoped apps (the scoped
 *     GlideUser API does not expose it). We don't need it - removed.
 *   - gs.getUserID() and gs.getUserDisplayName() ARE allowed in scope.
 */
(function () {

    var user = gs.getUserID();

    // Ensure the pref row exists (implicit opt-in just by loading the widget).
    var pref = new GlideRecord('__NETRA_SCOPE___user_pref');
    pref.addQuery('user', user);
    pref.setLimit(1);
    pref.query();
    if (!pref.next()) {
        pref.initialize();
        pref.user              = user;
        pref.active            = true;
        pref.watch_assignments = true;
        pref.watch_comments    = true;
        pref.watch_approvals   = true;
        pref.insert();
    }

    // Compute paused state from the (possibly newly created) pref row
    var paused = false;
    var pausedUntil = '';
    if (pref.paused_until && String(pref.paused_until) !== '') {
        var now = new GlideDateTime();
        if (new GlideDateTime(String(pref.paused_until)).compareTo(now) > 0) {
            paused = true;
            pausedUntil = String(pref.paused_until);
        }
    }

    data.user_name    = gs.getUserDisplayName();
    data.user_sys_id  = user;
    data.api_base     = '/api/__NETRA_SCOPE__/voice';
    data.paused       = paused;
    data.paused_until = pausedUntil;

})();
