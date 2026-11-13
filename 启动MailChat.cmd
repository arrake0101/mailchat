@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist "src-tauri\target\release\mailchat.exe" (
    start "" "src-tauri\target\release\mailchat.exe"
) else (
    npm start
)
