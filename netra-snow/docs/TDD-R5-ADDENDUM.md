# Netra R5 — TDD Addendum

Supplements [`TDD.md`](TDD.md) (which documents the R3-era architecture). This
addendum covers only what R5 adds or changes. Where the two disagree, R5 wins.

---

## 1. What R5 adds

| Area | R5 change |
|---|---|
| VR analyst suite | `NetraVulnerability` expanded from 11 → 26 public methods |
| Instance analytics | new `NetraPerformance` script include (read-only) |
| Safe-pause tooling | `install/perf-audit.js` one-shot + `docs/PERF-RUNBOOK.md` |
| Widget server | +16 Gemini tools (88 declarations ↔ 88 dispatch cases) |
| Access control | role gates on all VR reads/writes; perf tools admin-gated |
| Speech | VIT/CVE number normalization + VR grammar in `client.js` |
| Deployment | `scripts/build-update-set.mjs` — the XML is a build product again |
| Testing | `tests/` — 261-assertion zero-dependency harness |

Tool count: **~90** total (74 pre-existing + 16 new). The system prompt's VR
section grew by ~8 lines; prompt size is watched because it costs latency on
every turn (the tool loop can call Gemini up to 5× per turn).

---

## 2. Role-based access (new)

The user requirement was explicit: use real role-based access, no working
around controls. Netra already runs every query as the logged-in user, so
platform ACLs apply. R5 adds an **application-level gate** on top so VR
capabilities are only offered to users who should have them, and denials are
spoken clearly rather than returning empty result sets.

- `NetraVulnerability._canRead()` / `._canWrite()` — check the standard
  `sn_vul.*` roles (`vulnerability_analyst`, `admin`, `vulnerability_write`,
  `vulnerability_read`, `remediation_owner`, `read`) plus any comma-listed roles
  in `x_196061_netra_v1.vr_read_roles` / `vr_write_roles`.
- `NetraPerformance._canRead()` — `admin` or `perf_read_roles`.
- Every public method returns a spoken-friendly denial when the gate fails.

This is defense in depth, not a substitute for ACLs: the cross-scope privileges
still grant the app table access, and ServiceNow ACLs still apply to the write.

## 3. Defensive schema handling

`sn_vul_*` schemas vary across instances and plugin versions. R5 code guards
every non-guaranteed field with `isValidField(...)` and degrades gracefully:

- `remediation_target` — used for overdue basis + defer review date when present;
  otherwise overdue falls back to age (property `vr_overdue_days`, default 30).
- `substate` — set to `fixed`/`false_positive` when present; skipped otherwise.
- `close_notes`, `change_request`, `closed_at`, `vulnerability_group` — all guarded.
- `sn_vul_vulnerability_group` — the whole groups feature no-ops with a spoken
  message if the table is absent.

## 4. Bulk operation protocol

Bulk changes are two-phase and enforced at two layers:

1. **Preview** (`bulkPreview`) — counts matches (bounded scan), reads back a
   sample and the filter, no mutation.
2. **Apply** (`bulkApply`) — re-validates params, mutates at most `BULK_CAP`
   (50) items highest-risk-first, audits each, reports overflow.

The widget server adds a stateless gate: `bulk_vulnerability_apply` refuses
unless `args.confirmed === 'yes'`. The declaration teaches the model the
protocol (preview → speak the count → get an explicit yes → apply with
`confirmed='yes'`), and `confirmed` is deliberately **not** in the tool's
`required[]` so the model can't satisfy the gate reflexively.

## 5. Update-set generator (`build-update-set.mjs`)

Restores the batch XML to a build product. Takes the R4.7 batch as a base,
refreshes all code-bearing records from `source/`, adds R5 artifacts to a new
child set (`Netra 07`), and rewrites the parent to R5.

Key invariants:

- **Single-escape discipline** — payloads are entity-escaped exactly once;
  script fields keep their CDATA wrappers. Source is injected via function
  replacements so `$1`/`$&` in code are literal.
- **Only-if-changed** — records whose content is unchanged keep their
  guid/history (idempotent, byte-stable builds; deterministic given `--date`).
- **`--check`** — validates well-formedness, name↔sys_id parity, set-reference
  resolution, **byte round-trip of every code record to its source file**, and
  the absence of XML-illegal control characters.

`payload_hash` uses Java's `String.hashCode` (signed 32-bit) to match the file's
convention; it's advisory (ServiceNow uses it for collision detection, not load
validation), as the CDATA-payload `Netra_Version_1.xml` with empty hashes proves.

## 6. Test harness (`tests/`)

A faithful-enough in-memory ServiceNow mock (`glide-mock.js`) — GlideRecord with
operator + encoded-query support, GlideAggregate, GlideDateTime/Duration,
reference/journal fields, `isValidField` schemas, settable roles/properties, and
a `Class.create` that calls `initialize` like the real platform. Suites unit-test
the script includes, statically verify the widget (including tool-parity), and
validate the generator. See [`TEST-REPORT-R5.md`](TEST-REPORT-R5.md).

## 7. Notable fixes (see test report for detail)

- SSML sentinels changed from raw `0x01` to `U+E000` (XML 1.0 validity).
- `NetraTools._findByNumberAny` phantom-field query corrected.
- `exposureSummary` dead code removed; `assignVulnerableItem` gains
  disambiguation + encoded-query sanitizing.

## 8. Known limitations (carried into R5)

- **No barge-in.** User speech during TTS is still ignored by design; adding it
  risks an echo loop and needs live tuning. Deferred.
- **CVE word-number forms.** `"CVE twenty twenty one …"` is not normalized; the
  conservative normalizer handles digit and `CVE-YYYY-NNNN` forms.
- **`substate` values** are best-effort — if the instance's choice list differs,
  the state still changes and the audit note still records the intent.
- Everything in TDD.md §"known limitations" that R5 didn't touch still applies
  (iOS Safari continuous recognition, corporate-network Edge-TTS blocking,
  free-tier Gemini rate limits).
