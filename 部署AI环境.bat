@echo off
rem ============================================================
rem   AI 环境一键部署 - 启动器（v2 修正版）
rem   作用：以正确的编码和权限调用 deploy_ai_env_v2.ps1
rem   用法：双击本文件即可
rem ============================================================
chcp 65001 >nul
setlocal
cd /d "%~dp0"

title AI 环境一键部署 v2

echo ============================================
echo    AI 环境一键部署（SAM 3 / SAM 2.1）v2
echo ============================================
echo.

where powershell >nul 2>nul
if errorlevel 1 (
    echo [错误] 未找到 PowerShell，无法运行部署脚本
    echo 请确认系统为 Windows 10/11
    pause
    exit /b 1
)

if not exist "%~dp0deploy_ai_env_v2.ps1" (
    echo [错误] 未找到 deploy_ai_env_v2.ps1
    echo 请确认脚本和本文件放在同一个目录（通常是「数据集demo」）下
    pause
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy_ai_env_v2.ps1"
set RC=%ERRORLEVEL%

echo.
if "%RC%"=="0" (
    echo [完成] 部署成功，AI 环境可用。
) else (
    echo [结束] 退出码 %RC%：0=成功，2=自检有失败项，1=中途出错。
)

pause
