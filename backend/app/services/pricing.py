"""Расчёт стоимости заказа (разделы 5.9 и 6.5 ТЗ).

Единственное место, где считаются деньги заказа. Фронтенд присылает
товары и способ доставки, но не цены: раздел 22 ТЗ прямо запрещает
доверять стоимости, пришедшей с клиента.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import ROUND_HALF_UP, Decimal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.errors import BadRequestError
from app.models.enums import DeliveryMethod, DiscountType
from app.models.review import PromoCode, PromoCodeUsage

logger = logging.getLogger(__name__)

MONEY = Decimal("0.01")

# Стоимость доставки по способу, раздел 5.9.
DELIVERY_COSTS: dict[DeliveryMethod, Decimal] = {
    DeliveryMethod.COURIER: Decimal("590.00"),
    DeliveryMethod.PICKUP: Decimal("0.00"),
    DeliveryMethod.PICKUP_POINT: Decimal("0.00"),
    DeliveryMethod.TRANSPORT_COMPANY: Decimal("890.00"),
}

# Надбавка за документы для юрлица — раздел 5.9, оплата счётом.
INVOICE_HANDLING = Decimal("300.00")


def money(value: Decimal | str | int) -> Decimal:
    """Округление до копеек по правилам бухгалтерского учёта.

    round() из Decimal использует банковское округление и на .5 всегда
    вверх; для денег предсказуемее HALF_UP.
    """
    return Decimal(str(value)).quantize(MONEY, rounding=ROUND_HALF_UP)


@dataclass
class PricedItem:
    """Позиция с ценой, зафиксированной на момент расчёта."""

    product_id: str
    product_name: str
    sku: str
    quantity: int
    unit_price: Decimal
    old_price: Decimal | None = None
    category_id: str | None = None
    weight: Decimal | None = None

    @property
    def line_total(self) -> Decimal:
        return money(self.unit_price * self.quantity)

    @property
    def old_line_total(self) -> Decimal:
        return money((self.old_price or self.unit_price) * self.quantity)


@dataclass
class PriceBreakdown:
    """Итог с расшифровкой — она показывается покупателю в чеке."""

    subtotal: Decimal = Decimal("0.00")
    discount_amount: Decimal = Decimal("0.00")
    delivery_cost: Decimal = Decimal("0.00")
    total: Decimal = Decimal("0.00")
    promo_code: str | None = None
    promo_discount: Decimal = Decimal("0.00")
    free_delivery_applied: bool = False
    notes: list[str] = field(default_factory=list)


async def calculate(
    session: AsyncSession,
    items: list[PricedItem],
    *,
    delivery_method: DeliveryMethod,
    promo_code: str | None = None,
    user_id: str | None = None,
    free_delivery_threshold: Decimal = Decimal("0"),
) -> PriceBreakdown:
    """Считает итог заказа целиком.

    Порядок важен: скидка применяется к сумме товаров, доставка считается
    уже после неё. Иначе «бесплатная доставка» от промокода уменьшала бы
    сумму, на которую сама скидка уже применена.
    """
    if not items:
        raise BadRequestError("В заказе нет товаров", code="empty_cart")

    subtotal = money(sum((item.line_total for item in items), Decimal("0")))
    breakdown = PriceBreakdown(subtotal=subtotal)

    promo_discount = Decimal("0.00")
    free_delivery = False

    if promo_code:
        promo, discount, free_delivery, note = await _apply_promo(
            session,
            items,
            code=promo_code.strip().upper(),
            user_id=user_id,
        )
        breakdown.promo_code = promo.code
        promo_discount = discount
        free_delivery = free_delivery
        if note:
            breakdown.notes.append(note)

    # Акционные цены уже учтены в subtotal, поэтому промокод применяется
    # к сумме поверх акций — это обычная практика розницы.
    breakdown.promo_discount = money(promo_discount)
    breakdown.discount_amount = breakdown.promo_discount
    after_discount = money(subtotal - promo_discount)

    delivery = DELIVERY_COSTS.get(delivery_method, Decimal("590.00"))
    if free_delivery and delivery > 0:
        delivery = Decimal("0.00")
        breakdown.free_delivery_applied = True
    elif free_delivery_threshold > 0 and after_discount >= free_delivery_threshold:
        delivery = Decimal("0.00")

    breakdown.delivery_cost = money(delivery)
    breakdown.total = money(after_discount + delivery)
    return breakdown


async def _apply_promo(
    session: AsyncSession,
    items: list[PricedItem],
    *,
    code: str,
    user_id: str | None,
) -> tuple[PromoCode, Decimal, bool, str | None]:
    """Проверяет промокод и считает скидку.

    Возвращает ``(промокод, скидка, бесплатная_доставка, примечание)``.
    Промокод найденный, но неприменимый к этим товарам — не ошибка:
    покупатель видит примечание и корзину без скидки.
    """
    result = await session.execute(
        select(PromoCode)
        .where(PromoCode.code == code)
        .options(selectinload(PromoCode.categories), selectinload(PromoCode.excluded))
    )
    promo = result.scalar_one_or_none()
    if promo is None:
        raise BadRequestError(
            f"Промокод «{code}» не найден",
            code="promo_not_found",
            fields={"promo_code": "проверьте написание"},
        )

    note = await _check_promo_usable_db(session, promo, user_id, code=code)

    eligible = await _eligible_subtotal(session, promo, items)
    discount = Decimal("0.00")
    free_delivery = promo.discount_type is DiscountType.FREE_DELIVERY

    if note is None and promo.discount_type is not DiscountType.FREE_DELIVERY:
        if eligible < promo.min_order_amount:
            note = (
                f"Промокод не применён: минимальная сумма заказа "
                f"{money(promo.min_order_amount)} ₽, а к нему подходит "
                f"{eligible} ₽."
            )
        else:
            if promo.discount_type is DiscountType.PERCENT:
                discount = eligible * promo.discount_value / Decimal("100")
            else:
                discount = promo.discount_value
            if promo.max_discount_amount is not None:
                discount = min(discount, promo.max_discount_amount)
            discount = money(min(discount, eligible))
    elif note is None and promo.discount_type is DiscountType.FREE_DELIVERY:
        note = None

    return promo, discount, free_delivery, note


def _check_promo_usable(promo: PromoCode, *, code: str = "") -> str | None:
    """Проверки промокода, не требующие запросов. Возвращает причину отказа."""
    if not promo.is_active:
        return f"Промокод «{code}» больше не активен."

    now = datetime.now(UTC)
    if promo.valid_from > now:
        return f"Промокод «{code}» начнёт действовать позже."
    if promo.valid_to < now:
        return f"Срок действия промокода «{code}» истёк."

    if promo.usage_limit is not None and promo.used_count >= promo.usage_limit:
        return f"Промокод «{code}» исчерпал лимит использований."

    return None


async def _check_promo_usable_db(
    session: AsyncSession,
    promo: PromoCode,
    user_id: str | None,
    *,
    code: str = "",
) -> str | None:
    """Проверки промокода плюс лимит на одного пользователя (раздел 6.5)."""
    reason = _check_promo_usable(promo, code=code)
    if reason or user_id is None or promo.usage_limit_per_user is None:
        return reason

    used = await session.execute(
        select(PromoCodeUsage).where(
            PromoCodeUsage.promocode_id == promo.id,
            PromoCodeUsage.user_id == user_id,
        )
    )
    if len(used.scalars().all()) >= promo.usage_limit_per_user:
        return "Промокод уже использован вами максимальное число раз."
    return None


async def _eligible_subtotal(
    session: AsyncSession,
    promo: PromoCode,
    items: list[PricedItem],
) -> Decimal:
    """Сумма только тех позиций, которые попадают под промокод.

    Промокод может быть ограничен категориями или исключать товары
    (раздел 6.5). Скидка на неподходящие товары не распространяется —
    иначе получилось бы продавать дешевле, чем объявлено.
    """
    if not promo.categories and not promo.excluded:
        return money(sum((item.line_total for item in items), Decimal("0")))

    allowed_categories = {str(category.category_id) for category in promo.categories}
    excluded_products = {str(product.product_id) for product in promo.excluded}

    eligible = [
        item
        for item in items
        if item.product_id not in excluded_products
        and (not allowed_categories or item.category_id in allowed_categories)
    ]
    return money(sum((item.line_total for item in eligible), Decimal("0")))


def invoice_total(breakdown: PriceBreakdown) -> Decimal:
    """Итог для оплаты счётом с надбавкой за документы."""
    return money(breakdown.total + INVOICE_HANDLING)
