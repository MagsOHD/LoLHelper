@echo off
rem LoLHelper - Draft en direct : lance le programme compagnon (lecture seule du client League).
rem Options : Lancer-LoLHelper-Draft.bat -Reset   (efface l'adresse du site et le mot de passe enregistres)
title LoLHelper - Draft en direct
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0lolhelper-draft.ps1" %*
echo.
pause
