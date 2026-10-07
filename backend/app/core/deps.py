"""Зависимости FastAPI: текущий пользователь, роли, доступ к сессии и Redis."""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator, Callable
from typing import Annotated

from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import ForbiddenError, UnauthorizedError
from app.core.rate_limit import client_ip, get_redis
from app.core.security import decode_token
from app.db.session import get_db
from app.models.enums import UserRole
from app.models.user import User
from app.repositories.user import UserRepository

# auto_error=False: при отсутствии заголовка мы хотим наш собственный
# ответ в формате {error:{code,message}}, а не стандартный HTTPBearer-403.
_bearer_scheme = HTTPBearer(auto_error=False, description="JWT access-токен")

DbSession = Annotated[AsyncSession, Depends(get_db)]
RedisClient = Annotated[Redis, Depends(get_redis)]


def extract_token(
    request: Request,
    credentials: Annotated[
        HTTPAuthorizationCredentials | None,
        Depends(_bearer_scheme),
    ] = None,
) -> str:
    if credentials is None or not credentials.credentials:
        raise UnauthorizedError(
            "Требуется авторизация. Перейдите на страницу входа.",
            code="unauthorized",
        )
    return credentials.credentials


async def get_current_user(
    request: Request,
    session: DbSession,
    token: Annotated[str, Depends(extract_token)],
) -> User:
    """Текущий пользователь по access-токену.

    Пользователь каждый раз читается из БД, а не берётся из токена:
    блокировка и смена роли должны действовать немедленно, а не по
    истечении токена (раздел 10 ТЗ).
    """
    payload = decode_token(token, "access")
    try:
        user_id = uuid.UUID(payload["sub"])
    except (KeyError, ValueError) as exc:
        raise UnauthorizedError(
            "Некорректный идентификатор пользователя", code="invalid_token"
        ) from exc

    user = await UserRepository(session).get_by_id(user_id)
    if user is None:
        raise UnauthorizedError("Пользователь не найден", code="user_not_found")

    if not user.is_active or user.blocked_at is not None:
        raise ForbiddenError(
            "Учётная запись заблокирована. Обратитесь в поддержку.",
            code="account_blocked",
        )
    return user


async def get_optional_user(
    request: Request,
    session: DbSession,
    credentials: Annotated[
        HTTPAuthorizationCredentials | None,
        Depends(_bearer_scheme),
    ] = None,
) -> User | None:
    """Пользователь, если токен есть и валиден; иначе ``None``.

    Гостевые эндпоинты каталога не должны отвечать 401 гостю, но должны
    уметь отличать гостя от вошедшего — например, чтобы показать корзину
    из localStorage, а не из профиля.
    """
    if credentials is None or not credentials.credentials:
        return None
    try:
        payload = decode_token(credentials.credentials, "access")
        user_id = uuid.UUID(payload["sub"])
    except (UnauthorizedError, KeyError, ValueError):
        return None
    return await UserRepository(session).get_by_id(user_id)


CurrentUser = Annotated[User, Depends(get_current_user)]
OptionalUser = Annotated[User | None, Depends(get_optional_user)]


def require_roles(*roles: UserRole) -> Callable[..., type[User]]:
    """Зависимость «только эти роли».

    Принимает и строки — иначе пришлось бы импортировать UserRole во всех
    модулях роутеров ради одной проверки.
    """
    allowed = {r.value if isinstance(r, UserRole) else str(r) for r in roles}

    async def _dependency(user: CurrentUser) -> User:
        if user.role.value not in allowed:
            raise ForbiddenError(
                "У вас недостаточно прав для этого действия",
                code="insufficient_role",
            )
        return user

    return _dependency


require_admin = require_roles(UserRole.ADMIN)
require_staff = require_roles(UserRole.MANAGER, UserRole.ADMIN)


def get_client_ip(request: Request) -> str:
    return client_ip(
        request.client.host if request.client else None,
        request.headers.get("X-Forwarded-For"),
    )


def cart_session(request: Request) -> str | None:
    """Идентификатор гостевой корзины для текущего запроса.

    Читать его надо именно из ``request.state``, а не из ``request.cookies``:
    при первом обращении гостя cookie ещё нет, middleware генерирует
    идентификатор и кладёт его в state. Роутер, смотревший в cookies,
    получил бы пустое значение — и первая же добавленная позиция
    оказалась бы привязана к пустой сессии и терялась.
    """
    return getattr(request.state, "cart_session", None) or request.cookies.get("pulse_cart")


CartSession = Annotated[str | None, Depends(cart_session)]


async def get_request_id(request: Request) -> str:
    return getattr(request.state, "request_id", "")


async def pagination_params(
    page: int = 1,
    limit: int = 24,
) -> tuple[int, int]:
    """Единые параметры постраничной выдачи с жёстким потолком.

    Ограничение сверху защищает и БД, и ответ: без него limit=100000
    выгружает весь каталог одним запросом (раздел 12 ТЗ).
    """
    if page < 1:
        page = 1
    limit = max(1, min(limit, 100))
    return page, limit


PaginationParams = Annotated[tuple[int, int], Depends(pagination_params)]
RequestIP = Annotated[str, Depends(get_client_ip)]


async def db_session() -> AsyncIterator[AsyncSession]:
    """Явная зависимость-обёртка — удобна для фоновых задач и CLI."""
    async for session in get_db():
        yield session
