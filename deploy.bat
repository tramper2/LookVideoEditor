@echo off
echo =====================================================================
echo  Starting LookVideoEditor GitHub Pages Auto-Deployment Script
echo =====================================================================
echo.

where git >nul 2>nul
if %errorlevel% neq 0 goto NO_GIT

set CURRENT_BRANCH=main
for /f "tokens=*" %%i in ('git branch --show-current 2^>nul') do set CURRENT_BRANCH=%%i

echo [INFO] Committing changes on branch '%CURRENT_BRANCH%'...
git add .
git commit -m "Deploy LookVideoEditor to GitHub Pages"

echo.
echo [INFO] Force pushing to gh-pages branch...
git push -f git@github.com:tramper2/LookVideoEditor.git %CURRENT_BRANCH%:gh-pages

if %errorlevel% neq 0 goto ERROR

echo.
echo =====================================================================
echo  [SUCCESS] Deployment completed successfully!
echo  Repository: git@github.com:tramper2/LookVideoEditor.git
echo  URL: https://tramper2.github.io/LookVideoEditor/
echo =====================================================================
goto END

:NO_GIT
echo [ERROR] Git is not installed or not found in system PATH.
goto END

:ERROR
echo.
echo =====================================================================
echo  [ERROR] Deployment failed. Please check your SSH keys or permissions.
echo =====================================================================
goto END

:END
pause
