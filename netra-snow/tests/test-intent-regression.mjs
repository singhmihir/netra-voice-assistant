/**
 * test-intent-regression.mjs — light regression that (a) every one of the 11
 * script includes still LOADS under the ES5/scoped-sandbox-ish mock, and
 * (b) NetraIntent still parses representative commands. NetraIntent is
 * unchanged in R5; this guards against accidental breakage from shared edits.
 */
import fs from 'fs';
import path from 'path';
import url from 'url';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const { makeEnv, loadScriptInclude } = require('./glide-mock.js');
const fx = require('./fixtures.js');

const SI_DIR = path.join(__dirname, '..', 'source', 'script_includes');
const INCLUDES = [
  'NetraIntent', 'NetraTools', 'NetraResponder', 'NetraScanner', 'NetraKnowledge',
  'NetraChat', 'NetraSummarizer', 'NetraContext', 'NetraNavigator',
  'NetraVulnerability', 'NetraPerformance'
];

export default {
  name: 'intent + load regression',
  run(t) {
    // ---------- all 11 script includes load and construct ----------
    // Some includes (NetraResponder, NetraScanner) construct sibling includes
    // in initialize; provide lightweight stub constructors for all siblings so
    // construction succeeds and we exercise the real initialize path.
    const siblingStubs = {};
    INCLUDES.forEach((n) => { siblingStubs[n] = function () { this.type = n; }; });
    INCLUDES.forEach((name) => {
      const src = fs.readFileSync(path.join(SI_DIR, name + '.js'), 'utf8');
      const env = makeEnv(fx.buildWorld({}), {
        roles: ['admin'], userId: 'user_self', now: fx.now, choiceLabels: fx.choiceLabels, schema: fx.schema({})
      });
      try {
        // inject stubs for the OTHER includes (not this one)
        const extras = {};
        INCLUDES.forEach((n) => { if (n !== name) extras[n] = siblingStubs[n]; });
        const Ctor = loadScriptInclude(src, env, name, extras);
        t.truthy(typeof Ctor === 'function', name + ' loads (parses) and defines a class');
        const inst = new Ctor();
        t.truthy(inst, name + ' constructs');
        t.eq(inst.type, name, name + '.type is set');
      } catch (e) {
        t.ok(false, name + ' load/construct failed: ' + e.message);
      }
    });

    // ---------- NetraIntent parses representative commands ----------
    (function () {
      const src = fs.readFileSync(path.join(SI_DIR, 'NetraIntent.js'), 'utf8');
      const env = makeEnv(fx.buildWorld({}), { roles: ['admin'], userId: 'user_self', now: fx.now });
      const Intent = loadScriptInclude(src, env, 'NetraIntent');
      const parse = (txt, pending) => new Intent().parse(txt, pending || null);

      const cases = [
        ['create a ticket for my laptop is broken', 'create'],
        ['list my tickets', 'list'],
        ['resolve INC0001234', 'resolve'],
        ['list my approvals', 'list_approvals'],
        ['pause for two hours', 'pause_for'],
        ['resume', 'resume'],
        ['help', 'help'],
        ['status of INC0005555', 'status'],
      ];
      cases.forEach(([txt, expect]) => {
        const r = parse(txt);
        t.eq(r.action, expect, 'intent "' + txt + '" -> ' + expect + ' (got ' + r.action + ')');
      });
      // pending slot fill
      const pf = parse('two hours', 'pause_duration');
      t.eq(pf.action, 'pause_for', 'pending pause_duration slot fills');
    })();
  }
};
