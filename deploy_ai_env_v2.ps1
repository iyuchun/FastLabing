#Requires -Version 5.1
# ============================================================
#  SAM 3 / SAM 2.1  AI 环境一键部署（修正版 v2）
#  项目：视频打框标注工具（数据集demo）
#
#  放置位置：项目目录里（含 server\server.js 的那一层，通常是「数据集demo」）
#  用法    ：双击「一键部署AI环境-v2.bat」
#
#  做什么：
#    1. 检测 NVIDIA 显卡 + 算力（sm），算力 < 7.5（Pascal 及更老）直接跳过
#    2. 检查目标盘剩余空间
#    3. 找系统 Python 3.10~3.13（不走 conda），没有就静默装 Python 3.10.11
#    4. 在 <项目上级目录>\.venv-sam3 建 venv（与 server.js 的约定一致）
#    5. 全部依赖走国内镜像（PyPI 镜像 + 上海交大 PyTorch 镜像）
#    6. 修正 server.js 里的 VENV_PYTHON 绝对路径（幂等 + 语法校验 + 备份）
#    7. 自检（torch CUDA / sam3 / sam2 / 依赖），失败会返回非 0 退出码
#    8. 写 ai_env_manifest.json，供「一键卸载AI环境.bat」精确清理
#
#  版本定档（与本机 coal_mine 实测通过的环境一致）：
#    Python 3.10.11 / torch 2.11.0+cu128 / torchvision 0.26.0+cu128
#    triton-windows 3.6.0.post26 / sam2 1.1.0
#    cu128 的 arch_list = sm_75/80/86/90/100/120 → 20/30/40/50 系一个包全覆盖
# ============================================================

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

# ------------------------------------------------------------
# 0. 常量
# ------------------------------------------------------------
$PY_VER       = '3.10.11'
$TORCH_VER    = '2.11.0'
$TV_VER       = '0.26.0'
$CU           = 'cu128'
$TRITON_VER   = '3.6.0.post26'
$SAM2_VER     = '1.1.0'
$VENV_NAME    = '.venv-sam3'
$MIN_SM       = 7.5
$NEED_FREE_GB = 18

# ------------------------------------------------------------
# 1. 输出辅助
# ------------------------------------------------------------
function Say  ($m) { Write-Host $m }
function Step ($m) { Write-Host "`n[步骤] $m" -ForegroundColor Cyan }
function Ok   ($m) { Write-Host "[OK]   $m" -ForegroundColor Green }
function Warn ($m) { Write-Host "[警告] $m" -ForegroundColor Yellow }
function Err  ($m) { Write-Host "[错误] $m" -ForegroundColor Red }
function Info ($m) { Write-Host "       $m" -ForegroundColor Gray }

$ScriptDir = $PSScriptRoot
if (-not $ScriptDir) { $ScriptDir = (Get-Location).Path }
$LOG = Join-Path $ScriptDir 'deploy_ai_env.log'
function Log ($m) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m
    try { Add-Content -Path $LOG -Value $line -Encoding UTF8 } catch {}
}

Say ''
Say '============================================================'
Say '   AI 环境一键部署（SAM 3 / SAM 2.1）  修正版 v2'
Say '============================================================'
Log 'start v2'

# ------------------------------------------------------------
# 2. 定位项目目录（自动识别 server\server.js）
# ------------------------------------------------------------
function Find-ProjectDir([string]$start) {
    $cands = @()
    $cands += (Join-Path $start 'server\server.js')
    $cands += (Join-Path $start '*\server\server.js')
    $up1 = Split-Path -Parent $start
    if ($up1) {
        $cands += (Join-Path $up1 'server\server.js')
        $cands += (Join-Path $up1 '*\server\server.js')
        $up2 = Split-Path -Parent $up1
        if ($up2) { $cands += (Join-Path $up2 '*\server\server.js') }
    }
    foreach ($c in $cands) {
        $hit = Get-Item $c -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($hit) { return (Split-Path -Parent (Split-Path -Parent $hit.FullName)) }
    }
    return $null
}

$ProjectDir = Find-ProjectDir $ScriptDir
if (-not $ProjectDir) {
    Err '未找到 server\server.js'
    Err '请把本脚本放到「数据集demo」目录里再运行（与 一键启动.bat 同级）'
    Log 'project dir not found'
    Read-Host '按回车退出'
    exit 1
}
$LabDir   = Split-Path -Parent $ProjectDir
$Sam3Repo = Join-Path $LabDir 'sam3'
$Sam2Root = Join-Path $LabDir 'sam2'
$Sam3Ckpt = Join-Path $Sam3Repo 'sam3.pt'
$Sam2Ckpt = Join-Path $Sam2Root 'checkpoints\sam2.1_hiera_tiny.pt'
$VenvDir  = Join-Path $LabDir $VENV_NAME
$VenvPy   = Join-Path $VenvDir 'Scripts\python.exe'
$ServerJs = Join-Path $ProjectDir 'server\server.js'

Info "脚本位置  : $ScriptDir"
Info "项目目录  : $ProjectDir"
Info "SAM3 源码 : $Sam3Repo"
Info "SAM2 源码 : $Sam2Root"
Info "虚拟环境  : $VenvDir"
Info "server.js : $ServerJs"

# 权重检查（缺失只警告，不阻断依赖安装）
$missWeight = @()
if (-not (Test-Path $Sam3Ckpt)) { $missWeight += "SAM3 权重 : $Sam3Ckpt" }
if (-not (Test-Path $Sam2Ckpt)) { $missWeight += "SAM2 权重 : $Sam2Ckpt" }

# ------------------------------------------------------------
# 3. 磁盘规划（默认全放 D 盘）
# ------------------------------------------------------------
function Get-DataRoot {
    foreach ($d in @('D:\', 'E:\', 'F:\')) {
        if (Test-Path $d) { return ($d.TrimEnd('\')) }
    }
    return $env:USERPROFILE
}
$DATA_ROOT  = Get-DataRoot
$PY_TARGET  = Join-Path $DATA_ROOT 'Python310'
$CACHE_DIR  = Join-Path $DATA_ROOT 'ai-deploy-cache'
$PIP_CACHE  = Join-Path $DATA_ROOT 'pip-cache'
$TRITON_CACHE = Join-Path $DATA_ROOT 'triton-cache'

# ------------------------------------------------------------
# 4. 镜像源（2026-11 实测可用；按顺序自动切换）
# ------------------------------------------------------------
# PyPI 镜像（PEP503 标准 simple 索引，pip --index-url 可直接用）
$PYPI_MIRRORS = @(
    'https://pypi.tuna.tsinghua.edu.cn/simple',
    'https://mirrors.aliyun.com/pypi/simple/',
    'https://mirrors.ustc.edu.cn/pypi/simple/',
    'https://mirrors.cloud.tencent.com/pypi/simple/',
    'https://repo.huaweicloud.com/repository/pypi/simple/'
)
# 上海交大 PyTorch 镜像：标准 simple 索引，国内速度好（首选）
$TORCH_INDEX    = 'https://mirror.sjtu.edu.cn/pytorch-wheels/cu128'
# 阿里云 PyTorch 镜像：平面文件目录，只能配合 --find-links 用（备用）
$TORCH_FINDLINK = 'https://mirrors.aliyun.com/pytorch-wheels/cu128'
# 官方源（最后兜底，国内偏慢）
$TORCH_OFFICIAL = 'https://download.pytorch.org/whl/cu128'

# Python 安装包镜像
$PY_DL_MIRRORS = @(
    'https://mirrors.huaweicloud.com/python/{0}/python-{0}-amd64.exe',
    'https://mirrors.aliyun.com/python-release/windows/python-{0}-amd64.exe',
    'https://registry.npmmirror.com/-/binary/python/{0}/python-{0}-amd64.exe'
)

foreach ($d in @($CACHE_DIR, $PIP_CACHE, $TRITON_CACHE, (Join-Path $CACHE_DIR 'tmp'))) {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
}

# ------------------------------------------------------------
# 5. 检测 NVIDIA 显卡
# ------------------------------------------------------------
Step '检测 NVIDIA 显卡'

$gpuName = $null; $gpuCap = $null; $gpuMem = $null; $sm = 0.0

try {
    $smi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
    if ($smi) {
        $raw = & nvidia-smi --query-gpu=name,compute_cap,memory.total --format=csv,noheader 2>$null
        if ($raw) {
            $line = ("$raw".Split("`n")[0]).Trim()
            $parts = $line -split ','
            if ($parts.Count -ge 3) {
                $gpuName = $parts[0].Trim()
                $gpuCap  = $parts[1].Trim()
                $gpuMem  = $parts[2].Trim()
            }
        }
    }
} catch { Log "nvidia-smi 异常: $_" }

if (-not $gpuName) {
    Warn '未检测到 NVIDIA 显卡（或无驱动）'
    Say ''
    Say '============================================================'
    Say '   未检测到可用的 NVIDIA 显卡 → 跳过 AI 环境安装'
    Say '============================================================'
    Say '  本机不安装 AI 功能，Web 标注（导入/分帧/打框/导出）不受影响。'
    Say '  「AI 自动打标 / 智能跟踪」按钮会置灰。'
    Say ''
    Say '  如果你确实有 NVIDIA 独显但没检测到，通常是没装驱动：'
    Say '    https://www.nvidia.cn/drivers/'
    Say '  装完驱动后重新运行本脚本即可。'
    Say ''
    Log 'no nvidia gpu, skip'
    Read-Host '按回车退出'
    exit 0
}

Ok "显卡    : $gpuName"
Info "算力    : $gpuCap"
Info "显存    : $gpuMem"
try { $sm = [double]($gpuCap -split '\s')[0] } catch { $sm = 0.0 }

if ($sm -gt 0 -and $sm -lt $MIN_SM) {
    Warn "算力 sm_$gpuCap 低于 sm_7.5（Pascal 及更老架构）"
    Say ''
    Say '============================================================'
    Say '   显卡太老，torch cu128 里没有对应内核 → 跳过 AI 环境安装'
    Say '============================================================'
    Say '  torch 2.11+cu128 支持的算力：sm_75 / 80 / 86 / 90 / 100 / 120'
    Say '  也就是 GTX 16 系、RTX 20/30/40/50 系可用；'
    Say '  GTX 10 系（sm_61）、MX150/MX250（sm_61）等不支持 GPU 加速。'
    Say ''
    Say '  Web 标注功能不受影响，只是 AI 自动打标用不了。'
    Say ''
    Log "gpu too old sm=$gpuCap, skip"
    Read-Host '按回车退出'
    exit 0
}

if     ($sm -ge 12.0) { Ok '识别为 50 系（Blackwell, sm_120）→ torch cu128' }
elseif ($sm -ge 8.9)  { Ok '识别为 40 系（Ada, sm_89）→ torch cu128' }
elseif ($sm -ge 8.6)  { Ok '识别为 30 系（Ampere, sm_86）→ torch cu128' }
elseif ($sm -ge 8.0)  { Ok '识别为 A100/专业卡（sm_80）→ torch cu128' }
elseif ($sm -ge 7.5)  { Ok '识别为 20/16 系（Turing, sm_75）→ torch cu128' }
else                  { Warn "未识别算力 $gpuCap → 仍按 cu128 安装" }
Info "统一使用 torch $TORCH_VER+$CU（一个包同时覆盖 sm_75~sm_120）"

$memGb = 0.0
try { $memGb = [double]($gpuMem -replace '[^\d.]', '') / 1024.0 } catch {}
if ($memGb -gt 0 -and $memGb -lt 5.5) {
    Warn ("显存 {0:N1} GB 偏小（建议 8GB），1080p 长视频可能显存不足" -f $memGb)
}

# ------------------------------------------------------------
# 6. 磁盘空间检查（失败名单提前退出，别装到一半炸）
# ------------------------------------------------------------
Step "检查磁盘空间（目标盘 $DATA_ROOT）"

function Get-FreeGB([string]$path) {
    try {
        $root = ($path.TrimEnd('\') -split ':')[0] + ':\'
        $di = New-Object System.IO.DriveInfo($root)
        if ($di.IsReady) { return [math]::Round($di.AvailableFreeSpace / 1GB, 1) }
    } catch {}
    return -1
}

$freeGb = Get-FreeGB $DATA_ROOT
if ($freeGb -ge 0) {
    Info ("$DATA_ROOT 剩余空间 : {0:N1} GB（本次部署约需 {1} GB）" -f $freeGb, $NEED_FREE_GB)
    if ($freeGb -lt $NEED_FREE_GB) {
        Err "剩余空间不足：需要约 $NEED_FREE_GB GB，当前只有 $freeGb GB"
        Info 'torch 2.5GB + 解压临时文件 + venv 依赖 ≈ 12~15GB，缓存另需 3GB'
        Log "not enough free space: $freeGb GB"
        Read-Host '按回车退出'
        exit 1
    }
    Ok '空间充足'
} else {
    Warn '未能读取磁盘剩余空间，跳过检查'
}

# ------------------------------------------------------------
# 7. 查找系统 Python（3.10~3.13，不走 conda 创建环境）
# ------------------------------------------------------------
Step '查找系统 Python 3.10~3.13'

function Get-PyVer([string]$exe) {
    try {
        $out = & $exe -c "import sys;print('%d.%d'%sys.version_info[:2])" 2>$null
        if ($LASTEXITCODE -eq 0 -and $out) { return ("$out").Trim() }
    } catch {}
    return $null
}
$GOOD_VER = @('3.10', '3.11', '3.12', '3.13')

function Is-CondaPy([string]$exe) {
    $l = $exe.ToLower()
    return ($l -match 'conda|anaconda|miniconda')
}

$pyCands = @()
# 7.1 py 启动器
$pyLauncher = Get-Command py -ErrorAction SilentlyContinue
if ($pyLauncher) {
    foreach ($tag in @('-3.10', '-3.11', '-3.12', '-3.13')) {
        try {
            $p = & py $tag -c "import sys;print(sys.executable)" 2>$null
            if ($LASTEXITCODE -eq 0 -and $p) {
                $pp = ("$p").Trim()
                if (Test-Path $pp) { $pyCands += $pp }
            }
        } catch {}
    }
    if ($pyCands.Count -gt 0) { Info '来自 py 启动器' }
}
# 7.2 常见安装目录
$roots = @(
    $PY_TARGET,
    "$env:LOCALAPPDATA\Programs\Python",
    "$env:ProgramFiles\Python310", "$env:ProgramFiles\Python311",
    "$env:ProgramFiles\Python312", "$env:ProgramFiles\Python313",
    "${env:ProgramFiles(x86)}\Python310",
    'C:\Python310', 'C:\Python311', 'C:\Python312', 'C:\Python313',
    'D:\Python310', 'D:\Python311', 'D:\Python312', 'D:\Python313'
)
foreach ($r in $roots) {
    if (-not (Test-Path $r)) { continue }
    $exe = Join-Path $r 'python.exe'
    if (Test-Path $exe) { $pyCands += $exe }
    else {
        Get-ChildItem $r -Directory -ErrorAction SilentlyContinue | ForEach-Object {
            $e2 = Join-Path $_.FullName 'python.exe'
            if (Test-Path $e2) { $pyCands += $e2 }
        }
    }
}
# 7.3 PATH 里的 python（排除 Windows Store 占位符）
try {
    $onPath = (Get-Command python -ErrorAction SilentlyContinue).Source
    if ($onPath -and $onPath -notlike '*WindowsApps*') { $pyCands += $onPath }
} catch {}

$basePy = $null
foreach ($ver in @('3.10', '3.11', '3.12', '3.13')) {
    foreach ($c in ($pyCands | Select-Object -Unique)) {
        if (-not (Test-Path $c)) { continue }
        if ((Get-PyVer $c) -eq $ver -and -not (Is-CondaPy $c)) { $basePy = $c; break }
    }
    if ($basePy) { break }
}
# 实在没有非 conda 的，再接受 conda 里的解释器（只用来建 venv）
if (-not $basePy) {
    foreach ($ver in @('3.10', '3.11', '3.12', '3.13')) {
        foreach ($c in ($pyCands | Select-Object -Unique)) {
            if ((Test-Path $c) -and (Get-PyVer $c) -eq $ver) { $basePy = $c; break }
        }
        if ($basePy) { break }
    }
    if ($basePy) { Warn "只找到 conda 自带解释器，将用它创建 venv（后续依赖不依赖 conda）：$basePy" }
}

if ($basePy) {
    Ok "使用 Python $(Get-PyVer $basePy) : $basePy"
} else {
    Warn '未找到 Python 3.10~3.13'
}

# ------------------------------------------------------------
# 8. 没有 Python 就下载安装（国内镜像，静默）
# ------------------------------------------------------------
$pyInstalled = $null
if (-not $basePy) {
    Step "下载并安装 Python $PY_VER（国内镜像，约 25MB）"
    $dl = Join-Path $CACHE_DIR ("python-{0}-amd64.exe" -f $PY_VER)
    $got = $false
    foreach ($tpl in $PY_DL_MIRRORS) {
        $url = $tpl -replace '\{0\}', $PY_VER
        Info "尝试: $url"
        try {
            $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
            if ($curl) {
                & curl.exe -L --fail --retry 2 --connect-timeout 20 -s -o $dl $url
                if ($LASTEXITCODE -eq 0 -and (Test-Path $dl) -and (Get-Item $dl).Length -gt 1MB) { $got = $true; break }
            } else {
                $old = $ProgressPreference; $ProgressPreference = 'SilentlyContinue'
                Invoke-WebRequest -Uri $url -OutFile $dl -TimeoutSec 300 -UseBasicParsing
                $ProgressPreference = $old
                if ((Test-Path $dl) -and (Get-Item $dl).Length -gt 1MB) { $got = $true; break }
            }
        } catch { Warn "该镜像失败：$($_.Exception.Message)" }
    }
    if (-not $got) {
        Err 'Python 安装包所有镜像都下载失败，请检查网络'
        Info "可手动下载：https://mirrors.huaweicloud.com/python/$PY_VER/"
        Log 'python download failed'
        Read-Host '按回车退出'
        exit 1
    }
    Ok ("下载完成：{0:N1} MB" -f ((Get-Item $dl).Length / 1MB))

    Info "正在静默安装到 $PY_TARGET ..."
    $instArgs = @(
        '/quiet',
        'InstallAllUsers=0',
        'PrependPath=0',
        'Include_pip=1',
        'Include_launcher=1',
        'InstallLauncherAllUsers=0',
        'Include_test=0',
        'Include_doc=0',
        'Include_tcltk=0',
        "TargetDir=$PY_TARGET"
    )
    $proc = Start-Process -FilePath $dl -ArgumentList $instArgs -Wait -PassThru
    Log "python installer exit=$($proc.ExitCode)"

    foreach ($c in @((Join-Path $PY_TARGET 'python.exe'))) {
        if (Test-Path $c) { $basePy = $c; break }
    }
    if (-not $basePy) {
        $scan = @($PY_TARGET, "$env:LOCALAPPDATA\Programs\Python")
        foreach ($r in $scan) {
            if (Test-Path $r) {
                Get-ChildItem $r -Recurse -Filter python.exe -ErrorAction SilentlyContinue | ForEach-Object {
                    if (-not $basePy -and (Get-PyVer $_.FullName)) { $basePy = $_.FullName }
                }
            }
        }
    }
    if (-not $basePy) {
        Err 'Python 安装后仍未找到 python.exe'
        Info "请手动安装 Python $PY_VER 到 $PY_TARGET 后重跑本脚本"
        Log 'python install failed'
        Read-Host '按回车退出'
        exit 1
    }
    $pyInstalled = $PY_TARGET
    Ok "安装成功：$basePy"
}

Info "基础解释器版本: $(Get-PyVer $basePy)"

# ------------------------------------------------------------
# 9. 创建 venv
# ------------------------------------------------------------
Step "创建虚拟环境：$VenvDir"

if (Test-Path $VenvPy) {
    $vt = & $VenvPy -c "print('ok')" 2>$null
    if ($vt -eq 'ok') { Ok '已存在可用的 venv，跳过创建' }
    else {
        Warn '已有 venv 不可用，重建'
        Remove-Item $VenvDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}
if (-not (Test-Path $VenvPy)) {
    if (Test-Path $VenvDir) { Remove-Item $VenvDir -Recurse -Force -ErrorAction SilentlyContinue }
    & $basePy -m venv $VenvDir
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $VenvPy)) {
        Err '创建虚拟环境失败（确认基础 Python 自带 venv 模块）'
        Log 'venv create failed'
        Read-Host '按回车退出'
        exit 1
    }
    Ok 'venv 创建完成'
}

# 所有 pip 缓存/临时目录都压在 D 盘，不占 C 盘
$env:PIP_CACHE_DIR = $PIP_CACHE
$env:TRITON_CACHE_DIR = $TRITON_CACHE
$env:TEMP = Join-Path $CACHE_DIR 'tmp'
$env:TMP = $env:TEMP
$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONUTF8 = '1'

# ------------------------------------------------------------
# 10. 通用 pip 调用（自动切换镜像）
# ------------------------------------------------------------
function Invoke-Pip {
    param(
        [Parameter(Mandatory)][string[]]$PkgArgs,
        [string]$Tag = '',
        [string[]]$ExtraArgs = @()
    )
    foreach ($m in $PYPI_MIRRORS) {
        Info "源: $m"
        $a = @('-m', 'pip', 'install', '--no-input', '--disable-pip-version-check',
               '--timeout', '60', '--retries', '2', '--prefer-binary',
               '--index-url', $m) + $ExtraArgs + $PkgArgs
        & $VenvPy @a
        if ($LASTEXITCODE -eq 0) { return $true }
        Warn "$Tag 该源失败，切换下一个"
    }
    return $false
}

Step '升级 pip / setuptools / wheel'
if (Invoke-Pip -PkgArgs @('--upgrade', 'pip', 'setuptools', 'wheel') -Tag 'pip升级') {
    Ok 'pip 升级完成'
} else {
    Warn 'pip 升级失败，继续后续步骤'
}

# ------------------------------------------------------------
# 11. 安装 PyTorch（CUDA 版，多策略）
# ------------------------------------------------------------
Step "安装 PyTorch $TORCH_VER+$CU + torchvision $TV_VER+$CU（约 2.5GB，耐心等待）"

$torchPkgs = @("torch==$TORCH_VER+$CU", "torchvision==$TV_VER+$CU")
$torchOk = $false

# 策略 1：上海交大镜像（标准 simple 索引，速度最好）
if (-not $torchOk) {
    Info "策略1 torch 源: $TORCH_INDEX"
    foreach ($pu in $PYPI_MIRRORS) {
        $a = @('-m', 'pip', 'install', '--no-input', '--disable-pip-version-check',
               '--timeout', '120', '--retries', '3', '--prefer-binary',
               '--index-url', $TORCH_INDEX, '--extra-index-url', $pu) + $torchPkgs
        & $VenvPy @a
        if ($LASTEXITCODE -eq 0) { $torchOk = $true; break }
        Warn '该源失败，切换下一个'
    }
}

# 策略 2：阿里云 PyTorch 镜像（平面目录，配合 --find-links）
if (-not $torchOk) {
    Info "策略2 torch 源: --find-links $TORCH_FINDLINK"
    foreach ($pu in $PYPI_MIRRORS) {
        $a = @('-m', 'pip', 'install', '--no-input', '--disable-pip-version-check',
               '--timeout', '120', '--retries', '3', '--prefer-binary',
               '--index-url', $pu, '--find-links', $TORCH_FINDLINK) + $torchPkgs
        & $VenvPy @a
        if ($LASTEXITCODE -eq 0) { $torchOk = $true; break }
        Warn '该源失败，切换下一个'
    }
}

# 策略 3：官方源兜底（不带 +cu128 后缀，让源自己选）
if (-not $torchOk) {
    Info "策略3 torch 源: $TORCH_OFFICIAL（官方源，国内偏慢）"
    $a = @('-m', 'pip', 'install', '--no-input', '--disable-pip-version-check',
           '--timeout', '180', '--retries', '3',
           '--index-url', $TORCH_OFFICIAL) + $torchPkgs
    & $VenvPy @a
    if ($LASTEXITCODE -eq 0) { $torchOk = $true }
}

if (-not $torchOk) {
    Err 'PyTorch 安装失败'
    Info '手动排查命令：'
    Info "  `"$VenvPy`" -m pip install torch==$TORCH_VER+$CU torchvision==$TV_VER+$CU --index-url $TORCH_INDEX"
    Log 'torch install failed'
    Read-Host '按回车退出'
    exit 1
}
Ok 'PyTorch 安装完成'

# ------------------------------------------------------------
# 12. 安装其余依赖（项目实际运行需要的最小集合）
# ------------------------------------------------------------
Step '安装 SAM3 / SAM 2.1 运行依赖（最小集合）'

$deps = @(
    "triton-windows==$TRITON_VER",   # sam3 的 edt_triton 在 Windows 上是硬依赖
    'decord==0.6.0',                 # sam3/train/data/sam3_image_dataset.py 顶层 import，缺了整个 sam3 都导不进来
    'numpy>=1.26,<3',
    'scipy',
    'opencv-python',
    'pillow',
    'timm>=1.0.17',
    'einops',
    'ftfy==6.1.1',
    'regex',
    'iopath>=0.1.10',
    'typing_extensions',
    'huggingface_hub',
    'tqdm',
    'psutil',
    'pycocotools',
    'requests'
)
if (Invoke-Pip -PkgArgs $deps -Tag '主依赖') { Ok '主依赖安装完成' }
else { Warn '部分主依赖安装失败（见自检输出）' }

Step "安装 SAM 2.1（pip 包 sam2==$SAM2_VER）"
if (Invoke-Pip -PkgArgs @("sam2==$SAM2_VER") -Tag 'sam2') { Ok 'SAM2 安装完成' }
else { Warn 'SAM2 安装失败，「智能跟踪(SAM2.1)」将不可用' }

# ------------------------------------------------------------
# 13. 自检（失败返回非 0）
# ------------------------------------------------------------
Step '自检 AI 运行环境'

$checkPy = Join-Path $CACHE_DIR 'ai_env_check.py'
$checkCode = @'
import sys, io
if sys.stdout.encoding is None or "utf" not in (sys.stdout.encoding or "").lower():
    try: sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    except Exception: pass

bad = []
try:
    import torch, torchvision
    print("torch        :", torch.__version__)
    print("torchvision  :", torchvision.__version__)
    print("cuda runtime :", torch.version.cuda)
    print("cuda avail   :", torch.cuda.is_available())
    if torch.cuda.is_available():
        print("gpu          :", torch.cuda.get_device_name(0))
        print("arch list    :", torch.cuda.get_arch_list())
    else:
        bad.append("cuda-not-available")
        print("[!] CUDA 不可用（显卡驱动或 torch 版本不匹配）")
except Exception as e:
    bad.append("torch")
    print("[!] torch 导入异常:", repr(e))

for m in ["numpy", "cv2", "PIL", "scipy", "timm", "einops", "iopath", "ftfy",
          "regex", "tqdm", "psutil", "huggingface_hub", "requests", "decord"]:
    try:
        __import__(m); print("OK   ", m)
    except Exception as e:
        bad.append(m); print("FAIL ", m, type(e).__name__, e)

try:
    import triton
    print("OK    triton", triton.__version__)
except Exception as e:
    bad.append("triton"); print("FAIL  triton", e)

try:
    from sam3.model_builder import build_sam3_video_predictor
    print("OK    sam3.model_builder")
except Exception as e:
    bad.append("sam3"); print("FAIL  sam3.model_builder", repr(e))

try:
    from sam2.build_sam import build_sam2_video_predictor
    print("OK    sam2.build_sam")
except Exception as e:
    bad.append("sam2"); print("FAIL  sam2.build_sam", repr(e))

print("RESULT:", "PASS" if not bad else "FAIL", ("" if not bad else ("-> " + ",".join(bad))))
sys.exit(0 if not bad else 1)
'@
$checkCode | Set-Content -Path $checkPy -Encoding UTF8

$oldPP = $env:PYTHONPATH
$env:PYTHONPATH = "$Sam3Repo;$Sam2Root"
$env:SAM3_REPO = $Sam3Repo
$env:SAM3_CKPT = $Sam3Ckpt
$env:SAM2_ROOT = $Sam2Root
$env:SAM2_CKPT = $Sam2Ckpt
$env:KMP_DUPLICATE_LIB_OK = 'TRUE'
& $VenvPy $checkPy
$checkExit = $LASTEXITCODE
$env:PYTHONPATH = $oldPP
Remove-Item $checkPy -Force -ErrorAction SilentlyContinue
Log "selfcheck exit=$checkExit"

# ------------------------------------------------------------
# 14. 修正 server.js 里的环境路径（幂等 + 备份 + 语法校验）
# ------------------------------------------------------------
Step '修正 server.js（注入 venv 解释器绝对/相对路径）'

$nodeAvail = $null -ne (Get-Command node -ErrorAction SilentlyContinue)
if (-not $nodeAvail) { Info '未检测到 Node.js，server.js 将不做语法校验（不影响部署）' }

$rel = "path.join(ROOT, '..', '$VENV_NAME', 'Scripts', 'python.exe')"
$src = [System.IO.File]::ReadAllText($ServerJs, [System.Text.Encoding]::UTF8)
$orig = $src
$bak = "$ServerJs.bak"
$patchMsg = ''
$patchOk = $true

$defRe = "(?m)^[ \t]*const[ \t]+VENV_PYTHON[ \t]*=[ \t]*[^\r\n]+;"
$newDef = "const VENV_PYTHON = $rel;"

if ($src -match $defRe) {
    $src = [regex]::Replace($src, $defRe, $newDef)
    $patchMsg = '已把 VENV_PYTHON 指向项目内 venv'
} else {
    $anchor = 'function resolvePython()'
    if ($src.Contains($anchor)) {
        $src = $src.Replace($anchor, "// [AI 部署脚本] 项目内虚拟环境（由 deploy_ai_env_v2.ps1 创建）`r`n$newDef`r`n`r`n$anchor")
        $patchMsg = '已注入 VENV_PYTHON 定义'
    } else {
        $patchOk = $false
        $patchMsg = '未找到 resolvePython()，未自动修改'
    }
}

if ($patchOk -and ($src -notmatch [regex]::Escape('candidates.push(VENV_PYTHON);'))) {
    # 优先插在 PYTHON 环境变量那一行之后，保持 server.js 原有的「环境变量优先」语义
    $envPushRe = '(?m)^([ \t]*)if\s*\(\s*process\.env\.PYTHON\s*\)\s*candidates\.push\(process\.env\.PYTHON\);[ \t]*'
    $arrRe = '(?m)^([ \t]*)const[ \t]+candidates[ \t]*=[ \t]*\[\][ \t]*;'
    if ($src -match $envPushRe) {
        $src = [regex]::Replace($src, $envPushRe, [System.Text.RegularExpressions.MatchEvaluator]{
            param($m) $m.Value + "`r`n" + $m.Groups[1].Value + 'candidates.push(VENV_PYTHON);'
        })
        $patchMsg += ' + 已补 candidates.push(VENV_PYTHON)（排在 PYTHON 环境变量之后）'
    } elseif ($src -match $arrRe) {
        $src = [regex]::Replace($src, $arrRe, [System.Text.RegularExpressions.MatchEvaluator]{
            param($m) $m.Value + "`r`n" + $m.Groups[1].Value + 'candidates.push(VENV_PYTHON);'
        })
        $patchMsg += ' + 已补 candidates.push(VENV_PYTHON)（candidates 首位）'
    } else {
        $patchMsg += '（未找到 candidates 数组，请手动加入 candidates.push(VENV_PYTHON);）'
    }
}

if (-not $patchOk) {
    Warn $patchMsg
} elseif ($src -eq $orig) {
    Ok "server.js 已是目标状态，无需修改：$patchMsg"
} else {
    if (-not (Test-Path $bak)) { Copy-Item $ServerJs $bak -Force; Info "已备份：$bak" }
    [System.IO.File]::WriteAllText($ServerJs, $src, (New-Object System.Text.UTF8Encoding($false)))
    if ($nodeAvail) {
        & node --check $ServerJs 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Copy-Item $bak $ServerJs -Force
            Err 'server.js 语法校验失败，已回滚为备份'
            $patchOk = $false
        } else {
            Ok "$patchMsg，语法校验通过"
        }
    } else {
        Ok "$patchMsg（跳过语法校验）"
    }
}

# ------------------------------------------------------------
# 15. 写清单（给卸载脚本用）+ 汇总
# ------------------------------------------------------------
$manifest = [ordered]@{
    version      = 2
    created      = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
    projectDir   = $ProjectDir
    labDir       = $LabDir
    dataRoot     = $DATA_ROOT
    venv         = $VenvDir
    pythonTarget = $pyInstalled
    pythonBase   = $basePy
    caches       = @($PIP_CACHE, $TRITON_CACHE, $CACHE_DIR)
    serverJsBak  = $bak
    log          = $LOG
    gpu          = "$gpuName (sm_$gpuCap, $gpuMem)"
    versions     = @{ torch = "$TORCH_VER+$CU"; torchvision = "$TV_VER+$CU"; triton = $TRITON_VER; sam2 = $SAM2_VER }
}
$manifestPath = Join-Path $ProjectDir 'ai_env_manifest.json'
try {
    ($manifest | ConvertTo-Json -Depth 5) | Set-Content -Path $manifestPath -Encoding UTF8
    Info "部署清单：$manifestPath"
} catch { Warn "写清单失败：$($_.Exception.Message)" }

Say ''
Say '============================================================'
if ($checkExit -eq 0) {
    Say '   部署完成，AI 环境自检通过'
} else {
    Say '   部署结束，但自检有失败项（见上方 FAIL 行）'
}
Say '============================================================'
Info "显卡     : $gpuName"
Info "环境位置 : $VenvDir"
Info "解释器   : $VenvPy"
Info "日志     : $LOG"
Say ''
Say '后续步骤：'
Say '  1. 安装 Node.js（如果还没装）：https://nodejs.org'
Say '  2. 双击项目里的「一键部署.bat」装前端依赖（走 npmmirror）'
Say '  3. 双击「一键启动.bat」，浏览器打开 http://127.0.0.1:3000'
Say '  4. 验证 AI 可用：浏览器访问 http://127.0.0.1:3000/api/auto/capability'
Say '     看到 "available":true 即成功'
Say ''
if ($missWeight.Count -gt 0) {
    Warn '模型权重缺失，补齐后才能用 AI 功能：'
    foreach ($w in $missWeight) { Info $w }
    Say ''
}
if (-not $patchOk) {
    Warn 'server.js 未自动修改成功，请按提示手动处理（环境本身可用）'
    Say ''
}

Log "done, selfcheck=$checkExit"
if ($checkExit -eq 0) { exit 0 } else { exit 2 }
