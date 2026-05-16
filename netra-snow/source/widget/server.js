/**
 * Service Portal widget server script — netra-mic.
 *
 * The widget does almost everything client-side via Web Speech APIs and the
 * Scripted REST endpoints. The server script just ensures the user is
 * authenticated and exposes a couple of bootstrap values.
 */
(function () {

    data.user_name = gs.getUserDisplayName();
    data.user_sys_id = gs.getUserID();
    data.api_base = '/api/x_netra/voice';
    data.is_guest = gs.getUser().isPublic();

})();
