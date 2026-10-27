@echo off
rem Abre Portfolio Analysis en tu equipo, sin Vercel. Solo usa Python como servidor de archivos.
cd /d "%~dp0public"
set "PY="
py -3 -c "import sys" >nul 2>nul && set "PY=py -3"
if not defined PY python -c "import sys" >nul 2>nul && set "PY=python"
if not defined PY (
  echo No se encontro Python 3. Instalalo con:  winget install Python.Python.3.12
  pause
  exit /b 1
)
start "" http://127.0.0.1:8000
echo Portfolio Analysis corre en http://127.0.0.1:8000  -  cierra esta ventana para detenerlo.
%PY% -m http.server 8000 --bind 127.0.0.1
