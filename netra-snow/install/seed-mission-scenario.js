/**
 * Netra - seed the missions test scenario (R18, feature 7)
 *
 * Run as a background script (System Definition > Scripts - Background).
 * Global scope is simplest: cleanup deletes incidents, and the Netra scope
 * only holds read/write/create on incident, not delete.
 *
 * What it makes (all tagged correlation_id = 'netra-mission-seed', a field
 * the embedder never reads, so the tag cant make seeded tickets look alike):
 *
 *   QUEUE - 8 active incidents, no group, no assignee (the mission's work):
 *     2 near-duplicates of the ANCHOR below
 *     2 that match a RESOLVED ticket with close notes (the known fixes)
 *     4 generic ones with no history behind them
 *   ANCHOR   - 1 open incident already assigned to Network (the "existing
 *              open incident" the near-duplicates should name)
 *   RESOLVED - 2 closed incidents with close notes, one per known fix
 *   HISTORY  - 6 closed, assigned lookalikes (2 per theme). not in the
 *              spec's list, but without them triage has fewer than 3
 *              lookalikes per ticket and nothing ever comes out "confident",
 *              which leaves the apply step with nothing to test. set
 *              HISTORY = false to seed the bare spec set.
 *
 * Resolved/history rows are CLOSED (state 7): the semantic engine treats
 * 6 and 7 alike as "resolved", and closed is guaranteed inactive, so they
 * can never be picked up as an open duplicate.
 *
 * Afterwards run install/warm-semantic-index.js once - it embeds the newest
 * tickets first, so one run covers everything here.
 *
 * MODE 'cleanup' deletes every tagged incident and its cached vectors.
 */
(function () {
    var MODE    = 'seed';        // 'seed' | 'cleanup'
    var HISTORY = true;
    var MARK    = 'netra-mission-seed';
    var SCOPE   = 'x_196061_netra_v1';
    var CACHE   = SCOPE + '_kb_embedding';
    var HOUR    = 3600000;
    var DAY     = 24 * HOUR;

    function say(s) { gs.info('[netra-seed] ' + s); }

    function tagged() {
        var out = [];
        var gr = new GlideRecord('incident');
        gr.addQuery('correlation_id', MARK);
        gr.setLimit(200);
        gr.query();
        while (gr.next()) out.push({ sys_id: String(gr.sys_id), number: String(gr.number), active: String(gr.active) });
        return out;
    }

    if (MODE === 'cleanup') {
        var rows = tagged();
        var ids = [], deleted = 0, stuck = [];
        for (var c = 0; c < rows.length; c++) ids.push(rows[c].sys_id);
        if (ids.length) {
            var cg = new GlideRecord(CACHE);
            cg.addQuery('source_sys_id', 'IN', ids.join(','));
            cg.setLimit(ids.length * 2);
            cg.query();
            var vecs = 0;
            while (cg.next()) { cg.deleteRecord(); vecs++; }
            say('removed ' + vecs + ' cached vector(s)');
        }
        for (var d = 0; d < rows.length; d++) {
            var del = new GlideRecord('incident');
            if (del.get(rows[d].sys_id)) del.deleteRecord();
            var chk = new GlideRecord('incident');
            if (chk.get(rows[d].sys_id)) stuck.push(rows[d].number); else deleted++;
        }
        say('CLEANUP deleted ' + deleted + ' incident(s)' + (stuck.length ? ', could NOT delete ' + stuck.join(', ') + ' (run this in global scope)' : ''));
        return;
    }

    var existing = tagged();
    if (existing.length) {
        var nums = [];
        for (var e = 0; e < existing.length; e++) nums.push(existing[e].number);
        say('already seeded (' + nums.join(', ') + '). Set MODE = \'cleanup\', run, then seed again.');
        return;
    }

    // ---- lookups ---------------------------------------------------------
    function group(name) {
        var g = new GlideRecord('sys_user_group');
        g.addQuery('name', name);
        g.addQuery('active', true);
        g.setLimit(1);
        g.query();
        if (g.next()) return { sys_id: String(g.sys_id), name: String(g.name) };
        return null;
    }
    var used = {};
    function groupOr(name) {
        var g = group(name);
        if (g) { used[g.sys_id] = true; return g; }
        // PDI without the demo groups: borrow any active group we havent used yet
        var any = new GlideRecord('sys_user_group');
        any.addQuery('active', true);
        any.orderBy('name');
        any.setLimit(50);
        any.query();
        while (any.next()) {
            if (used[String(any.sys_id)]) continue;
            used[String(any.sys_id)] = true;
            say('no active group called ' + name + ', using ' + any.name + ' instead');
            return { sys_id: String(any.sys_id), name: String(any.name) };
        }
        return null;
    }
    var NET = groupOr('Network'), SW = groupOr('Software'), HW = groupOr('Hardware');
    if (!NET || !SW || !HW) { say('ERROR: need three active assignment groups, found fewer. Nothing seeded.'); return; }

    function closeCode() {
        var prefer = ['Solution provided', 'Solved (Permanently)', 'Solved Remotely (Permanently)'];
        var have = {}, first = '';
        var ch = new GlideRecord('sys_choice');
        ch.addQuery('name', 'incident');
        ch.addQuery('element', 'close_code');
        ch.addQuery('inactive', false);
        ch.setLimit(50);
        ch.query();
        while (ch.next()) { have[String(ch.value)] = true; if (!first) first = String(ch.value); }
        for (var p = 0; p < prefer.length; p++) if (have[prefer[p]]) return prefer[p];
        return first || 'Solution provided';
    }
    var CLOSE_CODE = closeCode();
    var me = gs.getUserID();
    var now = new GlideDateTime().getNumericValue();

    // ---- writer ----------------------------------------------------------
    // dates go in as epoch ms - a date string would be re-read in the
    // session timezone and land hours off
    function make(spec) {
        var gr = new GlideRecord('incident');
        gr.initialize();
        gr.short_description = spec.sd;
        gr.description = spec.desc;
        gr.caller_id = me;
        gr.correlation_id = MARK;
        gr.correlation_display = 'Netra mission seed';
        gr.category = spec.category || 'inquiry';
        gr.impact = spec.impact || 3;
        gr.urgency = spec.urgency || 3;
        gr.opened_at.setDateNumericValue(now - spec.age_ms);
        if (spec.group) gr.assignment_group = spec.group.sys_id;
        gr.state = spec.state || 1;
        if (spec.state === 7) {
            gr.close_code = CLOSE_CODE;
            gr.close_notes = spec.fix;
            gr.resolved_by = me;
            gr.closed_by = me;
            gr.resolved_at.setDateNumericValue(now - spec.age_ms + DAY);
            gr.closed_at.setDateNumericValue(now - spec.age_ms + DAY + HOUR);
        }
        var id = gr.insert();
        var back = new GlideRecord('incident');
        back.get(id);
        return { sys_id: String(id), number: String(back.number), sd: spec.sd, role: spec.role,
                 group: String(back.assignment_group.getDisplayValue() || ''), state: String(back.state), active: String(back.active) };
    }

    var made = [];

    // ANCHOR - open and already owned, so it is NOT in the mission queue
    var anchor = make({ role: 'anchor', sd: 'VPN disconnects every few minutes for remote staff',
        desc: 'Since this morning the GlobalProtect VPN drops the connection every 5 to 10 minutes for people working from home. Reconnecting works for a little while, then it drops again.',
        category: 'network', impact: 2, urgency: 2, group: NET, state: 2, age_ms: 5 * HOUR });
    made.push(anchor);

    // RESOLVED with close notes - the known fixes
    var fixOutlook = make({ role: 'resolved', sd: 'Outlook stuck on Trying to connect after password change',
        desc: 'After the quarterly password reset Outlook shows Trying to connect in the status bar and no new mail arrives. Webmail works fine.',
        category: 'software', impact: 2, urgency: 2, group: SW, state: 7, age_ms: 40 * DAY,
        fix: 'Cleared the cached credentials in Windows Credential Manager and recreated the Outlook profile; mail syncs again.' });
    var fixDock = make({ role: 'resolved', sd: 'Docking station not detecting external monitors',
        desc: 'Laptop docked but both external monitors stay black. Charging through the dock still works.',
        category: 'hardware', impact: 2, urgency: 2, group: HW, state: 7, age_ms: 35 * DAY,
        fix: 'Updated the dock firmware and the DisplayLink driver, then power-cycled the dock; both monitors detected.' });
    made.push(fixOutlook, fixDock);

    if (HISTORY) {
        var hist = [
            { sd: 'VPN tunnel drops for remote users every few minutes', desc: 'Remote staff lose the VPN tunnel repeatedly throughout the day.',
              category: 'network', group: NET, fix: 'Renewed the expired certificate on the VPN gateway and restarted the service.' },
            { sd: 'Home workers disconnected from VPN repeatedly', desc: 'Users working from home get kicked off the VPN every few minutes.',
              category: 'network', group: NET, fix: 'Set MTU to 1400 on the VPN profile after the firewall change; sessions stable.' },
            { sd: 'Outlook keeps prompting for password and will not sync', desc: 'Outlook asks for the password again and again after it was changed, mail not syncing.',
              category: 'software', group: SW, fix: 'Removed stale credentials and rebuilt the Outlook profile.' },
            { sd: 'Outlook disconnected from Exchange after password reset', desc: 'Outlook says disconnected since my password reset yesterday.',
              category: 'software', group: SW, fix: 'Signed out of Office, cleared cached credentials, signed back in.' },
            { sd: 'Second monitor not showing through laptop dock', desc: 'The external screen connected to the docking station shows no signal.',
              category: 'hardware', group: HW, fix: 'Reseated the USB-C cable and updated the dock firmware.' },
            { sd: 'Dock not recognising external displays after update', desc: 'After a Windows update the docking station no longer drives external displays.',
              category: 'hardware', group: HW, fix: 'Reinstalled the DisplayLink driver and power-cycled the dock.' }
        ];
        for (var h = 0; h < hist.length; h++) {
            hist[h].role = 'history';
            hist[h].impact = 2;
            hist[h].urgency = 2;
            hist[h].state = 7;
            hist[h].age_ms = (20 + h * 5) * DAY;
            made.push(make(hist[h]));
        }
    }

    // QUEUE - 8 unassigned, opened an hour apart so "oldest first" is stable
    var queue = [
        { role: 'near-duplicate', sd: 'VPN keeps disconnecting when working from home',
          desc: 'My VPN connection drops every few minutes since this morning and I have to reconnect constantly.' },
        { role: 'near-duplicate', sd: 'Remote VPN session drops repeatedly',
          desc: 'GlobalProtect disconnects me every 5 to 10 minutes while I work remotely. Started today.' },
        { role: 'known-fix', sd: 'Outlook will not connect after I changed my password',
          desc: 'Since resetting my password yesterday Outlook shows Trying to connect and no new mail arrives.' },
        { role: 'known-fix', sd: 'External monitors not detected through my docking station',
          desc: 'Both monitors stay black when the laptop is docked. They worked last week.' },
        { role: 'generic', sd: 'Request to install Adobe Acrobat Pro on my laptop',
          desc: 'I need Acrobat Pro to edit PDF contracts, standard reader is not enough.' },
        { role: 'generic', sd: 'Badge reader at building 2 side entrance not working',
          desc: 'The card reader by the side door of building 2 shows a red light and does not unlock.' },
        { role: 'generic', sd: 'Teams meeting audio echoes for all participants',
          desc: 'In our weekly call everybody hears an echo of their own voice.' },
        { role: 'generic', sd: 'Need access to the Finance shared drive folder',
          desc: 'Please grant me read access to the Finance quarterly reports folder.' }
    ];
    var queueMade = [];
    for (var q = 0; q < queue.length; q++) {
        queue[q].age_ms = (queue.length - q) * HOUR;   // first one oldest
        var row = make(queue[q]);
        queueMade.push(row);
        made.push(row);
    }

    // an assignment rule or data lookup may have routed a fresh ticket on
    // insert - then it is not in the queue and the test count is off. try
    // clearing once, and say so either way.
    var routed = [];
    for (var r = 0; r < queueMade.length; r++) {
        var chk = new GlideRecord('incident');
        if (!chk.get(queueMade[r].sys_id)) continue;
        if (String(chk.getValue('assignment_group') || '') || String(chk.getValue('assigned_to') || '')) {
            chk.setValue('assignment_group', '');
            chk.setValue('assigned_to', '');
            chk.update();
            var again = new GlideRecord('incident');
            again.get(queueMade[r].sys_id);
            routed.push(queueMade[r].number + (String(again.getValue('assignment_group') || '') ? ' (STILL assigned - a rule keeps routing it)' : ' (auto-routed on insert, cleared)'));
        }
    }

    // other unassigned active incidents will join the mission too
    var ga = new GlideAggregate('incident');
    ga.addEncodedQuery('active=true^assignment_groupISEMPTY^assigned_toISEMPTY');
    ga.addAggregate('COUNT');
    ga.query();
    var queueNow = ga.next() ? parseInt(ga.getAggregate('COUNT'), 10) : 0;

    say('SEEDED ' + made.length + ' incident(s), close_code "' + CLOSE_CODE + '", groups ' + NET.name + ' / ' + SW.name + ' / ' + HW.name);
    for (var m = 0; m < made.length; m++) {
        say('  ' + made[m].number + '  ' + made[m].role + (made[m].group ? ' [' + made[m].group + ']' : ' [unassigned]') +
            ' state ' + made[m].state + ' - ' + made[m].sd);
    }
    say('near-duplicates should name ' + anchor.number + '; known fixes should come from ' + fixOutlook.number + ' and ' + fixDock.number);
    if (routed.length) say('WARNING: ' + routed.join('; '));
    if (queueNow !== queueMade.length) {
        say('NOTE: the unassigned queue now holds ' + queueNow + ' incident(s), not ' + queueMade.length +
            ' - ' + (queueNow - queueMade.length) + ' pre-existing one(s) will be in the mission too.');
    }
    say('NEXT: run install/warm-semantic-index.js once, then launch the mission.');
})();
