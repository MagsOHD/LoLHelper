"""Application settings, read from environment variables and an optional `.env` file."""

from __future__ import annotations

from pathlib import Path

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent

PLATFORM_TO_REGION: dict[str, str] = {
    "euw1": "europe",
    "eun1": "europe",
    "tr1": "europe",
    "ru": "europe",
    "me1": "europe",
    "na1": "americas",
    "br1": "americas",
    "la1": "americas",
    "la2": "americas",
    "kr": "asia",
    "jp1": "asia",
    "oc1": "sea",
    "sg2": "sea",
    "tw2": "sea",
    "vn2": "sea",
}
PLATFORMS: list[str] = list(PLATFORM_TO_REGION)


def region_for_platform(platform: str, default: str = "europe") -> str:
    return PLATFORM_TO_REGION.get(platform.lower(), default)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(BACKEND_DIR / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    riot_api_key: str = ""
    riot_platform: str = "euw1"
    # Empty = derived from riot_platform (europe for euw1).
    riot_region: str = ""
    riot_match_count: int = 20
    riot_match_concurrency: int = 5

    database_path: Path = BACKEND_DIR / "data" / "app.db"
    cache_dir: Path = BACKEND_DIR / "data" / "cache"
    ddragon_locale: str = "fr_FR"
    frontend_dist: Path = BACKEND_DIR.parent / "frontend" / "dist"
    cors_origins: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]

    @field_validator("riot_api_key", mode="before")
    @classmethod
    def _strip_key(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value

    @field_validator("riot_platform", mode="before")
    @classmethod
    def _lower_platform(cls, value: object) -> object:
        return value.strip().lower() if isinstance(value, str) else value

    @field_validator("database_path", "cache_dir", "frontend_dist", mode="after")
    @classmethod
    def _resolve_path(cls, value: Path) -> Path:
        # Relative paths are relative to web/backend/ (where .env lives).
        if str(value) == ":memory:" or value.is_absolute():
            return value
        return (BACKEND_DIR / value).resolve()

    @property
    def riot_configured(self) -> bool:
        return bool(self.riot_api_key)

    @property
    def effective_region(self) -> str:
        return self.riot_region.strip().lower() or region_for_platform(self.riot_platform)

    def region_for(self, platform: str) -> str:
        if platform.lower() == self.riot_platform and self.riot_region:
            return self.effective_region
        return region_for_platform(platform, self.effective_region)
