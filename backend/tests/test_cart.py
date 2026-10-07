"""Корзина, избранное, сравнение (разделы 5.5–5.8 ТЗ).

Тесты проверяют то, что чаще всего ломается и что приводит к потере
денег или заказу: обрезку по остатку, отказ положить больше доступного,
изоляцию корзины между гостями и слияние при входе.
"""

from __future__ import annotations

from decimal import Decimal
from uuid import uuid4

import pytest_asyncio
from httpx import ASGITransport, AsyncClient


class TestCartGuestSession:
    """Гостевая корзина опознаётся по cookie (раздел 5.8)."""

    async def test_cookie_is_issued(self, client: AsyncClient) -> None:
        response = await client.get("/api/v1/cart")
        assert response.status_code == 200
        assert "pulse_cart" in response.cookies or "pulse_cart" in client.cookies

    async def test_first_add_is_not_lost(self, client: AsyncClient) -> None:
        """Регрессия: позиция, добавленная до получения cookie, исчезала.

        Middleware выдаёт идентификатор в request.state, а роутер читал
        request.cookies — на первом запросе там было пусто.
        """
        product_id = await _seed_product(client, stock=10)
        add = await client.post(
            "/api/v1/cart/items",
            json={"product_id": product_id, "quantity": 1},
        )
        assert add.status_code == 200

        reread = await client.get("/api/v1/cart")
        assert reread.json()["totals"]["items_count"] == 1

    async def test_cart_survives_next_request(self, client: AsyncClient) -> None:
        product_id = await _seed_product(client, stock=5)
        await client.post("/api/v1/cart/items", json={"product_id": product_id, "quantity": 2})
        cart = (await client.get("/api/v1/cart")).json()
        assert cart["items"][0]["quantity"] == 2

    async def test_totals_are_sum_of_lines(self, client: AsyncClient) -> None:
        """Раздел 22: суммы считает сервер, а не клиент."""
        product_id = await _seed_product(client, stock=10, price="1500.00")
        await client.post("/api/v1/cart/items", json={"product_id": product_id, "quantity": 3})
        totals = (await client.get("/api/v1/cart")).json()["totals"]
        assert Decimal(totals["subtotal"]) == Decimal("4500.00")
        assert Decimal(totals["total"]) == Decimal("4500.00")

    async def test_line_total_matches_unit_price(self, client: AsyncClient) -> None:
        product_id = await _seed_product(client, stock=10, price="999.50")
        await client.post("/api/v1/cart/items", json={"product_id": product_id, "quantity": 2})
        item = (await client.get("/api/v1/cart")).json()["items"][0]
        assert Decimal(item["line_total"]) == Decimal("1999.00")


class TestCartStockLimits:
    """Раздел 5.8: нельзя заказать больше, чем есть."""

    async def test_add_more_than_stock_is_capped_with_notice(self, client: AsyncClient) -> None:
        product_id = await _seed_product(client, stock=3)
        response = await client.post(
            "/api/v1/cart/items",
            json={"product_id": product_id, "quantity": 3},
        )
        # Сначала кладём 3, потом просим ещё 9 — итого 12 при остатке 3.
        response = await client.post(
            "/api/v1/cart/items",
            json={"product_id": product_id, "quantity": 9},
        )
        body = response.json()
        assert body["items"][0]["quantity"] == 3
        assert body["notices"], "покупатель должен получить сообщение о нехватке"
        notice = body["notices"][0]
        assert notice["code"] == "insufficient_stock"
        assert notice["available"] == 3
        assert "Доступно только" in notice["message"]

    async def test_out_of_stock_product_is_rejected(self, client: AsyncClient) -> None:
        product_id = await _seed_product(client, stock=0, status="out_of_stock")
        response = await client.post(
            "/api/v1/cart/items",
            json={"product_id": product_id, "quantity": 1},
        )
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "insufficient_stock"

    async def test_discontinued_product_is_rejected(self, client: AsyncClient) -> None:
        product_id = await _seed_product(client, stock=10, status="discontinued")
        response = await client.post(
            "/api/v1/cart/items",
            json={"product_id": product_id, "quantity": 1},
        )
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "product_unavailable"

    async def test_update_is_capped_by_stock(self, client: AsyncClient) -> None:
        product_id = await _seed_product(client, stock=2)
        await client.post("/api/v1/cart/items", json={"product_id": product_id, "quantity": 1})
        item_id = (await client.get("/api/v1/cart")).json()["items"][0]["id"]

        response = await client.patch(
            f"/api/v1/cart/items/{item_id}",
            json={"quantity": 40},
        )
        assert response.json()["items"][0]["quantity"] == 2
        assert response.json()["notices"]

    async def test_zero_quantity_is_rejected_by_schema(self, client: AsyncClient) -> None:
        product_id = await _seed_product(client, stock=5)
        response = await client.post(
            "/api/v1/cart/items",
            json={"product_id": product_id, "quantity": 0},
        )
        assert response.status_code == 422

    async def test_exceeds_stock_flag_is_set(self, client: AsyncClient) -> None:
        """Позиция, где остаток упал ниже количества, помечается явно."""
        product_id = await _seed_product(client, stock=5)
        await client.post("/api/v1/cart/items", json={"product_id": product_id, "quantity": 4})
        await _set_stock(client, product_id, 1)

        cart = (await client.get("/api/v1/cart")).json()
        assert cart["items"][0]["exceeds_stock"] is True
        assert cart["unavailable_count"] == 1
        assert cart["notices"]


class TestCartOperations:
    async def test_remove_item(self, client: AsyncClient) -> None:
        product_id = await _seed_product(client, stock=5)
        await client.post("/api/v1/cart/items", json={"product_id": product_id, "quantity": 1})
        item_id = (await client.get("/api/v1/cart")).json()["items"][0]["id"]

        response = await client.delete(f"/api/v1/cart/items/{item_id}")
        assert response.json()["items"] == []

    async def test_clear_cart(self, client: AsyncClient) -> None:
        first = await _seed_product(client, stock=5)
        second = await _seed_product(client, stock=5)
        await client.post("/api/v1/cart/items", json={"product_id": first, "quantity": 1})
        await client.post("/api/v1/cart/items", json={"product_id": second, "quantity": 1})

        response = await client.delete("/api/v1/cart")
        assert response.json()["items"] == []
        assert (await client.get("/api/v1/cart")).json()["items"] == []

    async def test_same_product_added_twice_increases_quantity(
        self,
        client: AsyncClient,
    ) -> None:
        product_id = await _seed_product(client, stock=10)
        await client.post("/api/v1/cart/items", json={"product_id": product_id, "quantity": 2})
        response = await client.post(
            "/api/v1/cart/items",
            json={"product_id": product_id, "quantity": 3},
        )
        body = response.json()
        assert len(body["items"]) == 1
        assert body["items"][0]["quantity"] == 5

    async def test_unknown_item_returns_404(self, client: AsyncClient) -> None:
        response = await client.delete("/api/v1/cart/items/00000000-0000-0000-0000-000000000000")
        assert response.status_code == 404


class TestCartIsolation:
    """Два гостя не должны видеть корзину друг друга."""

    async def test_carts_do_not_leak_between_guests(self, client: AsyncClient) -> None:
        from app.main import app

        product_id = await _seed_product(client, stock=10)
        await client.post("/api/v1/cart/items", json={"product_id": product_id, "quantity": 1})

        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
        ) as second:
            empty = (await second.get("/api/v1/cart")).json()
            assert empty["items"] == []


class TestFavorites:
    async def test_favorites_require_auth(self, client: AsyncClient) -> None:
        response = await client.get("/api/v1/favorites")
        assert response.status_code == 401

    async def test_add_and_list(self, client: AsyncClient, auth_headers: dict) -> None:
        product_id = await _seed_product(client, stock=5, price="5000.00")

        added = await client.post(
            f"/api/v1/favorites/{product_id}",
            headers=auth_headers,
        )
        assert added.status_code == 201
        assert added.json()["is_favorite"] is True

        listing = (await client.get("/api/v1/favorites", headers=auth_headers)).json()
        assert listing["total"] == 1
        assert listing["items"][0]["price"] == "5000.00"
        assert listing["items"][0]["price_changed"] is False

    async def test_price_change_is_reported(self, client: AsyncClient, auth_headers: dict) -> None:
        """Раздел 5.6: показываем изменение цены относительно добавления."""
        product_id = await _seed_product(client, stock=5, price="5000.00")
        await client.post(f"/api/v1/favorites/{product_id}", headers=auth_headers)
        await _set_price(client, product_id, "4000.00")

        listing = (await client.get("/api/v1/favorites", headers=auth_headers)).json()
        item = listing["items"][0]
        assert item["price_changed"] is True
        assert Decimal(item["price_delta"]) == Decimal("-1000.00")
        assert listing["attention_count"] == 1

    async def test_price_restored_means_no_change(
        self, client: AsyncClient, auth_headers: dict
    ) -> None:
        product_id = await _seed_product(client, stock=5, price="5000.00")
        await client.post(f"/api/v1/favorites/{product_id}", headers=auth_headers)
        await _set_price(client, product_id, "4000.00")
        await _set_price(client, product_id, "5000.00")

        listing = (await client.get("/api/v1/favorites", headers=auth_headers)).json()
        assert listing["items"][0]["price_changed"] is False

    async def test_remove(self, client: AsyncClient, auth_headers: dict) -> None:
        product_id = await _seed_product(client, stock=5)
        await client.post(f"/api/v1/favorites/{product_id}", headers=auth_headers)
        removed = await client.delete(f"/api/v1/favorites/{product_id}", headers=auth_headers)
        assert removed.json()["is_favorite"] is False
        assert (await client.get("/api/v1/favorites", headers=auth_headers)).json()["total"] == 0

    async def test_adding_twice_is_idempotent(
        self, client: AsyncClient, auth_headers: dict
    ) -> None:
        product_id = await _seed_product(client, stock=5)
        await client.post(f"/api/v1/favorites/{product_id}", headers=auth_headers)
        await client.post(f"/api/v1/favorites/{product_id}", headers=auth_headers)
        listing = (await client.get("/api/v1/favorites", headers=auth_headers)).json()
        assert listing["total"] == 1


class TestCompare:
    """Раздел 5.5: не больше четырёх товаров и только одной категории."""

    async def test_compare_two_same_category(self, client: AsyncClient) -> None:
        first = await _seed_product(
            client, stock=5, category="processory", specs={"cpu.socket": "AM5"}
        )
        second = await _seed_product(
            client, stock=5, category="processory", specs={"cpu.socket": "AM4"}
        )

        response = await client.post("/api/v1/compare", json={"product_ids": [first, second]})
        body = response.json()
        assert response.status_code == 200
        assert len(body["products"]) == 2
        # Хелпер именует категорию со своим префиксом, чтобы не пересекаться
        # с реальным каталогом.
        assert body["category"]["slug"] == "cat-processory"

    async def test_mixed_categories_are_rejected(self, client: AsyncClient) -> None:
        first = await _seed_product(client, stock=5, category="processory")
        second = await _seed_product(client, stock=5, category="ssd")

        response = await client.post("/api/v1/compare", json={"product_ids": [first, second]})
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "mixed_categories"

    async def test_more_than_four_is_rejected(self, client: AsyncClient) -> None:
        ids = [await _seed_product(client, stock=5, category="processory") for _ in range(5)]
        response = await client.post("/api/v1/compare", json={"product_ids": ids})
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "too_many_products_to_compare"

    async def test_four_products_allowed(self, client: AsyncClient) -> None:
        ids = [await _seed_product(client, stock=5, category="processory") for _ in range(4)]
        response = await client.post("/api/v1/compare", json={"product_ids": ids})
        assert response.status_code == 200

    async def test_differences_are_marked(self, client: AsyncClient) -> None:
        first = await _seed_product(
            client, stock=5, category="ssd", specs={"storage.capacity": 1024}
        )
        second = await _seed_product(
            client, stock=5, category="ssd", specs={"storage.capacity": 2048}
        )

        body = (await client.post("/api/v1/compare", json={"product_ids": [first, second]})).json()
        differing = [row for row in body["attributes"] if row["is_different"]]
        assert differing, "различающиеся параметры должны быть помечены"
        row = next(r for r in differing if r["key"] == "storage.capacity")
        assert row["values"] == ["1024", "2048"]

    async def test_empty_list_is_rejected(self, client: AsyncClient) -> None:
        response = await client.post("/api/v1/compare", json={"product_ids": []})
        assert response.status_code == 422

    async def test_duplicate_ids_are_collapsed(self, client: AsyncClient) -> None:
        product_id = await _seed_product(client, stock=5, category="ssd")
        response = await client.post(
            "/api/v1/compare",
            json={"product_ids": [product_id, product_id]},
        )
        assert response.status_code == 200
        assert len(response.json()["products"]) == 1


# ── Вспомогательные функции ──


async def _seed_product(
    client: AsyncClient,
    *,
    stock: int = 5,
    price: str = "1000.00",
    category: str = "ssd",
    status: str = "in_stock",
    specs: dict | None = None,
) -> str:
    """Создаёт категорию, бренд, товар и характеристики прямо в тестовой БД."""
    from sqlalchemy import select

    from app.db.session import session_scope
    from app.models.catalog import AttributeDef, Brand, Category, Product, ProductSpec

    async with session_scope() as session:
        slug = f"cat-{category}"
        result = await session.execute(select(Category).where(Category.slug == slug))
        category_row = result.scalar_one_or_none()
        if category_row is None:
            category_row = Category(name=category.title(), slug=slug, level=1)
            session.add(category_row)
            await session.flush()

        result = await session.execute(select(Brand).where(Brand.slug == "test-brand"))
        brand = result.scalar_one_or_none()
        if brand is None:
            brand = Brand(name="TestBrand", slug="test-brand")
            session.add(brand)
            await session.flush()

        sku = f"SKU-{uuid4()}"
        product = Product(
            slug=f"product-{sku.lower()}",
            sku=sku,
            name=f"Тестовый товар {sku}",
            category_id=category_row.id,
            brand_id=brand.id,
            price=Decimal(price),
            stock_quantity=stock,
            status=status,
        )
        session.add(product)
        await session.flush()

        for key, value in (specs or {}).items():
            attribute = await session.execute(select(AttributeDef).where(AttributeDef.key == key))
            definition = attribute.scalar_one_or_none()
            if definition is None:
                definition = AttributeDef(key=key, name=key, data_type="number", is_filterable=True)
                session.add(definition)
                await session.flush()
            session.add(
                ProductSpec(
                    product_id=product.id,
                    attribute_id=definition.id,
                    # Колонка выбирается по содержимому: тест задаёт и числа
                    # (1024), и строки (AM5), а типы у них разные.
                    value_num=Decimal(str(value)) if isinstance(value, int | float) else None,
                    value_text=None if isinstance(value, int | float) else str(value),
                )
            )
        await session.flush()
        product_id = str(product.id)
        await session.commit()

    return product_id


async def _set_stock(client: AsyncClient, product_id: str, stock: int) -> None:
    from sqlalchemy import update

    from app.db.session import session_scope
    from app.models.catalog import Product

    async with session_scope() as session:
        await session.execute(
            update(Product).where(Product.id == product_id).values(stock_quantity=stock)
        )
        await session.commit()


async def _set_price(client: AsyncClient, product_id: str, price: str) -> None:
    from sqlalchemy import update

    from app.db.session import session_scope
    from app.models.catalog import Product

    async with session_scope() as session:
        await session.execute(
            update(Product).where(Product.id == product_id).values(price=Decimal(price))
        )
        await session.commit()


@pytest_asyncio.fixture
async def auth_headers(client: AsyncClient) -> dict:
    """Регистрирует покупателя и возвращает заголовок авторизации."""
    from app.db.session import session_scope
    from app.models.user import User

    email = "buyer@example.com"
    async with session_scope() as session:
        from sqlalchemy import select

        user = (await session.execute(select(User).where(User.email == email))).scalar_one_or_none()
        if user is None:
            from app.core.security import hash_password

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
