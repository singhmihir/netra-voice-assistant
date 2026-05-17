/**
 * Business Rule: "Netra Notify On Comment"  (v3.4 - scope-safe, no introspection)
 *
 * Configuration in Studio:
 *   Table:        sys_journal_field
 *   Application:  Netra_V1
 *   When:         after
 *   Insert:       true
 *   Advanced:     true
 *   Active:       true
 *   Filter:       (leave blank - the script gates internally)
 *
 * v3.4 changes (after BR fired but no records created):
 *   - REMOVED getFields() (fenced in scope)
 *   - REMOVED dynamic sys_dictionary discovery (was working but slow)
 *   - Uses a HARDCODED list of common user-reference fields. Tries to read
 *     each one via parent.getValue() - silently skips fields that don't
 *     exist on this particular table. Works for incident, change_request,
 *     sc_task, problem, sc_request, kb_knowledge_submission, and any
 *     custom task-derived table without any introspection.
 *   - Adds system property "x_196061_netra_v1.notify_author" (default false).
 *     Set to true temporarily during testing so self-comments produce
 *     notifications (otherwise the author is correctly skipped).
 *   - Aggressive gs.info logging at EVERY step so you can see exactly
 *     what happened by filtering System Logs by "NetraNotify".
 */
(function executeRule(current, previous /*null on insert*/) {

    // ------------------------------------------------------------
    // 0. Static list of fields we care about - covers 99% of tables
    // ------------------------------------------------------------
    var REFERENCE_FIELDS = [
        'caller_id',          // incident
        'assigned_to',        // task (all subclasses)
        'opened_by',          // task
        'requested_by',       // change_request
        'requested_for',      // sc_request, sc_req_item
        'sys_created_by',     // any record (string username, not sys_id)
        'manager',            // various
        'approver',           // sysapproval_approver
        'u_owner',            // common custom owner field
        'u_business_owner'
    ];
    var GLIDE_LIST_FIELDS = [
        'watch_list',         // task watchers
        'work_notes_list'     // task work-note recipients
    ];

    // ------------------------------------------------------------
    // 1. Filter - only act on real comments / work notes
    // ------------------------------------------------------------
    var element = String(current.element || '');
    if (element != 'comments' && element != 'work_notes') return;

    var tableName  = String(current.name || '');
    var recordId   = String(current.element_id || '');
    var body       = String(current.value || '').trim();
    var authorUser = String(current.sys_created_by || '');

    gs.info('[NetraNotify] start - table=' + tableName +
            ' record=' + recordId +
            ' element=' + element +
            ' author=' + authorUser +
            ' bodylen=' + body.length);

    if (!tableName || !recordId || !body) {
        gs.info('[NetraNotify] skipped - missing tableName/recordId/body');
        return;
    }

    // ------------------------------------------------------------
    // 2. Open the parent record
    // ------------------------------------------------------------
    var parent = new GlideRecord(tableName);
    if (!parent.isValid()) {
        gs.warn('[NetraNotify] table not valid in this scope: ' + tableName);
        return;
    }
    if (!parent.get(recordId)) {
        gs.warn('[NetraNotify] record not found or not readable: ' + tableName + '/' + recordId);
        return;
    }

    // ------------------------------------------------------------
    // 3. Collect every user the record references (no introspection)
    // ------------------------------------------------------------
    var usersToNotify = {};

    REFERENCE_FIELDS.forEach(function (fieldName) {
        var raw = '';
        try { raw = String(parent.getValue(fieldName) || ''); } catch (e) { return; }
        if (!raw) return;
        // sys_created_by is a USERNAME, not a sys_id - need to resolve
        if (fieldName == 'sys_created_by') {
            var u = new GlideRecord('sys_user');
            u.addQuery('user_name', raw);
            u.setLimit(1);
            u.query();
            if (u.next()) { usersToNotify[String(u.sys_id)] = fieldName; }
        } else if (raw.length == 32) {
            // looks like a sys_id (32 hex chars)
            usersToNotify[raw] = fieldName;
        }
    });

    GLIDE_LIST_FIELDS.forEach(function (fieldName) {
        var raw = '';
        try { raw = String(parent.getValue(fieldName) || ''); } catch (e) { return; }
        if (!raw) return;
        raw.split(',').forEach(function (sysId) {
            sysId = sysId.trim();
            if (sysId && sysId.length == 32) usersToNotify[sysId] = fieldName;
        });
    });

    var candidateCount = 0;
    for (var ck in usersToNotify) candidateCount++;
    gs.info('[NetraNotify] candidates found: ' + candidateCount +
            ' (' + Object.keys(usersToNotify).join(',') + ')');

    if (candidateCount == 0) {
        gs.info('[NetraNotify] no user-reference fields populated on ' + tableName + '/' + recordId);
        return;
    }

    // ------------------------------------------------------------
    // 4. Optional: include the author for testing visibility
    // ------------------------------------------------------------
    var notifyAuthor = gs.getProperty('x_196061_netra_v1.notify_author', 'false') == 'true';
    gs.info('[NetraNotify] notify_author setting = ' + notifyAuthor);

    // ------------------------------------------------------------
    // 5. Resolve author display name
    // ------------------------------------------------------------
    var authorDisplay = authorUser;
    var au = new GlideRecord('sys_user');
    au.addQuery('user_name', authorUser);
    au.setLimit(1);
    au.query();
    if (au.next()) {
        var full = (String(au.first_name || '') + ' ' + String(au.last_name || '')).trim();
        if (full) authorDisplay = full;
    }

    // ------------------------------------------------------------
    // 6. Pronounceable number for spoken playback
    // ------------------------------------------------------------
    var num = '';
    try { num = String(parent.getValue('number') || ''); } catch (e) {}
    var spokenNum = '';
    if (num) {
        var letters = num.replace(/[^A-Z]/g, '').split('').join(' ');
        var digits  = num.replace(/[^0-9]/g, '').split('').map(function (dg) {
            return ({ '0':'zero','1':'one','2':'two','3':'three','4':'four',
                       '5':'five','6':'six','7':'seven','8':'eight','9':'nine' })[dg] || dg;
        }).join(' ');
        spokenNum = (letters + ' ' + digits).trim();
    }

    var kindLabel = element == 'work_notes' ? 'work note' : 'comment';
    var tableLabel = tableName;
    try { tableLabel = String(parent.getLabel() || tableName); } catch (e) {}

    // ------------------------------------------------------------
    // 7. Enqueue notifications
    // ------------------------------------------------------------
    var sentCount = 0;
    var skippedAsAuthor = 0;
    for (var userSysId in usersToNotify) {
        var fieldName = usersToNotify[userSysId];
        var user = new GlideRecord('sys_user');
        if (!user.get(userSysId)) {
            gs.info('[NetraNotify]   skipped ' + userSysId + ' (user not found)');
            continue;
        }
        var userName = String(user.user_name);

        if (userName == authorUser && !notifyAuthor) {
            skippedAsAuthor++;
            gs.info('[NetraNotify]   skipped ' + userName + ' (is author of comment, field=' + fieldName + ')');
            continue;
        }

        var inserted = _enqueue(userSysId, recordId, num, spokenNum, kindLabel,
                                 body, authorDisplay, element, tableLabel);
        if (inserted) {
            sentCount++;
            gs.info('[NetraNotify]   ENQUEUED for ' + userName + ' via field=' + fieldName + ' notif_sys_id=' + inserted);
        } else {
            gs.warn('[NetraNotify]   insert FAILED for ' + userName);
        }
    }

    gs.info('[NetraNotify] DONE - ' + tableName + ' ' + recordId +
            ' candidates=' + candidateCount +
            ' notified=' + sentCount +
            ' skippedAsAuthor=' + skippedAsAuthor);

    function _enqueue(userSysId, recordId, num, spokenNum, kind, body, author, element, tableLabel) {
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
        return String(n.insert() || '');
    }

})(current, previous);
