@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0script\Start-AntigravityDesktop.ps1" %*
if errorlevel 1 pause
