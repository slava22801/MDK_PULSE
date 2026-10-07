"""Настройки приложения. Источник — переменные окружения (раздел 20 ТЗ)."""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

_ChangeMe = "change_me"

# Идентификатор гостевой корзины (раздел 5.8 ТЗ). Живёт здесь, а не в
# ``app.main``, потому что его читает и middleware, и роутер авторизации:
# импорт из main создавал бы цикл main → router → auth → main.
CART_COOKIE = "pulse_cart"
CART_COOKIE_MAX_AGE = 60 * 60 * 24 * 30


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # ── Общее ──────────────────────────────────────────────
    app_name: str = "ПУЛЬС"
    app_env: Literal["development", "test", "production"] = "development"
    debug: bool = True
    public_base_url: str = "http://localhost:8080"

    # ── Секреты ────────────────────────────────────────────
    secret_key: str = _ChangeMe
    jwt_secret_key: str = _ChangeMe
    jwt_algorithm: str = "HS256"
    jwt_access_expire_minutes: int = 30
    jwt_refresh_expire_days: int = 30
    email_token_expire_minutes: int = 60 * 24
    password_reset_expire_minutes: int = 60

    # ── База данных ────────────────────────────────────────
    database_url: str = "postgresql+asyncpg://pulse:pulse_dev_password@localhost:5432/pulse_shop"
    test_database_url: str = ""
    database_echo: bool = False
    db_pool_size: int = 10
    db_max_overflow: int = 20
    db_pool_recycle_seconds: int = 1800
    db_pool_timeout_seconds: int = 30

    # ── Redis ──────────────────────────────────────────────
    redis_url: str = "redis://localhost:6379/0"

    # ── CORS ───────────────────────────────────────────────
    cors_origins: str = "http://localhost:8080,http://localhost:5173"

    # ── S3 / MinIO ─────────────────────────────────────────
    # local — файлы на диске (раздаёт backend, /media). Ноль внешних зависимостей.
    # s3    — любое S3-совместимое хранилище через boto3: MinIO, YOS, AWS S3.
    storage_driver: Literal["local", "s3"] = "local"
    media_root: str = "./media"
    s3_endpoint: str = ""
    s3_public_url: str = ""
    s3_access_key: str = ""
    s3_secret_key: str = ""
    s3_bucket: str = "pulse-media"
    s3_region: str = "us-east-1"
    max_upload_size_mb: int = 10

    # ── SMTP ───────────────────────────────────────────────
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_username: str = ""
    smtp_password: str = ""
    smtp_from_email: str = "no-reply@pulse.local"
    smtp_use_tls: bool = True
    emails_enabled: bool = False

    # ── Платежи ────────────────────────────────────────────
    # MVP: "fake". Реальные провайдеры добавляются сюда (yookassa, tinkoff).
    payment_provider: str = "fake"
    payment_api_key: str = ""
    payment_webhook_secret: str = _ChangeMe

    # ── Бизнес-правила ─────────────────────────────────────
    reservation_ttl_hours: int = 48
    low_stock_threshold: int = 5
    free_delivery_threshold: str = "0"
    default_delivery_cost: str = "590.00"
    max_compare_items: int = 4

    # ── Лимиты ─────────────────────────────────────────────
    rate_limit_auth_attempts: int = 5
    rate_limit_window_seconds: int = 300
    rate_limit_orders_per_hour: int = 10

    # ── Фронтенд (SSR) ─────────────────────────────────────
    frontend_base_url: str = "http://localhost:5173"
    api_internal_url: str = "http://localhost:8000"

    # ── Валидация ──────────────────────────────────────────
    @field_validator("free_delivery_threshold", "default_delivery_cost", mode="before")
    @classmethod
    def _blank_to_default(cls, value: object) -> object:
        return value if value not in ("", None) else value

    @model_validator(mode="after")
    def _secrets_must_be_changed_in_production(self) -> Settings:
        """Раздел 10 ТЗ: в production дефолтные секреты — недопустимы."""
        if self.is_production:
            weak = [
                name
                for name, value in (
                    ("SECRET_KEY", self.secret_key),
                    ("JWT_SECRET_KEY", self.jwt_secret_key),
                    ("PAYMENT_WEBHOOK_SECRET", self.payment_webhook_secret),
                )
                if value == _ChangeMe or len(value) < 16
            ]
            if weak:
                raise ValueError(
                    "Недопустимые секреты в production: " + ", ".join(weak) + ". "
                    "Задайте значения длиной не менее 16 символов."
                )
        return self

    # ── Производные значения ───────────────────────────────
    @property
    def is_production(self) -> bool:
        return self.app_env == "production"

    @property
    def cors_origin_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    @property
    def async_database_url(self) -> str:
        """Приводит синхронный URL к async-драйверу — alembic.ini читает оба."""
        return self.database_url.replace("postgresql://", "postgresql+asyncpg://").replace(
            "postgresql+psycopg://", "postgresql+asyncpg://"
        )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


settings: Settings = get_settings()
