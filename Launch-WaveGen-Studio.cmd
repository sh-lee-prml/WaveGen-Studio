@echo off
if not exist "%~dp0.studio-install.json" (
  echo Run Install-WaveGen-Studio.cmd first to download the runtime and models.
  pause
  exit /b 1
)
start "WaveGen Studio" /d "%~dp0" "%~dp0WaveGen Studio.exe"
