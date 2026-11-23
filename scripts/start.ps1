# FastLabing 一键启动
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$Host.UI.RawUI.WindowTitle = "FastLabing 视频标注台"

$venvPy = Join-Path $root ".venv\Scripts\python.exe"
if (-not $env:PYTHON) {
  $cfg = Join-Path $root "python-path.txt"
  if (Test-Path $cfg) {
    $v = (Get-Content $cfg -Raw).Trim()
    if ($v -and (Test-Path $v)) { $env:PYTHON = $v }
  }
}
if (-not $env:PYTHON -or -not (Test-Path $env:PYTHON)) {
  if (-not (Test-Path $venvPy)) {
    Write-Host "未找到 Python 依赖环境。" -ForegroundColor Yellow
    Write-Host "请先双击「一键安装依赖.bat」完成安装。" -ForegroundColor Yellow
    Read-Host "按回车退出"
    exit 1
  }
  $env:PYTHON = $venvPy
}

if (-not (Test-Path (Join-Path $root "node_modules\express"))) {
  Write-Host "未找到 Node 依赖。" -ForegroundColor Yellow
  Write-Host "请先双击「一键安装依赖.bat」完成安装。" -ForegroundColor Yellow
  Read-Host "按回车退出"
  exit 1
}

# 数据和代码严格分离：默认放在程序同级目录 Fastlabing-data
$dataRoot = Join-Path (Split-Path -Parent $root) "Fastlabing-data"
New-Item -ItemType Directory -Force -Path $dataRoot | Out-Null
$env:FASTLABING_STORAGE = $dataRoot
$env:SAM3_REPO = Join-Path $root "third_party\sam3"
$env:SAM3_CKPT = Join-Path $root "models\sam3.pt"
$env:SAM2_CKPT = Join-Path $root "models\sam2.1_hiera_tiny.pt"
$env:SAM2_TMP_DIR = Join-Path $dataRoot "tmp"
if (-not $env:AUTO_OPEN) { $env:AUTO_OPEN = "1" }
if (-not $env:PORT) {
  $p = 3000
  while ($p -lt 3100 -and (Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue)) { $p++ }
  $env:PORT = "$p"
} else {
  $listening = Get-NetTCPConnection -LocalPort ([int]$env:PORT) -State Listen -ErrorAction SilentlyContinue
  if ($listening) {
    Write-Host "端口 $env:PORT 已被占用，请先关闭占用该端口的程序，或设置其他 PORT。" -ForegroundColor Yellow
    Read-Host "按回车退出"
    exit 1
  }
}

Write-Host ""
Write-Host "  FastLabing 视频标注台" -ForegroundColor Green
Write-Host "  地址： http://127.0.0.1:$env:PORT" -ForegroundColor Green
Write-Host "  数据： $dataRoot" -ForegroundColor DarkGray
Write-Host "  关闭此窗口或按 Ctrl+C 即可停止服务。" -ForegroundColor DarkGray
Write-Host ""

& node (Join-Path $root "server\server.js")
$code = $LASTEXITCODE
Write-Host ""
Write-Host "服务已退出（code=$code）。" -ForegroundColor DarkGray
Read-Host "按回车关闭窗口"
