# FastLabing 一键安装依赖（Windows / PowerShell 5.1+）
# 用法：双击「一键安装依赖.bat」，或在 PowerShell 中执行 scripts\install.ps1
param(
  [string]$Python = "",
  [switch]$SkipNode,
  [switch]$SkipPython,
  [switch]$SkipModels
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

function Info($msg) { Write-Host "[FastLabing] $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "  OK  $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "  !   $msg" -ForegroundColor Yellow }
function Fail($msg) { Write-Host "  X   $msg" -ForegroundColor Red; exit 1 }

$mirror = "https://pypi.tuna.tsinghua.edu.cn/simple"
$venvDir = Join-Path $root ".venv"
$venvPy = Join-Path $venvDir "Scripts\python.exe"

Info "程序目录：$root"

# ---------------- Node 依赖 ----------------
if (-not $SkipNode) {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Fail "未找到 Node.js。请先安装 Node.js 18 或更高版本：https://nodejs.org/zh-cn/download"
  }
  Info "安装 Node 依赖（npm install）..."
  & npm install --omit=dev --no-audit --no-fund --registry=https://registry.npmmirror.com
  if ($LASTEXITCODE -ne 0) { Fail "npm install 失败，请检查网络后重试。" }
  Ok "Node 依赖安装完成"
}

# ---------------- Python 环境 ----------------
if (-not $SkipPython) {
  $reuse = $false

  # 可选的本地配置：python-path.txt 写入一个已装好依赖的 python.exe，避免重复安装
  if (-not $Python) {
    $cfg = Join-Path $root "python-path.txt"
    if (Test-Path $cfg) {
      $v = (Get-Content $cfg -Raw).Trim()
      if ($v -and (Test-Path $v)) { $Python = $v }
    }
  }

  if ($Python -and (Test-Path $Python)) {
    $env:PYTHONPATH = Join-Path $root "third_party\sam3"
    & $Python -c "import torch, sam2, sam3" 2>$null
    if ($LASTEXITCODE -eq 0) {
      $venvPy = $Python
      $reuse = $true
      Ok "复用已有 Python 环境：$Python"
    } else {
      Warn "指定环境缺少 torch / sam2 / sam3，将创建独立 .venv。"
    }
  }

  if (-not $reuse -and -not (Test-Path $venvPy)) {
    $pyCmd = $null
    $pyPrefix = @()
    if ($Python) {
      if (-not (Test-Path $Python)) { Fail "指定的 Python 不存在：$Python" }
      $pyCmd = $Python
    } elseif (Get-Command py -ErrorAction SilentlyContinue) {
      & py -3.12 -c "import sys" 2>$null
      if ($LASTEXITCODE -eq 0) { $pyCmd = "py"; $pyPrefix = @("-3.12") }
    }
    if (-not $pyCmd -and (Get-Command python -ErrorAction SilentlyContinue)) {
      $pyCmd = "python"
    }
    if (-not $pyCmd) {
      Fail "未找到 Python 3.12。请安装 Python 3.12（勾选 Add to PATH）：https://www.python.org/downloads/release/python-31210/"
    }

    $ver = & $pyCmd @pyPrefix -c "import sys; print('%d.%d' % sys.version_info[:2])"
    if ($LASTEXITCODE -ne 0 -or $ver.Trim() -ne "3.12") {
      Fail "需要 Python 3.12，当前检测到：$ver。请安装 Python 3.12 后重试。"
    }

    if (Test-Path $venvDir) { Remove-Item $venvDir -Recurse -Force }
    Info "创建 Python 虚拟环境 .venv ..."
    & $pyCmd @pyPrefix -m venv $venvDir
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $venvPy)) { Fail "创建虚拟环境失败。" }
  }

  if (-not $reuse) {
    Ok "Python 虚拟环境就绪"

    Info "升级 pip ..."
    & $venvPy -m pip install --upgrade pip -i $mirror
    if ($LASTEXITCODE -ne 0) { Fail "pip 升级失败，请检查网络。" }

    Info "安装 PyTorch 2.10.0 + CUDA 12.8（体积较大，请耐心等待）..."
    & $venvPy -m pip install torch==2.10.0+cu128 torchvision==0.25.0+cu128 -i $mirror --extra-index-url https://download.pytorch.org/whl/cu128
    if ($LASTEXITCODE -ne 0) {
      Fail "PyTorch 安装失败。可先设置代理后重试，或使用已有 CUDA 环境并设置 PYTHON 环境变量。"
    }
    Ok "PyTorch 安装完成"

    Info "安装 SAM / 图像依赖 ..."
    & $venvPy -m pip install -r (Join-Path $root "python\requirements.txt") -i $mirror
    if ($LASTEXITCODE -ne 0) {
      Warn "镜像源安装失败，改用官方 PyPI 重试 ..."
      & $venvPy -m pip install -r (Join-Path $root "python\requirements.txt") --index-url https://pypi.org/simple
      if ($LASTEXITCODE -ne 0) { Fail "Python 依赖安装失败，请检查网络。" }
    }
    Ok "Python 依赖安装完成"
  }

  Info "验证 Python 环境 ..."
  $env:PYTHONPATH = Join-Path $root "third_party\sam3"
  & $venvPy -c "import torch, sam2, sam3; print('torch=' + torch.__version__ + ' cuda=' + str(torch.cuda.is_available()))"
  if ($LASTEXITCODE -ne 0) { Fail "依赖校验失败：无法 import torch / sam2 / sam3。" }
  Ok "校验通过"
}

# ---------------- 模型权重 ----------------
if (-not $SkipModels) {
  $modelsDir = Join-Path $root "models"
  New-Item -ItemType Directory -Force -Path $modelsDir | Out-Null
  $sam2 = Join-Path $modelsDir "sam2.1_hiera_tiny.pt"
  $sam3 = Join-Path $modelsDir "sam3.pt"

  if (-not (Test-Path $sam2)) {
    Info "下载 SAM 2.1 tiny 权重（约 150MB）..."
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri "https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_tiny.pt" -OutFile $sam2
    if (-not (Test-Path $sam2)) { Fail "SAM 2.1 权重下载失败，请手动放到 models\sam2.1_hiera_tiny.pt" }
  }
  Ok "SAM 2.1 权重：" + $sam2

  if (-not (Test-Path $sam3)) {
    Warn "未找到 SAM 3 权重：$sam3"
    Warn "请从 https://huggingface.co/facebook/sam3 获取 sam3.pt 后放到 models\ 目录。"
    Warn "没有 SAM 3 权重时，仍可使用 SAM 2.1 跟踪。"
  } else {
    Ok ("SAM 3 权重：" + $sam3 + "（" + [math]::Round((Get-Item $sam3).Length / 1GB, 2) + " GB）")
  }
}

# ---------------- 数据目录 ----------------
$dataRoot = Join-Path (Split-Path -Parent $root) "Fastlabing-data"
New-Item -ItemType Directory -Force -Path $dataRoot | Out-Null
Ok "数据目录（与程序分离）：$dataRoot"

Write-Host ""
Write-Host "安装完成。双击「一键启动.bat」即可使用。" -ForegroundColor Green
