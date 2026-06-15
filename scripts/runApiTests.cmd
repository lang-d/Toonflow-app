@echo off
setlocal
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\node_modules\electron\dist\electron.exe" "%~dp0..\node_modules\tsx\dist\cli.mjs" --test --test-concurrency=1 "%~dp0..\tests\*.test.ts"
exit /b %errorlevel%
