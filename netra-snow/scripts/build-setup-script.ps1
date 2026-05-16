#requires -Version 5.1
<#
.SYNOPSIS
  Generate install/setup-netra.js — a single ServiceNow Background Script
  that creates every artifact for the Netra Voice Assistant app.

.DESCRIPTION
  Reads every source file from source/, escapes each line as a JS string
  literal, then injects them into setup-runtime.template.js to produce
  the final pasteable script at install/setup-netra.js.

  Re-run after editing any source file. The output is plain JavaScript;
  the script validates it parses by writing it through .NET's
  Microsoft.JScript engine when available.
#>

$ErrorActionPreference = 'Stop'

$repo  = Split-Path -Parent $PSScriptRoot
$root  = $repo
$src   = Join-Path $root 'source'
$tmpl  = Join-Path $root 'scripts\setup-runtime.template.js'
$outDir = Join-Path $root 'install'
$out   = Join-Path $outDir 'setup-netra.js'

# ---- Source files to embed: key -> relative path under source/ ----
$sources = [ordered]@{
    NetraIntent              = 'script_includes\NetraIntent.js'
    NetraTools               = 'script_includes\NetraTools.js'
    NetraResponder           = 'script_includes\NetraResponder.js'
    NetraScanner             = 'script_includes\NetraScanner.js'
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

# Convert a multi-line string into a JS expression of the form:
#     ["line one", "line two", ...].join("\n")
# Each line is double-quoted; backslashes and double quotes are escaped.
function ToJsArrayJoin([string]$content) {
    # Normalise line endings
    $content = $content.Replace("`r`n", "`n").Replace("`r", "`n")
    $lines = $content -split "`n"
    $escaped = foreach ($line in $lines) {
        # Escape \ then " then ASCII control chars
        $e = $line.Replace('\','\\').Replace('"','\"')
        # tab survives as literal tab; embedded \r/\n already split out
        '"' + $e + '"'
    }
    return "[" + ($escaped -join ",`n        ") + "].join(`"`n`")"
}

# ---- Build the SRC.* object literal ----
$body = New-Object System.Text.StringBuilder
[void]$body.AppendLine('    var SRC = {};')
foreach ($key in $sources.Keys) {
    $path = Join-Path $src $sources[$key]
    if (-not (Test-Path $path)) {
        throw "Missing source file: $path"
    }
    $content = ReadUtf8 $path
    $jsExpr = ToJsArrayJoin $content
    [void]$body.AppendLine('')
    [void]$body.AppendLine("    SRC.$key = $jsExpr;")
    Write-Host ("  + embedded {0,-25} ({1,6:N0} bytes from {2})" -f $key, $content.Length, $sources[$key]) -ForegroundColor Cyan
}

# ---- Read template and inject ----
$template = ReadUtf8 $tmpl
$marker = '/*__EMBEDDED_SOURCE__*/'
if ($template -notmatch [regex]::Escape($marker)) {
    throw "Template marker $marker not found in $tmpl"
}
$final = $template.Replace($marker, $body.ToString())

# ---- Write output (UTF-8 no BOM) ----
[System.IO.Directory]::CreateDirectory($outDir) | Out-Null
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($out, $final, $utf8NoBom)

Write-Host ''
Write-Host ("Wrote {0}" -f $out) -ForegroundColor Green
$size = (Get-Item $out).Length
Write-Host ("  size: {0:N0} bytes, {1:N0} lines" -f $size, ((Get-Content $out).Count)) -ForegroundColor Green
