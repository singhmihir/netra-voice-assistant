#requires -Version 5.1
<#
.SYNOPSIS
  Generate ServiceNow Source Control XML files into the Netra SNOW Config
  repo so the Netra app can be populated by pulling from GitHub in Studio.

.DESCRIPTION
  Reads the freshly-built Fix Script from install/setup-netra.js, wraps it
  in a sys_script_fix <record_update> XML, and writes it to:
    netra-snow-config/<APP_FOLDER>/sys_script_fix/sys_script_fix_<sysId>.xml

  The destination repo was renamed from "snowstarting" to
  "netra-snow-config" in May 2026.
#>

$ErrorActionPreference = 'Stop'

$repo  = Split-Path -Parent $PSScriptRoot
$snow  = "C:\Users\priya\netra-snow-config"
$appFolder = Join-Path $snow 'cbb86f0f93b0cf10936af0a75d03d662'
$appSysId  = 'cbb86f0f93b0cf10936af0a75d03d662'   # the netra_v1 app

# The Fix Script we are wrapping
$fixScriptJsPath = Join-Path $repo 'install\setup-netra.js'

# A stable sys_id for the Fix Script record (must be 32-hex)
$fixScriptSysId = 'fcab1d5fab40d8a01c4c0f5fa53fd3a7'

# Read and entity-escape the JS for XML char data
function EscapeXml([string]$s) {
    return $s.Replace('&','&amp;').Replace('<','&lt;').Replace('>','&gt;')
}

if (-not (Test-Path $fixScriptJsPath)) { throw "Missing: $fixScriptJsPath" }
$jsRaw     = [System.IO.File]::ReadAllText($fixScriptJsPath, [System.Text.Encoding]::UTF8)
$jsEscaped = EscapeXml $jsRaw

# Build the sys_script_fix XML in the ServiceNow Source Control format
# (a single <record_update> per file, no <unload> wrapper).
$now = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')

$xml = @"
<?xml version="1.0" encoding="UTF-8"?><record_update table="sys_script_fix">
    <sys_script_fix action="INSERT_OR_UPDATE">
        <active>true</active>
        <before>false</before>
        <description>Netra Voice Assistant - one-click installer. Resolves the Netra scoped app (by sys_id, name, or scope suffix), then provisions 4 tables, 9 Script Includes, 1 Business Rule, 1 Scheduled Job, 1 Scripted REST API + 2 resources, and 1 Service Portal Widget. Idempotent - safe to re-run.</description>
        <name>Netra Install</name>
        <record_for_rollback>false</record_for_rollback>
        <script>$jsEscaped</script>
        <sys_class_name>sys_script_fix</sys_class_name>
        <sys_created_by>admin</sys_created_by>
        <sys_created_on>$now</sys_created_on>
        <sys_id>$fixScriptSysId</sys_id>
        <sys_mod_count>0</sys_mod_count>
        <sys_name>Netra Install</sys_name>
        <sys_package display_value="Netra_V1" source="x_196061_netra_v1">$appSysId</sys_package>
        <sys_policy/>
        <sys_scope display_value="Netra_V1">$appSysId</sys_scope>
        <sys_update_name>sys_script_fix_$fixScriptSysId</sys_update_name>
        <sys_updated_by>admin</sys_updated_by>
        <sys_updated_on>$now</sys_updated_on>
        <unloadable>false</unloadable>
    </sys_script_fix>
    <sys_translated_text action="delete_multiple" query="documentkey=$fixScriptSysId"/>
</record_update>
"@

$outDir  = Join-Path $appFolder 'sys_script_fix'
[System.IO.Directory]::CreateDirectory($outDir) | Out-Null
$outFile = Join-Path $outDir "sys_script_fix_$fixScriptSysId.xml"

$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($outFile, $xml, $utf8NoBom)

Write-Host ("Wrote {0}" -f $outFile) -ForegroundColor Green
Write-Host ("  size: {0:N0} bytes" -f (Get-Item $outFile).Length)

# Validate XML
$doc = New-Object System.Xml.XmlDocument
$doc.Load($outFile)
Write-Host ("  XML valid: <{0}>" -f $doc.DocumentElement.Name) -ForegroundColor Green
