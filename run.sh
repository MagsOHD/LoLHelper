#!/bin/bash
# Script de démarrage pour LoL Helper

echo "🎮 LoL Team Composition Helper"
echo "================================"
echo ""

# Vérifier si l'environnement virtuel existe
if [ ! -d "venv" ]; then
    echo "Création de l'environnement virtuel..."
    python3 -m venv venv
fi

# Activer l'environnement virtuel
echo "Activation de l'environnement virtuel..."
source venv/bin/activate

# Installer les dépendances
echo "Installation des dépendances..."
pip install -q -r requirements.txt

# Lancer l'application
echo ""
echo "🚀 Lancement de l'application..."
echo "L'application sera accessible à http://localhost:8501"
echo ""

streamlit run app.py
