/* The three engine harnesses (quota governor, missions, semantic search) - each in its own process. */
'use strict';
var T = require('./lib/t'), cp = require('child_process'), path = require('path');
['brain', 'missions', 'semantic'].forEach(function (n) {
    T.test(n + ' engine harness', function () {
        var r = cp.spawnSync(process.execPath, [path.join(__dirname, 'engines', n + '.harness.js')], { encoding: 'utf8' });
        T.ok(r.status === 0, n + ' harness failed:\n' + (r.stdout || '') + (r.stderr || ''));
    });
});
T.run(__filename);
