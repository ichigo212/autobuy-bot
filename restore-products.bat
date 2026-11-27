@echo off
cd /d "%~dp0"
title Restore old products
node restore-products.js
echo.
pause
