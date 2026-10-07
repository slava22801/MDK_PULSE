"""Фикстуры pytest.

Тесты без маркера ``integration`` работают всегда, остальные требуют
``TEST_DATABASE_URL`` и молча пропускаются, если её нет. Так ``pytest``
зелёный на пустой машине и полный в docker-compose.
"""

from __future__ import annotations

import os

import pytest
import pytest_asyncio

# Переключение на тестовую базу должно произойти ДО импорта app.main:
# настройки и движок создаются один раз при первом импорте модуля.
# conftest импортируется раньше тестовых модулей, поэтому менять
# переменные окружения здесь безопасно.
#
# Защита от катастрофы: если целевая база не называется «*test»,
# набор прогоняться не будет — иначе очистка данных в фикстуре
# уничтожила бы стенд.
_TEST_URL = os.getenv("TEST_DATABASE_URL", "").strip()
if _TEST_URL:
    _db_name = _TEST_URL.rsplit("/", 1)[-1].split("?", 1)[0]
    if "test" not in _db_name.lower():
        raise RuntimeError(
            f"TEST_DATABASE_URL указывает на базу «{_db_name}», а не на тестовую. "
            "Проверки очищают таблицы — откажитесь, если это не тестовая база."
        )
    os.environ["DATABASE_URL"] = _TEST_URL
    os.environ["APP_ENV"] = "test"


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line("markers", "integration: требует TEST_DATABASE_URL")


@pytest.fixture(scope="session")
def test_database_url() -> str:
    url = os.getenv("TEST_DATABASE_URL", "").strip()
    if not url:
        pytest.skip("TEST_DATABASE_URL не задан — интеграционные тесты пропущены")
    return url


@pytest_asyncio.fixture(scope="session", loop_scope="session")
async def prepared_database(test_database_url: str) -> str:
    """Готовит схему тестовой базы через реальные миграции Alembic.

    ``Base.metadata.create_all`` не годится: в моделях есть индексы с
    операторными классами ``pg_trgm``, а расширение создаётся миграцией
    ``0001_foundation``. Прогон миграций заодно проверяет, что схема
    собирается с нуля.

    Само подключение асинхронное (драйвер asyncpg), а ``alembic`` внутри
    зовёт ``asyncio.run`` — поэтому он выполняется в отдельном потоке, где
    работающего цикла событий нет.
    """
    import asyncio

    from sqlalchemy import text

    from app.db.session import engine

    async with engine.begin() as connection:
        await connection.execute(text("DROP SCHEMA IF EXISTS public CASCADE"))
        await connection.execute(text("CREATE SCHEMA public"))

    await asyncio.to_thread(_run_alembic, test_database_url)
    return test_database_url


def _run_alembic(url: str) -> None:
    from alembic.config import Config

    from alembic import command

    config = Config("alembic.ini")
    config.set_main_option("sqlalchemy.url", url)
    command.upgrade(config, "head")


@pytest_asyncio.fixture
async def client(test_database_url: str, prepared_database: str):
    """HTTP-клиент против тестовой базы.

    База общая на весь набор: тесты не конкурируют по времени, а данные
    чистятся фикстурой-хелпером, а не пересозданием схемы на каждый тест —
    это на порядок быстрее.
    """
    from httpx import ASGITransport, AsyncClient

    from app.main import app

    await _reset_data()

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


async def _reset_data() -> None:
    """Очищает содержимое таблиц и заново создаёт справочные данные."""
    from sqlalchemy import text

    from app.db.session import engine

    tables = (
        "notifications",
        "idempotency_keys",
        "admin_audit_log",
        "favorites",
        "cart_items",
        "review_images",
        "reviews",
        "promocode_usages",
        "promocode_products",
        "promocode_categories",
        "promocodes",
        "product_specs",
        "product_images",
        "product_relations",
        "products",
        "attribute_defs",
        "email_tokens",
        "user_sessions",
        "addresses",
        "users",
        "banners",
        "faq_items",
        "pages",
        "settings",
        "pickup_points",
        # Справочники тоже чистим: иначе фикстура создаёт «Тестовый бренд»
        # заново на каждом тесте и упирается в brands_name_key.
        "brands",
        "categories",
    )
    async with engine.begin() as connection:
        await connection.execute(text(f"TRUNCATE {', '.join(tables)} RESTART IDENTITY CASCADE"))
    await _seed_reference_data()


async def _seed_reference_data() -> None:
    """Создаёт справочники, без которых магазин не работает.

    Без категорий, брендов и характеристик часть проверок выглядела бы как
    проверка пустого каталога: импорт, характеристики товара и фильтры
    падали бы не из-за ошибки в коде, а из-за отсутствия данных.

    Набор характеристик берётся из боевого ``app.seed_data.catalog_seed`` —
    тесты работают с той же схемой, что и витрина.
    """
    from app.db.session import session_scope
    from app.models.catalog import AttributeDef, Brand, Category
    from app.seed_data.catalog_seed import ATTRIBUTES

    async with session_scope() as session:
        category = Category(
            name="Тестовая категория",
            slug="test-category",
            level=1,
            sort_order=0,
        )
        session.add(category)
        session.add(Brand(name="Тестовый бренд", slug="test-brand"))
        for key, name, data_type, unit, widget, sort_order, _comparable, options in ATTRIBUTES:
            session.add(
                AttributeDef(
                    key=key,
                    name=name,
                    data_type=data_type,
                    unit=unit,
                    filter_widget=widget,
                    options=(
                        [{"value": value, "label": value} for value in options] if options else None
                    ),
                    is_filterable=True,
                    is_comparable=True,
                    sort_order=sort_order,
                    category_id=category.id,
                )
            )
        await session.flush()
        for definition in (
            await session.execute(
                AttributeDef.__table__.select().where(AttributeDef.category_id.is_not(None))
            )
        ).mappings():
            await session.execute(
                AttributeDef.__table__.update()
                .where(AttributeDef.key == definition["key"])
                .values(category_id=None)
            )
        await session.commit()


@pytest_asyncio.fixture
async def auth_headers(client):
    """Регистрирует покупателя и возвращает заголовок авторизации."""
    from sqlalchemy import select

    from app.core.security import hash_password
    from app.db.session import session_scope
    from app.models.user import User

    email = "buyer@example.com"
    async with session_scope() as session:
        user = (await session.execute(select(User).where(User.email == email))).scalar_one_or_none()
        if user is None:
            session.add(
                User(
                    email=email,
                    password_hash=hash_password("parol123"),
                    first_name="Тест",
                    last_name="Покупатель",
                    email_verified=True,
                )
            )
            await session.commit()

    response = await client.post(
        "/api/v1/auth/login",
        json={"email": email, "password": "parol123"},
    )
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['tokens']['access_token']}"}
