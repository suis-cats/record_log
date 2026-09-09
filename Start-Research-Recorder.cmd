@echo off
cd /d "%~dp0"
call npm.cmd run recorder
if errorlevel 1 pause
