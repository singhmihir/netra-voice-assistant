# Netra R5 — Instance Performance Runbook

How to quiet a developer instance down toward a fresh-instance baseline —
**safely, reversibly, and with every change captured in an update set** —
while keeping the Netra and Trident work fully active.

The tooling is `install/perf-audit.js` (one-shot, Scripts - Background) plus
two read-only voice tools (`instance health`, `list heavy jobs`) backed by the
`NetraPerformance` script include. The voice side never changes anything;
all changes go through the reviewed one-shot script, run by a human.

---

## The procedure

### 1. Audit (read-only — run this first, always)

1. Log in as admin on the target instance (dev390397).
2. **System Definition → Scripts - Background**, scope **Global**.
3. Paste `install/perf-audit.js` as-is (`MODE = 'AUDIT'`) and run.
4. Read the report:
   - **Section 1** — heaviest repeating jobs by runs/day (live scheduler queue).
   - **Section 2 — FLAGGED, DO NOT DISABLE** — everything matching the
     protected patterns, with the reason. *This is the "flag before we touch
     anything" list.*
   - **Section 3 — CANDIDATES** — telemetry/analytics jobs that are safe to
     pause **if the feature is unused on this instance** (each says which
     feature dies while paused).
   - **Section 4 — SPECIAL FLAGS** — currently: the temporary
     *Cross-Scope Privilege Auto-Healer* (see below).
   - **Section 5 — REVIEW** — unclassified. The script will never touch
     these; pause manually only after your own review.
   - **Section 6** — integrations inventory (scheduled imports, LDAP,
     outbound REST, MID servers) — read-only context.

### 2. Decide

Copy the **exact names** from Section 3 that you want paused into the
`PAUSE_LIST` array at the top of the script. Do not add Section 2 or
Section 5 names — Section 2 names are refused at apply time anyway
(defense in depth).

### 3. Capture — update set FIRST

Create and select update set **`Netra R5 - Instance Perf Tuning`**
(global scope) before applying. `sysauto`/`sysauto_script` are tracked
tables, so every `active` flip is captured as a customer update —
auditable, promotable, and revertible. **No change happens outside the
update set.**

### 4. Apply

Set `MODE = 'APPLY'` and run again. The script:

- re-checks every listed name against the protected patterns and **refuses**
  protected matches loudly;
- snapshots `{table, sys_id, name, was_active}` for everything it pauses;
- stores the snapshot in `x_196061_netra_v1.perf_snapshot` **and** prints it
  between `=== NETRA PERF SNAPSHOT ===` markers — save the printed copy too;
- pauses by setting `active = false`. It never deletes anything, and never
  touches `sys_trigger` rows directly.

### 5. Verify

- Re-run with `MODE = 'AUDIT'` — paused jobs disappear from Section 1/3.
- Say **"Netra, instance health"** — the busiest-jobs list should be calmer.
- Exercise the Netra demo end-to-end (exposure summary, triage, assignment)
  to confirm nothing Netra needs was affected.

### 6. Restore (any time)

Set `MODE = 'RESTORE'` and run (same update set). Everything in the snapshot
is re-activated. If the property was lost, paste the saved printed snapshot
into `SNAPSHOT_OVERRIDE`.

---

## The protected list (flag-before-touch) and why

| Pattern | Why it must stay on |
|---|---|
| `netra`, `trident`, `x_196061` | The product work this instance exists for. Includes the **Netra Watch** scanner (3-min proactive notifications). |
| `vulnerab / nvd / cve / third-party entry` | **Vulnerability Response data feeds.** Pausing these starves the CVE library and VIT flow the Netra VR demo runs on. |
| `smtp / pop reader / email` | Email send/receive. Usually quiesced on PDIs anyway; disabling the jobs causes confusing half-dead states. |
| `sla` | SLA engine — timers/breach math silently stop. |
| `text index / indexing` | Global search and Netra's knowledge search go stale. |
| `flow engine / process automation` | Flow Designer executions stop platform-wide. |
| `upgrade / patch` | Platform upgrade machinery. Never touch. |
| `cluster / node state / heartbeat` | Scheduler/cluster coordination. Never touch. |
| `session cleanup / table clean / db clean / rotation` | The housekeeping that keeps a PDI from bloating — pausing it makes performance *worse* over time. |
| `ldap`, `mid server`, `discovery`, `event management` | Integration infrastructure; disable half of it and the rest throws errors on a loop. |
| `instance scan`, `license / usage` | Health scan + licensing/usage accounting (contractual). |

**Anything not matched by a pattern lands in REVIEW and is never touched by
the script.** If you believe a REVIEW job should be paused, that's a human
decision made in the UI, inside the same update set.

## The special flag: Cross-Scope Privilege Auto-Healer (temporary)

Created 2026-07-09 as disaster recovery after the privilege-deletion
incident. It re-scans denial logs and re-grants cross-scope privileges
**every 5 minutes**, instance-wide. It was always meant to be temporary:

- **Performance**: a standing 288-runs/day job.
- **Security**: a standing auto-relaxation of scope boundaries.

Once the R5 update set (which carries the full curated privilege set) is
committed and the demo flows run clean for a day, deactivate it:
set `REMOVE_AUTO_HEALER = true` in APPLY mode. The record is deactivated,
not deleted, and lands in the snapshot like everything else.

## What "closer to a fresh instance" realistically means on a PDI

A personal developer instance already ships with email off and modest
scheduler load. The real wins here are: pausing analytics/ML collectors you
don't use (Section 3), retiring the auto-healer, and *not* letting anyone
disable the housekeeping jobs that keep tables small. Expect a calmer
`sys_trigger` queue and fewer background bursts during demos — not a
different instance class. For demo-day latency, the bigger levers remain the
R4.7 application-level ones (model choice, vocab gating, poll backoff),
which are already in place.

## Voice access (read-only)

| Utterance | Tool | What you get |
|---|---|---|
| "Netra, instance health" | `instance_health` | Active job count, runs due next hour, busiest job, slow transactions (24h), standing flags. |
| "Netra, list the heaviest jobs" | `list_heavy_jobs` | Top repeating jobs by runs/day with protected/candidate/review classification. |
| "Netra, integration report" | `integration_report` | Scheduled imports, LDAP, outbound REST, MID inventory. |

These require `admin` (or roles listed in `x_196061_netra_v1.perf_read_roles`)
and can neither pause nor change anything.
