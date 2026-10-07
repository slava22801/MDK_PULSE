"""Контент, уведомления и служебные таблицы (разделы 6.6, 10, 15 ТЗ)."""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.enums import NotificationType
from app.models.mixins import Base, TimestampsMixin, UUIDPrimaryKeyMixin, pg_enum


class Banner(UUIDPrimaryKeyMixin, TimestampsMixin, Base):
    """Баннеры главной страницы (раздел 6.6 ТЗ)."""

    __tablename__ = "banners"

    title: Mapped[str] = mapped_column(String(200), nullable=False)
    subtitle: Mapped[str | None] = mapped_column(String(300), nullable=True)
    image_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    link_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    button_text: Mapped[str | None] = mapped_column(String(50), nullable=True)

    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    # Период показа баннера на главной (акция действует с 1 по 15 числа).
    starts_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    ends_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)


class Page(UUIDPrimaryKeyMixin, TimestampsMixin, Base):
    """Текстовые страницы: о компании, доставка, оплата, гарантия, возврат."""

    __tablename__ = "pages"

    slug: Mapped[str] = mapped_column(String(100), unique=True, index=True, nullable=False)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    seo_title: Mapped[str | None] = mapped_column(String(300), nullable=True)
    seo_description: Mapped[str | None] = mapped_column(String(500), nullable=True)
    is_published: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)


class FaqItem(UUIDPrimaryKeyMixin, TimestampsMixin, Base):
    """FAQ (раздел 6.6 ТЗ)."""

    __tablename__ = "faq_items"

    question: Mapped[str] = mapped_column(String(300), nullable=False)
    answer: Mapped[str] = mapped_column(Text, nullable=False)
    category: Mapped[str | None] = mapped_column(String(100), nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    is_published: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)


class Setting(Base):
    """Справочник настроек магазина: ключ-значение.

    Отдельная таблица вместо колонок в отдельной «settings»: набор параметров
    меняется часто (реквизиты, контакты, соцсети), структура схемы — нет.
    """

    __tablename__ = "settings"

    key: Mapped[str] = mapped_column(String(100), primary_key=True)
    value: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    description: Mapped[str | None] = mapped_column(String(300), nullable=True)
    # Не выводить во фронтенд: реквизиты, ключи интеграций.
    is_secret: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )


class Notification(UUIDPrimaryKeyMixin, Base):
    """Уведомления в личном кабинете (раздел 15 ТЗ).

    Email уходит отдельным каналом, а запись остаётся здесь — чтобы кабинет
    показывал историю уведомлений после смены email у пользователя.
    """

    __tablename__ = "notifications"
    __table_args__ = (
        Index("ix_notifications_user_read_created", "user_id", "is_read", "created_at"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    type: Mapped[NotificationType] = mapped_column(
        pg_enum(NotificationType, "notification_type"),
        nullable=False,
    )
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    payload: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    is_read: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )


class AdminAuditLog(UUIDPrimaryKeyMixin, Base):
    """Журнал действий администратора (разделы 10 и 13 ТЗ).

    Отдельная таблица, а не запись в логи приложения: записи должны
    переживать ротацию логов и быть доступны в админке без доступа к серверу.
    """

    __tablename__ = "admin_audit_log"
    __table_args__ = (Index("ix_admin_audit_log_user_created", "user_id", "created_at"),)

    user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    action: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    entity_type: Mapped[str] = mapped_column(String(50), nullable=False)
    entity_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    details: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    ip_address: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )


class IdempotencyKey(UUIDPrimaryKeyMixin, Base):
    """Защита от повторной отправки заказа (раздел 10 ТЗ).

    Клиент присылает ключ с каждым оформлением. Повтор с тем же ключом
    возвращает уже созданный заказ вместо нового.
    """

    __tablename__ = "idempotency_keys"
    __table_args__ = (Index("ix_idempotency_keys_user_created", "user_id", "created_at"),)

    user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    key: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    endpoint: Mapped[str] = mapped_column(String(100), nullable=False)
    response_snapshot: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    amount: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
