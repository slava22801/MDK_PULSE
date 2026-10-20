"""Раздел «Остатки»: менеджер правит количество товара (раздел 6.1 ТЗ).

Проверяются две вещи, которые легко спутать между собой:

* право сотрудника: менеджер меняет остатки, но по-прежнему не видит
  каталог с ценами и закупочными ценами;
* смысл числа: «осталось 5 штук» — это про то, сколько можно продать,
  а не про то, что лежит на складе; зарезервированные единицы в это число
  не входят и при правке не теряются.
"""

from __future__ import annotations

from uuid import uuid4


async def _headers(client, role: str) -> dict:
    """Создаёт сотрудника с нужной ролью и возвращает заголовок авторизации."""
    from sqlalchemy import select

    from app.core.security import hash_password
    from app.db.session import session_scope
    from app.models.user import User

    email = f"{role}-{uuid4().hex[:8]}@example.com"
    async with session_scope() as session:
        user = (await session.execute(select(User).where(User.email == email))).scalar_one_or_none()
        if user is None:
            session.add(
                User(
                    email=email,
                    password_hash=hash_password("parol123"),
                    first_name="Сотрудник",
                    last_name=role,
                    role=role,
                    email_verified=True,
                )
            )
            await session.commit()

    response = await client.post(
        "/api/v1/auth/login", json={"email": email, "password": "parol123"}
    )
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['tokens']['access_token']}"}


async def _admin_headers(client) -> dict:
    return await _headers(client, "admin")


async def _manager_headers(client) -> dict:
    return await _headers(client, "manager")


async def _make_product(
    client, *, stock: int = 10, reserved: int = 0, min_stock: int = 0
) -> dict:
    """Создаёт товар и выставляет ему резерв.

    Резерв ставится напрямую в базе: в публичной схеме товара такого поля
    нет — резерв появляется сам, когда товар кладут в корзину.
    """
    from sqlalchemy import select

    from app.db.session import session_scope
    from app.models.catalog import Category, Product

    async with session_scope() as session:
        category = (await session.execute(select(Category).limit(1))).scalar_one()
        suffix = uuid4().hex[:10]
        product = Product(
            name="Товар для остатков",
            slug=f"prod-{suffix}",
            sku=f"SKU-{suffix}",
            category_id=category.id,
            price=1000,
            stock_quantity=stock,
            reserved_quantity=reserved,
            min_stock=min_stock,
        )
        session.add(product)
        await session.commit()
        await session.refresh(product)
        return {"id": str(product.id), "sku": product.sku}


class TestStockAccess:
    """Права на раздел остатков."""

    async def test_stock_requires_auth(self, client) -> None:
        assert (await client.get("/api/v1/admin/stock")).status_code == 401

    async def test_customer_cannot_read_stock(self, client, auth_headers) -> None:
        response = await client.get("/api/v1/admin/stock", headers=auth_headers)
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "insufficient_role"

    async def test_manager_can_read_stock(self, client) -> None:
        response = await client.get("/api/v1/admin/stock", headers=await _manager_headers(client))
        assert response.status_code == 200, response.text
        body = response.json()
        assert "items" in body
        assert body["limit"] == 25

    async def test_manager_can_set_stock(self, client) -> None:
        product = await _make_product(client, stock=10)
        response = await client.patch(
            f"/api/v1/admin/stock/{product['id']}",
            headers=await _manager_headers(client),
            json={"available_quantity": 4},
        )
        assert response.status_code == 200, response.text
        assert response.json()["available_quantity"] == 4

    async def test_manager_still_cannot_edit_catalog(self, client) -> None:
        """Менеджер получил остатки, но не каталог: закупочные цены ему не нужны."""
        response = await client.get(
            "/api/v1/admin/products", headers=await _manager_headers(client)
        )
        assert response.status_code == 403

    async def test_stock_list_hides_purchase_price(self, client) -> None:
        """В разделе остатков нет закупочной цены — она доступна администратору."""
        await _make_product(client, stock=10)
        response = await client.get("/api/v1/admin/stock", headers=await _manager_headers(client))
        assert response.status_code == 200
        for item in response.json()["items"]:
            assert "purchase_price" not in item


class TestSetAvailableQuantity:
    """Смысл установки количества."""

    async def test_sets_exact_available_quantity(self, client) -> None:
        product = await _make_product(client, stock=10)
        response = await client.patch(
            f"/api/v1/admin/stock/{product['id']}",
            headers=await _manager_headers(client),
            json={"available_quantity": 7, "reason": "инвентаризация"},
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["available_quantity"] == 7
        assert body["stock_quantity"] == 7
        assert body["reserved_quantity"] == 0

    async def test_reserved_units_are_kept(self, client) -> None:
        """Резерв не съедается: остаток на складе = осталось + зарезервировано."""
        product = await _make_product(client, stock=10, reserved=3)
        response = await client.patch(
            f"/api/v1/admin/stock/{product['id']}",
            headers=await _manager_headers(client),
            json={"available_quantity": 5},
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["available_quantity"] == 5
        assert body["reserved_quantity"] == 3
        assert body["stock_quantity"] == 8

    async def test_zero_stops_selling(self, client) -> None:
        """«Осталось 0» — товар больше не продаётся."""
        product = await _make_product(client, stock=10)
        response = await client.patch(
            f"/api/v1/admin/stock/{product['id']}",
            headers=await _manager_headers(client),
            json={"available_quantity": 0},
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["available_quantity"] == 0
        # Витрина показывает статус, выведенный из остатка.
        assert body["availability"] == "out_of_stock"

    async def test_negative_quantity_rejected(self, client) -> None:
        product = await _make_product(client, stock=10)
        response = await client.patch(
            f"/api/v1/admin/stock/{product['id']}",
            headers=await _manager_headers(client),
            json={"available_quantity": -1},
        )
        assert response.status_code == 422

    async def test_unknown_product_is_404(self, client) -> None:
        response = await client.patch(
            f"/api/v1/admin/stock/{uuid4()}",
            headers=await _manager_headers(client),
            json={"available_quantity": 1},
        )
        assert response.status_code == 404

    async def test_availability_reevaluated_after_change(self, client) -> None:
        """Статус для сотрудника считается из остатка, а не берётся из базы."""
        product = await _make_product(client, stock=10)
        response = await client.patch(
            f"/api/v1/admin/stock/{product['id']}",
            headers=await _manager_headers(client),
            json={"available_quantity": 2},
        )
        assert response.status_code == 200
        assert response.json()["availability"] == "low_stock"

    async def test_change_is_audited(self, client) -> None:
        """Раздел 10: правка остатка попадает в журнал с числами до и после."""
        product = await _make_product(client, stock=10)
        headers = await _admin_headers(client)
        await client.patch(
            f"/api/v1/admin/stock/{product['id']}",
            headers=headers,
            json={"available_quantity": 6, "reason": "поставка"},
        )

        log = (await client.get("/api/v1/admin/audit-log?limit=20", headers=headers)).json()
        entry = next(e for e in log["items"] if e["action"] == "product.stock_set")
        assert entry["details"]["available_before"] == 10
        assert entry["details"]["available_after"] == 6
        assert entry["details"]["reason"] == "поставка"


class TestStockList:
    """Список остатков: фильтры и сортировка."""

    async def test_list_contains_stock_numbers(self, client) -> None:
        await _make_product(client, stock=10, reserved=2)
        response = await client.get("/api/v1/admin/stock", headers=await _manager_headers(client))
        assert response.status_code == 200
        item = response.json()["items"][0]
        assert item["stock_quantity"] == 10
        assert item["reserved_quantity"] == 2
        assert item["available_quantity"] == 8

    async def test_only_low_filter_keeps_empty_and_low(self, client) -> None:
        """В фильтр попадает то, что пора закупать: не больше точки заказа."""
        healthy = await _make_product(client, stock=100, min_stock=10)
        low = await _make_product(client, stock=3, min_stock=10)
        empty = await _make_product(client, stock=0, min_stock=10)

        response = await client.get(
            "/api/v1/admin/stock?only_low=true&limit=100", headers=await _manager_headers(client)
        )
        assert response.status_code == 200
        skus = {item["sku"] for item in response.json()["items"]}
        assert healthy["sku"] not in skus
        assert low["sku"] in skus
        assert empty["sku"] in skus

    async def test_search_by_sku(self, client) -> None:
        product = await _make_product(client, stock=10)
        response = await client.get(
            f"/api/v1/admin/stock?search={product['sku']}", headers=await _manager_headers(client)
        )
        assert response.status_code == 200
        items = response.json()["items"]
        assert len(items) == 1
        assert items[0]["sku"] == product["sku"]
