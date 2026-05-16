#requires -Version 5.1
<#
.SYNOPSIS
  Generate the importable Update Set XML from the source files in source/.

.DESCRIPTION
  Reads every script artifact from netra-snow/source/, entity-escapes the
  contents, wraps them in the ServiceNow Update Set record format, and emits
  a single XML file at netra-snow/update-set/netra-v2.0.0.xml.

  Re-run this after editing any source file to refresh the bundle.

.NOTES
  Records included:
    - 4 Script Includes  (NetraIntent, NetraTools, NetraResponder, NetraScanner)
    - 1 Business Rule    (Netra Notify On Comment)
    - 1 Scheduled Job    (Netra Watch — every 3 minutes)
#>

$ErrorActionPreference = 'Stop'

$repo  = Split-Path -Parent $PSScriptRoot
$root  = $repo
$src   = Join-Path $root 'source'
$outDir = Join-Path $root 'update-set'
$out   = Join-Path $outDir 'netra-v2.0.0.xml'

# ---- Constants ----
$UPDATE_SET_ID = '2aa9f8c7db40121095ab18f4f3961980'
$STAMP         = '2026-05-16 12:00:00'

# ---- Records to emit ----
$records = @(
    @{ kind='script_include'; name='NetraIntent';
       sysId='4e0ac3f5db00121095ab18f4f3961401';
       path='script_includes\NetraIntent.js';
       desc='Regex-based natural-language intent parser with smalltalk and multi-turn support.' },

    @{ kind='script_include'; name='NetraTools';
       sysId='4e0ac3f5db00121095ab18f4f3961402';
       path='script_includes\NetraTools.js';
       desc='GlideRecord operations for incidents + user preferences (pause / resume).' },

    @{ kind='script_include'; name='NetraResponder';
       sysId='4e0ac3f5db00121095ab18f4f3961403';
       path='script_includes\NetraResponder.js';
       desc='Composes spoken replies with variety; handles greetings, smalltalk, pause flow.' },

    @{ kind='script_include'; name='NetraScanner';
       sysId='4e0ac3f5db00121095ab18f4f3961404';
       path='script_includes\NetraScanner.js';
       desc='Periodic scanner for new assignments, approvals, catalog tasks.' },

    @{ kind='business_rule';  name='Netra Notify On Comment';
       sysId='5f1bd406db00121095ab18f4f3961501';
       path='business_rule\netra_notify_on_comment.js';
       desc='Async after-insert on sys_journal_field; enqueues a notification when someone else comments on a ticket where the user is caller or assignee.' },

    @{ kind='scheduled_job';  name='Netra Watch';
       sysId='5f1bd406db00121095ab18f4f3961502';
       path='scheduled_jobs\netra_watch.js';
       desc='Runs every 3 minutes; delegates to NetraScanner.' }
)

# ---- Helpers ----
function Esc([string]$s) {
    # XML character-data escaping. Order matters: & must come first.
    return $s.Replace('&','&amp;').Replace('<','&lt;').Replace('>','&gt;')
}

function ScriptIncludeRecord($r) {
    $code = [System.IO.File]::ReadAllText((Join-Path $src $r.path), [System.Text.Encoding]::UTF8)
    $code = Esc $code
@"
  <sys_update_xml action="INSERT_OR_UPDATE">
    <action>INSERT_OR_UPDATE</action>
    <application display_value="Netra Voice Assistant">x_netra</application>
    <category>customer</category>
    <name>sys_script_include_$($r.sysId)</name>
    <payload>&lt;record_update table="sys_script_include"&gt;
&lt;sys_script_include action="INSERT_OR_UPDATE"&gt;
  &lt;access&gt;package_private&lt;/access&gt;
  &lt;active&gt;true&lt;/active&gt;
  &lt;api_name&gt;x_netra.$($r.name)&lt;/api_name&gt;
  &lt;client_callable&gt;false&lt;/client_callable&gt;
  &lt;description&gt;$($r.desc)&lt;/description&gt;
  &lt;name&gt;$($r.name)&lt;/name&gt;
  &lt;script&gt;&lt;![CDATA[$code]]&gt;&lt;/script&gt;
  &lt;sys_class_name&gt;sys_script_include&lt;/sys_class_name&gt;
  &lt;sys_id&gt;$($r.sysId)&lt;/sys_id&gt;
  &lt;sys_name&gt;$($r.name)&lt;/sys_name&gt;
  &lt;sys_package display_value="Netra Voice Assistant" source="x_netra"&gt;x_netra&lt;/sys_package&gt;
  &lt;sys_scope display_value="Netra Voice Assistant"&gt;x_netra&lt;/sys_scope&gt;
  &lt;sys_update_name&gt;sys_script_include_$($r.sysId)&lt;/sys_update_name&gt;
&lt;/sys_script_include&gt;
&lt;/record_update&gt;</payload>
    <remote_update_set display_value="Netra Voice Assistant v2.0.0">$UPDATE_SET_ID</remote_update_set>
    <replace_on_upgrade>false</replace_on_upgrade>
    <sys_created_by>admin</sys_created_by>
    <sys_created_on>$STAMP</sys_created_on>
    <sys_id>$($r.sysId)</sys_id>
    <target_name>$($r.name)</target_name>
    <type>Script Include</type>
    <update_domain>global</update_domain>
    <update_guid>$($r.sysId)</update_guid>
  </sys_update_xml>
"@
}

function BusinessRuleRecord($r) {
    $code = [System.IO.File]::ReadAllText((Join-Path $src $r.path), [System.Text.Encoding]::UTF8)
    $code = Esc $code
@"
  <sys_update_xml action="INSERT_OR_UPDATE">
    <action>INSERT_OR_UPDATE</action>
    <application display_value="Netra Voice Assistant">x_netra</application>
    <category>customer</category>
    <name>sys_script_$($r.sysId)</name>
    <payload>&lt;record_update table="sys_script"&gt;
&lt;sys_script action="INSERT_OR_UPDATE"&gt;
  &lt;abort_action&gt;false&lt;/abort_action&gt;
  &lt;access&gt;package_private&lt;/access&gt;
  &lt;action_delete&gt;false&lt;/action_delete&gt;
  &lt;action_insert&gt;true&lt;/action_insert&gt;
  &lt;action_query&gt;false&lt;/action_query&gt;
  &lt;action_update&gt;false&lt;/action_update&gt;
  &lt;active&gt;true&lt;/active&gt;
  &lt;add_message&gt;false&lt;/add_message&gt;
  &lt;advanced&gt;true&lt;/advanced&gt;
  &lt;change_fields&gt;false&lt;/change_fields&gt;
  &lt;client_callable&gt;false&lt;/client_callable&gt;
  &lt;collection&gt;sys_journal_field&lt;/collection&gt;
  &lt;condition/&gt;
  &lt;description&gt;$($r.desc)&lt;/description&gt;
  &lt;execute_function&gt;false&lt;/execute_function&gt;
  &lt;filter_condition/&gt;
  &lt;is_rest&gt;false&lt;/is_rest&gt;
  &lt;name&gt;$($r.name)&lt;/name&gt;
  &lt;order&gt;100&lt;/order&gt;
  &lt;priority&gt;100&lt;/priority&gt;
  &lt;script&gt;&lt;![CDATA[$code]]&gt;&lt;/script&gt;
  &lt;sys_class_name&gt;sys_script&lt;/sys_class_name&gt;
  &lt;sys_id&gt;$($r.sysId)&lt;/sys_id&gt;
  &lt;sys_name&gt;$($r.name)&lt;/sys_name&gt;
  &lt;sys_package display_value="Netra Voice Assistant" source="x_netra"&gt;x_netra&lt;/sys_package&gt;
  &lt;sys_scope display_value="Netra Voice Assistant"&gt;x_netra&lt;/sys_scope&gt;
  &lt;sys_update_name&gt;sys_script_$($r.sysId)&lt;/sys_update_name&gt;
  &lt;when&gt;async&lt;/when&gt;
&lt;/sys_script&gt;
&lt;/record_update&gt;</payload>
    <remote_update_set display_value="Netra Voice Assistant v2.0.0">$UPDATE_SET_ID</remote_update_set>
    <replace_on_upgrade>false</replace_on_upgrade>
    <sys_created_by>admin</sys_created_by>
    <sys_created_on>$STAMP</sys_created_on>
    <sys_id>$($r.sysId)</sys_id>
    <target_name>$($r.name)</target_name>
    <type>Business Rule</type>
    <update_domain>global</update_domain>
    <update_guid>$($r.sysId)</update_guid>
  </sys_update_xml>
"@
}

function ScheduledJobRecord($r) {
    $code = [System.IO.File]::ReadAllText((Join-Path $src $r.path), [System.Text.Encoding]::UTF8)
    $code = Esc $code
@"
  <sys_update_xml action="INSERT_OR_UPDATE">
    <action>INSERT_OR_UPDATE</action>
    <application display_value="Netra Voice Assistant">x_netra</application>
    <category>customer</category>
    <name>sysauto_script_$($r.sysId)</name>
    <payload>&lt;record_update table="sysauto_script"&gt;
&lt;sysauto_script action="INSERT_OR_UPDATE"&gt;
  &lt;active&gt;true&lt;/active&gt;
  &lt;business_calendar/&gt;
  &lt;conditional&gt;false&lt;/conditional&gt;
  &lt;name&gt;$($r.name)&lt;/name&gt;
  &lt;run_as/&gt;
  &lt;run_dayofmonth&gt;1&lt;/run_dayofmonth&gt;
  &lt;run_dayofweek&gt;1&lt;/run_dayofweek&gt;
  &lt;run_period&gt;1970-01-01 00:03:00&lt;/run_period&gt;
  &lt;run_start&gt;2026-05-16 00:00:00&lt;/run_start&gt;
  &lt;run_time&gt;1970-01-01 00:00:00&lt;/run_time&gt;
  &lt;run_type&gt;periodically&lt;/run_type&gt;
  &lt;script&gt;&lt;![CDATA[$code]]&gt;&lt;/script&gt;
  &lt;sys_class_name&gt;sysauto_script&lt;/sys_class_name&gt;
  &lt;sys_domain&gt;global&lt;/sys_domain&gt;
  &lt;sys_id&gt;$($r.sysId)&lt;/sys_id&gt;
  &lt;sys_name&gt;$($r.name)&lt;/sys_name&gt;
  &lt;sys_package display_value="Netra Voice Assistant" source="x_netra"&gt;x_netra&lt;/sys_package&gt;
  &lt;sys_scope display_value="Netra Voice Assistant"&gt;x_netra&lt;/sys_scope&gt;
  &lt;sys_update_name&gt;sysauto_script_$($r.sysId)&lt;/sys_update_name&gt;
  &lt;upgrade_safe&gt;false&lt;/upgrade_safe&gt;
&lt;/sysauto_script&gt;
&lt;/record_update&gt;</payload>
    <remote_update_set display_value="Netra Voice Assistant v2.0.0">$UPDATE_SET_ID</remote_update_set>
    <replace_on_upgrade>false</replace_on_upgrade>
    <sys_created_by>admin</sys_created_by>
    <sys_created_on>$STAMP</sys_created_on>
    <sys_id>$($r.sysId)</sys_id>
    <target_name>$($r.name)</target_name>
    <type>Scheduled Script Execution</type>
    <update_domain>global</update_domain>
    <update_guid>$($r.sysId)</update_guid>
  </sys_update_xml>
"@
}

# ---- Build ----
$body = New-Object System.Text.StringBuilder
[void]$body.AppendLine('<?xml version="1.0" encoding="UTF-8"?>')
[void]$body.AppendLine('<!--')
[void]$body.AppendLine('   Netra Voice Assistant - Update Set v2.0.0  (auto-generated)')
[void]$body.AppendLine('   Source: netra-snow/source/    Regenerate with scripts/build-update-set.ps1')
[void]$body.AppendLine('-->')
[void]$body.AppendLine("<unload unload_date=`"$STAMP`">")

# Update set header
[void]$body.AppendLine(@"
  <sys_remote_update_set action="INSERT_OR_UPDATE">
    <application display_value="Netra Voice Assistant">x_netra</application>
    <application_name>Netra Voice Assistant</application_name>
    <application_scope>x_netra</application_scope>
    <application_version>2.0.0</application_version>
    <description>Voice-first ServiceNow assistant for blind users. Free stack - Web Speech APIs, regex intent parsing, 3-minute scheduled scanner.</description>
    <name>Netra Voice Assistant v2.0.0</name>
    <remote_sys_id>$UPDATE_SET_ID</remote_sys_id>
    <state>loaded</state>
    <sys_created_by>admin</sys_created_by>
    <sys_created_on>$STAMP</sys_created_on>
    <sys_id>$UPDATE_SET_ID</sys_id>
    <sys_updated_by>admin</sys_updated_by>
    <sys_updated_on>$STAMP</sys_updated_on>
  </sys_remote_update_set>
"@)

foreach ($r in $records) {
    Write-Host "  -> emitting $($r.kind): $($r.name)" -ForegroundColor Cyan
    switch ($r.kind) {
        'script_include' { [void]$body.AppendLine((ScriptIncludeRecord $r)) }
        'business_rule'  { [void]$body.AppendLine((BusinessRuleRecord $r)) }
        'scheduled_job'  { [void]$body.AppendLine((ScheduledJobRecord $r)) }
    }
}

[void]$body.AppendLine('</unload>')

# Write
[System.IO.Directory]::CreateDirectory($outDir) | Out-Null
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($out, $body.ToString(), $utf8NoBom)

Write-Host ""
Write-Host "Wrote $out" -ForegroundColor Green
Write-Host ("  size: {0} bytes" -f (Get-Item $out).Length) -ForegroundColor Green
