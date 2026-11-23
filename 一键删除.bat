@echo off
rem ============================================================
rem   FastLabing 一键删除（清理依赖/缓存，默认保留数据与模型）
rem   调用 scripts\uninstall.ps1
rem ============================================================
chcp 65001 >nul
setlocal
cd /d "%~dp0"

title FastLabing 删除依赖

where powershell >nul 2>nul
if errorlevel 1 (
    echo [错误] 未找到 PowerShell，请确认系统为 Windows 10/11
    pause
    exit /b 1
)

if not exist "%~dp0scripts\uninstall.ps1" (
    echo [错误] 未找到 scripts\uninstall.ps1
    pause
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\uninstall.ps1" %*

echo.
pause
