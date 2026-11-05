@echo off
chcp 936 >nul 2>nul
title 崇文兰庭缴费通 - 后端服务
cd /d "%~dp0.."

echo ================================================
echo   崇文兰庭便民缴费通 · 一键启动
echo ================================================

where node >nul 2>nul
if errorlevel 1 goto NO_NODE

if not exist node_modules goto INSTALL
goto START

:NO_NODE
echo [报错] 电脑上没装 Node.js。
echo 请先去 https://nodejs.org 下载安装长期支持版 LTS，装完再双击本文件。
pause
exit /b

:INSTALL
echo 第一次启动：正在安装依赖，只需这一次，约 1 分钟...
call npm install --registry=https://registry.npmmirror.com
if errorlevel 1 goto INSTALL_FAIL

:START
echo.
echo 正在启动服务，关掉本窗口就是停止服务...
echo 物业后台: http://127.0.0.1:3000/admin   账号 admin  密码 admin123
echo 健康检查: http://127.0.0.1:3000/api/health
echo.
rem 切到 UTF-8，让下面 Node 程序里的中文日志正常显示
chcp 65001 >nul 2>nul
node app.js
rem 服务停了，切回中文编码，再提示按键退出
chcp 936 >nul 2>nul
pause
exit /b

:INSTALL_FAIL
echo [报错] 依赖安装失败，请检查网络后重试。
pause
exit /b
