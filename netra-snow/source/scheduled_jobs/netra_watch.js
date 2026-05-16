/**
 * Scheduled Job: "Netra Watch"
 *
 * Configuration (set when creating the job in Studio):
 *   Run:           Periodically
 *   Repeat every:  3 minutes
 *   Active:        true
 *
 * Behaviour: delegates to NetraScanner. Wraps in a try/catch so a single
 * bad row doesn't take down the schedule.
 */
(function () {
    try {
        new NetraScanner().run();
    } catch (e) {
        gs.error('[NetraWatch] scheduled run failed: ' + e + '\n' + e.stack);
    }
})();
