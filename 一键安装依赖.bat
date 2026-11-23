@echo off
rem ============================================================
rem   FastLabing 一键安装依赖
rem   调用 scripts\install.ps1
rem ============================================================
chcp 65001 >nul
setlocal
cd /d "%~dp0"

title FastLabing 安装依赖

echo ============================================
echo    FastLabing 视频标注台 - 安装依赖
echo ============================================
echo.
echo   将依次完成：Node 依赖 → Python 环境 → PyTorch CUDA
echo                → SAM/图像依赖 → 模型权重下载
echo.

where powershell >nul 2>nul
if errorlevel 1 (
    echo [错误] 未找到 PowerShell，请确认系统为 Windows 10/11
    pause
    exit /b 1
)

if not exist "%~dp0scripts\install.ps1" (
    echo [错误] 未找到 scripts\install.ps1
    echo 请确认解压完整后重试
    pause
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1" %*
set RC=%ERRORLEVEL%

echo.
if "%RC%"=="0" (
    echo [完成] 安装成功。
) else if "%RC%"=="2" (
    echo [注意] 安装结束，但自检有失败项，请把上面的 FAIL 行发给技术支持。
) else (
    echo [结束] 退出码 %RC%，请看上面的错误提示。
)

pause
