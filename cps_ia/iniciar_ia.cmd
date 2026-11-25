@echo off
REM ============================================================================
REM  iniciar_ia.cmd — Lanza el motor de IA (Chronos-2) con el entorno virtual.
REM ----------------------------------------------------------------------------
REM  Usa SIEMPRE .venv\Scripts\python.exe. El Python global (WindowsApps) NO
REM  tiene instalado 'chronos-forecasting' ni 'torch+cu', por eso el error
REM  "ModuleNotFoundError: No module named 'chronos'".
REM ============================================================================
setlocal
cd /d "%~dp0"

REM Consola y Python en UTF-8 (evita UnicodeEncodeError con "°C" y emojis).
chcp 65001 >nul
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"

if not exist ".venv\Scripts\python.exe" (
  echo [ERROR] No se encuentra ".venv\Scripts\python.exe".
  echo.
  echo Crea el entorno virtual e instala las dependencias:
  echo     python -m venv .venv
  echo     .venv\Scripts\python.exe -m pip install chronos-forecasting paho-mqtt
  echo.
  pause
  exit /b 1
)

echo [LAUNCH] Usando el Python del entorno virtual: .venv\Scripts\python.exe
".venv\Scripts\python.exe" ia_chronos_mqtt.py %*

endlocal
