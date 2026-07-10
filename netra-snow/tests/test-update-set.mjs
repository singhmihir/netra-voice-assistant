/**
 * test-update-set.mjs — runs the update-set generator in --check mode and
 * asserts the round-trip + well-formedness validation passes. SKIPs cleanly
 * if the generator or base XML is absent.
 */
import fs from 'fs';
import path from 'path';
import url from 'url';
import { execFileSync } from 'child_process';
const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const GEN = path.join(ROOT, 'scripts', 'build-update-set.mjs');
const BASE = path.join(ROOT, 'update-set', 'Netra_v2.0.0-R4.7_Batch.xml');
const R5 = path.join(ROOT, 'update-set', 'Netra_v2.0.0-R5_Batch.xml');

export default {
  name: 'update-set generator',
  run(t) {
    if (!fs.existsSync(GEN)) { t.skip('generator not present'); return; }
    if (!fs.existsSync(BASE)) { t.skip('base R4.7 XML not present'); return; }

    let out = '';
    let failed = false;
    try {
      out = execFileSync('node', [GEN, '--check', '--date', '2026-07-10 12.00.00'], { cwd: ROOT, encoding: 'utf8' });
    } catch (e) {
      failed = true;
      out = (e.stdout || '') + (e.stderr || '');
    }
    t.ok(!failed, 'generator --check exits 0');
    t.contains(out, 'Validation: PASS', 'generator reports validation PASS');
    t.contains(out, 'round-trip :', 'generator reports round-trip stat');
    // round-trip must be N/N (all match)
    const m = out.match(/round-trip\s*:\s*(\d+)\/(\d+)/);
    if (m) t.eq(m[1], m[2], 'all code records round-trip to source (' + m[1] + '/' + m[2] + ')');
    else t.ok(false, 'round-trip line not found in output');

    // if the R5 file exists, sanity-check it is well-formed-ish and has set 07
    if (fs.existsSync(R5)) {
      const xml = fs.readFileSync(R5, 'utf8');
      t.contains(xml, 'Netra v2.0.0-R5 - Complete App', 'R5 parent set named');
      t.contains(xml, 'Netra 07 - VR Analyst Expansion', 'R5 has child set 07');
      t.contains(xml, 'NetraPerformance', 'R5 ships NetraPerformance');
      const opens = (xml.match(/<sys_update_xml /g) || []).length;
      const closes = (xml.match(/<\/sys_update_xml>/g) || []).length;
      t.eq(opens, closes, 'R5 sys_update_xml tags balanced');
      // no XML-illegal control chars
      let bad = 0;
      for (let i = 0; i < xml.length; i++) { const c = xml.charCodeAt(i); if (c < 32 && c !== 9 && c !== 10 && c !== 13) bad++; }
      t.eq(bad, 0, 'R5 XML has no illegal control chars');
    } else {
      t.skip('R5 XML not yet built (run scripts/build-update-set.mjs)');
    }
  }
};
