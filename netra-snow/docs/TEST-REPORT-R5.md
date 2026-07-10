# Netra R5 — Test Report

**Release:** R5 (app version 2.0.0) · **Date:** 2026-07-10 · **Scope:** `x_196061_netra_v1`

R5 is the first Netra release with an **automated, repeatable test harness**.
Prior reports (R2–R4) were produced by driving a live instance through a
browser; that path can't run in CI and can't exercise the server brain without
a Service Portal session. R5 adds a zero-dependency Node harness that unit-tests
the ServiceNow script includes against an in-memory GlideRecord mock, statically
verifies the widget server, and validates the update-set generator — plus a
live-instance checklist for the parts a mock can't cover.

---

## Summary

| Suite | Assertions | Result |
|---|---:|:--:|
| NetraVulnerability (VR analyst suite) | 63 | ✅ pass |
| NetraPerformance (instance analytics) | 52 | ✅ pass |
| intent + load regression (all 11 script includes) | 42 | ✅ pass |
| server/static integrity (widget + ES5 + parity) | 95 | ✅ pass |
| update-set generator (round-trip + wellformed) | 9 | ✅ pass |
| **Total** | **261** | **✅ all green** |

Run with: `node netra-snow/tests/run-tests.mjs` (add `--filter <name>` for one suite).

---

## What each suite proves

### NetraVulnerability (63)
Exercises every one of the 26 public methods against a fixture world of 15
vulnerable items spanning all risk bands and states, 4 CVE entries, 2
vulnerability groups, and a user/group membership graph:

- **RBAC** — reads denied without a VR role; writes denied for read-only roles;
  `admin` and property-granted custom roles pass; denial messages name the role.
- **Filters** — band, CVE, asset, age, `me`/`group`/`all` scope, risk ordering.
- **Injection** — a caret-bearing value (`web^ORstateISNOTEMPTY`) is sanitized,
  not allowed to widen the query.
- **Lifecycle** — assign (with ambiguity refusal + candidate list), state change,
  defer (reason mandatory, optional review date), resolve/close (note mandatory),
  false positive, reopen — and false positive still works on an instance
  **without** the `substate` field.
- **Analytics** — overdue (both `remediation_target` and age-fallback bases),
  aging buckets + oldest sorting, opened/closed trend with MTTR, groups.
- **Bulk** — preview requires a filter and counts matches; apply enforces the
  50-item cap and reports overflow; unknown actions and reason-less defers refused.
- **Change creation** — a linked `change_request` is inserted with CVE context.

### NetraPerformance (52)
- **RBAC** — non-admin denied; `perf_read_roles` property grant works.
- **Classification** — Netra/Trident/NVD/SLA/indexing/email/cleanup → protected;
  PA/Predictive Intelligence → candidate; the temporary auto-healer → remove-
  recommended; unknown → review; **protected beats candidate** when both match.
- **Reports** — health summary (job counts, slow transactions, flags), topJobs
  ordering + classification, integration inventory, and graceful zeros when the
  underlying tables aren't readable.

### intent + load regression (42)
All **11** script includes load (parse) and construct under the ES5/scoped-
sandbox-style loader — guarding against a shared edit breaking any include —
and NetraIntent still parses representative ITSM commands and a slot-fill.

### server/static integrity (95)
Static analysis of the widget and every ServiceNow-side file:

- **Parses** — `new Function()` over all 19 files.
- **ES5-only** — a proper comment/string tokenizer scans for `let`/`const`/
  arrow/`class`/spread/`${}` template interpolation. **Zero real violations.**
- **Tool parity** — declaration names and dispatch cases extracted and set-
  compared: **88 declarations ↔ 88 dispatch cases, exact match** (was 72/72 at
  R4.7; +16 for R5). Every new R5 tool is both declared and dispatched.
- **Regression guards** — VIT/VUL routing in `_tableForNumber`; the debug API-key
  length/prefix leak is gone; version is `v8.0 (R5)`; no `gs.setProperty` in
  widget code; installer uses `source_scope` (never the phantom `source`);
  no XML-illegal control characters in any file shipped through the update set.

### update-set generator (9)
Runs `build-update-set.mjs --check` and asserts it exits clean with
**round-trip N/N** — every code-bearing record's payload, when unescaped,
equals its `source/` file byte-for-byte after scope substitution — plus
balanced tags, presence of child set 07, and zero illegal control chars in the
emitted R5 XML.

---

## Update-set integrity (independent verification)

`Netra_v2.0.0-R5_Batch.xml`: **8 update sets** (parent + 7 children),
**192 records**. Verified beyond the generator's own `--check`:

- **Well-formed** under Python's strict `expat` parser (stricter than
  ServiceNow's importer) — this caught a latent bug (below).
- **Round-trip** — the widget's four fields (template/client/server/css) and
  the NetraPerformance script include payloads all match their source files
  exactly after unescaping.
- **Deterministic** — same source + `--date` produces byte-identical output.

---

## Bugs found and fixed during R5 testing

1. **XML-illegal control chars silently broke the update-set export.** `client.js`
   used raw `0x01` (SOH) bytes as SSML emphasis/pause sentinels — valid in JS,
   forbidden in XML 1.0. The R4.7 export predated that change and used plain
   string sentinels, so the breakage was invisible until the generator embedded
   the current source. Fixed by switching the sentinels to `U+E000`
   (private-use, XML-valid); runtime SSML output is unchanged (verified). The
   generator now also refuses to emit control chars.
2. **`$1` backreference corruption in the generator.** Splicing source code
   (which contains `$1` in regex replacement strings) via `String.replace(re,
   str)` made JS interpret `$1` as a capture-group backreference. Fixed by using
   function replacements everywhere source is injected.
3. **`NetraTools._findByNumberAny` used a phantom field.** `addQuery(
   'caller_idORassigned_to', …)` is not a real field — GlideRecord silently
   dropped it, weakening the caller-or-assignee restriction. Fixed to a proper
   `addQuery('caller_id').addOrCondition('assigned_to')`.

The mock itself surfaced two harness bugs (an empty `Class.create` that never
called `initialize`, and a reference-field not unwrapped in the encoded-query
evaluator) — both fixed so the mock matches ServiceNow semantics.

---

## Coverage limits (what the harness can't prove — verify live)

The mock is not ServiceNow. These require the checklist below on dev390397:

- Real ACL/cross-scope enforcement (the mock models roles, not ACLs).
- The Gemini function-calling loop and the widget round-trip (needs an SP session).
- Actual `sn_vul_*` schema on the instance (field names/choice values, e.g.
  whether `substate`/`remediation_target`/`change_request` exist — the code
  guards these defensively).
- Browser speech recognition/TTS, the orb UI, and latency.
- The `perf-audit.js` apply/restore against real scheduler tables.

### Live-instance checklist

1. Import the R5 batch (or run `setup-netra.js`); Preview & Commit shows no errors.
2. `GET /api/x_196061_netra_v1/voice/ping` → all script includes and tables green.
3. Dev-panel *"debug"* → `v8.0 (R5)`, `api_key_status: configured`.
4. With a VR role: run the [`DEMO-SCRIPT.md`](DEMO-SCRIPT.md) storyline end-to-end;
   confirm each mutating action wrote a `[Netra]` work note.
5. Without a VR role: confirm VR requests get the role-needed message.
6. As admin: *"instance health"* returns real numbers.
7. Run `perf-audit.js` in AUDIT mode; review the flagged/candidate lists; if
   pausing, do it inside the `Netra R5 - Instance Perf Tuning` update set and
   verify RESTORE brings everything back.

---

## How to reproduce

```bash
node netra-snow/tests/run-tests.mjs                     # 261 assertions
node netra-snow/scripts/build-update-set.mjs --check    # generator round-trip
python3 -c "import xml.dom.minidom as m; m.parse('netra-snow/update-set/Netra_v2.0.0-R5_Batch.xml')"  # strict wellformed
```
