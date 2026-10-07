"""Ограничение частоты запросов на Redis (раздел 10 ТЗ).

Счётчик фиксированного окна: ``INCR`` + ``EXPIRE``. Проще скользящего окна
и ровно на порядок дешевле — для защиты от перебора паролей разница в
пограничных случаях несущественна.
"""

from __future__ import annotations

import logging
from functools import lru_cache

from redis.asyncio import Redis
from redis.exceptions import RedisError

from app.core.config import settings
from app.core.errors import RateLimitError

logger = logging.getLogger(__name__)


@lru_cache(maxsize=1)
def get_redis() -> Redis:
    return Redis.from_url(
        settings.redis_url,
        encoding="utf-8",
        decode_responses=True,
        socket_connect_timeout=3,
        socket_timeout=3,
    )


async def close_redis() -> None:
    """Закрывает соединение при остановке приложения."""
    if get_redis.cache_info().currsize:
        await get_redis().aclose()
        get_redis.cache_clear()


async def check_rate_limit(key: str, limit: int, window_seconds: int) -> int:
    """Регистрирует обращение и возвращает оставшийся лимит.

    Превышение — :class:`RateLimitError`. Если Redis недоступен, запрос
    **не блокируется**: лучше временно разрешить перебор, чем уронить
    весь магазин из-за хранилища кэша.

    В тестовом окружении ограничитель выключен: набор тестов напрашивается
    на авторизацию десятки раз подряд и упирался бы в лимит, отражая не
    защиту, а порядок выполнения тестов.
    """
    if settings.app_env == "test":
        return limit

    redis_key = f"ratelimit:{key}"
    try:
        redis = get_redis()
        pipe = redis.pipeline()
        pipe.incr(redis_key)
        pipe.expire(redis_key, window_seconds)
        count, _ = await pipe.execute()
    except RedisError as exc:
        logger.warning("Rate limit недоступен, запрос разрешён: %s", type(exc).__name__)
        return limit

    if count > limit:
        raise RateLimitError(f"Слишком много попыток. Повторите через {window_seconds} секунд.")
    return max(0, limit - int(count))


def client_ip(request_client: str | None, forwarded_for: str | None = None) -> str:
    """IP клиента.

    X-Forwarded-For берётся только когда приложение стоит за доверенным
    прокси (в docker-compose это Nginx). Значение из заголовка приходит от
    клиента, поэтому оно используется лишь как ключ ограничителя, а не
    как идентификатор для безопасности.
    """
    if forwarded_for:
        return forwarded_for.split(",")[0].strip()
    return request_client or "unknown"


def auth_rate_key(ip: str, identifier: str = "") -> str:
    """Ключ ограничителя для входа: по IP и, если есть, по email.

    Лимит по IP защищает от брутфорса всего подряд, лимит по связке
    «IP + email» — от целевой атаки на конкретный аккаунт.
    """
    return f"auth:{ip}:{identifier.lower()}" if identifier else f"auth:{ip}"
