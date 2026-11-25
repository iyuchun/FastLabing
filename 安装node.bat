@echo off
cd /d "%~dp0"

echo ============================================
echo    视频打框标注工具 - 一键部署
echo ============================================

where node >nul 2>nul
if errorlevel 1 (
    echo [错误] 未检测到 Node.js！
    echo 请先安装 Node.js（https://nodejs.org），然后重新运行本脚本。
    pause
    exit /b 1
)

echo [1/3] 检测到 Node.js：
call node --version
call npm --version

echo.
echo [2/3] 正在安装依赖（使用国内镜像加速，请保持联网）...
call npm install --registry=https://registry.npmmirror.com
if errorlevel 1 (
    echo [错误] 依赖安装失败，请检查网络后重试。
    pause
    exit /b 1
)

echo.
echo [3/3] 初始化运行目录...
if not exist storage mkdir storage

echo.
echo ============================================
echo    部署完成！双击「一键启动.bat」即可使用。
echo ============================================
pause