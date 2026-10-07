"""Админ-панель: роли, аудит, товары, пользователи, импорт (разделы 6, 10, 14 ТЗ)."""

from __future__ import annotations

import io
from decimal import Decimal
from uuid import uuid4

import pytest


async def _admin_headers(client) -> dict:
    """Создаёт администратора и возвращает заголовок авторизации."""
    from sqlalchemy import select

    from app.core.security import hash_password
    from app.db.session import session_scope
    from app.models.user import User

    email = "admin@example.com"
    async with session_scope() as session:
        user = (await session.execute(select(User).where(User.email == email))).scalar_one_or_none()
        if user is None:
            session.add(
                User(
                    email=email,
                    password_hash=hash_password("parol123"),
                    first_name="Главный",
                    last_name="Администратор",
                    role="admin",
                    email_verified=True,
                )
            )
            await session.commit()

    response = await client.post(
        "/api/v1/auth/login", json={"email": email, "password": "parol123"}
    )
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['tokens']['access_token']}"}


async def _manager_headers(client) -> dict:
    from sqlalchemy import select

    from app.core.security import hash_password
    from app.db.session import session_scope
    from app.models.user import User

    email = "manager@example.com"
    async with session_scope() as session:
        user = (await session.execute(select(User).where(User.email == email))).scalar_one_or_none()
        if user is None:
            session.add(
                User(
                    email=email,
                    password_hash=hash_password("parol123"),
                    first_name="Менеджер",
                    last_name="Продаж",
                    role="manager",
                    email_verified=True,
                )
            )
            await session.commit()

    response = await client.post(
        "/api/v1/auth/login", json={"email": email, "password": "parol123"}
    )
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['tokens']['access_token']}"}


async def _make_category(client, name: str = "Тестовая категория") -> str:
    from sqlalchemy import select

    from app.db.session import session_scope
    from app.models.catalog import Category

    async with session_scope() as session:
        slug = f"cat-{uuid4().hex[:8]}"
        # Имя уникально: у категорий уникален slug, но не имя, а в отчёте
        # об импорте название категории ищется по имени.
        session.add(Category(name=f"{name} {slug[-6:]}", slug=slug, level=1))
        await session.commit()
        category = (
            await session.execute(select(Category).where(Category.slug == slug))
        ).scalar_one()
        return str(category.id)


async def _brand_id(client) -> str:
    """Id любого бренда: справочный создаёт фикстура, дополнительные — тестовые.

    Имя уникально: второй бренд с именем «Бренд» нарушил бы ограничение
    ``brands_name_key``.
    """
    from sqlalchemy import select

    from app.db.session import session_scope
    from app.models.catalog import Brand

    async with session_scope() as session:
        brand = (await session.execute(select(Brand).limit(1))).scalar_one_or_none()
        if brand is None:
            suffix = uuid4().hex[:8]
            brand = Brand(name=f"Бренд {suffix}", slug=f"b-{suffix}")
            session.add(brand)
            await session.commit()
        return str(brand.id)


class TestRoleIsolation:
    """Раздел 3.3 и 3.4: менеджер не администратор."""

    async def test_admin_orders_require_auth(self, client) -> None:
        assert (await client.get("/api/v1/admin/orders")).status_code == 401

    async def test_manager_sees_orders(self, client) -> None:
        response = await client.get("/api/v1/admin/orders", headers=await _manager_headers(client))
        assert response.status_code == 200

    async def test_manager_sees_statistics(self, client) -> None:
        response = await client.get(
            "/api/v1/admin/statistics", headers=await _manager_headers(client)
        )
        assert response.status_code == 200

    async def test_manager_cannot_touch_products(self, client) -> None:
        headers = await _manager_headers(client)
        response = await client.get("/api/v1/admin/products", headers=headers)
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "insufficient_role"

    async def test_manager_cannot_touch_users(self, client) -> None:
        response = await client.get("/api/v1/admin/users", headers=await _manager_headers(client))
        assert response.status_code == 403

    async def test_manager_cannot_read_audit_log(self, client) -> None:
        headers = await _manager_headers(client)
        response = await client.get("/api/v1/admin/audit-log", headers=headers)
        assert response.status_code == 403

    async def test_admin_can_see_products(self, client) -> None:
        response = await client.get("/api/v1/admin/products", headers=await _admin_headers(client))
        assert response.status_code == 200
        assert "total" in response.json()

    async def test_customer_is_not_admin(self, client, auth_headers) -> None:
        response = await client.get("/api/v1/admin/orders", headers=auth_headers)
        assert response.status_code == 403


class TestAdminProducts:
    async def test_create_product_with_specs(self, client) -> None:
        category_id = await _make_category(client)
        response = await client.post(
            "/api/v1/admin/products",
            headers=await _admin_headers(client),
            json={
                "name": "Видеокарта Palit RTX 4070 SUPER",
                "sku": f"SKU-{uuid4().hex[:10]}",
                "category_id": category_id,
                "brand_id": await _brand_id(client),
                "price": "54990.00",
                "old_price": "59990.00",
                "purchase_price": "44000.00",
                "stock_quantity": 4,
                "specs": {"gpu.memory_size": "12", "gpu.memory_type": "GDDR6X"},
            },
        )
        assert response.status_code == 201, response.text
        body = response.json()
        assert body["price"] == "54990.00"
        # Закупочная цена видна сотруднику — это единственная схема, где
        # она вообще есть (в публичной каталоге поля нет).
        assert body["purchase_price"] == "44000.00"
        # slug сгенерирован из названия, кириллица транслитерирована.
        assert body["slug"].startswith("videokarta-palit")

    async def test_specs_written_by_type(self, client) -> None:
        category_id = await _make_category(client)
        created = await client.post(
            "/api/v1/admin/products",
            headers=await _admin_headers(client),
            json={
                "name": "Тест характеристик",
                "sku": f"SKU-{uuid4().hex[:10]}",
                "category_id": category_id,
                "price": "1000.00",
                "specs": {"cpu.cores": "8", "gpu.memory_type": "GDDR6"},
            },
        )
        assert created.status_code == 201, created.text

        detail = await client.get(
            f"/api/v1/admin/products/{created.json()['id']}",
            headers=await _admin_headers(client),
        )
        specs = detail.json()["specs"]
        assert specs["cpu.cores"] == "8"
        assert specs["gpu.memory_type"] == "GDDR6"

    async def test_duplicate_sku_rejected(self, client) -> None:
        category_id = await _make_category(client)
        payload = {
            "name": "Дубль",
            "sku": f"SKU-{uuid4().hex[:10]}",
            "category_id": category_id,
            "price": "1000.00",
        }
        headers = await _admin_headers(client)
        created = await client.post("/api/v1/admin/products", headers=headers, json=payload)
        assert created.status_code == 201

        duplicate = await client.post("/api/v1/admin/products", headers=headers, json=payload)
        assert duplicate.status_code == 409
        assert duplicate.json()["error"]["code"] == "sku_exists"

    async def test_old_price_must_exceed_current(self, client) -> None:
        response = await client.post(
            "/api/v1/admin/products",
            headers=await _admin_headers(client),
            json={
                "name": "Неверная скидка",
                "sku": f"SKU-{uuid4().hex[:10]}",
                "category_id": await _make_category(client),
                "price": "5000.00",
                "old_price": "4000.00",
            },
        )
        assert response.status_code == 422

    async def test_stock_adjustment(self, client) -> None:
        category_id = await _make_category(client)
        created = await client.post(
            "/api/v1/admin/products",
            headers=await _admin_headers(client),
            json={
                "name": "Товар для остатков",
                "sku": f"SKU-{uuid4().hex[:10]}",
                "category_id": category_id,
                "price": "1000.00",
                "stock_quantity": 5,
            },
        )
        product_id = created.json()["id"]

        adjusted = await client.post(
            f"/api/v1/admin/products/{product_id}/stock",
            headers=await _admin_headers(client),
            json={"delta": 10, "reason": "поставка"},
        )
        assert adjusted.json()["stock_quantity"] == 15

        written_off = await client.post(
            f"/api/v1/admin/products/{product_id}/stock",
            headers=await _admin_headers(client),
            json={"delta": -100},
        )
        assert written_off.status_code == 400
        assert written_off.json()["error"]["code"] == "negative_stock"

    async def test_product_in_orders_cannot_be_deleted(self, client) -> None:
        """Критерий истории: товар из заказов удалить нельзя, только скрыть."""
        from sqlalchemy import select

        from app.db.session import session_scope
        from app.models.order import Order, OrderItem

        category_id = await _make_category(client)
        created = await client.post(
            "/api/v1/admin/products",
            headers=await _admin_headers(client),
            json={
                "name": "Товар из заказа",
                "sku": f"SKU-{uuid4().hex[:10]}",
                "category_id": category_id,
                "price": "1000.00",
            },
        )
        product_id = created.json()["id"]

        async with session_scope() as session:
            order = (await session.execute(select(Order).limit(1))).scalar_one_or_none()
            if order is not None:
                session.add(
                    OrderItem(
                        order_id=order.id,
                        product_id=product_id,
                        product_name="Товар из заказа",
                        sku="X",
                        quantity=1,
                        price=Decimal("1000.00"),
                        total_price=Decimal("1000.00"),
                    )
                )
                await session.commit()
                response = await client.delete(
                    f"/api/v1/admin/products/{product_id}",
                    headers=await _admin_headers(client),
                )
                assert response.status_code == 409
                assert response.json()["error"]["code"] == "product_in_orders"


class TestAdminUsers:
    async def test_block_and_unblock(self, client) -> None:

        from app.db.session import session_scope
        from app.models.user import User

        async with session_scope() as session:
            user = User(
                email=f"block-{uuid4().hex[:6]}@example.com",
                password_hash="x",
                first_name="Блокируемый",
                last_name="Пользователь",
            )
            session.add(user)
            await session.commit()
            user_id = user.id

        headers = await _admin_headers(client)
        blocked = await client.patch(
            f"/api/v1/admin/users/{user_id}?is_blocked=true", headers=headers
        )
        assert blocked.json()["is_active"] is False
        assert blocked.json()["blocked_at"] is not None

        unblocked = await client.patch(
            f"/api/v1/admin/users/{user_id}?is_blocked=false", headers=headers
        )
        assert unblocked.json()["is_active"] is True

    async def test_admin_cannot_block_self(self, client) -> None:
        headers = await _admin_headers(client)
        me = (await client.get("/api/v1/auth/me", headers=headers)).json()

        response = await client.patch(
            f"/api/v1/admin/users/{me['id']}?is_blocked=true", headers=headers
        )
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "cannot_block_self"

    async def test_role_change_recorded(self, client) -> None:
        from app.db.session import session_scope
        from app.models.user import User

        async with session_scope() as session:
            user = User(
                email=f"role-{uuid4().hex[:6]}@example.com",
                password_hash="x",
                first_name="Менеджер",
                last_name="Будущий",
            )
            session.add(user)
            await session.commit()
            user_id = user.id

        response = await client.patch(
            f"/api/v1/admin/users/{user_id}?role=manager",
            headers=await _admin_headers(client),
        )
        assert response.json()["role"] == "manager"


class TestAuditLog:
    """Раздел 10: каждое действие администратора попадает в журнал."""

    async def test_product_creation_is_logged(self, client) -> None:
        headers = await _admin_headers(client)
        await client.post(
            "/api/v1/admin/products",
            headers=headers,
            json={
                "name": "Аудируемый товар",
                "sku": f"SKU-{uuid4().hex[:10]}",
                "category_id": await _make_category(client),
                "price": "1000.00",
            },
        )

        log = (await client.get("/api/v1/admin/audit-log", headers=headers)).json()
        actions = [entry["action"] for entry in log["items"]]
        assert "product.created" in actions

    async def test_stock_change_is_logged_with_values(self, client) -> None:
        headers = await _admin_headers(client)
        created = await client.post(
            "/api/v1/admin/products",
            headers=headers,
            json={
                "name": "Товар для аудита остатков",
                "sku": f"SKU-{uuid4().hex[:10]}",
                "category_id": await _make_category(client),
                "price": "1000.00",
                "stock_quantity": 2,
            },
        )
        await client.post(
            f"/api/v1/admin/products/{created.json()['id']}/stock",
            headers=headers,
            json={"delta": 7, "reason": "приёмка"},
        )

        log = (await client.get("/api/v1/admin/audit-log?limit=20", headers=headers)).json()
        entry = next(e for e in log["items"] if e["action"] == "product.stock_adjusted")
        assert entry["details"]["before"] == 2
        assert entry["details"]["after"] == 9

    async def test_password_is_never_logged(self, client) -> None:
        """Раздел 10: в лог попадает факт сброса, но не сам пароль."""
        from app.db.session import session_scope
        from app.models.user import User

        async with session_scope() as session:
            user = User(
                email=f"pwd-{uuid4().hex[:6]}@example.com",
                password_hash="x",
                first_name="С",
                last_name="Б",
            )
            session.add(user)
            await session.commit()
            user_id = user.id

        headers = await _admin_headers(client)
        await client.patch(f"/api/v1/admin/users/{user_id}?password=NovyParol777", headers=headers)

        log = (await client.get("/api/v1/admin/audit-log?limit=50", headers=headers)).json()
        dump = str(log)
        assert "NovyParol777" not in dump
        assert "password_reset" in dump


class TestImport:
    """Раздел 14 ТЗ: проверка, отчёт, импорт."""

    def _csv(self) -> bytes:
        return (
            "Артикул;Название;Категория;Бренд;Цена;Количество;Гарантия\n"
            "IMP-T-001;Видеокарта Palit RTX 4070;Тестовая категория;Тестовый бренд;54 990,00;7;36\n"
            "IMP-T-002;Процессор AMD Ryzen 5 7600X;Тестовая категория;Тестовый бренд;"
            "21 990,00;12;36\n"
        ).encode()

    async def test_dry_run_reports_without_writing(self, client) -> None:
        headers = await _admin_headers(client)
        response = await client.post(
            "/api/v1/admin/products/import",
            headers=headers,
            files={"file": ("prices.csv", self._csv(), "text/csv")},
            data={"dry_run": "true"},
        )
        assert response.status_code == 200, response.text
        report = response.json()
        assert report["total_rows"] == 2
        assert report["created"] == 2
        assert report["errors"] == []
        assert "Предварительный отчёт" in report["message"]

        # Проверяем, что товаров действительно нет.
        check = await client.get("/api/v1/products?q=IMP-T-001")
        assert check.json()["total"] == 0

    async def test_real_import_creates_products(self, client) -> None:
        headers = await _admin_headers(client)
        response = await client.post(
            "/api/v1/admin/products/import",
            headers=headers,
            files={"file": ("prices.csv", self._csv(), "text/csv")},
            data={"dry_run": "false"},
        )
        assert response.status_code == 200, response.text
        assert response.json()["created"] == 2

        check = await client.get("/api/v1/products?q=IMP-T-001")
        assert check.json()["total"] == 1

    async def test_bad_rows_are_reported_with_numbers(self, client) -> None:
        payload = (
            "Артикул;Название;Категория;Бренд;Цена;Количество\n"
            "BAD-1;Нормальный товар;Тестовая категория;Тестовый бренд;1000;5\n"
            "BAD-2;Сломанная цена;Тестовая категория;Тестовый бренд;не число;5\n"
            ";Без артикула;Тестовая категория;Тестовый бренд;1000;5\n"
        ).encode()

        response = await client.post(
            "/api/v1/admin/products/import",
            headers=await _admin_headers(client),
            files={"file": ("bad.csv", payload, "text/csv")},
            data={"dry_run": "true"},
        )
        report = response.json()
        assert report["total_rows"] == 3
        assert report["created"] == 1
        messages = {error["message"] for error in report["errors"]}
        assert any("не является числом" in message for message in messages)
        assert any("артикул" in message.lower() for message in messages)
        # У каждой ошибки есть номер строки и колонка — по ним сотрудник
        # находит проблему в файле.
        assert all(error["row_number"] > 0 for error in report["errors"])

    async def test_unsupported_format_rejected(self, client) -> None:
        response = await client.post(
            "/api/v1/admin/products/import",
            headers=await _admin_headers(client),
            files={"file": ("prices.txt", "Артикул;Цена".encode(), "text/plain")},
            data={"dry_run": "true"},
        )
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "unsupported_format"

    async def test_missing_columns_rejected(self, client) -> None:
        response = await client.post(
            "/api/v1/admin/products/import",
            headers=await _admin_headers(client),
            files={"file": ("prices.csv", "Артикул;Цена\nX;100", "text/csv")},
            data={"dry_run": "true"},
        )
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "missing_columns"

    async def test_xlsx_is_supported(self, client) -> None:
        from openpyxl import Workbook

        workbook = Workbook()
        sheet = workbook.active
        sheet.append(["Артикул", "Название", "Категория", "Бренд", "Цена", "Количество"])
        sheet.append(
            ["IMP-X-001", "Товар из XLSX", "Тестовая категория", "Тестовый бренд", 12345.00, 4]
        )
        buffer = io.BytesIO()
        workbook.save(buffer)
        buffer.seek(0)

        response = await client.post(
            "/api/v1/admin/products/import",
            headers=await _admin_headers(client),
            files={
                "file": (
                    "prices.xlsx",
                    buffer.read(),
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
            data={"dry_run": "true"},
        )
        assert response.status_code == 200, response.text
        assert response.json()["created"] == 1


class TestAdminOrders:
    async def test_list_and_search(self, client) -> None:
        headers = await _manager_headers(client)
        response = await client.get("/api/v1/admin/orders?limit=5", headers=headers)
        assert response.status_code == 200
        body = response.json()
        assert "items" in body
        assert body["limit"] == 5

    async def test_filter_by_status(self, client) -> None:
        headers = await _manager_headers(client)
        response = await client.get("/api/v1/admin/orders?status=new", headers=headers)
        assert response.status_code == 200
        for item in response.json()["items"]:
            assert item["status"] == "new"

    async def test_invalid_status_transition_lists_allowed(self, client, auth_headers) -> None:
        """Раздел 5.10: недопустимый переход объясняет, что можно вместо него."""
        from sqlalchemy import select

        from app.db.session import session_scope
        from app.models.order import Order

        async with session_scope() as session:
            order = (await session.execute(select(Order).limit(1))).scalar_one_or_none()
            if order is None:
                pytest.skip("нет заказов для проверки")
            order_id = order.id

        response = await client.patch(
            f"/api/v1/admin/orders/{order_id}",
            headers=await _admin_headers(client),
            json={"status": "completed"},
        )
        assert response.status_code == 409
        error = response.json()["error"]
        assert error["code"] == "invalid_status_transition"
        assert "allowed" in error["fields"]


class TestStatistics:
    async def test_statistics_shape(self, client) -> None:
        response = await client.get(
            "/api/v1/admin/statistics", headers=await _manager_headers(client)
        )
        assert response.status_code == 200, response.text
        body = response.json()
        for key in (
            "revenue_total",
            "orders_total",
            "average_order_value",
            "products_total",
            "best_sellers",
            "low_stock_items",
            "sales_by_day",
        ):
            assert key in body

    async def test_best_sellers_have_shape(self, client) -> None:
        response = await client.get(
            "/api/v1/admin/statistics", headers=await _admin_headers(client)
        )
        for item in response.json()["best_sellers"]:
            assert {"id", "name", "sku", "sold"} <= set(item)


class TestPromocodes:
    async def test_create_and_check(self, client) -> None:
        headers = await _admin_headers(client)
        created = await client.post(
            "/api/v1/admin/promocodes",
            headers=headers,
            json={
                "code": "admin-test",
                "discount_type": "percent",
                "discount_value": 10,
                "min_order_amount": 1000,
                "valid_from": "2026-01-01T00:00:00Z",
                "valid_to": "2027-01-01T00:00:00Z",
            },
        )
        assert created.status_code == 201, created.text
        assert created.json()["code"] == "ADMIN-TEST"

        check = await client.post(
            "/api/v1/admin/promocodes/check",
            headers=headers,
            json={"code": "ADMIN-TEST", "total": 5000},
        )
        assert check.json()["valid"] is True
        assert Decimal(str(check.json()["discount_amount"])) == Decimal("500.00")

    async def test_below_minimum_is_rejected(self, client) -> None:
        headers = await _admin_headers(client)
        await client.post(
            "/api/v1/admin/promocodes",
            headers=headers,
            json={
                "code": "admin-min",
                "discount_type": "percent",
                "discount_value": 10,
                "min_order_amount": 10000,
                "valid_from": "2026-01-01T00:00:00Z",
                "valid_to": "2027-01-01T00:00:00Z",
            },
        )
        check = await client.post(
            "/api/v1/admin/promocodes/check",
            headers=headers,
            json={"code": "ADMIN-MIN", "total": 100},
        )
        assert check.json()["valid"] is False

    async def test_duplicate_code_rejected(self, client) -> None:
        headers = await _admin_headers(client)
        payload = {
            "code": "admin-dup",
            "discount_type": "fixed",
            "discount_value": 500,
            "valid_from": "2026-01-01T00:00:00Z",
            "valid_to": "2027-01-01T00:00:00Z",
        }
        created = await client.post("/api/v1/admin/promocodes", headers=headers, json=payload)
        assert created.status_code == 201
        duplicate = await client.post("/api/v1/admin/promocodes", headers=headers, json=payload)
        assert duplicate.status_code == 409
        assert duplicate.json()["error"]["code"] == "promo_code_exists"


class TestCategoriesAndBrands:
    async def test_category_depth_limited(self, client) -> None:
        """Раздел 6.2 ТЗ: максимум два уровня."""
        from app.db.session import session_scope
        from app.models.catalog import Category

        async with session_scope() as session:
            parent = Category(name="Первый уровень", slug=f"c-{uuid4().hex[:8]}", level=1)
            session.add(parent)
            await session.flush()
            child = Category(
                name="Второй уровень",
                slug=f"c-{uuid4().hex[:8]}",
                level=1,
                parent_id=parent.id,
            )
            session.add(child)
            await session.commit()
            # Именно строка: httpx сериализует тело через json.dumps,
            # а UUID им не понимает.
            child_id = str(child.id)

        response = await client.post(
            "/api/v1/admin/categories",
            headers=await _admin_headers(client),
            json={"name": "Третий уровень", "parent_id": child_id},
        )
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "nesting_too_deep"

    async def test_create_brand(self, client) -> None:
        response = await client.post(
            "/api/v1/admin/brands",
            headers=await _admin_headers(client),
            json={"name": f"Бренд {uuid4().hex[:6]}"},
        )
        assert response.status_code == 200, response.text
        assert response.json()["slug"]
