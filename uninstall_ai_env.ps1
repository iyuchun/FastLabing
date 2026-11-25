#Requires -Version 5.1
# ============================================================
#  SAM 3 / SAM 2.1  AI 环境一键卸载
#  配套 deploy_ai_env_v2.ps1 使用
#
#  用法：
#    双击「一键卸载AI环境.bat」          交互式确认
#    powershell -File uninstall_ai_env.ps1 -Yes        静默卸载
#    powershell -File uninstall_ai_env.ps1 -Yes -KeepPython   保留 Python
#
#  会清理（源程序、模型权重一律不动）：
#    1. 项目内虚拟环境   <sam3_lab>\.venv-sam3
#    2. 部署缓存         <D盘>\pip-cache、\triton-cache、\ai-deploy-cache
#    3. 本脚本装过的 Python（只在清单里有记录时删，自己装的 Python 不动）
#    4. server.js.bak 还原回 server.js，并删除 .bak
#    5. 部署日志、部署清单
# ============================================================

param(
    [switch]$Yes,
    [switch]$KeepPython
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$VENV_NAME = '.venv-sam3'

function Say  ($m) { Write-Host $m }
function Ok   ($m) { Write-Host "[OK]   $m" -ForegroundColor Green }
function Warn ($m) { Write-Host "[警告] $m" -ForegroundColor Yellow }
function Err  ($m) { Write-Host "[错误] $m" -ForegroundColor Red }
function Info ($m) { Write-Host "       $m" -ForegroundColor Gray }

$ScriptDir = $PSScriptRoot
if (-not $ScriptDir) { $ScriptDir = (Get-Location).Path }

Say ''
Say '============================================================'
Say '   AI 环境一键卸载（SAM 3 / SAM 2.1）'
Say '============================================================'

# ------------------------------------------------------------
# 1. 定位项目目录
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

function Get-DataRoot {
    foreach ($d in @('D:\', 'E:\', 'F:\')) {
        if (Test-Path $d) { return ($d.TrimEnd('\')) }
    }
    return $env:USERPROFILE
}

# ------------------------------------------------------------
# 2. 读取部署清单（没有就从路径推算）
# ------------------------------------------------------------
$manifestPath = $null
$manifest = $null
if ($ProjectDir) {
    $mp = Join-Path $ProjectDir 'ai_env_manifest.json'
    if (Test-Path $mp) {
        try { $manifest = Get-Content $mp -Raw -Encoding UTF8 | ConvertFrom-Json; $manifestPath = $mp } catch {}
    }
}

if ($manifest) {
    Info "已读取部署清单：$manifestPath"
    $LabDir      = $manifest.labDir
    $VenvDir     = $manifest.venv
    $DATA_ROOT   = $manifest.dataRoot
    $pyTarget    = $manifest.pythonTarget
    $ServerJsBak = $manifest.serverJsBak
    $LogPath     = $manifest.log
    $cacheList   = @($manifest.caches)
    $ProjectDir  = $manifest.projectDir
} else {
    if (-not $ProjectDir) {
        Err '未找到 server\server.js，无法定位项目目录'
        Info '请把本脚本放到「数据集demo」目录里再运行'
        Read-Host '按回车退出'
        exit 1
    }
    Warn '未找到部署清单 ai_env_manifest.json，按默认路径推算'
    $LabDir      = Split-Path -Parent $ProjectDir
    $VenvDir     = Join-Path $LabDir $VENV_NAME
    $DATA_ROOT   = Get-DataRoot
    $pyTarget    = $null          # 没有清单就不敢删 Python
    $ServerJsBak = Join-Path $ProjectDir 'server\server.js.bak'
    $LogPath     = Join-Path $ProjectDir 'deploy_ai_env.log'
    $cacheList   = @(
        (Join-Path $DATA_ROOT 'pip-cache'),
        (Join-Path $DATA_ROOT 'triton-cache'),
        (Join-Path $DATA_ROOT 'ai-deploy-cache')
    )
}

# ------------------------------------------------------------
# 3. 汇总待删项
# ------------------------------------------------------------
function Get-DirSizeGB([string]$p) {
    if (-not (Test-Path $p)) { return -1 }
    try {
        $sum = (Get-ChildItem $p -Recurse -Force -File -ErrorAction SilentlyContinue |
                Measure-Object -Property Length -Sum).Sum
        if (-not $sum) { return 0 }
        return [math]::Round($sum / 1GB, 2)
    } catch { return -1 }
}

$targets = @()
function Add-Target([string]$path, [string]$label, [string]$kind) {
    if ($path -and (Test-Path $path)) {
        $script:targets += [pscustomobject]@{ Path = $path; Label = $label; Kind = $kind; SizeGB = (Get-DirSizeGB $path) }
    }
}

Add-Target $VenvDir   '虚拟环境（AI 依赖）' 'venv'
foreach ($c in ($cacheList | Select-Object -Unique)) { Add-Target $c '部署缓存' 'cache' }
if ($pyTarget -and -not $KeepPython) { Add-Target $pyTarget 'Python（本脚本安装的）' 'python' }
elseif ($pyTarget -and $KeepPython) { Warn "按 -KeepPython 保留：$pyTarget" }

Say ''
Say '将删除以下内容（源程序、模型权重 sam3.pt / sam2.1_hiera_tiny.pt 不动）：'
if ($targets.Count -eq 0) {
    Info '（没有找到可删除的目录）'
} else {
    $i = 1
    foreach ($t in $targets) {
        $sz = if ($t.SizeGB -ge 0) { "{0:N2} GB" -f $t.SizeGB } else { '未知' }
        Say ("  {0}. [{1}] {2}   ({3})" -f $i, $sz, $t.Path, $t.Label)
        $i++
    }
}
if (Test-Path $ServerJsBak) {
    Say "  - 还原 server.js（用备份 $ServerJsBak 覆盖），再删除备份"
}
if (Test-Path $manifestPath) { Say "  - 删除部署清单 $manifestPath" }
if (Test-Path $LogPath)      { Say "  - 删除部署日志 $LogPath" }
Say ''
Info '保留不动：sam3 源码、sam2 权重、数据集demo 源码、node_modules、storage'

# ------------------------------------------------------------
# 4. 确认
# ------------------------------------------------------------
if (-not $Yes) {
    Say ''
    Say '请先关闭「一键启动.bat」的服务窗口和浏览器里的标注页面（否则文件被占用删不掉）。'
    $ans = Read-Host '确认卸载？输入 Y 回车确认，直接回车取消'
    if ($ans.Trim().ToUpper() -ne 'Y') {
        Say '已取消，未做任何改动。'
        Read-Host '按回车退出'
        exit 0
    }
}

# ------------------------------------------------------------
# 5. 结束占用 venv 的 python 子进程
# ------------------------------------------------------------
Say ''
Say '正在检查占用中的进程 ...'
try {
    $procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.ExecutablePath -and $_.ExecutablePath.ToLower().StartsWith($VenvDir.ToLower())
    }
    if ($procs) {
        foreach ($p in $procs) {
            Warn "结束进程 PID=$($p.ProcessId)  $($p.Name)"
            Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Seconds 2
    } else {
        Info '没有发现占用 venv 的进程'
    }
} catch { Warn "进程检查失败：$($_.Exception.Message)" }

# ------------------------------------------------------------
# 6. 执行删除
# ------------------------------------------------------------
$failed = @()
foreach ($t in $targets) {
    Say "正在删除：$($t.Path)"
    try {
        Remove-Item $t.Path -Recurse -Force -ErrorAction Stop
        Ok '已删除'
    } catch {
        # 再试一次（目录句柄释放慢）
        Start-Sleep -Seconds 2
        try { Remove-Item $t.Path -Recurse -Force -ErrorAction Stop; Ok '已删除（重试成功）' }
        catch { Err "删除失败：$($_.Exception.Message)"; $failed += $t.Path }
    }
}

# 还原 server.js
$serverJs = Join-Path $ProjectDir 'server\server.js'
if (Test-Path $ServerJsBak) {
    Say "正在还原 server.js ..."
    try {
        Copy-Item $ServerJsBak $serverJs -Force -ErrorAction Stop
        Remove-Item $ServerJsBak -Force -ErrorAction SilentlyContinue
        Ok 'server.js 已还原为部署前的版本'
    } catch {
        Err "还原失败：$($_.Exception.Message)（备份仍在 $ServerJsBak）"
        $failed += $ServerJsBak
    }
}

foreach ($f in @($manifestPath, $LogPath)) {
    if ($f -and (Test-Path $f)) {
        try { Remove-Item $f -Force -ErrorAction Stop; Ok "已删除 $f" }
        catch { Err "删除失败 $f ：$($_.Exception.Message)"; $failed += $f }
    }
}

# ------------------------------------------------------------
# 7. 汇总
# ------------------------------------------------------------
Say ''
Say '============================================================'
if ($failed.Count -eq 0) {
    Say '   卸载完成'
} else {
    Say '   卸载完成，但有项目删除失败'
}
Say '============================================================'
if ($failed.Count -gt 0) {
    Say ''
    Warn '以下内容未删掉，请关闭占用的程序后手动删除：'
    foreach ($f in $failed) { Info $f }
}
Say ''
Info 'Web 功能不受影响：node_modules 和 storage 都保留了，双击「一键启动.bat」仍可标注。'
Info '如果 AI 相关按钮报错，重启一次服务即可（server.js 已还原）。'
Say ''
Read-Host '按回车退出'
exit 0
