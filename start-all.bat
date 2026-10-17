@echo off
rem 【编码】本文件必须保存为 ANSI/GBK + CRLF（cmd 按代码页 936 解析批处理），
rem UTF-8 存盘会导致中文乱码、注释被误执行；编辑后需 iconv 转回 GBK。
rem qq-bridge 一键启动：SnowLuma + DeepSeek Harness 桌面端 + 桥，一个脚本全拉起。
rem SNOWLUMA_AUTOSTART：探测不到 3001 时自动拉起 SnowLuma（个人自用允许；
rem 若要把本仓库分享他人请改为 0，SnowLuma EULA 禁止自动化部署）。
cd /d "%~dp0"
setlocal
set SNOWLUMA_AUTOSTART=1
set SNOWLUMA_DIR=D:\100work\103Tools\qq-hermes-bridge\snowluma
set DSH_EXE=C:\Users\linxun\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe

rem ---- 1. SnowLuma（OneBot 3001/3000） ----
netstat -ano | findstr /C:":3001 " | findstr /C:"LISTENING" >nul 2>&1
if errorlevel 1 (
  if "%SNOWLUMA_AUTOSTART%"=="1" if exist "%SNOWLUMA_DIR%\launcher.bat" (
    echo [start-all] 拉起 SnowLuma，请在弹出窗口确认登录...
    start "SnowLuma" /d "%SNOWLUMA_DIR%" launcher.bat
  ) else (
    echo [start-all] 警告：3001 上没有 SnowLuma，且未找到 launcher.bat
  )
) else (
  echo [start-all] SnowLuma 已在线
)

rem ---- 2. DeepSeek Harness 桌面端 ----
tasklist /FI "IMAGENAME eq DeepSeek Harness.exe" 2>nul | find /I "DeepSeek Harness" >nul
if errorlevel 1 (
  if exist "%DSH_EXE%" (
    echo [start-all] 启动 DeepSeek Harness 桌面端...
    start "" "%DSH_EXE%"
  ) else (
    echo [start-all] 警告：未找到 DeepSeek Harness.exe，请手动启动 DSH
  )
) else (
  echo [start-all] DeepSeek Harness 已在运行
)

rem ---- 3. 等两者就绪（每 5 秒查一次，最多约 120 秒） ----
set /a tries=0
:waitloop
netstat -ano | findstr /C:":3001 " | findstr /C:"LISTENING" >nul 2>&1
if errorlevel 1 (set sl=0) else (set sl=1)
tasklist /FI "IMAGENAME eq DeepSeek Harness.exe" 2>nul | find /I "DeepSeek Harness" >nul
if errorlevel 1 (set dsh=0) else (set dsh=1)
if "%sl%"=="1" if "%dsh%"=="1" goto ready
set /a tries+=1
if %tries% geq 24 (
  echo [start-all] 等待超时，SnowLuma/DSH 仍未全部就绪，带病继续...
  goto syncport
)
echo [start-all] 等待就绪中 %tries%/24 ...
timeout /t 5 /nobreak >nul
goto waitloop

:ready
echo [start-all] SnowLuma 与 DeepSeek Harness 均已就绪

:syncport
rem ---- 4. 同步 DSH 当前端口到 config.json（桌面端重启后端口可能变化） ----
node sync-dsh-port.mjs
endlocal

rem ---- 5. 启动桥（上游 start.bat：状态目录 ACL 加固 + 崩溃守护循环） ----
call start.bat
