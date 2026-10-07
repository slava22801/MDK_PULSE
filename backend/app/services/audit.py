"""Журнал действий администратора (разделы 10 и 13 ТЗ).

Запись делается в той же транзакции, что и само изменение. Это важно:
если действие откатилось, не должна остаться запись о том, будто оно
произошло. И наоборот — зарегистрированная покупка с изменением цены всегда
находима.
"""

from __future__ import annotations

import logging
import uuid
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.content import AdminAuditLog
from app.models.user import User

logger = logging.getLogger(__name__)


class AuditService:
    """Пишет действия сотрудников в журнал.

    Отдельный класс, а не функция в каждом сервисе: формат записи должен быть
    один, иначе часть изменений окажется в журнале, а часть — нет.
    """

    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def record(
        self,
        actor: User | None,
        *,
        action: str,
        entity_type: str,
        entity_id: uuid.UUID | str | None = None,
        details: dict[str, Any] | None = None,
        ip_address: str | None = None,
    ) -> AdminAuditLog:
        """Регистрирует действие.

        Значения секретов сюда не кладутся: ``details`` попадает в журнал
        как есть, поэтому вызывающий обязан передавать только то, что
        безопасно показывать сотруднику.
        """
        entry = AdminAuditLog(
            user_id=actor.id if actor else None,
            action=action,
            entity_type=entity_type,
            entity_id=str(entity_id) if entity_id else None,
            details=_redact(details) if details else None,
            ip_address=ip_address,
        )
        self.session.add(entry)
        logger.info(
            "Действие администратора: %s %s (%s) — %s",
            actor.email if actor else "система",
            action,
            entity_type,
            entity_id,
        )
        return entry


_SENSITIVE = frozenset({"password", "password_hash", "new_password", "token", "secret", "api_key"})


def _redact(details: dict[str, Any]) -> dict[str, Any]:
    """Вычищает секреты из записи журнала (раздел 10 ТЗ)."""
    return {key: ("***" if key.lower() in _SENSITIVE else value) for key, value in details.items()}


async def record_password_reset(
    session: AsyncSession,
    actor: User,
    target: User,
    ip_address: str | None,
) -> None:
    """Отдельная запись для сброса пароля.

    Хранится факт сброса, а не сам пароль: разница между «пароль сброшен»
    и «пароль не раскрыт» — это ровно то, что журнал обязан сохранить.
    """
    await AuditService(session).record(
        actor,
        action="user.password_reset",
        entity_type="user",
        entity_id=target.id,
        details={"target_email": target.email},
        ip_address=ip_address,
    )
