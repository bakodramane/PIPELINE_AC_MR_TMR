@echo off
title AgCensus Compiler
cd /d "%~dp0"
echo ========================================
echo   AgCensus Compiler - FAO WCA 2020
echo ========================================
echo.
echo Starting application...
echo This window must stay open while the app is running.
echo To quit: close this window or press Ctrl+C
echo.
npm run tauri:dev
echo.
echo Application closed.
pause
