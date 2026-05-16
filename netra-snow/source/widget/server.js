/**
 * Service Portal widget server script — netra-mic.
 *
 * Ensures the current user has an x_196061_netra_user_pref row so the
 * scheduled scanner picks them up. Returns initial state to the client.
 */
(function () {

    var user = gs.getUserID();

    // Ensure the pref row exists (implicit opt-in just by loading the widget).
    var pref = new GlideRecord('x_196061_netra_user_pref');
    pref.addQuery('user', user);
    pref.setLimit(1);
    pref.query();
    if (!pref.next()) {
        pref.initialize();
        pref.user = user;
        pref.active = true;
        pref.watch_assignments = true;
        pref.watch_comments = true;
        pref.watch_approvals = true;
        pref.insert();
    }

    var paused = false;
    var pausedUntil = '';
    if (pref.paused_until && String(pref.paused_until) !== '') {
        var now = new GlideDateTime();
        if (new GlideDateTime(String(pref.paused_until)).compareTo(now) > 0) {
            paused = true;
            pausedUntil = String(pref.paused_until);
        }
    }

    data.user_name = gs.getUserDisplayName();
    data.api_base = '/api/x_196061_netra/voice';
    data.is_guest = gs.getUser().isPublic();
    data.paused = paused;
    data.paused_until = pausedUntil;

})();
