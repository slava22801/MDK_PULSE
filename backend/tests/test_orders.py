"""Заказы: остатки, идемпотентность, статусы (разделы 5.9–5.10, критерии №8, 10, 13, 25)."""

from __future__ import annotations

from decimal import Decimal
from uuid import uuid4

import pytest
import pytest_asyncio
from sqlalchemy import select

from app.models.catalog import Product
from app.models.enums import DeliveryMethod, OrderStatus
from app.models.order import Order
from app.models.review import PromoCode
from app.services.orders import TRANSITIONS
from app.services.pricing import DELIVERY_COSTS, money

DELIVERY_ADDRESS = {
    "city": "Красноярск",
    "street": "ул. Ленина",
    "building": "10",
}

VALID_CUSTOMER = {
    "customer_first_name": "Иван",
    "customer_last_name": "Петров",
    "customer_email": "buyer@example.com",
    "customer_phone": "+7 999 123-45-67",
    "delivery_method": "courier",
    "payment_method": "cash_on_delivery",
    "delivery_address": DELIVERY_ADDRESS,
}


def make_order_payload(**overrides) -> dict:
    return {**VALID_CUSTOMER, **overrides}


@pytest_asyncio.fixture
async def product_with_stock(request) -> str:
    """Товар с заданным остатком."""
    stock = getattr(request, "param", 10)
    return await _create_product(stock=stock)


async def _create_product(
    *,
    stock: int = 10,
    price: str = "1000.00",
    name: str | None = None,
) -> str:
    from app.db.session import session_scope

    async with session_scope() as session:
        from app.models.catalog import Brand, Category

        category = Category(name="Тест", slug=f"cat-{uuid4().hex[:8]}", level=1)
        session.add(category)
        # Имя бренда уникально в схеме, поэтому в каждом товаре — своё.
        brand = Brand(name=f"Бренд {uuid4().hex[:8]}", slug=f"brand-{uuid4().hex[:8]}")
        session.add(brand)
        await session.flush()

        product = Product(
            slug=f"p-{uuid4().hex[:12]}",
            sku=f"SKU-{uuid4().hex[:12]}",
            name=name or f"Тестовый товар {uuid4().hex[:6]}",
            category_id=category.id,
            brand_id=brand.id,
            price=Decimal(price),
            stock_quantity=stock,
        )
        session.add(product)
        await session.commit()
        return str(product.id)


async def _add_to_cart(client, product_id: str, quantity: int, headers: dict | None = None) -> dict:
    """Кладёт товар в корзину через API.

    Именно через API, а не вставкой в базу: корзина гостя опознаётся по
    cookie, и прямая запись со своим session_id создала бы корзину, которой
    API не видит. Такой тест проходил бы на пустом месте.
    """
    response = await client.post(
        "/api/v1/cart/items",
        json={"product_id": product_id, "quantity": quantity},
        headers=headers or {},
    )
    assert response.status_code == 200, response.text
    return response.json()


async def _stock(product_id: str) -> int:
    from app.db.session import session_scope

    async with session_scope() as session:
        product = await session.get(Product, product_id)
        return product.stock_quantity


async def _reserved(product_id: str) -> int:
    from app.db.session import session_scope

    async with session_scope() as session:
        product = await session.get(Product, product_id)
        return product.reserved_quantity


async def _set_stock(product_id: str, stock: int) -> None:
    from app.db.session import session_scope

    async with session_scope() as session:
        product = await session.get(Product, product_id)
        product.stock_quantity = stock
        product.reserved_quantity = 0
        await session.commit()


class TestOrderCreation:
    async def test_order_is_created_with_unique_number(self, client) -> None:
        product_id = await _create_product(stock=10, price="1000.00")
        await _add_to_cart(client, product_id, 2)

        response = await client.post("/api/v1/orders", json=make_order_payload())
        assert response.status_code == 201, response.text
        body = response.json()
        assert body["order_number"].startswith("PL-")
        assert body["status"] == "new"
        assert Decimal(body["subtotal"]) == Decimal("2000.00")

    async def test_two_orders_have_different_numbers(self, client) -> None:
        numbers = set()
        for _ in range(3):
            product_id = await _create_product(stock=10)
            await _add_to_cart(client, product_id, 1)
            response = await client.post("/api/v1/orders", json=make_order_payload())
            assert response.status_code == 201, response.text
            numbers.add(response.json()["order_number"])
        assert len(numbers) == 3

    async def test_empty_cart_is_rejected(self, client) -> None:
        response = await client.post("/api/v1/orders", json=make_order_payload())
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "empty_cart"

    async def test_delivery_address_required_for_courier(self, client) -> None:
        """Раздел 5.9: без адреса курьерскую доставку оформить нельзя."""
        product_id = await _create_product(stock=5)
        await _add_to_cart(client, product_id, 1)
        payload = make_order_payload()
        payload.pop("delivery_address")

        response = await client.post("/api/v1/orders", json=payload)
        assert response.status_code == 422

    async def test_pickup_needs_no_address(self, client) -> None:
        product_id = await _create_product(stock=5)
        await _add_to_cart(client, product_id, 1)
        payload = make_order_payload(
            delivery_method="pickup",
            payment_method="cash_on_delivery",
        )
        payload.pop("delivery_address")

        response = await client.post("/api/v1/orders", json=payload)
        assert response.status_code == 201, response.text

    async def test_cart_is_cleared_after_order(self, client) -> None:
        product_id = await _create_product(stock=5)
        await _add_to_cart(client, product_id, 1)
        await client.post("/api/v1/orders", json=make_order_payload())

        cart = (await client.get("/api/v1/cart")).json()
        assert cart["items"] == []

    async def test_client_cannot_dictate_price(self, client) -> None:
        """Раздел 22 ТЗ: цены считает сервер, присланные клиентом игнорируются."""
        product_id = await _create_product(stock=5, price="8990.00")
        await _add_to_cart(client, product_id, 1)
        payload = make_order_payload()
        payload.update({"total_amount": "1.00", "subtotal": "1.00"})

        response = await client.post("/api/v1/orders", json=payload)
        assert response.status_code == 201, response.text
        body = response.json()
        assert Decimal(body["subtotal"]) == Decimal("8990.00")
        assert body["total_amount"] != "1.00"

    async def test_order_keeps_product_snapshot(self, client, auth_headers) -> None:
        """Критерий №25: правка товара не меняет оформленный заказ."""
        product_id = await _create_product(stock=5, price="1000.00")
        await _add_to_cart(client, product_id, 2, headers=auth_headers)
        order = (
            await client.post("/api/v1/orders", json=make_order_payload(), headers=auth_headers)
        ).json()

        # Меняем цену и название товара после заказа.
        from app.db.session import session_scope

        async with session_scope() as session:
            product = await session.get(Product, product_id)
            product.price = Decimal("50000.00")
            product.name = "Полностью другое название"
            await session.commit()

        response = await client.get(f"/api/v1/orders/{order['id']}", headers=auth_headers)
        assert response.status_code == 200
        fresh = response.json()
        assert fresh["subtotal"] == "2000.00"
        assert "другое" not in fresh["items"][0]["product_name"]


class TestStockReservations:
    async def test_reservation_does_not_reduce_stock(self, client) -> None:
        """Резерв уменьшает свободный остаток, но не сам остаток."""
        product_id = await _create_product(stock=10)
        await _add_to_cart(client, product_id, 3)

        await client.post("/api/v1/orders", json=make_order_payload())
        assert await _stock(product_id) == 10
        assert await _reserved(product_id) == 3

    async def test_cannot_order_more_than_available(self, client) -> None:
        """Критерий №8: нельзя заказать больше, чем есть."""
        product_id = await _create_product(stock=2)
        await _add_to_cart(client, product_id, 2)
        # Пока оформляем, кто-то скупает товар.
        await _set_stock(product_id, 0)

        response = await client.post("/api/v1/orders", json=make_order_payload())
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "insufficient_stock"
        assert "Доступно только" in response.json()["error"]["message"]

    async def test_payment_consumes_stock(self, client, auth_headers) -> None:
        """Критерий №13: остаток уменьшается после оплаты, а не оформления."""
        product_id = await _create_product(stock=10)
        await _add_to_cart(client, product_id, 3, headers=auth_headers)
        order = (
            await client.post("/api/v1/orders", json=make_order_payload(), headers=auth_headers)
        ).json()

        assert await _stock(product_id) == 10
        await _pay_order(client, order, auth_headers)
        assert await _stock(product_id) == 7
        assert await _reserved(product_id) == 0

    async def test_cancel_returns_reservation(self, client, auth_headers) -> None:
        product_id = await _create_product(stock=10)
        await _add_to_cart(client, product_id, 4, headers=auth_headers)
        order = (
            await client.post("/api/v1/orders", json=make_order_payload(), headers=auth_headers)
        ).json()
        assert await _reserved(product_id) == 4

        response = await client.post(f"/api/v1/orders/{order['id']}/cancel", headers=auth_headers)
        assert response.status_code == 200, response.text
        assert response.json()["status"] == "cancelled"
        assert await _reserved(product_id) == 0
        assert await _stock(product_id) == 10

    async def test_second_cancel_is_rejected(self, client, auth_headers) -> None:
        product_id = await _create_product(stock=10)
        await _add_to_cart(client, product_id, 1, headers=auth_headers)
        order = (
            await client.post("/api/v1/orders", json=make_order_payload(), headers=auth_headers)
        ).json()
        await client.post(f"/api/v1/orders/{order['id']}/cancel", headers=auth_headers)

        response = await client.post(f"/api/v1/orders/{order['id']}/cancel", headers=auth_headers)
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "order_not_cancellable"


class TestIdempotency:
    async def test_same_key_returns_same_order(self, client) -> None:
        """Раздел 10: защита от повторной отправки заказа."""
        product_id = await _create_product(stock=10)
        await _add_to_cart(client, product_id, 1)
        payload = make_order_payload()

        first = await client.post(
            "/api/v1/orders", json=payload, headers={"Idempotency-Key": "key-abc"}
        )
        await _add_to_cart(client, product_id, 1)
        second = await client.post(
            "/api/v1/orders", json=payload, headers={"Idempotency-Key": "key-abc"}
        )

        assert first.status_code == 201
        assert second.status_code == 201
        assert first.json()["order_number"] == second.json()["order_number"]

    async def test_only_one_order_row_created(self, client) -> None:
        from app.db.session import session_scope

        product_id = await _create_product(stock=10)
        await _add_to_cart(client, product_id, 1)
        payload = make_order_payload()

        await client.post("/api/v1/orders", json=payload, headers={"Idempotency-Key": "key-xyz"})
        # Корзина уже очищена — без ключа второй запрос провалился бы,
        # с ключом должен вернуться тот же заказ.
        await client.post("/api/v1/orders", json=payload, headers={"Idempotency-Key": "key-xyz"})

        async with session_scope() as session:
            total = len((await session.execute(select(Order))).scalars().all())
        assert total == 1

    async def test_different_keys_create_different_orders(self, client) -> None:
        product_id = await _create_product(stock=10)
        numbers = []
        for key in ("key-1", "key-2"):
            await _add_to_cart(client, product_id, 1)
            response = await client.post(
                "/api/v1/orders", json=make_order_payload(), headers={"Idempotency-Key": key}
            )
            numbers.append(response.json()["order_number"])
        assert numbers[0] != numbers[1]


class TestPricing:
    async def test_delivery_cost_added(self, client) -> None:
        product_id = await _create_product(stock=5, price="1000.00")
        await _add_to_cart(client, product_id, 1)
        body = (await client.post("/api/v1/orders", json=make_order_payload())).json()

        delivery = DELIVERY_COSTS[DeliveryMethod.COURIER]
        assert Decimal(body["delivery_cost"]) == delivery
        assert Decimal(body["total_amount"]) == Decimal("1000.00") + delivery

    async def test_pickup_has_no_delivery_cost(self, client) -> None:
        product_id = await _create_product(stock=5, price="1000.00")
        await _add_to_cart(client, product_id, 1)
        payload = make_order_payload(delivery_method="pickup")
        payload.pop("delivery_address")

        body = (await client.post("/api/v1/orders", json=payload)).json()
        assert Decimal(body["delivery_cost"]) == Decimal("0.00")
        assert Decimal(body["total_amount"]) == Decimal("1000.00")

    async def test_percent_promo_applies(self, client) -> None:
        await _create_promo(code="SAVE10", percent=Decimal("10"))
        product_id = await _create_product(stock=5, price="1000.00")
        await _add_to_cart(client, product_id, 1)

        body = (
            await client.post("/api/v1/orders", json=make_order_payload(promo_code="SAVE10"))
        ).json()
        assert Decimal(body["discount_amount"]) == Decimal("100.00")
        expected = Decimal("1000.00") - Decimal("100.00") + DELIVERY_COSTS[DeliveryMethod.COURIER]
        assert Decimal(body["total_amount"]) == money(expected)

    async def test_fixed_promo_respects_cap(self, client) -> None:
        await _create_promo(
            code="BIG",
            percent=None,
            fixed=Decimal("500"),
            max_discount=Decimal("200"),
        )
        product_id = await _create_product(stock=5, price="1000.00")
        await _add_to_cart(client, product_id, 1)

        body = (
            await client.post("/api/v1/orders", json=make_order_payload(promo_code="BIG"))
        ).json()
        # Скидка 500 ₽ ограничена потолком 200 ₽.
        assert Decimal(body["discount_amount"]) == Decimal("200.00")

    async def test_min_order_amount_blocks_discount(self, client) -> None:
        await _create_promo(code="MIN500", percent=Decimal("10"), min_order=Decimal("50000"))
        product_id = await _create_product(stock=5, price="1000.00")
        await _add_to_cart(client, product_id, 1)

        body = (
            await client.post("/api/v1/orders", json=make_order_payload(promo_code="MIN500"))
        ).json()
        assert Decimal(body["discount_amount"]) == Decimal("0.00")

    async def test_unknown_promo_is_reported(self, client) -> None:
        product_id = await _create_product(stock=5)
        await _add_to_cart(client, product_id, 1)

        response = await client.post(
            "/api/v1/orders",
            json=make_order_payload(promo_code="НЕТТАКОГО"),
        )
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "promo_not_found"

    async def test_preview_matches_order(self, client) -> None:
        """Предпросмотр и заказ должны давать одну и ту же сумму."""
        product_id = await _create_product(stock=5, price="2500.00")
        await _add_to_cart(client, product_id, 2)

        preview = (
            await client.post(
                "/api/v1/checkout/preview",
                json={"delivery_method": "courier", "payment_method": "cash_on_delivery"},
            )
        ).json()
        order = (await client.post("/api/v1/orders", json=make_order_payload())).json()

        assert preview["total"] == order["total_amount"]
        assert preview["subtotal"] == order["subtotal"]


class TestPayment:
    async def test_payment_marks_order_paid(self, client, auth_headers) -> None:
        product_id = await _create_product(stock=5)
        await _add_to_cart(client, product_id, 1, headers=auth_headers)
        order = (
            await client.post("/api/v1/orders", json=make_order_payload(), headers=auth_headers)
        ).json()

        await _pay_order(client, order, auth_headers)
        fresh = (await client.get(f"/api/v1/orders/{order['id']}", headers=auth_headers)).json()
        assert fresh["status"] == "paid"
        assert fresh["payment_status"] == "paid"

    async def test_paid_order_cannot_be_paid_twice(self, client, auth_headers) -> None:
        product_id = await _create_product(stock=5)
        await _add_to_cart(client, product_id, 1, headers=auth_headers)
        order = (
            await client.post("/api/v1/orders", json=make_order_payload(), headers=auth_headers)
        ).json()
        await _pay_order(client, order, auth_headers)

        response = await client.post(f"/api/v1/orders/{order['id']}/payment", headers=auth_headers)
        assert response.status_code == 409

    async def test_cancelled_order_cannot_be_paid(self, client, auth_headers) -> None:
        product_id = await _create_product(stock=5)
        await _add_to_cart(client, product_id, 1, headers=auth_headers)
        order = (
            await client.post("/api/v1/orders", json=make_order_payload(), headers=auth_headers)
        ).json()
        await client.post(f"/api/v1/orders/{order['id']}/cancel", headers=auth_headers)

        response = await client.post(f"/api/v1/orders/{order['id']}/payment", headers=auth_headers)
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "order_not_payable"

    async def test_forged_webhook_is_rejected(self, client, auth_headers) -> None:
        """Раздел 10: поддельный вебхук не должен оплачивать заказ."""
        product_id = await _create_product(stock=5)
        await _add_to_cart(client, product_id, 1, headers=auth_headers)
        order = (
            await client.post("/api/v1/orders", json=make_order_payload(), headers=auth_headers)
        ).json()

        response = await client.post(
            "/api/v1/payments/webhook",
            json={"external_id": "fake_hacked", "status": "succeeded"},
            headers={"X-Signature": "deadbeef"},
        )
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "invalid_webhook_signature"

        fresh = (await client.get(f"/api/v1/orders/{order['id']}", headers=auth_headers)).json()
        assert fresh["status"] != "paid"

    async def test_wrong_token_is_rejected(self, client, auth_headers) -> None:
        product_id = await _create_product(stock=5)
        await _add_to_cart(client, product_id, 1, headers=auth_headers)
        order = (
            await client.post("/api/v1/orders", json=make_order_payload(), headers=auth_headers)
        ).json()
        await client.post(f"/api/v1/orders/{order['id']}/payment", headers=auth_headers)

        response = await client.post(
            f"/api/v1/payments/{order['id']}/confirm",
            json={"token": "~подделка~1234~9999999999~abc"},
            headers=auth_headers,
        )
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "invalid_payment_token"


class TestStatusMachine:
    def test_every_status_has_transitions_defined(self) -> None:
        for status in OrderStatus:
            assert status in TRANSITIONS, f"нет правил для статуса {status}"

    def test_all_eleven_statuses_present(self) -> None:
        """Раздел 5.10 ТЗ перечисляет одиннадцать статусов."""
        assert len(OrderStatus) == 11

    def test_no_transition_out_of_final_statuses(self) -> None:
        for status in (OrderStatus.CANCELLED, OrderStatus.REFUNDED):
            assert TRANSITIONS[status] == ()

    def test_cancelled_has_no_outgoing_transitions(self) -> None:
        """Из отменённого заказа выйти нельзя — иначе отменённый заказ
        мог бы снова стать оплаченным."""
        assert {t.to for t in TRANSITIONS[OrderStatus.CANCELLED]} == set()

    async def test_cannot_skip_payment(self, client) -> None:
        """Новый заказ нельзя сразу перевести в «Выполнен»."""
        from app.services.orders import OrderService as Service

        product_id = await _create_product(stock=5)
        await _add_to_cart(client, product_id, 1)
        order = (await client.post("/api/v1/orders", json=make_order_payload())).json()

        from app.db.session import session_scope

        async with session_scope() as session:
            stored = await session.get(Order, order["id"])
            with pytest.raises(Exception) as exc:
                await Service(session).change_status(stored, OrderStatus.COMPLETED)
            assert "invalid_status_transition" in str(exc.value.code)

    async def test_cancel_releases_stock(self, client, auth_headers) -> None:
        product_id = await _create_product(stock=5)
        await _add_to_cart(client, product_id, 2, headers=auth_headers)
        order = (
            await client.post("/api/v1/orders", json=make_order_payload(), headers=auth_headers)
        ).json()
        await client.post(f"/api/v1/orders/{order['id']}/cancel", headers=auth_headers)

        fresh = (await client.get(f"/api/v1/orders/{order['id']}", headers=auth_headers)).json()
        assert fresh["status"] == "cancelled"
        assert fresh["can_cancel"] is False
        assert await _stock(product_id) == 5


class TestOrderAccess:
    async def test_guest_cannot_read_order(self, client) -> None:
        product_id = await _create_product(stock=5)
        await _add_to_cart(client, product_id, 1)
        order = (await client.post("/api/v1/orders", json=make_order_payload())).json()

        response = await client.get(f"/api/v1/orders/{order['id']}")
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "order_not_found"

    async def test_unknown_order_returns_404(self, client, auth_headers) -> None:
        response = await client.get(
            f"/api/v1/orders/{uuid4()}",
            headers=auth_headers,
        )
        assert response.status_code == 404

    async def test_orders_list_requires_auth(self, client) -> None:
        response = await client.get("/api/v1/me/orders")
        assert response.status_code == 401


class TestReorder:
    async def test_reorder_returns_items_to_cart(self, client, auth_headers) -> None:
        product_id = await _create_product(stock=5, price="1500.00")
        await _add_to_cart(client, product_id, 2, headers=auth_headers)

        order = (
            await client.post("/api/v1/orders", json=make_order_payload(), headers=auth_headers)
        ).json()

        response = await client.post(f"/api/v1/orders/{order['id']}/reorder", headers=auth_headers)
        assert response.status_code == 200, response.text
        cart = (await client.get("/api/v1/cart", headers=auth_headers)).json()
        assert cart["totals"]["items_count"] == 2
        assert cart["items"][0]["product_id"] == product_id

    async def test_reorder_clamps_to_available(self, client, auth_headers) -> None:
        product_id = await _create_product(stock=5)
        await _add_to_cart(client, product_id, 4, headers=auth_headers)
        order = (
            await client.post("/api/v1/orders", json=make_order_payload(), headers=auth_headers)
        ).json()

        # К моменту повторного заказа на складе осталось 2 единицы.
        await _set_stock(product_id, 2)
        response = await client.post(f"/api/v1/orders/{order['id']}/reorder", headers=auth_headers)
        assert response.status_code == 200, response.text

        cart = (await client.get("/api/v1/cart", headers=auth_headers)).json()
        assert cart["totals"]["items_count"] == 2


# ── Вспомогательные ──


async def _pay_order(client, order: dict, headers: dict) -> None:
    """Полный цикл оплаты: создать платёж и подтвердить его.

    Заголовки обязательны: оплачивать заказ может только его владелец,
    поэтому платёжные тесты работают от авторизованного покупателя.
    """
    payment = await client.post(f"/api/v1/orders/{order['id']}/payment", headers=headers)
    assert payment.status_code == 200, payment.text
    token = payment.json()["confirmation_token"]

    confirm = await client.post(
        f"/api/v1/payments/{order['id']}/confirm",
        json={"token": token},
        headers=headers,
    )
    assert confirm.status_code == 200, confirm.text


async def _create_promo(
    *,
    code: str,
    percent: Decimal | None = None,
    fixed: Decimal | None = None,
    max_discount: Decimal | None = None,
    min_order: Decimal = Decimal("0"),
) -> None:
    from datetime import UTC, datetime, timedelta

    from app.db.session import session_scope
    from app.models.enums import DiscountType

    async with session_scope() as session:
        session.add(
            PromoCode(
                code=code,
                discount_type=(DiscountType.PERCENT if percent is not None else DiscountType.FIXED),
                discount_value=percent if percent is not None else (fixed or Decimal("0")),
                max_discount_amount=max_discount,
                min_order_amount=min_order,
                valid_from=datetime.now(UTC) - timedelta(days=1),
                valid_to=datetime.now(UTC) + timedelta(days=30),
                is_active=True,
            )
        )
        await session.commit()
