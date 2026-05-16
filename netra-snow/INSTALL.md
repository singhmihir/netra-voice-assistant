# Netra on ServiceNow — Installation Guide

This installs Netra into your ServiceNow developer instance. Everything is
100% free — no external API keys, no paid services. Estimated time: **8 minutes**.

> **Browser requirement:** Chrome or Edge (the Web Speech API for STT works
> reliably only there). Firefox/Safari can fall back to push-to-talk via mic
> button + `Alt+N` hotkey, but won't have wake-word recognition.

---

## 0. Prerequisites

- A ServiceNow developer instance from https://developer.servicenow.com
- Admin access to that instance
- This repo, cloned locally (so you have the files to paste)

---

## 1. Create the scoped application (1 min)

1. In ServiceNow, navigate to **System Applications → My Company Applications**.
2. Click **Create new** → **Start from scratch**.
3. Fill in:
   - **Name:** `Netra Voice Assistant`
   - **Scope:** `x_netra`  *(must match exactly)*
   - **Version:** `1.0.0`
   - **Description:** Voice-first accessibility assistant for blind users.
4. Click **Create**. You should be dropped into ServiceNow **Studio** with the new app open.

---

## 2. Create the notification queue table (2 min)

While in Studio with `Netra Voice Assistant` open:

1. **Create Application File** (top-left + button) → **Table**.
2. Settings:
   - **Label:** `Netra Notification`
   - **Name:** `x_netra_notification` *(should auto-populate)*
3. Save, then add these columns via **Form Designer** → **Add field**:

| Column          | Type       | Length | Default     |
|-----------------|------------|--------|-------------|
| `user`          | Reference → `sys_user` | —    | —           |
| `ticket_sys_id` | String     | 32     | —           |
| `ticket_number` | String     | 32     | —           |
| `kind`          | String     | 40     | —           |
| `message`       | String     | 1000   | —           |
| `delivered`     | True/False | —      | `false`     |
| `delivered_at`  | Date/Time  | —      | —           |

Save the table.

---

## 3. Import the Update Set (1 min)

Imports the **3 Script Includes** + **1 Business Rule** in one shot.

1. Navigate to **System Update Sets → Retrieved Update Sets**.
2. Click **Import Update Set from XML** (related links at the bottom).
3. Upload `netra-snow/update-set/netra-v1.0.0.xml` from this repo.
4. Open the loaded update set, click **Preview Update Set**, then **Commit Update Set**.
5. You should now see in Studio:
   - `NetraIntent` (Script Include)
   - `NetraTools` (Script Include)
   - `NetraResponder` (Script Include)
   - `Netra Notify On Comment` (Business Rule)

> If preview shows collisions, accept "Update", not "Skip".

---

## 4. Create the Scripted REST API (3 min)

1. Navigate to **System Web Services → Scripted REST APIs** → **New**.
2. Settings:
   - **Name:** `Netra Voice`
   - **API ID:** `voice` *(this becomes part of the URL)*
   - **Application:** `Netra Voice Assistant`
3. Save. The full base path will be `/api/x_netra/voice`.
4. In the related list **Resources**, click **New** and create the first resource:
   - **Name:** `command`
   - **HTTP method:** `POST`
   - **Relative path:** `/command`
   - **Requires authentication:** ✔
   - **Script:** paste the entire contents of `netra-snow/source/scripted_rest/command.js`
5. Save. Click **New** again for the second resource:
   - **Name:** `notifications`
   - **HTTP method:** `GET`
   - **Relative path:** `/notifications`
   - **Requires authentication:** ✔
   - **Script:** paste the contents of `netra-snow/source/scripted_rest/notifications.js`
6. Save.

---

## 5. Create the Service Portal widget (2 min)

1. Navigate to **Service Portal → Service Portal Configuration → Widgets** → **New**.
2. Settings:
   - **Name:** `Netra Mic`
   - **ID:** `netra-mic`
   - **Application:** `Netra Voice Assistant`
3. Save. Now paste each piece from `netra-snow/source/widget/`:
   - **Body HTML template** ← `template.html`
   - **Client controller** ← `client.js`
   - **Server script** ← `server.js`
   - **CSS - SCSS** ← `stylesheet.scss`
   - **Option schema** ← `option_schema.json` (just `[]`)
4. Save.

---

## 6. Add the widget to a portal page (30 sec)

1. Navigate to **Service Portal → Service Portal Configuration → Designer**.
2. Open the **Service Portal home** page (`sp` portal, page id `index`).
3. Drag a **Netra Mic** widget into any container. It floats fixed in the
   bottom-right corner regardless of where you drop it.
4. Save the page.

---

## 7. Test it (1 min)

1. Open the Service Portal in Chrome/Edge: `https://YOUR-INSTANCE.service-now.com/sp`
2. Grant microphone permission when prompted.
3. Try, in order:
   - Click the blue mic button → say *"create a ticket for my email is not working"*
   - Click again → *"list my tickets"*
   - Click again → *"resolve I N C zero zero zero one two three four"* (or whatever number was created)
4. To test proactive notifications: have a colleague (or another admin user)
   add a comment to one of your tickets. Within 8 seconds, Netra should
   speak the comment aloud.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Mic button does nothing in Firefox/Safari | Use Chrome or Edge. Web Speech API isn't supported elsewhere. |
| "I didn't catch that" every time | Site needs HTTPS; ServiceNow dev instances are HTTPS by default. Check microphone permissions in the browser address bar. |
| Server returns 401 / 403 | Run `gs.getUserID()` in **System Definition → Scripts - Background** to confirm you're logged in. The Scripted REST resources require auth. |
| Notifications never fire | Confirm the Business Rule is active (**System Definition → Business Rules**, filter by Application = Netra). Confirm someone other than the caller is commenting. |
| Widget appears but no floating dock | Check the browser console for SCSS compile errors. Often a missing semicolon — re-paste `stylesheet.scss`. |

---

## Uninstall

To remove Netra entirely:

1. Delete the scoped application from **System Applications → All Available Applications → My Apps**. ServiceNow removes every record in the `x_netra` scope automatically.
2. Remove the widget from any portal pages.

---

## What's next

- Train richer intent patterns by editing `NetraIntent` directly in Studio
- Add voice support for other tables (request, change, problem) by extending `NetraTools`
- Wire Netra into Now Mobile by publishing the widget to the mobile portal
