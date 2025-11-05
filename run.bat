@echo off
REM Script de démarrage pour LoL Helper (Windows)

echo LoL Team Composition Helper
echo ================================
echo.

REM Vérifier si l'environnement virtuel existe
if not exist "venv" (
    echo Creation de l'environnement virtuel...
    python -m venv venv
)

REM Activer l'environnement virtuel
echo Activation de l'environnement virtuel...
call venv\Scripts\activate.bat

REM Installer les dépendances
echo Installation des dependances...
pip install -q -r requirements.txt

REM Lancer l'application
echo.
echo Lancement de l'application...
echo L'application sera accessible a http://localhost:8501
echo.

streamlit run app.py
