@echo off
cd /d "%~dp0"
:loop
".venv\Scripts\uvicorn.exe" app.main:app --host 127.0.0.1 --port 8000 >> backend-service.log 2>&1
echo [%date% %time%] uvicorn exited, restarting in 3s... >> backend-service.log
timeout /t 3 /nobreak >nul
goto loop
