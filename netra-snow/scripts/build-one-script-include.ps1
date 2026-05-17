#requires -Version 5.1
<#
.SYNOPSIS
  Generate ONE ServiceNow Source Control XML file for a Script Include and
  drop it into the snowstarting repo, ready to commit and pull from Studio.

.EXAMPLE
  .\build-one-script-include.ps1 -Name NetraIntent -SysId f1f1b1d111111111111111111111aaaa
#>

param(
    [Parameter(Mandatory=$true)] [string]$Name,    # e.g. "NetraIntent"
    [Parameter(Mandatory=$true)] [string]$SysId,   # 32-hex new sys_id
    [string]$Description = ""
)

$ErrorActionPreference = 'Stop'

# Known target (this is the user's Netra_V1 app)
$APP_SYS_ID  = 'cbb86f0f93b0cf10936af0a75d03d662'
$APP_NAME    = 'Netra_V1'
$APP_SCOPE   = 'x_196061_netra_v1'

# Paths
$repo  = Split-Path -Parent $PSScriptRoot
$srcJs = Join-Path $repo "source\script_includes\$Name.js"
$snow  = "C:\Users\priya\snowstarting"
$appDir = Join-Path $snow $APP_SYS_ID
$outDir = Join-Path $appDir 'sys_script_include'
$outFile = Join-Path $outDir "sys_script_include_$SysId.xml"

if (-not (Test-Path $srcJs)) { throw "Source not found: $srcJs" }

# Read JS, substitute scope placeholder, then XML-entity-escape
$js = [System.IO.File]::ReadAllText($srcJs, [System.Text.Encoding]::UTF8)
$js = $js -replace '__NETRA_SCOPE__', $APP_SCOPE
$jsEscaped = $js.Replace('&','&amp;').Replace('<','&lt;').Replace('>','&gt;')

$now = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
$desc = if ($Description) { $Description } else { "$Name (Netra)" }

$xml = @"
<?xml version="1.0" encoding="UTF-8"?><record_update table="sys_script_include">
    <sys_script_include action="INSERT_OR_UPDATE">
        <access>package_private</access>
        <active>true</active>
        <api_name>$APP_SCOPE.$Name</api_name>
        <caller_access/>
        <client_callable>false</client_callable>
        <description>$desc</description>
        <mobile_callable>false</mobile_callable>
        <name>$Name</name>
        <sandbox_callable>false</sandbox_callable>
        <script>$jsEscaped</script>
        <sys_class_name>sys_script_include</sys_class_name>
        <sys_created_by>admin</sys_created_by>
        <sys_created_on>$now</sys_created_on>
        <sys_id>$SysId</sys_id>
        <sys_mod_count>0</sys_mod_count>
        <sys_name>$Name</sys_name>
        <sys_package display_value="$APP_NAME" source="$APP_SCOPE">$APP_SYS_ID</sys_package>
        <sys_policy/>
        <sys_scope display_value="$APP_NAME">$APP_SYS_ID</sys_scope>
        <sys_update_name>sys_script_include_$SysId</sys_update_name>
        <sys_updated_by>admin</sys_updated_by>
        <sys_updated_on>$now</sys_updated_on>
    </sys_script_include>
    <sys_translated_text action="delete_multiple" query="documentkey=$SysId"/>
</record_update>
"@

[System.IO.Directory]::CreateDirectory($outDir) | Out-Null
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($outFile, $xml, $utf8NoBom)

# Validate
$doc = New-Object System.Xml.XmlDocument
$doc.Load($outFile)

Write-Host ("Wrote {0}" -f $outFile) -ForegroundColor Green
Write-Host ("  Script Include: {0}  ({1} bytes)" -f $Name, (Get-Item $outFile).Length)
Write-Host ("  api_name:       {0}.{1}" -f $APP_SCOPE, $Name)
Write-Host ("  sys_id:         {0}" -f $SysId)
Write-Host ("  scope:          {0}" -f $APP_SCOPE)
Write-Host ("  XML valid:      yes (root <{0}>)" -f $doc.DocumentElement.Name)
