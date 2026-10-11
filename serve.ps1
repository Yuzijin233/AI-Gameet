# =====================================================================
#  AI-Gameet - green edition local server (Windows PowerShell only)
#
#  Why PowerShell: this build must run WITHOUT installing Node.js.
#  It serves the game on http://localhost:5176/ and also provides the
#  three tiny APIs the game needs:
#     POST /api/chat  - proxy to DeepSeek (key comes from the page, so it
#                       never has to be written into any file)
#     POST /api/save  - mirror the save + memory files into .\save\
#     GET  /api/save  - read them back (restore after clearing browser data)
#     GET  /__ddz     - identity tag (used to detect an already running copy)
#
#  localhost is a "secure context", so the mic (voice input) also works.
#
#  NOTE: this file is intentionally ASCII-only. Windows PowerShell 5.1
#  reads non-ASCII .ps1 files with the ANSI codepage unless they carry a
#  BOM, which turns Chinese text into mojibake - so keep it English here.
#  The game UI itself is fully Chinese.
# =====================================================================
param(
  [int]$Port = 5176,
  [switch]$NoOpen
)

# 允许用环境变量抑制"自动开浏览器"（自动化测试跑 start.bat 时用得上）
if ($env:AI_GAMEET_NO_OPEN) { $NoOpen = $true }

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

$INSTANCE_TAG = 'ai-gameet-green-v1'

function Write-Info($msg) { Write-Host $msg }

# ---------------------------------------------------------------- helpers
$MIME = @{
  '.html' = 'text/html; charset=utf-8'
  '.htm'  = 'text/html; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'
  '.mjs'  = 'text/javascript; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.md'   = 'text/plain; charset=utf-8'
  '.txt'  = 'text/plain; charset=utf-8'
  '.png'  = 'image/png'
  '.jpg'  = 'image/jpeg'
  '.jpeg' = 'image/jpeg'
  '.webp' = 'image/webp'
  '.gif'  = 'image/gif'
  '.svg'  = 'image/svg+xml'
  '.ico'  = 'image/x-icon'
  '.mp3'  = 'audio/mpeg'
  '.wav'  = 'audio/wav'
  '.ogg'  = 'audio/ogg'
  '.woff2'= 'font/woff2'
}

$SAVE_DIR   = Join-Path $Root 'save'
$SAVE_FILE  = Join-Path $SAVE_DIR 'ddz_save.json'
# The memory files are named "AI<ji-yi>.md" / "AI<ji-yi>.json" in the UI.
# Spelled with char codes on purpose: this .ps1 must stay pure ASCII so that
# Windows PowerShell 5.1 cannot mangle the Chinese names into mojibake.
$MEM_BASE   = 'AI' + [char]0x8BB0 + [char]0x5FC6
$MEMORY_MD  = Join-Path $SAVE_DIR ($MEM_BASE + '.md')
$MEMORY_JSON= Join-Path $SAVE_DIR ($MEM_BASE + '.json')

function Get-Mime($path) {
  $ext = [System.IO.Path]::GetExtension($path).ToLower()
  if ($MIME.ContainsKey($ext)) { return $MIME[$ext] }
  return 'application/octet-stream'
}

# UTF-8 without BOM (PS 5.1's Set-Content -Encoding UTF8 adds a BOM,
# which would break JSON.parse in the page on the next GET).
function Write-Utf8NoBom($path, $text) {
  $dir = Split-Path -Parent $path
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $enc = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($path, $text, $enc)
}

function Send-Bytes($ctx, [int]$status, [byte[]]$bytes, [string]$type, [hashtable]$extra = $null) {
  $res = $ctx.Response
  $res.StatusCode = $status
  $res.ContentType = $type
  $res.Headers['Cache-Control'] = 'no-cache'
  if ($extra) { foreach ($k in $extra.Keys) { $res.Headers[$k] = $extra[$k] } }
  if ($null -ne $bytes) {
    $res.ContentLength64 = $bytes.Length
    if ($ctx.Request.HttpMethod -ne 'HEAD') {
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
    }
  }
  $res.Close()
}

function Send-Text($ctx, [int]$status, [string]$text, [string]$type = 'text/plain; charset=utf-8') {
  Send-Bytes $ctx $status ([System.Text.Encoding]::UTF8.GetBytes($text)) $type
}

function Read-Body($ctx) {
  $reader = New-Object System.IO.StreamReader($ctx.Request.InputStream, [System.Text.Encoding]::UTF8)
  $text = $reader.ReadToEnd()
  $reader.Close()
  return $text
}

# Range: only the common "bytes=a-b" form (audio seeking needs it)
function Get-Range($header, [long]$size) {
  if (-not $header) { return $null }
  $m = [System.Text.RegularExpressions.Regex]::Match($header, '^bytes=(\d*)-(\d*)$')
  if (-not $m.Success) { return $null }
  $a = $m.Groups[1].Value
  $b = $m.Groups[2].Value
  if ($a -eq '' -and $b -eq '') { return $null }
  if ($a -eq '') {
    $start = [Math]::Max(0, $size - [long]$b)
    $end = $size - 1
  } else {
    $start = [long]$a
    if ($b -eq '' -or [long]$b -ge $size) { $end = $size - 1 } else { $end = [long]$b }
  }
  if ($start -gt $end -or $start -ge $size) { return $null }
  return @{ start = $start; end = $end }
}

# ---------------------------------------------------------------- API: chat
function Handle-Chat($ctx) {
  $body = Read-Body $ctx
  # The page sends its own key in X-Api-Key (settings -> API Key).
  # Optional fallback for advanced users: put the key into apikey.txt.
  $key = ''
  if ($ctx.Request.Headers['X-Api-Key']) { $key = $ctx.Request.Headers['X-Api-Key'].Trim() }
  if (-not $key) {
    $keyFile = Join-Path $Root 'apikey.txt'
    if (Test-Path $keyFile) { $key = (Get-Content $keyFile -Raw).Trim() }
  }
  if (-not $key) {
    Send-Text $ctx 500 '{"error":"no api key"}' 'application/json; charset=utf-8'
    return
  }
  try {
    $req = [System.Net.HttpWebRequest]::Create('https://api.deepseek.com/chat/completions')
    $req.Method = 'POST'
    $req.ContentType = 'application/json'
    $req.Headers.Add('Authorization', "Bearer $key")
    $req.Timeout = 30000
    $req.ReadWriteTimeout = 30000
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
    $req.ContentLength = $bytes.Length
    $stream = $req.GetRequestStream()
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Close()
    $resp = $req.GetResponse()
    $sr = New-Object System.IO.StreamReader($resp.GetResponseStream(), [System.Text.Encoding]::UTF8)
    $text = $sr.ReadToEnd()
    $sr.Close()
    $resp.Close()
    Send-Text $ctx 200 $text 'application/json; charset=utf-8'
  } catch [System.Net.WebException] {
    $code = 502
    $errText = $_.Exception.Message
    $resp = $_.Exception.Response
    if ($resp) {
      try {
        $code = [int]$resp.StatusCode
        $sr = New-Object System.IO.StreamReader($resp.GetResponseStream(), [System.Text.Encoding]::UTF8)
        $errText = $sr.ReadToEnd()
        $sr.Close()
      } catch { }
    }
    Send-Text $ctx $code $errText 'application/json; charset=utf-8'
  } catch {
    Send-Text $ctx 502 ('{"error":"' + $_.Exception.Message.Replace('"', "'") + '"}') 'application/json; charset=utf-8'
  }
}

# ---------------------------------------------------------------- API: save
function Handle-SaveGet($ctx) {
  if (-not (Test-Path $SAVE_FILE)) {
    Send-Text $ctx 200 '{"ok":false,"reason":"no-file"}' 'application/json; charset=utf-8'
    return
  }
  $json = [System.IO.File]::ReadAllText($SAVE_FILE, [System.Text.Encoding]::UTF8)
  $mtime = (Get-Item $SAVE_FILE).LastWriteTimeUtc
  $ms = [int64](([DateTime]$mtime - [DateTime]'1970-01-01').TotalMilliseconds)
  Send-Text $ctx 200 ('{"ok":true,"save":' + $json.Trim() + ',"mtime":' + $ms + '}') 'application/json; charset=utf-8'
}

# The page POSTs the save as already-formatted JSON text and we store it
# verbatim: no ConvertTo-Json round trip, so nothing can be reshaped by
# PowerShell (5.1 turns empty arrays into null, single item arrays into
# scalars, and so on).
function Handle-SavePost($ctx) {
  $body = (Read-Body $ctx).Trim()
  if (-not $body) {
    Send-Text $ctx 400 '{"error":"empty body"}' 'application/json; charset=utf-8'
    return
  }
  try {
    $obj = $body | ConvertFrom-Json
  } catch {
    Send-Text $ctx 400 '{"error":"bad json"}' 'application/json; charset=utf-8'
    return
  }
  if ($null -eq $obj -or -not ($obj.PSObject.Properties.Name -contains 'friends')) {
    Send-Text $ctx 400 '{"error":"not a save"}' 'application/json; charset=utf-8'
    return
  }
  $savedAt = $obj.savedAt
  if (-not $savedAt) { $savedAt = '' }
  # legacy clients inline the two rendered memory files; keep them out of the save
  if ($obj.PSObject.Properties.Name -contains 'memoryMd' -or $obj.PSObject.Properties.Name -contains 'memoryJson') {
    $memMd = $obj.memoryMd
    $memJson = $obj.memoryJson
    $obj.PSObject.Properties.Remove('memoryMd')
    $obj.PSObject.Properties.Remove('memoryJson')
    $body = ($obj | ConvertTo-Json -Depth 40).Trim()
    if ($memMd) { Write-Utf8NoBom $MEMORY_MD ([string]$memMd) }
    if ($memJson) { Write-Utf8NoBom $MEMORY_JSON ([string]$memJson) }
  }
  Write-Utf8NoBom $SAVE_FILE ($body + "`n")
  Send-Text $ctx 200 ('{"ok":true,"savedAt":"' + $savedAt + '","file":"ddz_save.json"}') 'application/json; charset=utf-8'
}

# POST /api/memory  { md: "<markdown>", json: "<json>" }
function Handle-MemoryPost($ctx) {
  $body = (Read-Body $ctx).Trim()
  $obj = $null
  try { $obj = $body | ConvertFrom-Json } catch {
    Send-Text $ctx 400 '{"error":"bad json"}' 'application/json; charset=utf-8'
    return
  }
  $n = 0
  if ($obj.md)   { Write-Utf8NoBom $MEMORY_MD ([string]$obj.md); $n++ }
  if ($obj.json) { Write-Utf8NoBom $MEMORY_JSON ([string]$obj.json); $n++ }
  Send-Text $ctx 200 ('{"ok":true,"files":' + $n + '}') 'application/json; charset=utf-8'
}

# ---------------------------------------------------------------- static
function Handle-Static($ctx) {
  $urlPath = [System.Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath)
  if ($urlPath -eq '/' -or $urlPath -eq '') { $urlPath = '/index.html' }
  $rel = $urlPath.TrimStart('/').Replace('/', [System.IO.Path]::DirectorySeparatorChar)
  $full = Join-Path $Root $rel
  $fullCheck = [System.IO.Path]::GetFullPath($full)
  if (-not $fullCheck.StartsWith([System.IO.Path]::GetFullPath($Root))) {
    Send-Text $ctx 403 'Forbidden'
    return
  }
  if (-not (Test-Path $fullCheck -PathType Leaf)) {
    Send-Text $ctx 404 ('404 Not Found: ' + $urlPath)
    return
  }
  $type = Get-Mime $fullCheck
  $isMedia = $type.StartsWith('audio/') -or $type.StartsWith('video/')
  $bytes = [System.IO.File]::ReadAllBytes($fullCheck)
  $extra = @{}
  if ($isMedia) {
    $extra['Accept-Ranges'] = 'bytes'
    $extra['Content-Disposition'] = 'inline'
  }
  $range = $null
  if ($isMedia -and $ctx.Request.Headers['Range']) {
    $range = Get-Range $ctx.Request.Headers['Range'] $bytes.Length
  }
  if ($range) {
    $len = $range.end - $range.start + 1
    $slice = New-Object byte[] $len
    [Array]::Copy($bytes, $range.start, $slice, 0, $len)
    $extra['Content-Range'] = ('bytes ' + $range.start + '-' + $range.end + '/' + $bytes.Length)
    Send-Bytes $ctx 206 $slice $type $extra
    return
  }
  Send-Bytes $ctx 200 $bytes $type $extra
}

# ---------------------------------------------------------------- request
function Handle-Request($ctx) {
  try {
    $path = $ctx.Request.Url.AbsolutePath
    $method = $ctx.Request.HttpMethod
    if ($path -eq '/__ddz') {
      Send-Text $ctx 200 ('{"app":"' + $INSTANCE_TAG + '","port":' + $Port + '}') 'application/json; charset=utf-8'
      return
    }
    if ($path -eq '/api/chat' -and $method -eq 'POST') { Handle-Chat $ctx; return }
    if ($path -eq '/api/save' -and $method -eq 'POST') { Handle-SavePost $ctx; return }
    if ($path -eq '/api/save' -and $method -eq 'GET') { Handle-SaveGet $ctx; return }
    if ($path -eq '/api/memory' -and $method -eq 'POST') { Handle-MemoryPost $ctx; return }
    if ($method -eq 'GET' -or $method -eq 'HEAD') { Handle-Static $ctx; return }
    Send-Text $ctx 405 'Method Not Allowed'
  } catch {
    try { Send-Text $ctx 500 ('{"error":"' + $_.Exception.Message.Replace('"', "'") + '"}') 'application/json; charset=utf-8' } catch { }
  }
}

# ---------------------------------------------------------------- startup
# 1) a copy already running on the default port? then just open the browser
function Test-Running([int]$p) {
  try {
    $c = New-Object System.Net.WebClient
    $c.Encoding = [System.Text.Encoding]::UTF8
    $t = $c.DownloadString("http://localhost:$p/__ddz")
    return $t.Contains($INSTANCE_TAG)
  } catch { return $false }
}

if (-not $NoOpen) {
  for ($p = $Port; $p -lt $Port + 10; $p++) {
    if (Test-Running $p) {
      Write-Info "[server] already running on port $p - reusing it, no extra server started."
      Write-Info "[server] if the browser did not open by itself, copy this URL: http://localhost:$p/"
      Start-Process ("http://localhost:$p/") | Out-Null
      Start-Sleep -Seconds 1
      Write-Info "[server] (close the OLD server window first if you want this new copy to take over)"
      exit 0
    }
  }
}

# 2) bind the first free port
$listener = $null
$bound = $Port
for ($p = $Port; $p -lt $Port + 10; $p++) {
  try {
    $l = New-Object System.Net.HttpListener
    $l.Prefixes.Add("http://localhost:$p/")
    $l.Start()
    $listener = $l
    $bound = $p
    break
  } catch { }
}
if (-not $listener) {
  Write-Info '[ERROR] cannot listen on any port (5176-5185). Close the other copy and retry.'
  Read-Host 'Press Enter to exit'
  exit 1
}

$url = "http://localhost:$bound/"
Write-Info '============================================'
Write-Info '  AI-Gameet  -  local server (green build)'
Write-Info '============================================'
Write-Info ''
Write-Info "  URL : $url"
Write-Info '  Close this window to stop the server.'
Write-Info ''

if (-not $NoOpen) { Start-Process $url | Out-Null }

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    Handle-Request $ctx
  }
} finally {
  try { $listener.Stop(); $listener.Close() } catch { }
}
