@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1" -InstallDirectory "%~dp0." %*
if errorlevel 1 pause
