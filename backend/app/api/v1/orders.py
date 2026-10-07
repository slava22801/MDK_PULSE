"""Роутеры заказов (раздел 8.6 ТЗ).

Все суммы считаются на сервере; клиент присылает только состав корзины
и данные покупателя (раздел 22 ТЗ).
"""

from __future__ import annotations

import json
import uuid
from typing import Annotated

from fastapi import APIRouter, Header, Query, Request, status

from app.core.config import settings
from app.core.deps import CartSession, CurrentUser, DbSession, OptionalUser
from app.core.errors import BadRequestError, ConflictError
from app.payments import FakePaymentProvider, get_provider
from app.schemas.order import (
    CheckoutPreview,
    CheckoutPreviewRequest,
    MessageResponse,
    OrderCreate,
    OrderItemOut,
    OrderListResponse,
    OrderOut,
    OrderSummary,
    PaymentConfirmRequest,
    PaymentStartResponse,
)
from app.services import pricing
from app.services.orders import OrderService

router = APIRouter(tags=["Заказы"])


def _to_order_out(service: OrderService, order) -> OrderOut:
    """Собирает полный ответ по заказу из уже загруженных данных."""
    summary: OrderSummary = service.summary_of(order)
    return OrderOut(
        **summary.model_dump(),
        items=[OrderItemOut.model_validate(item, from_attributes=True) for item in order.items],
        promo_code=order.promo_code,
        customer_first_name=order.customer_first_name,
        customer_last_name=order.customer_last_name,
        customer_email=order.customer_email,
        customer_phone=order.customer_phone,
        delivery_address=order.delivery_address,
        comment=order.comment,
        manager_comment=order.manager_comment,
        can_cancel=order.status.is_cancellable_by_customer,
    )


@router.post(
    "/checkout/preview",
    response_model=CheckoutPreview,
    summary="Предварительный расчёт заказа",
)
async def checkout_preview(
    payload: CheckoutPreviewRequest,
    session: DbSession,
    user: OptionalUser,
    cart_session: CartSession,
) -> CheckoutPreview:
    """Шаг 1 раздела 5.9: показать итог до ввода данных.

    Считается по текущему состоянию корзины и ничего не резервирует:
    предпросмотр не должен занимать товар.
    """
    service = OrderService(session)
    items = await service.cart_items(user=user, cart_session=cart_session)
    if not items:
        raise BadRequestError("Корзина пуста", code="empty_cart")

    priced = [
        pricing.PricedItem(
            product_id=str(item.product_id),
            product_name=item.product.name,
            sku=item.product.sku,
            quantity=item.quantity,
            unit_price=item.product.price,
            old_price=item.product.old_price,
            category_id=str(item.product.category_id),
        )
        for item in items
    ]

    breakdown = await pricing.calculate(
        session,
        priced,
        delivery_method=payload.delivery_method,
        promo_code=payload.promo_code,
        user_id=str(user.id) if user else None,
        free_delivery_threshold=pricing.Decimal(settings.free_delivery_threshold or "0"),
    )

    unavailable = [
        # Название берём у товара: у позиции корзины такого поля нет,
        # только количество (раздел 7.9 ТЗ).
        f"{item.product.name}: доступно {item.product.available_quantity}"
        for item in items
        if item.quantity > item.product.available_quantity
    ]

    return CheckoutPreview(
        items_count=sum(item.quantity for item in priced),
        items=[
            OrderItemOut(
                id=uuid.uuid4(),
                product_id=None,
                product_name=item.product_name,
                sku=item.sku,
                quantity=item.quantity,
                price=item.unit_price,
                total_price=item.line_total,
            )
            for item in priced
        ],
        subtotal=breakdown.subtotal,
        discount_amount=breakdown.discount_amount,
        delivery_cost=breakdown.delivery_cost,
        total=breakdown.total,
        promo_code=breakdown.promo_code,
        notes=breakdown.notes,
        unavailable=unavailable,
    )


@router.post(
    "/orders",
    response_model=OrderOut,
    status_code=status.HTTP_201_CREATED,
    summary="Оформить заказ",
)
async def create_order(
    payload: OrderCreate,
    session: DbSession,
    user: OptionalUser,
    cart_session: CartSession,
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
) -> OrderOut:
    """Шаги 2–7 раздела 5.9: проверка корзины, резерв, создание заказа.

    Заголовок ``Idempotency-Key`` защищает от повторной отправки формы
    при двойном клике: второй запрос с тем же ключом вернёт тот же заказ
    (раздел 10 ТЗ).
    """
    service = OrderService(session)
    order = await service.create_order(
        payload,
        user=user,
        cart_session=cart_session,
        idempotency_key=idempotency_key,
    )
    return _to_order_out(service, order)


@router.get("/orders", response_model=OrderListResponse, summary="История заказов")
async def list_orders(
    session: DbSession,
    user: OptionalUser,
    page: Annotated[int, Query(ge=1)] = 1,
    limit: Annotated[int, Query(ge=1, le=50)] = 10,
) -> OrderListResponse:
    """Свои заказы. Гостю возвращается пустой список, а не чужие заказы."""
    if user is None:
        return OrderListResponse()

    items, total = await OrderService(session).list_orders(
        user=user,
        page=page,
        limit=limit,
    )
    return OrderListResponse(
        items=items,
        total=total,
        page=page,
        limit=limit,
        pages=(total + limit - 1) // limit if limit else 0,
    )


@router.get("/orders/{order_id}", response_model=OrderOut, summary="Детали заказа")
async def get_order(
    order_id: uuid.UUID,
    session: DbSession,
    user: OptionalUser,
) -> OrderOut:
    service = OrderService(session)
    order = await service.get_for_user(order_id, user)
    return _to_order_out(service, order)


@router.post(
    "/orders/{order_id}/cancel",
    response_model=OrderOut,
    summary="Отменить заказ",
)
async def cancel_order(
    order_id: uuid.UUID,
    session: DbSession,
    user: CurrentUser,
) -> OrderOut:
    """Отмена покупателем (раздел 5.11).

    Резерв возвращается на склад как побочный эффект перехода
    в статус «Отменён».
    """
    service = OrderService(session)
    order = await service.get_for_user(order_id, user)
    await service.cancel_order(order, user)
    refreshed = await service.load_order(order.id)
    return _to_order_out(service, refreshed)


@router.post(
    "/orders/{order_id}/reorder",
    response_model=MessageResponse,
    summary="Повторный заказ",
)
async def reorder(
    order_id: uuid.UUID,
    session: DbSession,
    user: CurrentUser,
) -> MessageResponse:
    """Возвращает позиции заказа в корзину (раздел 5.11).

    Кладётся столько, сколько есть на складе: повторный заказ не должен
    падать из-за остатка, изменившегося с прошлой покупки.
    """
    service = OrderService(session)
    order = await service.get_for_user(order_id, user)
    await service.reorder(order, user)
    return MessageResponse(message="Товары из заказа возвращены в корзину")


# ── Оплата ──


@router.post(
    "/orders/{order_id}/payment",
    response_model=PaymentStartResponse,
    summary="Начать оплату",
)
async def start_payment(
    order_id: uuid.UUID,
    session: DbSession,
    user: CurrentUser,
) -> PaymentStartResponse:
    """Создаёт платёж у провайдера и возвращает адрес для оплаты."""
    service = OrderService(session)
    order = await service.get_for_user(order_id, user)
    intent = await service.start_payment(order)
    return PaymentStartResponse(
        provider=intent.provider,
        external_id=intent.external_id,
        amount=intent.amount,
        status=intent.status,
        redirect_url=intent.redirect_url,
        confirmation_token=intent.confirmation_token,
    )


@router.post(
    "/payments/{order_id}/confirm",
    response_model=MessageResponse,
    summary="Подтвердить оплату (фейковый провайдер)",
)
async def confirm_payment(
    order_id: uuid.UUID,
    payload: PaymentConfirmRequest,
    session: DbSession,
    user: CurrentUser,
) -> MessageResponse:
    """Подтверждение оплаты на странице фейкового провайдера.

    У реального провайдера оплату подтверждает вебхук; этот эндпоинт нужен,
    чтобы полный цикл «заказ → оплата → статус» проходил на стенде без
    внешней системы (раздел 16 ТЗ).
    """
    service = OrderService(session)
    order = await service.get_for_user(order_id, user)

    provider = get_provider()
    if not isinstance(provider, FakePaymentProvider):
        raise ConflictError(
            "Подтверждение оплаты доступно только фейковому провайдеру",
            code="provider_not_fake",
        )

    payment = await service.latest_payment(order)
    if payment is None or not payment.external_id:
        raise BadRequestError(
            "Для заказа не создан платёж — сначала начните оплату",
            code="payment_not_found",
        )

    if not provider.verify_token(payload.token, payment.external_id, payment.amount):
        raise BadRequestError(
            "Ссылка на оплату недействительна или истекла",
            code="invalid_payment_token",
        )

    body = json.dumps(
        {
            "external_id": payment.external_id,
            "status": "succeeded",
            "amount": str(payment.amount),
        }
    ).encode()
    await service.apply_webhook(body, provider.sign_webhook(body))
    return MessageResponse(message="Платёж подтверждён")


@router.post(
    "/payments/webhook",
    include_in_schema=False,
    summary="Вебхук платёжной системы",
)
async def payment_webhook(
    request: Request,
    session: DbSession,
    signature: Annotated[str | None, Header(alias="X-Signature")] = None,
) -> dict:
    """Приём вебхука от платёжной системы.

    Подпись проверяется всегда: без неё любой желающий мог бы отметить
    заказ оплаченным (раздел 10 ТЗ).
    """
    raw = await request.body()
    order = await OrderService(session).apply_webhook(raw, signature or "")
    return {"ok": True, "order_id": str(order.id) if order else None}
