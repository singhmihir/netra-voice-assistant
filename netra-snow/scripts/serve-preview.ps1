#requires -Version 5.1
# Tiny static-file HTTP server for netra-snow/preview.
# Browsers block mic access on file://, so we need http://localhost.

param([int]$Port = 8765)

$ErrorActionPreference = 'Continue'

Add-Type -AssemblyName System.Web

$repo = Split-Path -Parent $PSScriptRoot
$dir  = Join-Path $repo 'preview'

if (-not (Test-Path $dir)) {
    Write-Host "Preview folder not found: $dir" -ForegroundColor Red
    exit 1
}

$listener = New-Object System.Net.HttpListener
$prefix = "http://localhost:$Port/"
$listener.Prefixes.Add($prefix)

try {
    $listener.Start()
} catch {
    Write-Host ("Could not bind to {0}: {1}" -f $prefix, $_.Exception.Message) -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Netra preview is live at:" -ForegroundColor Green
Write-Host "    $prefix" -ForegroundColor Yellow
Write-Host "Serving from: $dir" -ForegroundColor DarkGray
Write-Host ""

$mime = @{
    '.html' = 'text/html; charset=utf-8'
    '.js'   = 'application/javascript; charset=utf-8'
    '.css'  = 'text/css; charset=utf-8'
    '.json' = 'application/json'
    '.svg'  = 'image/svg+xml'
    '.ico'  = 'image/x-icon'
}

while ($listener.IsListening) {
    try {
        $ctx = $listener.GetContext()
    } catch {
        break
    }
    try {
        $req = $ctx.Request
        $res = $ctx.Response

        $rel = $req.Url.AbsolutePath
        try { $rel = [System.Web.HttpUtility]::UrlDecode($rel) } catch {}
        $rel = $rel.TrimStart('/')
        if ([string]::IsNullOrEmpty($rel) -or $rel.EndsWith('/')) {
            $rel = $rel + 'index.html'
        }
        $file = Join-Path $dir $rel

        Write-Host ("  {0} {1}" -f $req.HttpMethod, $rel) -ForegroundColor DarkGray

        if (Test-Path $file -PathType Leaf) {
            $ext = [System.IO.Path]::GetExtension($file).ToLower()
            $ct = $mime[$ext]
            if (-not $ct) { $ct = 'application/octet-stream' }
            $res.ContentType = $ct
            $bytes = [System.IO.File]::ReadAllBytes($file)
            $res.ContentLength64 = $bytes.Length
            $res.OutputStream.Write($bytes, 0, $bytes.Length)
        } else {
            $res.StatusCode = 404
            $msg = [System.Text.Encoding]::UTF8.GetBytes("Not found: $rel")
            $res.OutputStream.Write($msg, 0, $msg.Length)
        }
        $res.OutputStream.Close()
    } catch {
        Write-Host ("  ! request error: " + $_.Exception.Message) -ForegroundColor Red
        try { $ctx.Response.StatusCode = 500; $ctx.Response.Close() } catch {}
    }
}

$listener.Stop()
$listener.Close()
