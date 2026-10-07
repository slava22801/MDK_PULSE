"""Логирование по разделу 13 ТЗ.

Ключевой момент — :class:`SecretRedactingFilter`: пароли, токены и данные карт
не должны попадать в логи ни при каком виде исключения.
"""

from __future__ import annotations

import json
import logging
import sys
from typing import Any

from app.core.config import settings

REDACTED = "***redacted***"

# Ключи, значения которых вычищаются на любом уровне вложенности.
_SENSITIVE_KEYS = frozenset(
    {
        "password",
        "new_password",
        "old_password",
        "password_hash",
        "password_confirm",
        "confirm_password",
        "token",
        "access_token",
        "refresh_token",
        "token_hash",
        "authorization",
        "secret",
        "secret_key",
        "jwt_secret_key",
        "api_key",
        "webhook_secret",
        "card_number",
        "card",
        "cvv",
        "cvc",
        "smtp_password",
    }
)

_SENSITIVE_MARKERS = ("password", "token", "secret", "api_key", "card_number", "cvv")

LEVELS = {
    "DEBUG": logging.DEBUG,
    "INFO": logging.INFO,
    "WARNING": logging.WARNING,
    "ERROR": logging.ERROR,
    "CRITICAL": logging.CRITICAL,
}


def _is_sensitive(key: str) -> bool:
    lowered = key.lower()
    return lowered in _SENSITIVE_KEYS or any(marker in lowered for marker in _SENSITIVE_MARKERS)


def redact(value: Any, _depth: int = 0) -> Any:
    """Рекурсино заменяет чувствительные значения. Глубина ограничена защитой от циклов."""
    if _depth > 6:
        return value
    if isinstance(value, dict):
        return {
            k: (REDACTED if _is_sensitive(str(k)) else redact(v, _depth + 1))
            for k, v in value.items()
        }
    if isinstance(value, list | tuple | set):
        return [redact(v, _depth + 1) for v in value]
    if isinstance(value, str) and value.startswith(("Bearer ", "Basic ")):
        return value.split(" ", 1)[0] + " " + REDACTED
    return value


class SecretRedactingFilter(logging.Filter):
    """Чистит record.msg и record.args до того, как запись уйдёт в хендлер."""

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.msg, dict | list):
            record.msg = redact(record.msg)
        elif isinstance(record.msg, str) and "password" in record.msg.lower():
            record.msg = REDACTED
        if record.args:
            if isinstance(record.args, dict):
                record.args = redact(record.args)
            else:
                record.args = tuple(
                    redact(a) if isinstance(a, dict | list) else a for a in record.args
                )
        return True


class JsonFormatter(logging.Formatter):
    """Структурный вывод — в него удобно скормить centralized log collector."""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        for attr in ("request_id", "method", "path", "status_code", "duration_ms", "user_id"):
            if hasattr(record, attr):
                payload[attr] = getattr(record, attr)
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False, default=str)


class ConsoleFormatter(logging.Formatter):
    """Человекочитаемый вывод для разработки."""

    def __init__(self) -> None:
        super().__init__(
            fmt="%(asctime)s %(levelname)-8s %(name)s | %(message)s",
            datefmt="%H:%M:%S",
        )


def configure_logging() -> None:
    """Настраивает корневой логгер. Вызывается один раз при старте приложения."""
    level = LEVELS.get("DEBUG" if settings.debug else "INFO", logging.INFO)
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter() if settings.is_production else ConsoleFormatter())
    handler.addFilter(SecretRedactingFilter())

    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(level)

    # Шумные сторонние библиотеки приглушаем — в логах остаётся наша логика.
    for noisy in ("uvicorn.access", "botocore", "boto3", "s3transfer", "aiosqlite"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
