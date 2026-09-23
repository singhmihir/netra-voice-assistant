/* The investigation scenario the instance seed script builds, in memory. */
'use strict';
function seedOutage(s, g) {
    var P = g.P, MIN = 60000, now = P.now;
    g.put('cmdb_ci_linux_server', { sys_id: 'ci_web', name: 'netra-lab-web01', operational_status: '1', install_status: '1' });
    g.put('cmdb_ci_linux_server', { sys_id: 'ci_other', name: 'netra-lab-unrelated01', operational_status: '1', install_status: '1' });
    P.DISPLAY.ci_web = 'netra-lab-web01'; P.DISPLAY.ci_other = 'netra-lab-unrelated01';
    g.put('change_request', { sys_id: 'chgA', number: 'CHG0030006', short_description: 'Apply kernel patches', type: 'normal', risk: '3', impact: '3', state: '3',
                              close_code: 'successful', cmdb_ci: 'ci_web', work_start: g.fmtUtc(now - 100 * MIN), work_end: g.fmtUtc(now - 70 * MIN), closed_at: g.fmtUtc(now - 65 * MIN) });
    g.put('change_request', { sys_id: 'chgB', number: 'CHG0030007', short_description: 'Old change, outside the window', type: 'normal', risk: '3', impact: '3', state: '3',
                              cmdb_ci: 'ci_web', work_start: g.fmtUtc(now - 5 * 1440 * MIN - 60 * MIN), work_end: g.fmtUtc(now - 5 * 1440 * MIN) });
    g.put('change_request', { sys_id: 'chgC', number: 'CHG0030008', short_description: 'Decoy on another box', type: 'normal', risk: '3', impact: '3', state: '3',
                              cmdb_ci: 'ci_other', work_start: g.fmtUtc(now - 80 * MIN), work_end: g.fmtUtc(now - 50 * MIN) });
    for (var i = 0; i < 4; i++) {
        g.put('incident', { sys_id: 'out' + i, number: 'INC00300' + (10 + i), cmdb_ci: 'ci_web', state: '2', active: 'true', impact: '2', urgency: '2', priority: '3',
                            caller_id: 'u_admin', short_description: 'web01 502 on login page ' + i,
                            opened_at: g.fmtUtc(now - (30 - i) * MIN), sys_created_on: g.fmtUtc(now - (30 - i) * MIN) });
    }
    // a ticket with nothing to go on
    g.put('incident', { sys_id: 'thin', number: 'INC0030099', state: '1', active: 'true', caller_id: 'u_admin', short_description: 'something is odd',
                        opened_at: g.fmtUtc(now - 10 * MIN), sys_created_on: g.fmtUtc(now - 10 * MIN) });
}
module.exports = { seedOutage: seedOutage };
