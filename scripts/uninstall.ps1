# FastLabing 一键删除：停止服务并清理依赖/缓存（默认保留项目数据与模型）
param(
  [switch]$PurgeData,
  [switch]$PurgeModels,
  [switch]$Yes
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$dataRoot = Join-Path (Split-Path -Parent $root) "Fastlabing-data"
Set-Location $root
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

function Info($msg) { Write-Host "[FastLabing] $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "  OK  $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "  !   $msg" -ForegroundColor Yellow }

$sizeText = "未知"
if (Test-Path $dataRoot) {
  $bytes = (Get-ChildItem $dataRoot -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
  if ($bytes) { $sizeText = [math]::Round($bytes / 1MB, 1).ToString() + " MB" }
}

if (-not $Yes) {
  Write-Host ""
  Write-Host "将停止 FastLabing 服务，并删除：.venv、node_modules、Python 缓存。" -ForegroundColor Yellow
  Write-Host "默认保留模型权重和项目数据。" -ForegroundColor DarkGray
  Write-Host ""
  $ans = Read-Host "确认继续？(y/N)"
  if ($ans -notmatch "^[yY]") { Write-Host "已取消。"; exit 0 }

  $ans = Read-Host "是否同时删除模型权重 models\*.pt（约 3.4GB）？(y/N)"
  if ($ans -match "^[yY]") { $PurgeModels = $true }

  Write-Host "项目数据目录：$dataRoot（$sizeText）" -ForegroundColor DarkGray
  $ans = Read-Host "是否同时删除所有项目数据（视频、帧图、标注、导出）？此操作不可恢复！(y/N)"
  if ($ans -match "^[yY]") { $PurgeData = $true }
}

Info "停止 FastLabing 相关进程 ..."
$escapedRoot = [WildcardPattern]::Escape($root)
$procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  $_.CommandLine -and
  $_.Name -match "^(node|python)\.exe$" -and
  $_.CommandLine -like ("*" + $escapedRoot + "*")
}
foreach ($p in $procs) {
  try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; Ok "已停止 $($p.Name) (PID $($p.ProcessId))" } catch { Warn "无法停止 PID $($p.ProcessId)：$($_.Exception.Message)" }
}

Info "清理依赖与缓存 ..."
foreach ($dir in @(".venv", "node_modules", ".pytest_cache")) {
  $p = Join-Path $root $dir
  if (Test-Path $p) {
    try { Remove-Item $p -Recurse -Force -ErrorAction Stop; Ok "已删除 $dir" }
    catch { Warn "删除 $dir 失败：$($_.Exception.Message)" }
  }
}

$cacheDirs = Get-ChildItem $root -Recurse -Directory -Filter "__pycache__" -ErrorAction SilentlyContinue
foreach ($d in $cacheDirs) {
  try { Remove-Item $d.FullName -Recurse -Force -ErrorAction Stop } catch {}
}
Get-ChildItem $root -Recurse -File -Include "*.pyc" -ErrorAction SilentlyContinue | ForEach-Object {
  try { Remove-Item $_.FullName -Force -ErrorAction Stop } catch {}
}
Ok "缓存清理完成"

if ($PurgeModels) {
  Info "删除模型权重 ..."
  Get-ChildItem (Join-Path $root "models") -File -Filter "*.pt" -ErrorAction SilentlyContinue | ForEach-Object {
    try { Remove-Item $_.FullName -Force -ErrorAction Stop; Ok "已删除 $($_.Name)" } catch { Warn "删除 $($_.Name) 失败：$($_.Exception.Message)" }
  }
}

if ($PurgeData) {
  Info "删除项目数据 ..."
  if (Test-Path $dataRoot) {
    try { Remove-Item $dataRoot -Recurse -Force -ErrorAction Stop; Ok "已删除 $dataRoot" }
    catch { Warn "删除数据目录失败：$($_.Exception.Message)" }
  } else {
    Ok "数据目录不存在，无需删除"
  }
} else {
  Warn "已保留项目数据：$dataRoot"
}

Write-Host ""
Write-Host "清理完成。源码与启动脚本仍然保留。" -ForegroundColor Green
if (-not $Yes) { Read-Host "按回车关闭窗口" }
