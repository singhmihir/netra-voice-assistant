/**
 * Business Rule: "Netra Notify On Comment"  (v3.2 — fully dynamic)
 *
 * Configuration in Studio:
 *   Table:        sys_journal_field
 *   Application:  Netra_V1
 *   When:         after
 *   Insert:       true
 *   Advanced:     true
 *   Active:       true
 *
 * How it works (works for ANY table, not just incident):
 *   1. A comment / work_note is added anywhere in the platform.
 *   2. We read current.name (parent table) and current.element_id (record sys_id).
 *   3. We open the parent record and walk EVERY field on it.
 *   4. For each field whose type is `reference -> sys_user` or
 *      `glide_list -> sys_user`, we collect the user sys_id(s).
 *   5. For every user collected (except the comment's author), we insert
 *      one row into x_196061_netra_v1_notification so Netra can announce it.
 *
 * Result: works automatically for incident.caller_id, incident.assigned_to,
 * change_request.requested_by, sc_task.assigned_to, problem.opened_by,
 * any watch_list, and any custom table that references sys_user — no per-
 * table code, no maintenance when ServiceNow adds new tables.
 */
(function executeRule(current, previous /*null on insert*/) {

    // 1. Filter — only real comments / work notes (skip every other journal use)
    var element = String(current.element || '');
    if (element != 'comments' && element != 'work_notes') return;

    var tableName  = String(current.name || '');
    var recordId   = String(current.element_id || '');
    var body       = String(current.value || '').trim();
    var authorUser = String(current.sys_created_by || '');

    if (!tableName || !recordId || !body) return;

    // 2. Open the parent record (any table — incident, change, problem, sc_task, ...)
    var parent = new GlideRecord(tableName);
    if (!parent.isValid()) return;          // table doesn't exist or no access
    if (!parent.get(recordId)) return;      // record was deleted

    // 3. Walk every field on the parent and collect every sys_user reference
    var usersToNotify = {};                 // sys_id -> true (dedupe)
    try {
        var fields = parent.getFields();
        for (var i = 0; i < fields.size(); i++) {
            var f  = fields.get(i);
            var ed = f.getED();
            if (!ed) continue;

            var type = String(ed.getInternalType());
            var ref  = String(ed.getReference() || '');
            if (ref != 'sys_user') continue;

            var raw = String(f.getValue() || '');
            if (!raw) continue;

            if (type == 'reference') {
                usersToNotify[raw] = true;
            } else if (type == 'glide_list') {
                // watch_list and similar — comma-separated sys_ids
                raw.split(',').forEach(function (sysId) {
                    sysId = sysId.trim();
                    if (sysId) usersToNotify[sysId] = true;
                });
            }
        }
    } catch (e) {
        gs.warn('[NetraNotifyOnComment] field walk failed for ' + tableName + ' ' + recordId + ': ' + e);
        return;
    }

    // Nothing to do if no users are referenced on the record
    var hasAny = false;
    for (var k in usersToNotify) { hasAny = true; break; }
    if (!hasAny) return;

    // 4. Resolve author display name (best effort)
    var authorDisplay = authorUser;
    var au = new GlideRecord('sys_user');
    au.addQuery('user_name', authorUser);
    au.setLimit(1);
    au.query();
    if (au.next()) {
        var full = (String(au.first_name || '') + ' ' + String(au.last_name || '')).trim();
        if (full) authorDisplay = full;
    }

    // 5. Compose the spoken message
    var num = String(parent.getValue('number') || parent.getDisplayValue() || '').trim();
    var spokenNum = '';
    if (num) {
        // "INC0001234" -> "I N C zero zero zero one two three four"
        var letters = num.replace(/[^A-Z]/g, '').split('').join(' ');
        var digits  = num.replace(/[^0-9]/g, '').split('').map(function (d) {
            return ({ '0':'zero','1':'one','2':'two','3':'three','4':'four',
                       '5':'five','6':'six','7':'seven','8':'eight','9':'nine' })[d] || d;
        }).join(' ');
        spokenNum = (letters + ' ' + digits).trim();
    }

    var kindLabel  = element == 'work_notes' ? 'work note' : 'comment';
    var tableLabel = String(parent.getLabel() || tableName);

    // 6. Notify every collected user (except the author)
    for (var userSysId in usersToNotify) {
        var user = new GlideRecord('sys_user');
        if (!user.get(userSysId)) continue;
        if (String(user.user_name) == authorUser) continue;   // skip self

        _enqueue(userSysId, tableName, recordId, num, spokenNum, kindLabel,
                 body, authorDisplay, element, tableLabel);
    }

    function _enqueue(userSysId, tableName, recordId, num, spokenNum,
                      kind, body, author, element, tableLabel) {
        var n = new GlideRecord('__NETRA_SCOPE___notification');
        n.initialize();
        n.user           = userSysId;
        n.ticket_sys_id  = recordId;
        n.ticket_number  = num;
        n.kind           = element == 'work_notes' ? 'work_note' : 'comment';
        n.message        = 'New ' + kind + ' on ' + tableLabel +
                           (spokenNum ? ' ' + spokenNum : '') +
                           ' from ' + author + '. ' +
                           body.substring(0, 400) + (body.length > 400 ? '...' : '');
        n.delivered      = false;
        n.insert();
    }

})(current, previous);
