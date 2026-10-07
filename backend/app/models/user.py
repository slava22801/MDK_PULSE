"""Пользователи, сессии, токены и адреса (разделы 5.7, 5.11, 6.4 ТЗ)."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.enums import TokenPurpose, UserRole
from app.models.mixins import Base, TimestampsMixin, UUIDPrimaryKeyMixin, pg_enum


class User(UUIDPrimaryKeyMixin, TimestampsMixin, Base):
    """Раздел 7.1 ТЗ."""

    __tablename__ = "users"

    email: Mapped[str] = mapped_column(String(320), unique=True, index=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    first_name: Mapped[str] = mapped_column(String(100), nullable=False)
    last_name: Mapped[str] = mapped_column(String(100), nullable=False)
    phone: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)

    role: Mapped[UserRole] = mapped_column(
        pg_enum(UserRole, "user_role"),
        default=UserRole.CUSTOMER,
        nullable=False,
        index=True,
    )
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    email_verified: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    blocked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    sessions: Mapped[list[UserSession]] = relationship(
        back_populates="user",
        cascade="all, delete-orphan",
        lazy="selectin",
    )

    @property
    def is_staff(self) -> bool:
        return self.role.is_staff

    @property
    def full_name(self) -> str:
        return f"{self.last_name} {self.first_name}".strip()

    def __repr__(self) -> str:
        return f"<User {self.email} role={self.role.value}>"


class UserSession(UUIDPrimaryKeyMixin, TimestampsMixin, Base):
    """Активные сессии пользователя.

    Раздел 5.7 ТЗ требует «просмотр активных сессий» и выход из аккаунта.
    Refresh-токен нельзя отозвать по устройству без отдельной записи: JWT сам
    по себе stateless и остаётся валидным до истечения срока. Здесь хранится
    только хеш токена — сам токен остаётся только у клиента.
    """

    __tablename__ = "user_sessions"

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    refresh_token_hash: Mapped[str] = mapped_column(String(128), index=True, nullable=False)
    user_agent: Mapped[str | None] = mapped_column(String(512), nullable=True)
    ip_address: Mapped[str | None] = mapped_column(String(64), nullable=True)

    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    user: Mapped[User] = relationship(back_populates="sessions", lazy="joined")

    @property
    def is_active(self) -> bool:
        if self.revoked_at is not None:
            return False
        return self.expires_at > datetime.now(self.expires_at.tzinfo)

    def __repr__(self) -> str:
        return f"<UserSession {self.id} user={self.user_id} active={self.is_active}>"


class EmailToken(UUIDPrimaryKeyMixin, TimestampsMixin, Base):
    """Одноразовые токены: подтверждение email и сброс пароля (раздел 5.7).

    Хранится только хеш. Поле purpose разделяет два независимых сценария,
    чтобы токен сброса пароля нельзя было предъявить для подтверждения email.
    """

    __tablename__ = "email_tokens"
    __table_args__ = (
        UniqueConstraint("user_id", "purpose", name="uq_email_tokens_user_purpose"),
        Index("ix_email_tokens_user_purpose_active", "user_id", "purpose", "expires_at"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    purpose: Mapped[TokenPurpose] = mapped_column(
        pg_enum(TokenPurpose, "token_purpose"),
        nullable=False,
    )
    token_hash: Mapped[str] = mapped_column(String(128), unique=True, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    user: Mapped[User] = relationship(lazy="joined")

    @property
    def is_usable(self) -> bool:
        return self.used_at is None and self.expires_at > datetime.now(self.expires_at.tzinfo)

    def __repr__(self) -> str:
        return f"<EmailToken {self.purpose.value} usable={self.is_usable}>"


class Address(UUIDPrimaryKeyMixin, TimestampsMixin, Base):
    """Адреса доставки (раздел 5.11 ТЗ)."""

    __tablename__ = "addresses"

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    label: Mapped[str] = mapped_column(String(50), default="Домой")
    recipient_name: Mapped[str] = mapped_column(String(200), nullable=False)
    phone: Mapped[str] = mapped_column(String(32), nullable=False)
    postal_code: Mapped[str | None] = mapped_column(String(16), nullable=True)
    country: Mapped[str] = mapped_column(String(100), default="Россия")
    city: Mapped[str] = mapped_column(String(100), nullable=False)
    street: Mapped[str] = mapped_column(String(255), nullable=False)
    building: Mapped[str] = mapped_column(String(20), nullable=False)
    apartment: Mapped[str | None] = mapped_column(String(20), nullable=True)
    comment: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    user: Mapped[User] = relationship(lazy="joined")
