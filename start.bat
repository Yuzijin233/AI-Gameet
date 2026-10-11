@echo off
setlocal
cd /d "%~dp0"

echo ============================================
echo   AI-Gameet  -  local server
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 goto trypython

echo [1/1] Starting with Node.js ...
echo       Browser will open automatically.
echo       Close this window to stop the server.
echo.
node server.js
if errorlevel 1 goto nodefail
goto end

:nodefail
echo.
echo [ERROR] server exited unexpectedly. Please copy the messages above.
echo.
pause
goto end

:trypython
where python >nul 2>nul
if errorlevel 1 goto nonode

echo [1/1] Node.js not found, falling back to Python static server...
echo       NOTE: no /api/chat proxy in this mode; AI will use local lines.
echo.
start "" http://localhost:5173/
python -m http.server 5173
goto end

:nonode
echo [ERROR] Neither Node.js nor Python was found.
echo         Please install Node.js first: https://nodejs.org
echo.
pause

:end
endlocal