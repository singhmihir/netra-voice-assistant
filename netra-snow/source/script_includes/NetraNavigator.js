/**
 * NetraNavigator — voice-driven page navigation hints.
 *
 * Returns a portal/UI URL the client widget can navigate to. Common spoken
 * destinations are mapped to ServiceNow URLs without leaving the instance.
 *
 *   "open my profile"     -> /sp?id=my_profile
 *   "open my tickets"     -> /sp?id=ticket_list
 *   "open approvals"      -> /sp?id=approvals
 *   "open knowledge"      -> /sp?id=kb_home
 *   "open dashboard"      -> /sp?id=index
 *   "open ticket INC..."  -> /sp?id=ticket&table=incident&sys_id=...
 */
var NetraNavigator = Class.create();
NetraNavigator.prototype = {

    DEST_MAP: {
        'profile':         { url: '/sp?id=my_profile',  label: 'your profile' },
        'home':            { url: '/sp?id=index',       label: 'the portal home' },
        'dashboard':       { url: '/sp?id=index',       label: 'your dashboard' },
        'tickets':         { url: '/sp?id=ticket_list', label: 'your tickets' },
        'my tickets':      { url: '/sp?id=ticket_list', label: 'your tickets' },
        'incidents':       { url: '/sp?id=ticket_list&table=incident', label: 'your incidents' },
        'approvals':       { url: '/sp?id=approvals',   label: 'pending approvals' },
        'requests':        { url: '/sp?id=requests',    label: 'your requests' },
        'catalog':         { url: '/sp?id=sc_home',     label: 'the service catalog' },
        'knowledge':       { url: '/sp?id=kb_home',     label: 'the knowledge base' },
        'kb':              { url: '/sp?id=kb_home',     label: 'the knowledge base' },
        'home page':       { url: '/sp?id=index',       label: 'the portal home' }
    },

    initialize: function () {},

    /**
     * @param {string} destination free-form (e.g. "my tickets", "approvals")
     * @returns {{ok:boolean, url?:string, label?:string, error?:string}}
     */
    resolve: function (destination) {
        var key = String(destination || '').toLowerCase().trim();
        if (!key) return { ok: false, error: 'Where would you like to go?' };
        if (this.DEST_MAP[key]) return { ok: true, url: this.DEST_MAP[key].url, label: this.DEST_MAP[key].label };
        // Fuzzy: try partial match
        for (var k in this.DEST_MAP) {
            if (k.indexOf(key) >= 0 || key.indexOf(k) >= 0) {
                return { ok: true, url: this.DEST_MAP[k].url, label: this.DEST_MAP[k].label };
            }
        }
        return { ok: false, error: 'I do not know where ' + destination + ' is.' };
    },

    /** URL to view a specific record in the portal. */
    recordUrl: function (table, sysId) {
        return '/sp?id=ticket&table=' + encodeURIComponent(table) + '&sys_id=' + encodeURIComponent(sysId);
    },

    type: 'NetraNavigator'
};
