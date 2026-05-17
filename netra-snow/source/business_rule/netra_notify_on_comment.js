/**
 * Business Rule: "Netra Notify On Comment"  (v3.3 - dynamic, scope-fence-safe)
 *
 * Configuration in Studio:
 *   Table:        sys_journal_field
 *   Application:  Netra_V1
 *   When:         after
 *   Insert:       true
 *   Advanced:     true
 *   Active:       true
 *
 * v3.3 change: getFields() is fenced in scoped apps
 * (MethodNotAllowedException). This version uses a sys_dictionary query
 * to discover user-reference fields - same dynamic behaviour, no fenced
 * APIs.
 *
 * How it works (works for ANY table - incident, change, problem, sc_task,
 * custom tables - and notifies EVERY user the record references):
 *   1. Filter the sys_journal_field insert to comments / work_notes only.
 *   2. Read the parent table (current.name) and record sys_id (current.element_id).
 *   3. Walk the table hierarchy via sys_db_object.super_class so we catch
 *      inherited fields (e.g. incident inherits task.assigned_to).
 *   4. Query sys_dictionary for every active field across that hierarchy
 *      where reference = sys_user and internal_type in (reference, glide_list).
 *   5. For each such field, read its value from the parent record.
 *      - reference -> single user sys_id
 *      - glide_list -> CSV of user sys_ids (watch_list etc.)
 *   6. For every distinct user collected (except the comment author),
 *      enqueue a notification on x_<scope>_notification.
 */
(function executeRule(current, previous /*null on insert*/) {

    // 1. Filter - only act on real comments / work notes
    var element = String(current.element || '');
    if (element != 'comments' && element != 'work_notes') return;

    var tableName  = String(current.name || '');
    var recordId   = String(current.element_id || '');
    var body       = String(current.value || '').trim();
    var authorUser = String(current.sys_created_by || '');

    if (!tableName || !recordId || !body) return;

    // 2. Open the parent record (any table)
    var parent = new GlideRecord(tableName);
    if (!parent.isValid()) return;
    if (!parent.get(recordId)) return;

    // 3. Walk the table hierarchy (e.g. incident -> task)
    var allTables = _getTableHierarchy(tableName);

    // 4. Query sys_dictionary for every sys_user reference field on the hierarchy
    var usersToNotify = {};
    var d = new GlideRecord('sys_dictionary');
    d.addQuery('name', 'IN', allTables.join(','));
    d.addQuery('reference', 'sys_user');
    d.addQuery('internal_type', 'IN', 'reference,glide_list');
    d.addQuery('active', true);
    d.query();

    while (d.next()) {
        var fieldName = String(d.element || '');
        if (!fieldName) continue;
        var type = String(d.internal_type);

        // Read value via GlideRecord.getValue (allowed cross-scope)
        var raw = '';
        try {
            raw = String(parent.getValue(fieldName) || '');
        } catch (e) {
            continue;
        }
        if (!raw) continue;

        if (type == 'reference') {
            usersToNotify[raw] = true;
        } else if (type == 'glide_list') {
            // CSV of sys_ids (watch_list and friends)
            raw.split(',').forEach(function (sysId) {
                sysId = sysId.trim();
                if (sysId) usersToNotify[sysId] = true;
            });
        }
    }

    // Bail if nobody to notify
    var hasAny = false;
    for (var k in usersToNotify) { hasAny = true; break; }
    if (!hasAny) {
        gs.info('[NetraNotifyOnComment] no user-reference fields populated on ' + tableName + ' ' + recordId);
        return;
    }

    // 5. Resolve author display name (best effort)
    var authorDisplay = authorUser;
    var au = new GlideRecord('sys_user');
    au.addQuery('user_name', authorUser);
    au.setLimit(1);
    au.query();
    if (au.next()) {
        var full = (String(au.first_name || '') + ' ' + String(au.last_name || '')).trim();
        if (full) authorDisplay = full;
    }

    // 6. Compose the spoken message bits
    var num = '';
    try { num = String(parent.getValue('number') || ''); } catch (e) {}
    if (!num) {
        try { num = String(parent.getDisplayValue() || ''); } catch (e) {}
    }
    var spokenNum = '';
    if (num) {
        // "INC0001234" -> "I N C zero zero zero one two three four"
        var letters = num.replace(/[^A-Z]/g, '').split('').join(' ');
        var digits  = num.replace(/[^0-9]/g, '').split('').map(function (dg) {
            return ({ '0':'zero','1':'one','2':'two','3':'three','4':'four',
                       '5':'five','6':'six','7':'seven','8':'eight','9':'nine' })[dg] || dg;
        }).join(' ');
        spokenNum = (letters + ' ' + digits).trim();
    }

    var kindLabel  = element == 'work_notes' ? 'work note' : 'comment';
    var tableLabel = tableName;
    try { tableLabel = String(parent.getLabel() || tableName); } catch (e) {}

    // 7. Enqueue a notification for each user (except the author)
    var sentCount = 0;
    for (var userSysId in usersToNotify) {
        var user = new GlideRecord('sys_user');
        if (!user.get(userSysId)) continue;
        if (String(user.user_name) == authorUser) continue;   // skip self

        _enqueue(userSysId, recordId, num, spokenNum, kindLabel, body, authorDisplay, element, tableLabel);
        sentCount++;
    }
    gs.info('[NetraNotifyOnComment] ' + tableName + ' ' + recordId +
            ' -> notified ' + sentCount + ' user(s) via ' + Object.keys(usersToNotify).length + ' candidate(s)');

    // ============================================================
    // Helpers
    // ============================================================
    function _getTableHierarchy(tableName) {
        var tables = [tableName];
        var seen = {};
        seen[tableName] = true;
        var cursor = tableName;
        for (var hops = 0; hops < 8; hops++) {
            var t = new GlideRecord('sys_db_object');
            t.addQuery('name', cursor);
            t.setLimit(1);
            t.query();
            if (!t.next()) break;

            var scSysId = String(t.super_class || '');
            if (!scSysId) break;

            var p = new GlideRecord('sys_db_object');
            if (!p.get(scSysId)) break;

            var parentName = String(p.name || '');
            if (!parentName || seen[parentName]) break;

            seen[parentName] = true;
            tables.push(parentName);
            cursor = parentName;
        }
        return tables;
    }

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
        n.insert();
    }

})(current, previous);
