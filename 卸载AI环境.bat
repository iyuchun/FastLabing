@echo off
rem ============================================================
rem   AI 环境一键卸载 - 启动器
rem   作用：调用 uninstall_ai_env.ps1
rem   用法：双击本文件即可（会先列出要删的东西并让你确认）
rem ============================================================
chcp 65001 >nul
setlocal
cd /d "%~dp0"

title AI 环境一键卸载

echo ============================================
echo    AI 环境一键卸载（SAM 3 / SAM 2.1）
echo ============================================
echo.

where powershell >nul 2>nul
if errorlevel 1 (
    echo [错误] 未找到 PowerShell，无法运行卸载脚本
    pause
    exit /b 1
)

if not exist "%~dp0uninstall_ai_env.ps1" (
    echo [错误] 未找到 uninstall_ai_env.ps1
    echo 请确认脚本和本文件放在同一个目录（通常是「数据集demo」）下
    pause
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall_ai_env.ps1"

echo.
echo 卸载脚本已结束。
pause
