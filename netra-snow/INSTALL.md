# Netra on ServiceNow — Installation Guide (v5.0)

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

## Path B — Update Set XML (v5.0 batch, RECOMMENDED)

The complete app ships as ONE file now: `update-set/Netra_v5.0_Batch.xml`
(parent "Netra - v5.0" + six children, ~280 updates - tables, script
includes, widget + page, REST API, automation, app shell, properties and
the navigator menu).

1. *System Update Sets → Retrieved Update Sets → Import Update Set from XML*
2. Upload `Netra_v5.0_Batch.xml`
3. Open the parent **"Netra - v5.0"**, click **Preview Update Set Batch**
4. Click **Commit Update Set Batch** - the children commit in order
5. Set your Gemini key in the `x_196061_netra_v1.gemini_api_key` property
   (shipped blank on purpose) and open `/sp?id=netra_live`

## Path C — Studio app import

`app-source/` holds the whole scoped app in Studio's source-control layout.
Push this repo to a git remote your instance can reach, then
*Studio → Import From Source Control* → repo URL + credentials → Netra
installs as a real application you can keep developing in Studio.

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
