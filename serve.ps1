# 미니수첩 로컬 서버 (설치 필요 없음). 사용: powershell -ExecutionPolicy Bypass -File serve.ps1 [-Port 5178] [-Open]
param([int]$Port = 5178, [switch]$Open)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$types = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.css' = 'text/css; charset=utf-8'
  '.png' = 'image/png'; '.svg' = 'image/svg+xml'; '.webmanifest' = 'application/manifest+json'; '.json' = 'application/json'
  '.md' = 'text/plain; charset=utf-8'; '.ico' = 'image/x-icon'
}
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
try { $listener.Start() } catch {
  # already running (e.g. launched twice) -> just open the app
  if ($Open) { Start-Process "msedge" "--app=http://localhost:$Port/" }
  exit 0
}
Write-Host "미니수첩 서버 실행 중: http://localhost:$Port/  (이 창을 닫으면 종료)"
if ($Open) {
  try { Start-Process "msedge" "--app=http://localhost:$Port/" } catch { Start-Process "http://localhost:$Port/" }
}
while ($listener.IsListening) {
  try { $ctx = $listener.GetContext() } catch { break }
  $req = $ctx.Request; $res = $ctx.Response
  try {
    $path = [Uri]::UnescapeDataString($req.Url.AbsolutePath.TrimStart('/'))
    if ($path -eq '') { $path = 'index.html' }
    $file = [IO.Path]::GetFullPath((Join-Path $root $path))
    if (-not $file.StartsWith($root) -or -not (Test-Path $file -PathType Leaf)) {
      $res.StatusCode = 404; $b = [Text.Encoding]::UTF8.GetBytes('not found')
    } else {
      $ext = [IO.Path]::GetExtension($file).ToLower()
      $res.ContentType = if ($types.ContainsKey($ext)) { $types[$ext] } else { 'application/octet-stream' }
      $res.Headers.Add('Cache-Control', 'no-cache')
      $b = [IO.File]::ReadAllBytes($file)
    }
    $res.ContentLength64 = $b.Length
    $res.OutputStream.Write($b, 0, $b.Length)
  } catch { } finally { try { $res.Close() } catch { } }
}
