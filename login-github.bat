@echo off
chcp 65001 >nul
set HTTP_PROXY=http://127.0.0.1:7897
set HTTPS_PROXY=http://127.0.0.1:7897
set NO_PROXY=localhost,127.0.0.1,192.168.0.0/16
echo ============================================
echo   GitHub login (through proxy 127.0.0.1:7897)
echo ============================================
echo.
echo   Choose:  GitHub.com  /  HTTPS  /  Yes  /  Login with a web browser
echo   A one-time code appears - copy it, then Enter opens the browser.
echo.
"C:\Program Files\GitHub CLI\gh.exe" auth login --hostname github.com --git-protocol https --web
echo.
echo --------------------------------------------
echo   If it says "Logged in as ...", it worked.
echo --------------------------------------------
pause
