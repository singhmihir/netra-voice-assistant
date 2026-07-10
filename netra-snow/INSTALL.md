# Netra on ServiceNow — Installation Guide (v2.0.0)

**Two install paths.** Pick one.

| Path | Time | Manual steps |
|---|---|---|
| **A. Background Script (Recommended)** | ~3 min | 2 paste-and-run, plus 1 portal click |
| B. Update Set XML + UI clicks | ~10 min | 6 UI steps |

> Browser requirement: Chrome or Edge for the Web Speech APIs. Other browsers can still click the mic button but won't have wake word.

---

## Path A — Background Script (Recommended)

### A.1  Create the scoped application (1 min)

1. In ServiceNow, navigate to **System Applications → My Company Applications → Create new**.
2. Click **Start from scratch**.
3. Fill in:
   - **Name:** `Netra Voice Assistant`
   - **Scope:** `x_196061_netra` *(must match exactly)*
   - **Version:** `2.0.0`
4. Click **Create**.

### A.2  Run the Background Script (1 min)

1. Open the file `netra-snow/install/setup-netra.js` from this repo. Select all (`Ctrl+A`), copy.
2. In ServiceNow, navigate to **System Definition → Scripts - Background**.
3. At the top, set **Run this script in** to your app's scope (`Netra Voice Assistant`) — or leave it on `global` if you have admin and your instance allows cross-scope writes.
4. Paste the script into the **Run script** box.
5. Click **Run script**.

You should see output like:
```
=== Netra install starting ===
Using scope x_196061_netra (sys_id ...)

Tables...
  + table x_196061_netra_notification
    . column x_196061_netra_notification.user (reference)
    ...
  + table x_196061_netra_user_pref
    ...

Script Includes...
  > script include NetraIntent
  > script include NetraTools
  > script include NetraResponder
  > script include NetraScanner

Business Rule...
  > business rule Netra Notify On Comment on sys_journal_field

Scheduled Job...
  > scheduled job Netra Watch (every 00:03:00)

Scripted REST API...
  > scripted REST service Netra Voice (/api/x_196061_netra/voice)
  > REST resource POST /command
  > REST resource GET /notifications

Service Portal Widget...
  > widget netra-mic

=== Netra install complete ===
```

The script is **idempotent** — re-run it any time to update artifacts from refreshed source.

### A.3  Add the widget to a portal page (1 min)

1. **Service Portal → Service Portal Configuration → Designer**
2. Open the **Service Portal home** page (portal `sp`, page id `index`)
3. Drag a **Netra Mic** widget into any container — it positions itself fixed in the bottom-right corner
4. Save the page

### A.4  Test (1 min)

Open the portal in **Chrome or Edge**:
`https://YOUR-INSTANCE.service-now.com/sp`

Allow microphone when prompted.

| Try this | Expected |
|---|---|
| Say *"Netra"* | Dock chimes, status flips to listening |
| *"Create a ticket for my email is broken"* | Confirms with a new INC number |
| *"List my tickets"* | Reads back open tickets |
| *"Pause"* | Asks *"For how many hours?"* |
| *"Two hours"* | Confirms pause; purple banner appears |
| *"Resume"* | Comes back |

Proactive scan check:
- **System Definition → Scheduled Jobs → Netra Watch → Execute Now**
- Then have another admin user assign an incident to you — within the 8-second poll window after the scheduler runs, Netra will interrupt and announce it.

---

## Path B — Update Set XML (alternative)

The batch XML `update-set/Netra_v2.0.0-R5_Batch.xml` is the **complete app** —
7 child update sets under one parent ("Netra v2.0.0-R5 - Complete App"):
01 Application & Tables, 02 Script Includes, 03 REST API & Automation,
04 Service Portal, 05 Properties & Privileges, 06 Vulnerability Response,
07 VR Analyst Expansion & Performance. No manual record creation is needed.

1. **System Update Sets → Retrieved Update Sets → Import Update Set from XML.**
2. Upload `Netra_v2.0.0-R5_Batch.xml`.
3. Open the parent set **"Netra v2.0.0-R5 - Complete App"**, click **Preview**,
   resolve any preview warnings, then **Commit**. The 7 children commit
   automatically in numeric order (tables before code before portal).
4. Continue to **Post-install** below.

> The XML is regenerated from `source/` by `node scripts/build-update-set.mjs`
> (it validates well-formedness and round-trips every code record to source).
> The prior `Netra_v2.0.0-R4.7_Batch.xml` is kept as the generator's base and
> as release history — do not import both.

---

## Post-install (both paths)

### 1. Set the Gemini API key (required for the conversational brain + TTS)

1. **System Properties → All Properties** (or filter `sys_properties.list`).
2. Set **`x_196061_netra_v1.gemini_api_key`** to a free key from
   <https://aistudio.google.com/apikey>. Keep it `is_private` — never commit it.
3. Optional: `x_196061_netra_v1.gemini_model` (default `gemini-flash-lite-latest`).

### 2. Assign roles to your analyst / service account

Netra acts as the logged-in user and enforces real ACLs.

- **ITSM features**: the user needs the usual `itil` etc. roles.
- **Vulnerability Response (R5)**: assign one of
  `sn_vul.vulnerability_analyst`, `sn_vul.admin`, `sn_vul.vulnerability_write`
  (or `sn_vul.vulnerability_read` for read-only). Without a VR role, Netra
  politely declines VR requests.
- **Instance-health tools (R5)**: `admin`.
- To grant VR/perf access to a **custom** role, add it (comma-separated) to
  `x_196061_netra_v1.vr_read_roles`, `.vr_write_roles`, or `.perf_read_roles`.

### 3. Smoke test

Load the portal page with the widget, then say (or type in the dev panel):

| Say | Expect |
|---|---|
| *"debug"* (dev panel typed command) | version **v8.0 (R5)**, `api_key_status: configured` |
| *"What's my vulnerability exposure?"* | Spoken band counts (or a role-needed message if unroled) |
| *"Instance health"* | Active job count + busiest job (admin only) |

Also hit **GET `/api/x_196061_netra_v1/voice/ping`** — it now probes
`NetraVulnerability` and `NetraPerformance` too.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `ERROR: scoped app "x_196061_netra" not found.` | Complete step A.1 first. |
| Background Script fails partway | Re-run it — it's idempotent. Common cause: scope dropdown was on `global`; switch to `Netra Voice Assistant` scope. |
| Tables appear but columns missing | Re-run the script. The `upsertColumn` step creates them. |
| Wake word does nothing | Use Chrome or Edge. Confirm mic permission. Site must be HTTPS (dev instances are). |
| Scheduled job never fires | Confirm **Netra Watch** is active. Confirm `x_196061_netra_user_pref` has rows (the widget creates one when first loaded). Use **Execute Now** to test. |
| Pause doesn't stick | Confirm `x_196061_netra_user_pref.paused_until` column exists. Re-run Background Script. |

---

## Uninstall

To remove Netra entirely:

1. **System Applications → All Available Applications → My Apps → Netra Voice Assistant**
2. Click **Delete** on the row. ServiceNow removes every record in the `x_196061_netra` scope automatically — tables, script includes, business rules, scheduled jobs, REST API, widget.
3. Remove the widget instance from any portal pages.
