@echo off
setlocal
echo ---------------------------------------------------
echo Launching Chrome for Gemini Automation (Port 9222)
echo ---------------------------------------------------

:: Define profile path in the project folder
set "PROFILE_DIR=%~dp0browser_data\chrome_debug_profile"
if not exist "%PROFILE_DIR%" mkdir "%PROFILE_DIR%"

echo Using Profile: %PROFILE_DIR%
echo.

:: Try to find Chrome
set "CHROME_PATH="
if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" set "CHROME_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe"
if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" set "CHROME_PATH=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "CHROME_PATH=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"

if "%CHROME_PATH%"=="" (
    echo ERROR: Chrome.exe not found in standard locations.
    echo Please ensure Google Chrome is installed.
    pause
    exit /b 1
)

echo Found Chrome: "%CHROME_PATH%"
echo.
echo Launching...
echo.
echo [INSTRUCTIONS]
echo 1. Chrome will open.
echo 2. Go to https://gemini.google.com
echo 3. LOG IN with your Google Account.
echo 4. Keep this window OPEN.
echo 5. You can minimize it, but do not close it.
echo.

start "" "%CHROME_PATH%" --remote-debugging-port=9222 --user-data-dir="%PROFILE_DIR%" --no-first-run --no-default-browser-check

echo Chrome launched. You may close this terminal window if the browser stays open.
pause
