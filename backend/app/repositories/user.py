"""Работа с пользователями: доступ к таблице и операции, специфичные для ролей.

Репозиторий отвечает за SQL. Всё, что является бизнес-правилом (можно ли
оставить отзыв, какие статусы заказа показывать), живёт в сервисах.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.enums import UserRole
from app.models.user import Address, User, UserSession


class UserRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get_by_id(self, user_id: uuid.UUID) -> User | None:
        return await self.session.get(User, user_id)

    async def get_by_email(self, email: str) -> User | None:
        result = await self.session.execute(select(User).where(User.email == email.lower()))
        return result.scalar_one_or_none()

    async def email_exists(self, email: str) -> bool:
        result = await self.session.execute(
            select(func.count()).select_from(User).where(User.email == email.lower())
        )
        return bool(result.scalar_one())

    async def add(self, user: User) -> User:
        self.session.add(user)
        await self.session.flush()
        return user

    async def update(self, user: User) -> User:
        user.updated_at = datetime.now(UTC)
        await self.session.flush()
        return user

    async def list_paginated(
        self,
        page: int,
        limit: int,
        *,
        search: str | None = None,
        role: UserRole | None = None,
    ) -> tuple[list[User], int]:
        """Список пользователей для админки (раздел 6.4 ТЗ)."""
        conditions = []
        if search:
            pattern = f"%{search.lower()}%"
            conditions.append(
                User.email.ilike(pattern) | User.phone.ilike(pattern),
            )
        if role is not None:
            conditions.append(User.role == role)

        total_result = await self.session.execute(
            select(func.count()).select_from(User).where(*conditions)
        )
        total = total_result.scalar_one()

        result = await self.session.execute(
            select(User)
            .where(*conditions)
            .order_by(User.created_at.desc())
            .offset((page - 1) * limit)
            .limit(limit)
        )
        return list(result.scalars().all()), total

    async def add_session(self, session_row: UserSession) -> UserSession:
        self.session.add(session_row)
        await self.session.flush()
        return session_row

    async def get_session_by_token_hash(self, token_hash: str) -> UserSession | None:
        result = await self.session.execute(
            select(UserSession).where(UserSession.refresh_token_hash == token_hash)
        )
        return result.scalar_one_or_none()

    async def list_active_sessions(self, user_id: uuid.UUID) -> list[UserSession]:
        result = await self.session.execute(
            select(UserSession)
            .where(UserSession.user_id == user_id, UserSession.revoked_at.is_(None))
            .order_by(UserSession.last_used_at.desc().nullslast(), UserSession.created_at.desc())
        )
        return list(result.scalars().all())

    async def revoke_all_sessions(self, user_id: uuid.UUID) -> int:
        """Выход со всех устройств — используется при смене пароля."""
        result = await self.session.execute(
            select(UserSession).where(
                UserSession.user_id == user_id,
                UserSession.revoked_at.is_(None),
            )
        )
        now = datetime.now(UTC)
        count = 0
        for row in result.scalars().all():
            row.revoked_at = now
            count += 1
        await self.session.flush()
        return count

    # ── Адреса ──

    async def list_addresses(self, user_id: uuid.UUID) -> list[Address]:
        result = await self.session.execute(
            select(Address)
            .where(Address.user_id == user_id)
            .order_by(Address.is_default.desc(), Address.created_at.desc())
        )
        return list(result.scalars().all())

    async def get_address(self, user_id: uuid.UUID, address_id: uuid.UUID) -> Address | None:
        return await self.session.get(Address, address_id) if address_id else None
