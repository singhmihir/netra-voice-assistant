/**
 * Business Rule: "Netra Notify On Comment"
 *
 * Table:   sys_journal_field   (covers incident.comments and incident.work_notes)
 * When:    async, after insert
 *
 * Fires the instant someone other than the caller comments on an incident
 * where the user is either the caller OR the assigned_to.  We don't gate on
 * pause here — the queue absorbs everything, and the widget / notifications
 * endpoint is responsible for honouring pause when delivering.
 */
(function executeRule(current, previous /*null when inserting*/) {

    if (current.name != 'incident') return;
    var element = String(current.element || '');
    if (element != 'comments' && element != 'work_notes') return;

    var incident = new GlideRecord('incident');
    if (!incident.get(String(current.element_id))) return;

    var authorUserName = String(current.sys_created_by);

    // Resolve the author display name once
    var authorDisplayName = authorUserName;
    var au = new GlideRecord('sys_user');
    au.addQuery('user_name', authorUserName);
    au.query();
    if (au.next()) {
        authorDisplayName = (String(au.first_name || '') + ' ' + String(au.last_name || '')).trim() || authorUserName;
    }

    var body = String(current.value || '').trim();
    if (!body) return;

    var num = String(incident.number);
    var spoken = num.replace(/([A-Z])/g, '$1 ').trim() + ' ' +
                 num.replace(/^[A-Z]+/, '').split('').join(' ');
    var kind = element == 'work_notes' ? 'work note' : 'comment';

    // Notify the caller (if not the author)
    var callerSysId = String(incident.caller_id);
    if (callerSysId) {
        var callerUser = new GlideRecord('sys_user');
        if (callerUser.get(callerSysId) && String(callerUser.user_name) != authorUserName) {
            enqueue(callerSysId, incident, num, spoken, kind, body, authorDisplayName);
        }
    }

    // Notify the assignee (if different from the caller AND not the author)
    var assigneeSysId = String(incident.assigned_to);
    if (assigneeSysId && assigneeSysId != callerSysId) {
        var assigneeUser = new GlideRecord('sys_user');
        if (assigneeUser.get(assigneeSysId) && String(assigneeUser.user_name) != authorUserName) {
            enqueue(assigneeSysId, incident, num, spoken, kind, body, authorDisplayName);
        }
    }

    function enqueue(userSysId, incidentGR, num, spokenNum, kind, body, author) {
        var n = new GlideRecord('__NETRA_SCOPE___notification');
        n.initialize();
        n.user = userSysId;
        n.ticket_sys_id = String(incidentGR.sys_id);
        n.ticket_number = num;
        n.kind = element == 'work_notes' ? 'work_note' : 'comment';
        n.message = 'New ' + kind + ' on ' + spokenNum + ' from ' + author + '. ' +
                    body.substring(0, 400) + (body.length > 400 ? '...' : '');
        n.delivered = false;
        n.insert();
    }

})(current, previous);
