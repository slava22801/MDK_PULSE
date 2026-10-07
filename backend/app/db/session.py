"""Движок и сессия SQLAlchemy 2.0 (async)."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase

from app.core.config import settings


class Base(DeclarativeBase):
    """Общий декларативный базовый класс для всех моделей."""


def _engine_kwargs() -> dict:
    """Настройки пула. Для sqlite (тесты без Docker) пул не создаётся."""
    url = settings.async_database_url
    common: dict = {"echo": settings.database_echo, "pool_pre_ping": True}
    if url.startswith("sqlite"):
        return common
    return {
        **common,
        "pool_size": settings.db_pool_size,
        "max_overflow": settings.db_max_overflow,
        "pool_recycle": settings.db_pool_recycle_seconds,
        "pool_timeout": settings.db_pool_timeout_seconds,
    }


engine: AsyncEngine = create_async_engine(settings.async_database_url, **_engine_kwargs())

session_factory: async_sessionmaker[AsyncSession] = async_sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False,
    autoflush=False,
)


@asynccontextmanager
async def session_scope() -> AsyncIterator[AsyncSession]:
    """Контекстный менеджер для операций вне запроса (CLI, фоновые задачи)."""
    async with session_factory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


async def get_db() -> AsyncIterator[AsyncSession]:
    """FastAPI-зависимость: одна сессия на запрос, откат при исключении."""
    async with session_factory() as session:
        try:
            yield session
        except Exception:
            await session.rollback()
            raise


async def dispose_engine() -> None:
    await engine.dispose()
