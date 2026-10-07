"""Хеширование паролей, JWT и одноразовые токены (разделы 5.7 и 10 ТЗ).

Два осознанных решения, отличающиеся от «как обычно делают»:

1. **bcrypt вызывается напрямую, без passlib.** Passlib не обновлялся с 2020
   года и конфликтует с ветками bcrypt 5.x, выдавая предупреждение при каждом
   импорте. Прямой вызов — это ровно то, что делает passlib внутри.
2. **Пароли длиннее 72 байт предварительно хешируются sha256.** bcrypt молча
   обрезает вход длиннее 72 байт, из-за чего две разные длинные пароли
   дают один и тот же хеш. Обрезка — тихая коллизия паролей, поэтому
   длинный пароль приводится к 64-символьной base64-строке фиксированной
   длины и bcrypt больше ничего не теряет.
"""

from __future__ import annotations

import base64
import hashlib
import re
import secrets
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

import bcrypt
import jwt

from app.core.config import settings
from app.core.errors import UnauthorizedError

TokenType = Literal["access", "refresh", "email_verification", "password_reset"]

_PASSWORD_MAX_BYTES = 72
_password_prehashed_prefix = "$pulse$"


# ── Пароли ─────────────────────────────────────────────────────


def _prepare(password: str) -> bytes:
    """Готовит пароль к bcrypt с защитой от тихой обрезки."""
    raw = password.encode("utf-8")
    if len(raw) <= _PASSWORD_MAX_BYTES:
        return raw
    digest = hashlib.sha256(raw).digest()
    return (_password_prehashed_prefix + base64.b64encode(digest).decode()).encode()


def hash_password(password: str) -> str:
    return bcrypt.hashpw(_prepare(password), bcrypt.gensalt()).decode()


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(_prepare(password), password_hash.encode())
    except (ValueError, TypeError):
        # Повреждённый хеш не должен ронять запрос 500 — это 401.
        return False


@dataclass(frozen=True)
class PasswordProblem:
    code: str
    message: str


def validate_password(password: str, password_confirm: str | None = None) -> list[PasswordProblem]:
    """Проверка по требованиям раздела 5.7 ТЗ.

    Возвращает список проблем, а не бросает исключение: ошибки полей
    показываются под полями формы (раздел 9 ТЗ).
    """
    problems: list[PasswordProblem] = []

    if len(password) < 8:
        problems.append(
            PasswordProblem("password_too_short", "Пароль должен содержать минимум 8 символов")
        )
    if not re.search(r"[A-Za-zА-Яа-яЁё]", password):
        problems.append(
            PasswordProblem("password_no_letter", "Пароль должен содержать хотя бы одну букву")
        )
    if not re.search(r"\d", password):
        problems.append(
            PasswordProblem("password_no_digit", "Пароль должен содержать хотя бы одну цифру")
        )
    if len(password.encode("utf-8")) > 128:
        problems.append(PasswordProblem("password_too_long", "Пароль длиннее 128 байт"))
    if password_confirm is not None and password != password_confirm:
        problems.append(PasswordProblem("password_mismatch", "Пароли не совпадают"))

    return problems


# ── Токены общего назначения ───────────────────────────────────


def generate_secure_token(nbytes: int = 32) -> str:
    """Одноразовый токен для подтверждения email и сброса пароля."""
    return secrets.token_urlsafe(nbytes)


def hash_token(token: str) -> str:
    """Хеш токена для хранения.

    sha256, а не медленный bcrypt: токенты и так одноразовые и защищены
    случайностью длины 32 байта, а проверка идёт на каждом запросе.
    """
    return hashlib.sha256(token.encode()).hexdigest()


# ── JWT ────────────────────────────────────────────────────────


def create_access_token(user_id: uuid.UUID, role: str) -> tuple[str, int]:
    """Возвращает (token, ttl_seconds). Роль кладём в токен, чтобы не ходить
    в БД ради проверки прав на каждом защищённом запросе."""
    ttl = timedelta(minutes=settings.jwt_access_expire_minutes)
    now = datetime.now(UTC)
    payload: dict[str, Any] = {
        "sub": str(user_id),
        "role": role,
        "type": "access",
        # jti обязателен: без него два выпуска токена в пределах одной секунды
        # дают побайтово одинаковый JWT (одинаковые sub/role/iat/exp).
        # Клиент после refresh видел бы «тот же» токен, и сравнить выданные
        # токены в логах или отозвать конкретный было бы невозможно.
        "jti": secrets.token_urlsafe(16),
        "iat": int(now.timestamp()),
        "exp": int((now + ttl).timestamp()),
    }
    token = jwt.encode(payload, settings.jwt_secret_key, algorithm=settings.jwt_algorithm)
    return token, int(ttl.total_seconds())


def create_refresh_token(user_id: uuid.UUID, session_id: uuid.UUID) -> tuple[str, datetime]:
    ttl = timedelta(days=settings.jwt_refresh_expire_days)
    now = datetime.now(UTC)
    expires_at = now + ttl
    payload: dict[str, Any] = {
        "sub": str(user_id),
        "sid": str(session_id),
        "type": "refresh",
        "jti": secrets.token_urlsafe(16),
        "iat": int(now.timestamp()),
        "exp": int(expires_at.timestamp()),
    }
    token = jwt.encode(payload, settings.jwt_secret_key, algorithm=settings.jwt_algorithm)
    return token, expires_at


def decode_token(token: str, expected_type: TokenType) -> dict[str, Any]:
    """Проверяет подпись, срок и тип токена.

    ``verify_sub`` включён обязательно: без проверки subject алгоритм
    принимает токены без ``sub``, и в коде ниже появится неявная ошибка
    вместо явного отказа.
    """
    try:
        payload = jwt.decode(
            token,
            settings.jwt_secret_key,
            algorithms=[settings.jwt_algorithm],
            options={"require": ["sub", "exp", "iat", "type"], "verify_sub": True},
        )
    except jwt.ExpiredSignatureError as exc:
        raise UnauthorizedError("Срок действия токена истёк", code="token_expired") from exc
    except jwt.InvalidTokenError as exc:
        raise UnauthorizedError("Некорректный токен", code="invalid_token") from exc

    if payload.get("type") != expected_type:
        raise UnauthorizedError(
            f"Ожидается токен типа {expected_type}, получен {payload.get('type')}",
            code="invalid_token_type",
        )
    return payload


def token_expiry(purpose: TokenType) -> datetime:
    """Срок действия одноразового токена из настроек."""
    if purpose == "password_reset":
        minutes = settings.password_reset_expire_minutes
    else:
        minutes = settings.email_token_expire_minutes
    return datetime.now(UTC) + timedelta(minutes=minutes)
