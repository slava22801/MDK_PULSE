"""Общие элементы моделей: миксины и колонки, повторяющиеся по всем таблицам."""

from __future__ import annotations

import enum
import uuid
from datetime import datetime

from sqlalchemy import DateTime, String, func
from sqlalchemy import Enum as SAEnum
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


def pg_enum[EnumT: enum.Enum](enum_class: type[EnumT], name: str) -> SAEnum:
    """Столбец-ENUM, который хранит **значения**, а не имена членов.

    По умолчанию SQLAlchemy пишет в PostgreSQL ``member.name`` — то есть
    ``"ADMIN"``, ``"PAID"``, ``"IN_STOCK"``. API же отдаёт ``"admin"``,
    ``"paid"``, ``"in_stock"``: расходились бы хранилище и контракт,
    а любой фильтр по сырому SQL и любая выгрузка данных смотрели бы в
    таблицу и видели бы не то, что показывает интерфейс.
    ``values_callable`` заставляет писать именно значения.
    """
    return SAEnum(
        enum_class,
        name=name,
        values_callable=lambda members: [member.value for member in members],  # type: ignore[attr-defined]
        native_enum=True,
        validate_strings=True,
    )


class UUIDPrimaryKeyMixin:
    """UUID-первичный ключ.

    Осознанный выбор против автоинкремента: идентификаторы уходят в публичные
    URL и API, где последовательные числа раскрывают объём бизнеса и позволяют
    перебирать чужие заказы и отзывы простым инкрементом.
    """

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True,
        default=uuid.uuid4,
    )


class TimestampsMixin:
    """created_at / updated_at с автоматическим обслуживанием на стороне БД."""

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )


class UserAgentMixin:
    """last_user_agent — нужен для раздела 5.7 ТЗ (список активных сессий)."""

    last_user_agent: Mapped[str | None] = mapped_column(String(512), nullable=True)


__all__ = ["Base", "TimestampsMixin", "UUIDPrimaryKeyMixin", "UserAgentMixin"]
