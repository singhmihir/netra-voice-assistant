#requires -Version 5.1
<#
.SYNOPSIS
  Populate the singhmihir/netra-snow-config repo (the "Netra SNOW Config"
  manual-deployment reference): every Netra artifact as a plain source
  file with a README telling the user exactly what to create in ServiceNow.

  Repo was renamed from "snowstarting" to "netra-snow-config" in May 2026.
#>

$ErrorActionPreference = 'Stop'

$src   = "C:\Users\priya\servicenow-voice-assistant\netra-snow\source"
$dest  = "C:\Users\priya\netra-snow-config"
$scope = "x_196061_netra_v1"
$app   = "Netra_V1"

function CopyWithScope([string]$srcFile, [string]$destFile) {
    $txt = [System.IO.File]::ReadAllText($srcFile, [System.Text.Encoding]::UTF8)
    $txt = $txt -replace '__NETRA_SCOPE__', $scope
    [System.IO.Directory]::CreateDirectory((Split-Path -Parent $destFile)) | Out-Null
    $utf8 = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($destFile, $txt, $utf8)
    Write-Host ("  + {0}" -f ($destFile.Substring($dest.Length + 1)))
}

function WriteReadme([string]$path, [string]$content) {
    [System.IO.Directory]::CreateDirectory((Split-Path -Parent $path)) | Out-Null
    $utf8 = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($path, $content, $utf8)
    Write-Host ("  R {0}" -f ($path.Substring($dest.Length + 1)))
}

# ============================================================
# 01 - tables
# ============================================================
$tablesReadme = @"
# Step 1 - Create the four tables

Create these inside the **$app** application (scope ``$scope``).

In Studio, click **Create Application File -> Table** for each one.

---

## 1.1  Table ``${scope}_notification``

| Setting | Value                                  |
|---------|----------------------------------------|
| Label   | ``Netra Notification``                 |
| Name    | ``${scope}_notification`` *(auto)*     |
| Extends | *(none - base table)*                  |

Add columns (Form Designer -> Add field):

| Column          | Type                  | Length | Default |
|-----------------|-----------------------|--------|---------|
| ``user``        | Reference -> ``sys_user`` | -    | -       |
| ``ticket_sys_id`` | String              | 32     | -       |
| ``ticket_number`` | String              | 32     | -       |
| ``kind``        | String                | 40     | -       |
| ``message``     | String                | 1000   | -       |
| ``delivered``   | True/False            | -      | ``false`` |
| ``delivered_at`` | Date/Time            | -      | -       |

---

## 1.2  Table ``${scope}_user_pref``

| Setting | Value                            |
|---------|----------------------------------|
| Label   | ``Netra User Pref``              |
| Name    | ``${scope}_user_pref`` *(auto)*  |

Columns:

| Column              | Type                  | Length | Default |
|---------------------|-----------------------|--------|---------|
| ``user``            | Reference -> ``sys_user`` | -    | -       |
| ``active``          | True/False            | -      | ``true``  |
| ``paused_until``    | Date/Time             | -      | -       |
| ``last_scan_time``  | Date/Time             | -      | -       |
| ``watch_assignments`` | True/False          | -      | ``true``  |
| ``watch_comments``  | True/False            | -      | ``true``  |
| ``watch_approvals`` | True/False            | -      | ``true``  |
| ``voice_mode``      | String                | 20     | ``normal`` |

---

## 1.3  Table ``${scope}_context``

| Setting | Value                          |
|---------|--------------------------------|
| Label   | ``Netra Context``              |
| Name    | ``${scope}_context``           |

Columns:

| Column           | Type                  | Length | Default |
|------------------|-----------------------|--------|---------|
| ``user``         | Reference -> ``sys_user`` | -    | -       |
| ``focus_table``  | String                | 40     | -       |
| ``focus_sys_id`` | String                | 32     | -       |
| ``focus_number`` | String                | 32     | -       |
| ``focus_set_at`` | Date/Time             | -      | -       |
| ``last_utterance`` | String              | 1000   | -       |

---

## 1.4  Table ``${scope}_watchlist``

| Setting | Value                          |
|---------|--------------------------------|
| Label   | ``Netra Watchlist``            |
| Name    | ``${scope}_watchlist``         |

Columns:

| Column          | Type                  | Length |
|-----------------|-----------------------|--------|
| ``user``        | Reference -> ``sys_user`` | -    |
| ``record_table`` | String               | 40     |
| ``record_sys_id`` | String              | 32     |
| ``record_number`` | String              | 32     |

---

✅ Once all 4 tables exist, move on to **Step 2 - Script Includes**.
"@
WriteReadme "$dest\01-tables\README.md" $tablesReadme

# ============================================================
# 02 - script includes
# ============================================================
$siReadme = @"
# Step 2 - Create the nine Script Includes

For each ``.js`` file in this folder:

1. In Studio -> **Create Application File -> Script Include**
2. Settings:
   - **Name**: (file name without ``.js``, e.g. ``NetraIntent``)
   - **API Name**: auto-populates as ``$scope.<Name>``
   - **Description**: copy from the JSDoc at the top of the file
   - **Accessible from**: ``This application scope only``
   - **Client callable**: ☐ (unchecked)
   - **Active**: ☑
3. Paste the ENTIRE file contents into the **Script** field. Replace the
   default ``var Name = Class.create(); ...`` skeleton ServiceNow gives you.
4. **Submit**.

## Order (each depends on the ones above)

| # | Name | Depends on |
|---|------|-----------|
| 1 | NetraIntent | (none - pure regex parser) |
| 2 | NetraTools | tables from Step 1 |
| 3 | NetraContext | ``${scope}_context`` table |
| 4 | NetraKnowledge | ``kb_knowledge`` (OOTB) |
| 5 | NetraChat | ``sys_cs_*`` (OOTB, optional) |
| 6 | NetraSummarizer | (none - pure logic) |
| 7 | NetraNavigator | (none - URL mapper) |
| 8 | NetraScanner | NetraTools, ``${scope}_notification`` |
| 9 | NetraResponder | NetraTools, NetraKnowledge, NetraChat, NetraContext, NetraNavigator, NetraSummarizer |

## Quick smoke test after creating NetraIntent (#1)

**System Definition - Scripts - Background** (run in **$app** scope):

``````javascript
var p = new $scope.NetraIntent().parse('create a ticket for my email is broken');
gs.log(JSON.stringify(p));
// Expected: {"action":"create","args":{"description":"my email is broken"}, ...}
``````

> Use ``gs.log()`` (not ``gs.print()``) - ``gs.print`` is fenced in scoped apps.
"@
WriteReadme "$dest\02-script-includes\README.md" $siReadme

# Copy all 9 script includes
$scriptIncludes = @(
    'NetraIntent', 'NetraTools', 'NetraResponder', 'NetraScanner',
    'NetraKnowledge', 'NetraChat', 'NetraSummarizer', 'NetraContext', 'NetraNavigator'
)
foreach ($n in $scriptIncludes) {
    CopyWithScope "$src\script_includes\$n.js" "$dest\02-script-includes\$n.js"
}

# ============================================================
# 03 - business rule
# ============================================================
$brReadme = @"
# Step 3 - Create the Business Rule

## ``Netra Notify On Comment``

In Studio -> **Create Application File -> Business Rule**.

| Setting       | Value |
|---------------|-------|
| Name          | ``Netra Notify On Comment`` |
| Table         | ``sys_journal_field`` (Sys Journal Field [global]) |
| Application   | ``$app`` |
| Active        | ☑ |
| Advanced      | ☑ |
| When          | **after** |
| Insert        | ☑ |
| Update        | ☐ |
| Delete        | ☐ |
| Query         | ☐ |
| Order         | 100 |

Switch to the **Advanced** tab and paste the contents of
``netra_notify_on_comment.js``.

Then **Submit**.

## What it does

Fires the instant someone other than the caller comments on an incident
where the user is caller or assignee. Inserts a row into
``${scope}_notification`` so the widget speaks it within 8 seconds.
"@
WriteReadme "$dest\03-business-rule\README.md" $brReadme
CopyWithScope "$src\business_rule\netra_notify_on_comment.js" "$dest\03-business-rule\netra_notify_on_comment.js"

# ============================================================
# 04 - scheduled job
# ============================================================
$sjReadme = @"
# Step 4 - Create the Scheduled Job

## ``Netra Watch``

Navigate to **System Definition -> Scheduled Jobs -> New** (or **Studio -> Create -> Scheduled Script Execution**).

| Setting          | Value |
|------------------|-------|
| Name             | ``Netra Watch`` |
| Application      | ``$app`` |
| Active           | ☑ |
| Run              | **Periodically** |
| Repeat Interval  | Days=0, Hours=0, Minutes=3, Seconds=0 |
| Conditional      | ☐ |

Paste the contents of ``netra_watch.js`` into the **Run this script** field.

**Submit**.

## What it does

Every 3 minutes calls ``NetraScanner.run()`` which scans all active users
for newly assigned incidents / changes / catalog tasks / approvals and
enqueues notifications.

## Manual trigger for testing

After saving, click **Execute Now** in the related links to verify it
runs without error.
"@
WriteReadme "$dest\04-scheduled-job\README.md" $sjReadme
CopyWithScope "$src\scheduled_jobs\netra_watch.js" "$dest\04-scheduled-job\netra_watch.js"

# ============================================================
# 05 - scripted rest
# ============================================================
$restReadme = @"
# Step 5 - Create the Scripted REST API + 2 resources

## 5.1  Create the service definition

**System Web Services -> Scripted REST APIs -> New**.

| Setting       | Value |
|---------------|-------|
| Name          | ``Netra Voice`` |
| API ID        | ``voice`` |
| Application   | ``$app`` |
| Active        | ☑ |

**Submit**. The base path will be ``/api/$scope/voice``.

## 5.2  Add resource: ``command``

Open the **Netra Voice** record -> related list **Resources** -> **New**.

| Setting                    | Value |
|----------------------------|-------|
| Name                       | ``command`` |
| HTTP method                | ``POST`` |
| Relative path              | ``/command`` |
| Requires authentication    | ☑ |
| Requires ACL authorization | ☐ |

Paste the contents of ``command.js`` into the **Script** field. **Submit**.

## 5.3  Add resource: ``notifications``

Same steps, with:

| Setting                    | Value |
|----------------------------|-------|
| Name                       | ``notifications`` |
| HTTP method                | ``GET`` |
| Relative path              | ``/notifications`` |
| Requires authentication    | ☑ |

Paste the contents of ``notifications.js``. **Submit**.

## Verification

Curl from a terminal (or use the **REST API Explorer** in Studio):

``````
POST /api/$scope/voice/command
Body: { "transcript": "list my tickets" }
``````

You should get back JSON with ``message``, ``intent``, ``data``.
"@
WriteReadme "$dest\05-scripted-rest\README.md" $restReadme
CopyWithScope "$src\scripted_rest\command.js"       "$dest\05-scripted-rest\command.js"
CopyWithScope "$src\scripted_rest\notifications.js" "$dest\05-scripted-rest\notifications.js"

# ============================================================
# 06 - widget
# ============================================================
$widgetReadme = @"
# Step 6 - Create the Service Portal widget

## ``netra-mic``

**Service Portal -> Service Portal Configuration -> Widgets -> New**.

| Setting     | Value |
|-------------|-------|
| Name        | ``Netra Mic`` |
| ID          | ``netra-mic`` |
| Application | ``$app`` |
| Public      | ☐ |

Then paste each file from this folder into the matching widget field:

| File                     | Paste into                |
|--------------------------|---------------------------|
| ``template.html``        | **Body HTML template**    |
| ``client.js``            | **Client controller**     |
| ``server.js``            | **Server script**         |
| ``stylesheet.scss``      | **CSS - SCSS**            |
| ``option_schema.json``   | **Option schema** (just ``[]``) |

**Submit**.

## Add it to a portal page

1. **Service Portal -> Service Portal Configuration -> Designer**
2. Open the Service Portal home page (portal ``sp``, page id ``index``)
3. Drag **Netra Mic** into any container - it floats fixed in the bottom-right corner
4. **Save**

## Use it

Open ``/sp`` in **Chrome or Edge**. Allow microphone. Say **"Netra"** -
the floating dock turns red and listens for your command.
"@
WriteReadme "$dest\06-widget\README.md" $widgetReadme
CopyWithScope "$src\widget\template.html"     "$dest\06-widget\template.html"
CopyWithScope "$src\widget\client.js"         "$dest\06-widget\client.js"
CopyWithScope "$src\widget\server.js"         "$dest\06-widget\server.js"
CopyWithScope "$src\widget\stylesheet.scss"   "$dest\06-widget\stylesheet.scss"
CopyWithScope "$src\widget\option_schema.json" "$dest\06-widget\option_schema.json"

# ============================================================
# Master README
# ============================================================
$masterReadme = @"
# Netra_V1 - Manual Deployment Reference

Voice-first ServiceNow assistant for blind users. Scope ``$scope``, app
``$app``.

This repo holds **only the scripts you need to paste into ServiceNow** -
no automation, no Update Set, no Source Control plumbing. Work through the
folders in order; each one has its own README with exact UI clicks.

## Deployment order

| Step | Folder | What you build |
|------|--------|----------------|
| 1 | [``01-tables/``](01-tables/)             | 4 custom tables (notification, user_pref, context, watchlist) |
| 2 | [``02-script-includes/``](02-script-includes/) | 9 Script Includes (the brain) |
| 3 | [``03-business-rule/``](03-business-rule/) | 1 Business Rule (instant comment alerts) |
| 4 | [``04-scheduled-job/``](04-scheduled-job/) | 1 Scheduled Job (3-minute scanner) |
| 5 | [``05-scripted-rest/``](05-scripted-rest/) | 1 Scripted REST API + 2 resources |
| 6 | [``06-widget/``](06-widget/) | 1 Service Portal Widget (the UI) |

## What each artifact does

- **Tables** - durable state: notification queue, per-user preferences, context, watchlist
- **NetraIntent** - regex parser, turns voice into ``{action, args}``
- **NetraTools** - incident CRUD, approvals, watchlist, pause preferences
- **NetraResponder** - composes the spoken reply, routes every intent
- **NetraScanner** - periodic scanner; finds new assignments / approvals
- **NetraKnowledge** - keyword-scored search over ``kb_knowledge``
- **NetraChat** - read & reply to Connect Chat messages
- **NetraSummarizer** - extractive summary for long tickets / KB articles
- **NetraContext** - remembers the last ticket the user mentioned
- **NetraNavigator** - maps spoken destinations to portal URLs
- **Business Rule** - instant alert on new ticket comments
- **Scheduled Job** - runs ``NetraScanner.run()`` every 3 minutes
- **Scripted REST** - ``POST /command`` and ``GET /notifications`` for the widget
- **Widget** - floating dock, wake word, push-to-talk, TTS, pause UI

## Voice command reference (after install)

| You say | What happens |
|---|---|
| *"create a ticket for my email is broken"* | Opens INC, reads back number |
| *"list my tickets"* / *"what's on my plate"* | Reads up to 5 open tickets |
| *"resolve INC0001234"* | Marks resolved |
| *"update INC0001234 with I rebooted"* | Adds a comment |
| *"status of INC0001234"* | Reads state, priority, assignee |
| *"read INC0001234"* | Reads description + latest comment |
| *"search tickets for VPN"* | Searches your incidents |
| *"search knowledge for password reset"* | KB search |
| *"read KB0010001"* | Reads article body (summarised if long) |
| *"open my approvals"* / *"approve CHG0001234"* | Approval handling |
| *"pause"* -> *"two hours"* | Mute notifications for N hours |
| *"resume"* | Unmute |
| *"hi"* / *"thanks"* / *"how are you"* | Smalltalk |
| *"help"* | Lists what Netra can do |
| *"stop"* / *"cancel"* | Interrupts Netra mid-sentence |

## Browser requirement

Chrome or Edge (for Web Speech API wake-word + TTS). Other browsers can
click the mic button but won't catch the wake word.

## Source of truth & design doc

Full source, generators, sequence diagrams, technical design document
and live browser preview at
**https://github.com/singhmihir/netra-voice-assistant**.
"@
WriteReadme "$dest\README.md" $masterReadme

Write-Host ""
Write-Host "=== Reference repo populated ===" -ForegroundColor Green
Write-Host ("Files written:")
Get-ChildItem $dest -Recurse -File | Where-Object { $_.FullName -notmatch '\.git\\' } |
    ForEach-Object { "  $($_.FullName.Substring($dest.Length + 1))  ($($_.Length) bytes)" }
