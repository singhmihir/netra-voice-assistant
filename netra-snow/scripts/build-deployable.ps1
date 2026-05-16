#requires -Version 5.1
<#
.SYNOPSIS
  Generate the deployable Update Set XML for Netra.

.DESCRIPTION
  1. Reads source/fix_script/netra-install.js   (the Fix Script TEMPLATE).
  2. Reads every source file under source/      and embeds them as JS strings.
  3. Substitutes the __EMBEDDED_SOURCE__ marker.
  4. XML-escapes the resulting JS and wraps it in a sys_remote_update_set XML.

  The Fix Script itself substitutes __NETRA_SCOPE__ at runtime, so the
  Update Set is completely scope-agnostic — works for any company id.

  Output: update-set/netra-deployable.xml
#>

$ErrorActionPreference = 'Stop'

$repo  = Split-Path -Parent $PSScriptRoot
$src   = Join-Path $repo 'source'
$tmpl  = Join-Path $src 'fix_script\netra-install.js'
$outDir = Join-Path $repo 'update-set'
$out   = Join-Path $outDir 'netra-deployable.xml'

# Source files to embed: SRC.<key> -> relative path under source/
$sources = [ordered]@{
    NetraIntent              = 'script_includes\NetraIntent.js'
    NetraTools               = 'script_includes\NetraTools.js'
    NetraResponder           = 'script_includes\NetraResponder.js'
    NetraScanner             = 'script_includes\NetraScanner.js'
    NetraKnowledge           = 'script_includes\NetraKnowledge.js'
    NetraChat                = 'script_includes\NetraChat.js'
    NetraSummarizer          = 'script_includes\NetraSummarizer.js'
    NetraContext             = 'script_includes\NetraContext.js'
    NetraNavigator           = 'script_includes\NetraNavigator.js'
    netra_notify_on_comment  = 'business_rule\netra_notify_on_comment.js'
    netra_watch              = 'scheduled_jobs\netra_watch.js'
    command                  = 'scripted_rest\command.js'
    notifications            = 'scripted_rest\notifications.js'
    template                 = 'widget\template.html'
    client                   = 'widget\client.js'
    server                   = 'widget\server.js'
    stylesheet               = 'widget\stylesheet.scss'
}

function ReadUtf8([string]$path) {
    return [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
}

# Convert content to a JS expression: ["line1","line2",...].join("\n")
function ToJsArrayJoin([string]$content) {
    $content = $content.Replace("`r`n", "`n").Replace("`r", "`n")
    $lines = $content -split "`n"
    $escaped = foreach ($line in $lines) {
        $e = $line.Replace('\','\\').Replace('"','\"')
        '"' + $e + '"'
    }
    return "[" + ($escaped -join ",`n        ") + "].join(`"`n`")"
}

# XML char-data escape
function EscapeXml([string]$s) {
    return $s.Replace('&','&amp;').Replace('<','&lt;').Replace('>','&gt;')
}

# ---- Build SRC.* block ----
Write-Host "Embedding source files..." -ForegroundColor Cyan
$srcBlock = New-Object System.Text.StringBuilder
[void]$srcBlock.AppendLine('    var SRC = {};')
foreach ($key in $sources.Keys) {
    $path = Join-Path $src $sources[$key]
    if (-not (Test-Path $path)) { throw "Missing source: $path" }
    $content = ReadUtf8 $path
    $jsExpr = ToJsArrayJoin $content
    [void]$srcBlock.AppendLine('')
    [void]$srcBlock.AppendLine("    SRC.$key = $jsExpr;")
    Write-Host ("  + {0,-25} ({1,7:N0} bytes)" -f $key, $content.Length) -ForegroundColor DarkGray
}

# ---- Read template + inject ----
$template = ReadUtf8 $tmpl
$marker = '/*__EMBEDDED_SOURCE__*/'
if ($template -notmatch [regex]::Escape($marker)) { throw "Template marker not found." }
$fixScriptJs = $template.Replace($marker, $srcBlock.ToString())
Write-Host ""
Write-Host ("Fix Script JS produced: {0:N0} bytes" -f $fixScriptJs.Length) -ForegroundColor Green

# ---- Wrap in Update Set XML ----
$UPDATE_SET_ID = '4cc9f8c7db40121095ab18f4f3961290'
$FIX_SCRIPT_ID = '4cc9f8c7db40121095ab18f4f3961291'
$STAMP = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')

# Double escape: first escape for the inner record payload (entities)
$escapedJs = EscapeXml $fixScriptJs

# The fix script record's XML, with CDATA holding the script
# (the CDATA itself lives inside an entity-escaped <payload>)
$innerRecord = @"
&lt;record_update table="sys_script_fix"&gt;
&lt;sys_script_fix action="INSERT_OR_UPDATE"&gt;
  &lt;active&gt;true&lt;/active&gt;
  &lt;before&gt;false&lt;/before&gt;
  &lt;description&gt;Netra Voice Assistant - one-click installer. Detects the scope of the app named "netra" and provisions every artifact (tables, script includes, business rule, scheduled job, scripted REST API, widget).&lt;/description&gt;
  &lt;name&gt;Netra Install&lt;/name&gt;
  &lt;script&gt;&lt;![CDATA[$escapedJs]]&gt;&lt;/script&gt;
  &lt;sys_class_name&gt;sys_script_fix&lt;/sys_class_name&gt;
  &lt;sys_id&gt;$FIX_SCRIPT_ID&lt;/sys_id&gt;
  &lt;sys_name&gt;Netra Install&lt;/sys_name&gt;
  &lt;sys_update_name&gt;sys_script_fix_$FIX_SCRIPT_ID&lt;/sys_update_name&gt;
  &lt;unloadable&gt;false&lt;/unloadable&gt;
&lt;/sys_script_fix&gt;
&lt;/record_update&gt;
"@

$xml = @"
<?xml version="1.0" encoding="UTF-8"?>
<!--
  Netra Voice Assistant - Deployable Update Set
  Auto-generated. Source: netra-snow/source/.
  Regenerate with scripts/build-deployable.ps1.

  HOW TO INSTALL:
    1. In ServiceNow, create a scoped application named exactly:  netra
       (System Applications -> My Company Applications -> Create new)
       ServiceNow will auto-generate the scope as x_<companyId>_netra.
    2. System Update Sets -> Retrieved Update Sets -> Import Update Set from XML
    3. Upload this file, Preview, then Commit.
    4. Open the Fix Script "Netra Install" and click Run.
    5. Add the "Netra Mic" widget to your portal home page.
-->
<unload unload_date="$STAMP">
  <sys_remote_update_set action="INSERT_OR_UPDATE">
    <application display_value="Global">global</application>
    <application_name>Global</application_name>
    <application_scope>global</application_scope>
    <application_version>3.0.0</application_version>
    <description>Netra Voice Assistant v3.0.0 - one-Fix-Script installer that adapts to any scope auto-generated for the "netra" app.</description>
    <name>Netra Voice Assistant v3.0.0</name>
    <remote_sys_id>$UPDATE_SET_ID</remote_sys_id>
    <state>loaded</state>
    <sys_created_by>admin</sys_created_by>
    <sys_created_on>$STAMP</sys_created_on>
    <sys_id>$UPDATE_SET_ID</sys_id>
    <sys_updated_by>admin</sys_updated_by>
    <sys_updated_on>$STAMP</sys_updated_on>
  </sys_remote_update_set>
  <sys_update_xml action="INSERT_OR_UPDATE">
    <action>INSERT_OR_UPDATE</action>
    <application display_value="Global">global</application>
    <category>customer</category>
    <name>sys_script_fix_$FIX_SCRIPT_ID</name>
    <payload>$innerRecord</payload>
    <remote_update_set display_value="Netra Voice Assistant v3.0.0">$UPDATE_SET_ID</remote_update_set>
    <replace_on_upgrade>false</replace_on_upgrade>
    <sys_created_by>admin</sys_created_by>
    <sys_created_on>$STAMP</sys_created_on>
    <sys_id>$FIX_SCRIPT_ID</sys_id>
    <target_name>Netra Install</target_name>
    <type>Fix Script</type>
    <update_domain>global</update_domain>
    <update_guid>$FIX_SCRIPT_ID</update_guid>
  </sys_update_xml>
</unload>
"@

[System.IO.Directory]::CreateDirectory($outDir) | Out-Null
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($out, $xml, $utf8NoBom)

Write-Host ""
Write-Host ("Wrote {0}" -f $out) -ForegroundColor Green
Write-Host ("  size: {0:N0} bytes" -f (Get-Item $out).Length) -ForegroundColor Green

# Validate XML
$doc = New-Object System.Xml.XmlDocument
try {
    $doc.Load($out)
    Write-Host ("  XML valid: <{0}> with {1} record(s)" -f $doc.DocumentElement.Name, $doc.DocumentElement.ChildNodes.Count) -ForegroundColor Green
    # Also validate the embedded payload XML
    $payload = $doc.SelectSingleNode('//sys_update_xml/payload').InnerText
    $inner = New-Object System.Xml.XmlDocument
    $inner.LoadXml($payload)
    Write-Host ("  Embedded payload XML valid: <{0}>" -f $inner.DocumentElement.Name) -ForegroundColor Green
} catch {
    Write-Host ("  XML INVALID: " + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
