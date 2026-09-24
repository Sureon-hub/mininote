# MiniNote "open folder" helper: handles mininote-open:<encoded path> links from the app
# and shows the file in Windows Explorer. Installed by "탐색기 연결 설치.bat".
param([string]$u)
$p = [uri]::UnescapeDataString(($u -replace '^mininote-open:/*', ''))
# only plain local paths like C:\...  (no network shares, no "..")
if ($p -notmatch '^[A-Za-z]:\\' -or $p -match '\.\.') { exit 1 }
if (Test-Path -LiteralPath $p -PathType Leaf) {
  # /select only highlights the file – it never runs it
  Start-Process explorer.exe -ArgumentList "/select,`"$p`""
} elseif (Test-Path -LiteralPath $p -PathType Container) {
  Start-Process explorer.exe -ArgumentList "`"$p`""
} else {
  $d = Split-Path -Path $p -Parent
  if ($d -and (Test-Path -LiteralPath $d -PathType Container)) { Start-Process explorer.exe -ArgumentList "`"$d`"" }
}
