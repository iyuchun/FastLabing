#Requires -Version 5.1
<#
.SYNOPSIS
  FastLabing 一键安装依赖（Windows / PowerShell 5.1+）

.DESCRIPTION
  按顺序完成：
    1. 检测 NVIDIA 显卡与算力，不可用时跳过 AI 部分（Web 标注仍可用）
    2. npm install（npmmirror 国内镜像）
    3. 找 Python 3.10~3.12，没有就静默装 3.10.11；在程序目录建 .venv
    4. 装 PyTorch CUDA 12.8（上海交大 → 阿里云 → 官方源 三级降级）
    5. 装 python/requirements.txt 里剩下的依赖（清华 → 阿里 → 中科大 → 腾讯 → 华为）
    6. 下载模型权重（ModelScope 国内镜像，支持断点续传）
         - SAM 2.1 tiny  156,008,466 B
         - SAM 3        3,450,062,241 B
       models\ 里已有且大小正确则跳过
    7. 自检：torch CUDA / sam3 / sam2 / 依赖逐项验证，失败返回退出码 2

.PARAMETER Python
  指定基础解释器（python.exe 完整路径），不指定则自动查找

.PARAMETER Sam3From
  本地已有 sam3.pt 的路径，直接复制进 models\，不走网络

.PARAMETER HfToken
  HuggingFace token（仅当 ModelScope 也拿不到 SAM 3 权重时作为兜底通道）

.PARAMETER SkipNode / SkipPython / SkipModels / SkipSam3
  跳过对应阶段

.PARAMETER Yes
  全程不再询问（CI / 批量部署用）

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Sam3From "D:\weights\sam3.pt" -Yes
#>
param(
    [string]$Python = "",
    [string]$Sam3From = "",
    [string]$HfToken = "",
    [switch]$SkipNode,
    [switch]$SkipPython,
    [switch]$SkipModels,
    [switch]$SkipSam3,
    [switch]$Yes,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $root 'package.json'))) {
    # 脚本被单独拷走时，按当前目录兜底
    $root = (Get-Location).Path
}
Set-Location $root

$LOG = Join-Path $root 'install.log'

# ---------------- 输出 ----------------
function Info  ($m) { Write-Host "[FastLabing] $m" -ForegroundColor Cyan }
function Step  ($m) { Write-Host "`n[步骤] $m" -ForegroundColor Cyan }
function Ok    ($m) { Write-Host "  OK  $m" -ForegroundColor Green }
function Warn  ($m) { Write-Host "  !   $m" -ForegroundColor Yellow }
function Err   ($m) { Write-Host "  X   $m" -ForegroundColor Red }
function Note  ($m) { Write-Host "      $m" -ForegroundColor DarkGray }
function Log   ($m) {
    try { Add-Content -Path $LOG -Value ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) -Encoding UTF8 } catch {}
}

# ---------------- 版本定档（本机 RTX 5060 实测跑通的组合） ----------------
$TORCH_VER   = '2.11.0'
$TV_VER      = '0.26.0'
$CU          = 'cu128'
$TRITON_VER  = '3.6.0.post26'
$SAM2_VER    = '1.1.0'
$PY_FALLBACK = '3.10.11'
$MIN_SM      = 7.5
$NEED_FREE_GB = 18

# ---------------- 权重定档（字节数取自官方，逐字节校验） ----------------
$SAM2_FILE = 'sam2.1_hiera_tiny.pt'
$SAM3_FILE = 'sam3.pt'
$SAM2_SIZE = 156008466
$SAM3_SIZE = 3450062241

# ---------------- 镜像源（2026-11 逐一实测） ----------------
$PYPI_MIRRORS = @(
    'https://pypi.tuna.tsinghua.edu.cn/simple',
    'https://mirrors.aliyun.com/pypi/simple/',
    'https://mirrors.ustc.edu.cn/pypi/simple/',
    'https://mirrors.cloud.tencent.com/pypi/simple/',
    'https://repo.huaweicloud.com/repository/pypi/simple/'
)
# PyTorch CUDA 轮子：上交大是标准 PEP503 索引（实测 pip 可解析 2.11.0+cu128）
$TORCH_INDEX    = 'https://mirror.sjtu.edu.cn/pytorch-wheels/cu128'
# 阿里云 pytorch-wheels 是平面目录，只能配 --find-links
$TORCH_FINDLINK = 'https://mirrors.aliyun.com/pytorch-wheels/cu128'
$TORCH_OFFICIAL = 'https://download.pytorch.org/whl/cu128'

# 权重镜像（ModelScope 实测 206 + 断点续传，约 3MB/s）
$SAM2_URLS = @(
    "https://modelscope.cn/models/facebook/sam2.1-hiera-tiny/resolve/master/$SAM2_FILE",
    "https://hf-mirror.com/facebook/sam2.1-hiera-tiny/resolve/main/$SAM2_FILE",
    "https://dl.fbaipublicfiles.com/segment_anything_2/092824/$SAM2_FILE"
)
$SAM3_URLS = @(
    "https://modelscope.cn/models/facebook/sam3/resolve/master/$SAM3_FILE",
    "https://hf-mirror.com/facebook/sam3/resolve/main/$SAM3_FILE",
    "https://huggingface.co/facebook/sam3/resolve/main/$SAM3_FILE"
)

$PY_DL_MIRRORS = @(
    'https://mirrors.huaweicloud.com/python/{0}/python-{0}-amd64.exe',
    'https://mirrors.aliyun.com/python-release/windows/python-{0}-amd64.exe',
    'https://registry.npmmirror.com/-/binary/python/{0}/python-{0}-amd64.exe'
)

$NPM_REGISTRY = 'https://registry.npmmirror.com'

Info "程序目录：$root"
Log "=== install start ==="

# ---------------- 0. 前置检查 ----------------
Step '环境检查'
Write-Host '============================================================' -ForegroundColor DarkGray
Write-Host '   FastLabing 视频标注台  ·  一键安装依赖' -ForegroundColor White
Write-Host '============================================================' -ForegroundColor DarkGray

# 磁盘空间
function Get-FreeGB([string]$path) {
    try {
        $drive = (Split-Path -Qualifier $path).TrimEnd(':')
        $di = New-Object System.IO.DriveInfo("$drive`:\")
        if ($di.IsReady) { return [math]::Round($di.AvailableFreeSpace / 1GB, 1) }
    } catch {}
    return -1
}
$freeGb = Get-FreeGB $root
if ($freeGb -ge 0) {
    Info "磁盘剩余：$freeGb GB（本次约需 $NEED_FREE_GB GB）"
    if ($freeGb -lt $NEED_FREE_GB) {
        Err "空间不足：需要约 $NEED_FREE_GB GB（PyTorch 2.5GB + 权重 3.6GB + 依赖）"
        Read-Host '按回车退出'
        exit 1
    }
} else {
    Warn '未能读取磁盘剩余空间，跳过检查'
}

# 显卡
$gpuName = $null; $gpuCap = $null; $gpuMem = $null; $sm = 0.0; $gpuOk = $false
try {
    if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
        $raw = & nvidia-smi --query-gpu=name,compute_cap,memory.total --format=csv,noheader 2>$null
        if ($raw) {
            $line = ("$raw".Split("`n")[0]).Trim()
            $parts = $line -split ','
            if ($parts.Count -ge 3) {
                $gpuName = $parts[0].Trim(); $gpuCap = $parts[1].Trim(); $gpuMem = $parts[2].Trim()
            }
        }
    }
} catch { Log "nvidia-smi: $_" }

if ($gpuName) {
    try { $sm = [double]($gpuCap -split '\s')[0] } catch { $sm = 0.0 }
    if ($sm -ge $MIN_SM) {
        $gpuOk = $true
        Ok "显卡：$gpuName  (sm_$gpuCap, $gpuMem)"
        if     ($sm -ge 12.0) { Note '50 系 Blackwell → torch cu128（sm_120）' }
        elseif ($sm -ge 8.9)  { Note '40 系 Ada → torch cu128（sm_89）' }
        elseif ($sm -ge 8.6)  { Note '30 系 Ampere → torch cu128（sm_86）' }
        elseif ($sm -ge 8.0)  { Note 'A100 级专业卡 → torch cu128（sm_80）' }
        else                  { Note '20 / 16 系 Turing → torch cu128（sm_75）' }
    } else {
        Warn "显卡 $gpuName 算力 sm_$gpuCap 低于 sm_7.5，cu128 没有对应内核"
    }
} else {
    Warn '未检测到 NVIDIA 显卡'
}

if (-not $gpuOk -and -not $SkipPython) {
    Write-Host ''
    Write-Host '------------------------------------------------------------' -ForegroundColor DarkGray
    Warn 'AI 推理需要 NVIDIA 显卡（sm_7.5 以上：GTX 16 系 / RTX 20-50 系）'
    Note '本次跳过 Python 环境与模型权重安装。'
    Note 'Web 功能（导入视频、分帧、手工打框、导出）完全可用，只是「AI 自动打标 / 智能跟踪」不可用。'
    Note '装好显卡驱动后重新运行本脚本即可补装。'
    Write-Host '------------------------------------------------------------' -ForegroundColor DarkGray
    if (-not $SkipNode) {
        Step '仍然安装 Web 端依赖（npm）'
    } else { exit 0 }
}

# ---------------- 1. Node 依赖 ----------------
if (-not $SkipNode) {
    Step '安装 Node 依赖'
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Err '未找到 Node.js。请先安装 Node.js 18 或更高：https://nodejs.org/zh-cn/download'
        Note '装好后重新运行本脚本。'
        Read-Host '按回车退出'
        exit 1
    }
    $nodeVer = (& node --version).Trim()
    Ok "Node $nodeVer"
    Info "npm install（$NPM_REGISTRY）"
    & npm install --omit=dev --no-audit --no-fund --registry=$NPM_REGISTRY
    if ($LASTEXITCODE -ne 0) {
        Err 'npm install 失败，请检查网络后重试'
        Read-Host '按回车退出'
        exit 1
    }
    Ok 'Node 依赖完成'
    Log 'npm ok'
}

if (-not $gpuOk) {
    Step '完成'
    Ok 'Web 依赖已就绪。双击「一键启动.bat」即可使用手工标注功能。'
    exit 0
}

# ---------------- 2. Python 环境 ----------------
$venvDir = Join-Path $root '.venv'
$venvPy  = Join-Path $venvDir 'Scripts\python.exe'
$reuse   = $false

if (-not $SkipPython) {
    Step '准备 Python 环境'

    # 2.1 可选：python-path.txt 指向一台已装好依赖的解释器（本机用，分发前请删）
    if (-not $Python) {
        $cfg = Join-Path $root 'python-path.txt'
        if (Test-Path $cfg) {
            $v = ([System.IO.File]::ReadAllText($cfg)).Trim()
            if ($v -and (Test-Path $v)) { $Python = $v; Note "读取 python-path.txt：$v" }
            elseif ($v) { Warn "python-path.txt 指向的路径不存在，忽略：$v" }
        }
    }

    if ($Python -and (Test-Path $Python)) {
        $env:PYTHONPATH = Join-Path $root 'third_party\sam3'
        & $Python -c "import torch, sam2, sam3" 2>$null
        if ($LASTEXITCODE -eq 0) {
            $venvPy = $Python
            $reuse = $true
            Ok "复用已有 Python 环境：$Python"
        } else {
            Warn '该环境缺少 torch / sam2 / sam3，改为创建独立 .venv'
            $Python = ''
        }
    }

    # 2.2 找基础解释器
    function Get-PyVer([string]$exe) {
        try {
            $out = & $exe -c "import sys;print('%d.%d'%sys.version_info[:2])" 2>$null
            if ($LASTEXITCODE -eq 0 -and $out) { return ("$out").Trim() }
        } catch {}
        return $null
    }
    $GOOD_VER = @('3.10', '3.11', '3.12')

    $basePy = $null
    if (-not $reuse) {
        $cands = @()
        if ($Python) { $cands += $Python }
        $pyLauncher = Get-Command py -ErrorAction SilentlyContinue
        if ($pyLauncher) {
            foreach ($tag in @('-3.10', '-3.11', '-3.12')) {
                try {
                    $p = & py $tag -c "import sys;print(sys.executable)" 2>$null
                    if ($LASTEXITCODE -eq 0 -and $p) {
                        $pp = ("$p").Trim()
                        if (Test-Path $pp) { $cands += $pp }
                    }
                } catch {}
            }
        }
        $roots = @(
            "$env:LOCALAPPDATA\Programs\Python",
            "$env:ProgramFiles\Python310", "$env:ProgramFiles\Python311", "$env:ProgramFiles\Python312",
            "${env:ProgramFiles(x86)}\Python310",
            'C:\Python310', 'C:\Python311', 'C:\Python312',
            'D:\Python310', 'D:\Python311', 'D:\Python312'
        )
        foreach ($r in $roots) {
            if (-not (Test-Path $r)) { continue }
            $exe = Join-Path $r 'python.exe'
            if (Test-Path $exe) { $cands += $exe }
            else {
                Get-ChildItem $r -Directory -ErrorAction SilentlyContinue | ForEach-Object {
                    $e2 = Join-Path $_.FullName 'python.exe'
                    if (Test-Path $e2) { $cands += $e2 }
                }
            }
        }
        try {
            $onPath = (Get-Command python -ErrorAction SilentlyContinue).Source
            if ($onPath -and $onPath -notlike '*WindowsApps*') { $cands += $onPath }
        } catch {}

        foreach ($ver in $GOOD_VER) {
            foreach ($c in ($cands | Select-Object -Unique)) {
                if ((Test-Path $c) -and (Get-PyVer $c) -eq $ver) { $basePy = $c; break }
            }
            if ($basePy) { break }
        }
        if ($basePy) { Ok "使用 Python $(Get-PyVer $basePy)：$basePy" }
        else { Warn '未找到 Python 3.10 / 3.11 / 3.12' }
    }

    # 2.3 没有就静默装 3.10.11（国内镜像）
    if (-not $reuse -and -not $basePy) {
        Step "下载并安装 Python $PY_FALLBACK（国内镜像，约 25MB）"
        $cacheDir = Join-Path $env:TEMP 'fastlabing-install'
        if (-not (Test-Path $cacheDir)) { New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null }
        $dl = Join-Path $cacheDir "python-$PY_FALLBACK-amd64.exe"
        $got = $false
        foreach ($tpl in $PY_DL_MIRRORS) {
            $url = $tpl -replace '\{0\}', $PY_FALLBACK
            Info "尝试 $url"
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
            Err 'Python 安装包下载失败，请检查网络'
            Note "手动下载：https://mirrors.huaweicloud.com/python/$PY_FALLBACK/"
            Read-Host '按回车退出'
            exit 1
        }
        $pyTarget = Join-Path (Split-Path -Qualifier $root) 'Fastlabing-python'
        Info "静默安装到 $pyTarget"
        $instArgs = @('/quiet','InstallAllUsers=0','PrependPath=0','Include_pip=1',
                      'Include_launcher=1','InstallLauncherAllUsers=0',
                      'Include_test=0','Include_doc=0','Include_tcltk=0',"TargetDir=$pyTarget")
        $proc = Start-Process -FilePath $dl -ArgumentList $instArgs -Wait -PassThru
        Log "python installer exit=$($proc.ExitCode)"
        $cand = Join-Path $pyTarget 'python.exe'
        if (Test-Path $cand) { $basePy = $cand; Ok "已安装：$cand" }
        else {
            Err 'Python 安装后未找到 python.exe'
            Note "请手动安装 Python 3.10 后重试，或把现有 python.exe 路径写入 python-path.txt"
            Read-Host '按回车退出'
            exit 1
        }
    }

    # 2.4 建 venv
    if (-not $reuse) {
        if ($Force -and (Test-Path $venvDir)) {
            Warn '按 -Force 重建 .venv'
            Remove-Item $venvDir -Recurse -Force -ErrorAction SilentlyContinue
        }
        if (Test-Path $venvPy) {
            & $venvPy -c "print('ok')" 2>$null | Out-Null
            if ($LASTEXITCODE -eq 0) { Ok '.venv 已存在且可用' }
            else {
                Warn '.venv 损坏，重建'
                Remove-Item $venvDir -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
        if (-not (Test-Path $venvPy)) {
            Info "创建虚拟环境 $venvDir"
            & $basePy -m venv $venvDir
            if ($LASTEXITCODE -ne 0 -or -not (Test-Path $venvPy)) {
                Err '创建虚拟环境失败'
                Read-Host '按回车退出'
                exit 1
            }
            Ok '.venv 创建完成'
        }
    }

    # pip 缓存/临时目录放到系统临时区，不污染程序目录
    $env:PIP_CACHE_DIR    = Join-Path $env:LOCALAPPDATA 'pip\Cache'
    $env:TRITON_CACHE_DIR = Join-Path $env:LOCALAPPDATA 'triton\Cache'
    $env:PYTHONIOENCODING = 'utf-8'
    $env:PYTHONUTF8       = '1'

    # ---------------- 3. PyTorch ----------------
    if (-not $reuse) {
        Step "安装 PyTorch $TORCH_VER+$CU + torchvision $TV_VER+$CU（约 2.5GB）"
        $pypiPrimary = $PYPI_MIRRORS[0]
        & $venvPy -m pip install --no-input --disable-pip-version-check --upgrade pip setuptools wheel --index-url $pypiPrimary
        if ($LASTEXITCODE -ne 0) { Warn 'pip 升级失败，继续' }

        $torchPkgs = @("torch==$TORCH_VER+$CU", "torchvision==$TV_VER+$CU")
        $torchOk = $false

        Info "源 1/3（上海交大）：$TORCH_INDEX"
        foreach ($pu in $PYPI_MIRRORS) {
            & $venvPy -m pip install --no-input --disable-pip-version-check --timeout 120 --retries 3 --prefer-binary `
                --index-url $TORCH_INDEX --extra-index-url $pu @torchPkgs
            if ($LASTEXITCODE -eq 0) { $torchOk = $true; break }
            Warn '该源失败，换下一个 PyPI 镜像'
        }

        if (-not $torchOk) {
            Info "源 2/3（阿里云 find-links）：$TORCH_FINDLINK"
            foreach ($pu in $PYPI_MIRRORS) {
                & $venvPy -m pip install --no-input --disable-pip-version-check --timeout 120 --retries 3 --prefer-binary `
                    --index-url $pu --find-links $TORCH_FINDLINK @torchPkgs
                if ($LASTEXITCODE -eq 0) { $torchOk = $true; break }
                Warn '该源失败，换下一个 PyPI 镜像'
            }
        }

        if (-not $torchOk) {
            Info "源 3/3（官方，国内偏慢）：$TORCH_OFFICIAL"
            & $venvPy -m pip install --no-input --disable-pip-version-check --timeout 180 --retries 3 `
                --index-url $TORCH_OFFICIAL @torchPkgs
            if ($LASTEXITCODE -eq 0) { $torchOk = $true }
        }

        if (-not $torchOk) {
            Err 'PyTorch 安装失败'
            Note "手动排查：`"$venvPy`" -m pip install torch==$TORCH_VER+$CU torchvision==$TV_VER+$CU --index-url $TORCH_INDEX"
            Read-Host '按回车退出'
            exit 1
        }
        Ok 'PyTorch 安装完成'
        Log 'torch ok'

        # ---------------- 4. 其余依赖 ----------------
        Step '安装 SAM / 图像依赖'
        $req = Join-Path $root 'python\requirements.txt'
        if (-not (Test-Path $req)) {
            Err "未找到 $req"
            Read-Host '按回车退出'
            exit 1
        }
        $depOk = $false
        foreach ($m in $PYPI_MIRRORS) {
            Info "源：$m"
            & $venvPy -m pip install --no-input --disable-pip-version-check --timeout 60 --retries 2 --prefer-binary `
                --index-url $m -r $req
            if ($LASTEXITCODE -eq 0) { $depOk = $true; break }
            Warn '该源失败，换下一个'
        }
        if (-not $depOk) {
            Err 'Python 依赖安装失败，请检查网络'
            Read-Host '按回车退出'
            exit 1
        }
        Ok 'Python 依赖完成'
        Log 'deps ok'
    }
}

# ---------------- 5. 自检 ----------------
$checkExit = 0
if (-not $SkipPython) {
    Step '自检运行环境'
    $checkPy = Join-Path $env:TEMP 'fastlabing_check.py'
    $checkCode = @'
import sys
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
        bad.append("cuda")
        print("[!] CUDA 不可用（检查显卡驱动 / 是否 N 卡）")
except Exception as e:
    bad.append("torch")
    print("[!] torch 导入失败:", repr(e))

for m in ["numpy","cv2","PIL","scipy","timm","einops","iopath","ftfy",
          "regex","tqdm","psutil","huggingface_hub","requests","decord"]:
    try:
        __import__(m); print("OK   ", m)
    except Exception as e:
        bad.append(m); print("FAIL ", m, e)

try:
    import triton; print("OK    triton", triton.__version__)
except Exception as e:
    bad.append("triton"); print("FAIL  triton", e)

try:
    from sam3.model_builder import build_sam3_image_model
    from sam3.model_builder import build_sam3_video_predictor
    print("OK    sam3.model_builder")
except Exception as e:
    bad.append("sam3"); print("FAIL  sam3.model_builder", repr(e))

try:
    from sam2.build_sam import build_sam2_video_predictor
    print("OK    sam2.build_sam")
except Exception as e:
    bad.append("sam2"); print("FAIL  sam2.build_sam", repr(e))

print("RESULT:", "PASS" if not bad else "FAIL", ("" if not bad else "-> " + ",".join(bad)))
sys.exit(0 if not bad else 1)
'@
    $checkCode | Set-Content -Path $checkPy -Encoding UTF8
    $oldPP = $env:PYTHONPATH
    $env:PYTHONPATH = Join-Path $root 'third_party\sam3'
    $env:SAM3_REPO  = Join-Path $root 'third_party\sam3'
    $env:KMP_DUPLICATE_LIB_OK = 'TRUE'
    & $venvPy $checkPy
    $checkExit = $LASTEXITCODE
    $env:PYTHONPATH = $oldPP
    Remove-Item $checkPy -Force -ErrorAction SilentlyContinue
    Log "selfcheck exit=$checkExit"
    if ($checkExit -eq 0) { Ok '自检通过' } else { Warn '自检有失败项（见上方 FAIL 行）' }
}

# ---------------- 6. 模型权重 ----------------
function Get-FileSize([string]$p) {
    if (-not (Test-Path $p)) { return -1 }
    return (Get-Item $p).Length
}

function Test-CkptMagic([string]$p) {
    # torch 的 .pt 是 zip 容器，头 4 字节应为 PK\x03\x04
    try {
        $fs = [System.IO.File]::OpenRead($p)
        $buf = New-Object byte[] 4
        $null = $fs.Read($buf, 0, 4)
        $fs.Close()
        return ($buf[0] -eq 0x50 -and $buf[1] -eq 0x4B -and $buf[2] -eq 0x03 -and $buf[3] -eq 0x04)
    } catch { return $false }
}

function Save-Model {
    param(
        [string]$Dest,
        [int64]$ExpectedSize,
        [string[]]$Urls,
        [string]$Label,
        [string]$Token = ""
    )
    $cur = Get-FileSize $Dest
    if ($cur -eq $ExpectedSize) {
        Ok "$Label 已存在（$([math]::Round($cur/1MB,1)) MB），跳过"
        return $true
    }
    if ($cur -gt $ExpectedSize) {
        Warn "$Label 现有文件比预期大（$cur B），删除重下"
        Remove-Item $Dest -Force -ErrorAction SilentlyContinue
        $cur = -1
    }
    if ($cur -gt 0) {
        Info "$Label 已有 $([math]::Round($cur/1MB,1)) MB 未完成，尝试断点续传"
    }

    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    if (-not $curl) {
        Err '未找到 curl.exe（Windows 10 1803 以下不含），请手动下载：'
        foreach ($u in $Urls) { Note $u }
        Note "放到：$Dest"
        return $false
    }

    foreach ($u in $Urls) {
        Info "源：$u"
        $args = @('-L', '--fail', '--retry', '3', '--retry-delay', '2',
                  '--connect-timeout', '20', '-C', '-', '-o', $Dest)
        if ($Token) { $args = @('-H', "Authorization: Bearer $Token") + $args }
        $args += $u
        & curl.exe @args
        $rc = $LASTEXITCODE
        $now = Get-FileSize $Dest
        if ($now -eq $ExpectedSize) {
            if (Test-CkptMagic $Dest) {
                Ok "$Label 下载完成（$([math]::Round($now/1MB,1)) MB，校验通过）"
                return $true
            }
            Warn '文件大小对但内容不是 torch checkpoint，重新下载'
            Remove-Item $Dest -Force -ErrorAction SilentlyContinue
            continue
        }
        if ($rc -eq 0 -and $now -gt 0) {
            Warn "大小不符（$now / $ExpectedSize），换下一个源续传"
        } elseif ($now -le 0) {
            Warn "该源失败（curl rc=$rc），换下一个"
        }
    }
    return $false
}

$modelsOk = $true
if (-not $SkipModels) {
    Step '准备模型权重'
    $modelsDir = Join-Path $root 'models'
    if (-not (Test-Path $modelsDir)) { New-Item -ItemType Directory -Force -Path $modelsDir | Out-Null }

    # --- SAM 2.1 tiny ---
    $sam2Path = Join-Path $modelsDir $SAM2_FILE
    if (-not (Save-Model -Dest $sam2Path -ExpectedSize $SAM2_SIZE -Urls $SAM2_URLS -Label 'SAM 2.1 tiny')) {
        $modelsOk = $false
        Warn 'SAM 2.1 权重未就绪 —— 「智能跟踪(SAM 2.1)」暂不可用'
        Note "可手动下载后放到：$sam2Path"
        foreach ($u in $SAM2_URLS) { Note "  $u" }
    }

    # --- SAM 3 ---
    $sam3Path = Join-Path $modelsDir $SAM3_FILE
    $sam3Cur = Get-FileSize $sam3Path
    if ($sam3Cur -eq $SAM3_SIZE) {
        Ok "SAM 3 已存在（$([math]::Round($sam3Cur/1GB,2)) GB），跳过"
    } elseif ($SkipSam3) {
        Warn '按 -SkipSam3 跳过 SAM 3 权重'
    } else {
        $doDownload = $true
        if ($Sam3From) {
            if (Test-Path $Sam3From) {
                $srcSize = Get-FileSize $Sam3From
                if ($srcSize -eq $SAM3_SIZE) {
                    Info "从本地复制 SAM 3 权重：$Sam3From"
                    Copy-Item $Sam3From $sam3Path -Force
                    if ((Get-FileSize $sam3Path) -eq $SAM3_SIZE) { Ok 'SAM 3 权重已就位（本地复制）'; $doDownload = $false }
                    else { Warn '复制后大小不符，改为下载' }
                } else {
                    Warn "指定文件大小不符（$srcSize / $SAM3_SIZE），改为下载"
                }
            } else {
                Warn "指定的 sam3.pt 不存在：$Sam3From"
            }
        }

        if ($doDownload) {
            Info ("SAM 3 权重约 {0:N2} GB，ModelScope 国内镜像约 3MB/s，预计 15~25 分钟" -f ($SAM3_SIZE / 1GB))
            if (-not $Yes) {
                $ans = Read-Host '现在下载 SAM 3 权重吗？不下载也能用 SAM 2.1（y/N，默认 y）'
                if ($ans -and $ans -notmatch '^[yY]') { $doDownload = $false; Warn '已跳过 SAM 3 权重下载' }
            }
        }

        if ($doDownload) {
            $tok = $HfToken
            if (-not $tok) { $tok = $env:HF_TOKEN }
            # 只有带 token 才把 HF 那两个源放进来（gated 仓库匿名必 403）
            $urls = @($SAM3_URLS[0])
            if ($tok) { $urls += $SAM3_URLS[1..2] }
            if (-not (Save-Model -Dest $sam3Path -ExpectedSize $SAM3_SIZE -Urls $urls -Label 'SAM 3' -Token $tok)) {
                Warn 'SAM 3 权重未就绪 —— 只有 SAM 2.1 可用（不影响其余功能）'
                Note '获取方式（任选其一）：'
                Note '  1) ModelScope 网页手动下载后放到 models\sam3.pt：'
                Note '     https://modelscope.cn/models/facebook/sam3'
                Note '  2) 本机已有文件时直接指定：'
                Note '     scripts\install.ps1 -Sam3From "D:\weights\sam3.pt"'
                Note '  3) 有 HF 访问权限（facebook/sam3 是 gated，需先申请）：'
                Note '     scripts\install.ps1 -HfToken hf_xxxxxxxx'
            }
        }
    }
}

# ---------------- 7. 尾部 ----------------
$dataRoot = Join-Path (Split-Path -Parent $root) 'Fastlabing-data'
New-Item -ItemType Directory -Force -Path $dataRoot | Out-Null

Write-Host ''
Write-Host '============================================================' -ForegroundColor DarkGray
if ($checkExit -eq 0 -and $modelsOk) {
    Write-Host '   安装完成，AI 环境自检通过' -ForegroundColor Green
} elseif ($checkExit -eq 0) {
    Write-Host '   安装完成（部分权重缺失，见上方提示）' -ForegroundColor Yellow
} else {
    Write-Host '   安装结束，但自检有失败项（见上方 FAIL 行）' -ForegroundColor Yellow
}
Write-Host '============================================================' -ForegroundColor DarkGray
Note "Python 环境：$venvPy"
Note "模型目录  ：$(Join-Path $root 'models')"
Note "数据目录  ：$dataRoot"
Note "日志      ：$LOG"
Write-Host ''
Write-Host '下一步：双击「一键启动.bat」，浏览器打开 http://127.0.0.1:3000' -ForegroundColor White
Write-Host ''
Log "=== install done, selfcheck=$checkExit, models=$modelsOk ==="

if ($checkExit -ne 0) { exit 2 }
exit 0
