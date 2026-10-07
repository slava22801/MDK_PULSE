"""Pydantic-схемы авторизации и пользователя (разделы 5.7 и 8.1 ТЗ)."""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

from app.core.security import validate_password
from app.models.enums import UserRole
from app.schemas.cart import CartMergeResponse


class TokenPair(BaseModel):
    """Пара токенов из раздела 5.7 ТЗ."""

    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in: int = Field(description="Срок access-токена в секундах")


class UserOut(BaseModel):
    """Публичное представление пользователя.

    password_hash в схеме отсутствует намеренно: даже если где-то в коде
    объект утечёт в лог через ``repr``, хеш наружу не попадёт.
    """

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    email: EmailStr
    first_name: str
    last_name: str
    phone: str | None
    role: UserRole
    is_active: bool
    email_verified: bool
    created_at: datetime

    @property
    def full_name(self) -> str:
        return f"{self.last_name} {self.first_name}".strip()


class AuthResponse(BaseModel):
    user: UserOut
    tokens: TokenPair
    # Результат слияния гостевой корзины с серверной (раздел 5.8 ТЗ).
    # Заполняется только при входе, когда гостевой cookie был.
    merged_cart: CartMergeResponse | None = None


class RefreshRequest(BaseModel):
    refresh_token: str = Field(min_length=20, max_length=512)


class LogoutRequest(BaseModel):
    """Refresh-токен, который нужно отозвать.

    Тело, а не заголовок: logout вызывается из клиента, где access-токен
    мог уже истечь, а refresh-токен ещё жив и именно он указывает,
    какую сессию закрыть.
    """

    refresh_token: str = Field(min_length=20, max_length=512)


class RefreshResponse(BaseModel):
    tokens: TokenPair


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=128)


class RegisterRequest(BaseModel):
    """Регистрация по разделу 5.7 ТЗ.

    Клиентская валидация — не более первой линии: сервер проверяет пароль
    заново, потому что API могут вызывать напрямую (раздел 10 ТЗ).
    """

    email: EmailStr
    first_name: str = Field(min_length=2, max_length=100)
    last_name: str = Field(min_length=2, max_length=100)
    phone: str = Field(min_length=6, max_length=32)
    password: str = Field(min_length=8, max_length=128)
    password_confirm: str = Field(min_length=8, max_length=128)
    accept_policy: bool

    @field_validator("phone")
    @classmethod
    def _normalize_phone(cls, value: str) -> str:
        """Приводит телефон к каноническому виду, чтобы «+7 999…» и «7999…»
        не считались разными номерами в поиске админки."""
        digits = "".join(ch for ch in value if ch.isdigit())
        if not 10 <= len(digits) <= 15:
            raise ValueError("Телефон должен содержать от 10 до 15 цифр")
        return f"+{digits}"

    @field_validator("first_name", "last_name")
    @classmethod
    def _strip_names(cls, value: str) -> str:
        cleaned = value.strip()
        if len(cleaned) < 2:
            raise ValueError("Слишком короткое значение")
        return cleaned

    def password_problems(self) -> dict[str, str]:
        """Проблемы пароля в виде ``{поле: сообщение}`` — для ответа API."""
        problems = validate_password(self.password, self.password_confirm)
        return {problem.code: problem.message for problem in problems}


class MessageResponse(BaseModel):
    message: str


class ForgotPasswordRequest(BaseModel):
    email: EmailStr


class ResetPasswordRequest(BaseModel):
    token: str = Field(min_length=20, max_length=512)
    password: str = Field(min_length=8, max_length=128)
    password_confirm: str = Field(min_length=8, max_length=128)

    def password_problems(self) -> dict[str, str]:
        return {p.code: p.message for p in validate_password(self.password, self.password_confirm)}


class ChangePasswordRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=128)
    password: str = Field(min_length=8, max_length=128)
    password_confirm: str = Field(min_length=8, max_length=128)

    def password_problems(self) -> dict[str, str]:
        return {p.code: p.message for p in validate_password(self.password, self.password_confirm)}


class VerifyEmailRequest(BaseModel):
    token: str = Field(min_length=20, max_length=512)


class DeleteAccountRequest(BaseModel):
    password: str = Field(min_length=1, max_length=128)


class SessionOut(BaseModel):
    """Активная сессия — раздел 5.7 ТЗ."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    user_agent: str | None
    ip_address: str | None
    created_at: datetime
    last_used_at: datetime | None
    expires_at: datetime
    is_current: bool = False


class ChangePasswordResponse(BaseModel):
    message: str
    revoked_sessions: int = 0
