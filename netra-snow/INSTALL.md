# Netra on ServiceNow — Installation Guide (v2.0.0)

Total time: **~10 minutes**. Zero external services. Zero recurring cost.

> **Browser:** Chrome or Edge required for the wake word and Web Speech APIs.

---

## What you'll set up

| Done by Update Set XML       | Done manually (UI, ~5 min)           |
|---|---|
| 4 Script Includes            | Scoped app `x_netra`                 |
| Business Rule                | Table `x_netra_notification`         |
| Scheduled Job (every 3 min)  | Table `x_netra_user_pref`            |
|                              | Scripted REST API + 2 resources      |
|                              | Service Portal widget                 |

---

## 1. Create the scoped application (1 min)

1. **System Applications → My Company Applications → Create new → Start from scratch**
2. Settings:
   - **Name:** `Netra Voice Assistant`
   - **Scope:** `x_netra` *(must match exactly)*
   - **Version:** `2.0.0`
3. Click **Create**. ServiceNow drops you into **Studio** with this app open.

> Keep that Studio tab open — every subsequent step happens inside this app's scope.

---

## 2. Create the two tables (3 min)

### 2a. `x_netra_notification`

In Studio: **Create Application File → Table**

| Setting   | Value                  |
|-----------|------------------------|
| Label     | `Netra Notification`   |
| Name      | `x_netra_notification` |

Add these columns:

| Column          | Type                  | Length | Default |
|-----------------|-----------------------|--------|---------|
| `user`          | Reference → `sys_user`| —      | —       |
| `ticket_sys_id` | String                | 32     | —       |
| `ticket_number` | String                | 32     | —       |
| `kind`          | String                | 40     | —       |
| `message`       | String                | 1000   | —       |
| `delivered`     | True/False            | —      | `false` |
| `delivered_at`  | Date/Time             | —      | —       |

Save.

### 2b. `x_netra_user_pref`

| Setting   | Value                |
|-----------|----------------------|
| Label     | `Netra User Pref`    |
| Name      | `x_netra_user_pref`  |

Add these columns:

| Column              | Type                  | Length | Default |
|---------------------|-----------------------|--------|---------|
| `user`              | Reference → `sys_user`| —      | —       |
| `active`            | True/False            | —      | `true`  |
| `paused_until`      | Date/Time             | —      | —       |
| `last_scan_time`    | Date/Time             | —      | —       |
| `watch_assignments` | True/False            | —      | `true`  |
| `watch_comments`    | True/False            | —      | `true`  |
| `watch_approvals`   | True/False            | —      | `true`  |

Save.

---

## 3. Import the Update Set (1 min)

Drops the 4 Script Includes, the Business Rule, and the Scheduled Job in one shot.

1. **System Update Sets → Retrieved Update Sets → Import Update Set from XML**
2. Upload `netra-snow/update-set/netra-v2.0.0.xml` from this repo
3. Open the loaded set, click **Preview Update Set**, then **Commit Update Set**

You should now see in Studio under `Netra Voice Assistant`:
- `NetraIntent`, `NetraTools`, `NetraResponder`, `NetraScanner` (Script Includes)
- `Netra Notify On Comment` (Business Rule)
- `Netra Watch` (Scheduled Script Execution, runs every 3 minutes)

Confirm the scheduled job is active: **System Definition → Scheduled Jobs**, filter by Application = Netra. The next-run column should show a time within 3 minutes.

---

## 4. Create the Scripted REST API (3 min)

1. **System Web Services → Scripted REST APIs → New**
2. Settings:
   - **Name:** `Netra Voice`
   - **API ID:** `voice`
   - **Application:** `Netra Voice Assistant`
3. Save. The full base path becomes `/api/x_netra/voice`.
4. Open the related list **Resources**, click **New**:
   - **Name:** `command`
   - **HTTP method:** `POST`
   - **Relative path:** `/command`
   - **Requires authentication:** ✔
   - **Script:** paste the entire contents of `netra-snow/source/scripted_rest/command.js`
   - Save.
5. **New** again:
   - **Name:** `notifications`
   - **HTTP method:** `GET`
   - **Relative path:** `/notifications`
   - **Requires authentication:** ✔
   - **Script:** paste `netra-snow/source/scripted_rest/notifications.js`
   - Save.

---

## 5. Create the Service Portal widget (2 min)

1. **Service Portal → Service Portal Configuration → Widgets → New**
2. Settings:
   - **Name:** `Netra Mic`
   - **ID:** `netra-mic`
   - **Application:** `Netra Voice Assistant`
3. Save, then paste each section from `netra-snow/source/widget/`:
   - **Body HTML template** ← `template.html`
   - **Client controller** ← `client.js`
   - **Server script** ← `server.js`
   - **CSS - SCSS** ← `stylesheet.scss`
   - **Option schema** ← `option_schema.json` *(content is just `[]`)*
4. Save.

---

## 6. Add the widget to a portal page (30 sec)

1. **Service Portal → Service Portal Configuration → Designer**
2. Open the **Service Portal home** page (portal `sp`, page id `index`)
3. Drag a **Netra Mic** widget into any container — it floats fixed in the bottom-right corner
4. Save the page

---

## 7. Test (1 min)

Open the portal in Chrome/Edge:
`https://YOUR-INSTANCE.service-now.com/sp`

When prompted, allow microphone access.

**Try in order:**

| Step | Say (or type and press Alt+N) | Expected |
|---|---|---|
| 1 | *"Netra"* | Floating dock chimes and listens |
| 2 | *"Create a ticket for my email is broken"* | Netra confirms with a new INC number |
| 3 | *"List my tickets"* | She reads back open tickets |
| 4 | *"Pause"* | She asks: "For how many hours should I pause?" |
| 5 | *"Two hours"* | She confirms pause and shows the purple paused banner |
| 6 | *"Resume"* | She comes back |

**Test proactive notifications:**

1. Have another admin user comment on one of your incidents → within 8 seconds, Netra speaks the comment aloud.
2. Have another admin assign an incident to you → within 3 minutes (next NetraScanner run), Netra interrupts and announces it.

To trigger the scanner manually for testing:
- **System Definition → Scheduled Jobs → Netra Watch → Execute Now**

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Wake word does nothing | Use Chrome or Edge. Site must be HTTPS (it is, by default on dev instances). Check mic permission. |
| Scheduled job never fires | Confirm `Active = true` and `Run = Periodically` on **Netra Watch**. Check that `x_netra_user_pref` has at least one row (it's created when you first load the widget). |
| Pause doesn't stick | Check that the table `x_netra_user_pref` has the `paused_until` column. Re-import the Update Set if Script Includes show errors. |
| "I didn't catch that" loop | Ambient noise. Mute background tabs (especially other video). |

---

## How it all fits together

```
                      ┌─────────────────────────────────────┐
                      │   Service Portal page (Chrome/Edge) │
                      │                                     │
                      │   netra-mic widget                  │
                      │   ├─ wake word "Netra"              │
                      │   ├─ Web Speech STT                 │
                      │   ├─ Web Speech TTS                 │
                      │   └─ polls /notifications every 8s  │
                      └────────┬────────────────────────────┘
                               │
                  POST /command│         GET /notifications
                               ▼
   ┌───────────────────────────────────────────────────────────┐
   │  Scripted REST API  /api/x_netra/voice/*                  │
   │     │                                                      │
   │     ▼                                                      │
   │  NetraIntent  → NetraResponder  → NetraTools (GlideRecord)│
   │                                                            │
   │                                          ┌──────────────┐ │
   │  Scheduled Job "Netra Watch"  ──────────►│ x_netra_     │ │
   │  every 3 min  → NetraScanner  ───────────┤ notification │ │
   │  scans assignments/approvals/tasks        │ (queue)      │ │
   │                                          └──────────────┘ │
   │                                                  ▲         │
   │  Business Rule on sys_journal_field ─────────────┘         │
   │  fires the instant a comment is added                      │
   └────────────────────────────────────────────────────────────┘
```
