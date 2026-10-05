"""Domain errors raised by the Riot / Data Dragon clients (messages are user-facing, French)."""

from __future__ import annotations


class RiotError(Exception):
    """Generic upstream failure. `status_code` is the HTTP status our API should answer."""

    status_code = 502

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


class RiotNotFound(RiotError):
    status_code = 404


class RiotAuthError(RiotError):
    status_code = 502

    def __init__(self, message: str | None = None):
        super().__init__(
            message
            or (
                "Clé API Riot invalide ou expirée. Les clés de développement expirent toutes les "
                "24 h : régénérez-la sur https://developer.riotgames.com puis mettez à jour "
                "RIOT_API_KEY dans le fichier .env et redémarrez le serveur."
            )
        )


class RiotRateLimited(RiotError):
    status_code = 503

    def __init__(self, message: str | None = None):
        super().__init__(
            message or "Limite de requêtes de l'API Riot atteinte. Réessayez dans quelques instants."
        )


class RiotNotConfigured(RiotError):
    status_code = 400

    def __init__(self, message: str | None = None):
        super().__init__(
            message
            or "Aucune clé API Riot configurée (RIOT_API_KEY) : la synchronisation est impossible."
        )
