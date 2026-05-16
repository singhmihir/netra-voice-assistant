/**
 * Business Rule: "Netra — notify caller on new comment"
 *
 * Table:       sys_journal_field   (the central journal table behind
 *                                   incident.comments and incident.work_notes)
 * When:        async, after insert
 * Filter:      element IN ('comments', 'work_notes')  AND  name = 'incident'
 *
 * Behaviour: When a journal entry is added to an incident, look up the
 * incident's caller. If the entry was added by someone OTHER than the caller,
 * enqueue a Netra notification so the caller's open Service Portal tab can
 * announce it.
 */
(function executeRule(current, previous /*null when inserting*/) {

    // Only act on incident journal entries.
    if (current.name != 'incident') return;
    var element = String(current.element || '');
    if (element != 'comments' && element != 'work_notes') return;

    var incident = new GlideRecord('incident');
    if (!incident.get(String(current.element_id))) return;

    var callerSysId = String(incident.caller_id);
    if (!callerSysId) return;

    var authorSysId = String(current.sys_created_by);  // username, not sys_id
    // Resolve the caller's username to compare with sys_created_by
    var callerUser = new GlideRecord('sys_user');
    if (!callerUser.get(callerSysId)) return;
    if (String(callerUser.user_name) == authorSysId) {
        // Caller commented on their own ticket — no need to interrupt them.
        return;
    }

    // Author display name for nicer spoken output
    var authorName = authorSysId;
    var authorUser = new GlideRecord('sys_user');
    authorUser.addQuery('user_name', authorSysId);
    authorUser.query();
    if (authorUser.next()) {
        authorName = String(authorUser.first_name || '') + ' ' + String(authorUser.last_name || '');
        authorName = authorName.trim() || authorSysId;
    }

    var body = String(current.value || '').trim();
    if (!body) return;

    // Pronounceable ticket number ("I N C zero zero zero...")
    var num = String(incident.number);
    var spoken = num.replace(/([A-Z])/g, '$1 ').trim() +
                 ' ' + num.replace(/^[A-Z]+/, '').split('').join(' ');

    var kind = element == 'work_notes' ? 'work note' : 'comment';

    var n = new GlideRecord('x_netra_notification');
    n.initialize();
    n.user = callerSysId;
    n.ticket_sys_id = String(incident.sys_id);
    n.ticket_number = num;
    n.kind = element;
    n.message =
        'New ' + kind + ' on ' + spoken + ' from ' + authorName + '. ' +
        body.substring(0, 400) + (body.length > 400 ? '...' : '');
    n.delivered = false;
    n.insert();

})(current, previous);
