@echo off
rem Mininote launcher: starts the local server (hidden) and opens the app window in Edge.
start "" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0serve.ps1" -Open
