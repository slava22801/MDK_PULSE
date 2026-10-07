"""Сервис корзины (раздел 5.8 ТЗ).

Три правила, которые реализует этот модуль:

1. **Количество не может превысить остаток.** Раздел 5.8 требует проверки на
   складе при каждом изменении; при нехватке покупатель видит сообщение
   «Доступно только N единиц товара».
2. **Суммы считает сервер.** Фронтенд не присылает цену и не имеет права
   решать, сколько стоит корзина (раздел 22 ТЗ).
3. **Гостевая корзина сливается с серверной при входе** — количество
   суммируется по совпадающим позициям, с обрезкой по остатку.
"""

from __future__ import annotations

import logging
import uuid
from decimal import Decimal

from sqlalchemy import and_, delete, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.config import settings
from app.core.errors import (
    ConflictError,
    InsufficientStockError,
    NotFoundError,
)
from app.models.catalog import Product
from app.models.order import CartItem
from app.models.user import User
from app.repositories.catalog import effective_status
from app.schemas.cart import (
    AddToCartRequest,
    CartItemOut,
    CartMergeResponse,
    CartNotice,
    CartOut,
    CartTotals,
    UpdateCartItemRequest,
)
from app.schemas.catalog import CategoryRef

logger = logging.getLogger(__name__)

# Порог «мало на складе» для витрины; тот же, что в каталоге.
LOW_STOCK_THRESHOLD = 5


class CartService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def _commit(self) -> None:
        """Фиксирует изменения корзины.

        Без явного ``commit`` сессия откатывалась бы в конце запроса:
        покупатель увидел бы добавленный товар в ответе, а после
        перезагрузки страницы корзина была бы пустой.
        """
        await self.session.commit()

    # ── Чтение ──

    async def get_cart(
        self,
        *,
        user: User | None = None,
        cart_session: str | None = None,
        notices: list[CartNotice] | None = None,
    ) -> CartOut:
        rows = await self._load_items(user=user, cart_session=cart_session)
        items = [self._to_item(row, row.product) for row in rows]
        return CartOut(
            items=items,
            totals=self._totals(items),
            unavailable_count=sum(1 for item in items if item.exceeds_stock),
            # Объявления не теряются между вызовами: если их не передать
            # явно, покупатель увидит урезанное количество без объяснения.
            notices=notices if notices is not None else self._stock_notices(items),
        )

    @staticmethod
    def _stock_notices(items: list[CartItemOut]) -> list[CartNotice]:
        """Сообщения о нехватке остатка — ровно то, что требует раздел 5.8."""
        notices: list[CartNotice] = []
        for item in items:
            if item.quantity <= item.available_quantity:
                continue
            notices.append(
                CartNotice(
                    product_id=item.product_id,
                    product_name=item.product_name,
                    requested=item.quantity,
                    available=item.available_quantity,
                    message=(
                        f"Доступно только {item.available_quantity} "
                        f"{_plural(item.available_quantity)} товара: «{item.product_name}»."
                    ),
                )
            )
        return notices

    async def _load_items(
        self,
        *,
        user: User | None,
        cart_session: str | None,
    ) -> list[CartItem]:
        stmt = (
            select(CartItem)
            .join(Product, Product.id == CartItem.product_id)
            .options(
                selectinload(CartItem.product).selectinload(Product.category),
                selectinload(CartItem.product).selectinload(Product.brand),
                selectinload(CartItem.product).selectinload(Product.images),
            )
            .order_by(CartItem.created_at)
        )
        stmt = self._scope(stmt, user=user, cart_session=cart_session)
        result = await self.session.execute(stmt)
        return list(result.scalars().unique().all())

    def _scope(self, stmt, *, user: User | None, cart_session: str | None):
        """Ограничивает выборку владельцем корзины.

        Гость опознаётся по cookie-идентификатору, авторизованный — по id.
        Если у пользователя нет корзины, гостевой идентификатор подставляется
        только для чтения: иначе запрос создал бы гостевую корзину в ответе
        на безобидное получение.
        """
        if user is not None:
            return stmt.where(CartItem.user_id == user.id)
        if cart_session:
            return stmt.where(
                CartItem.user_id.is_(None),
                CartItem.session_id == cart_session,
            )
        return stmt.where(_nothing())

    # ── Изменение ──

    async def add_item(
        self,
        payload: AddToCartRequest,
        *,
        user: User | None = None,
        cart_session: str | None = None,
    ) -> CartOut:
        product = await self._get_product(payload.product_id)
        self._ensure_purchasable(product)

        stmt = select(CartItem).where(
            CartItem.product_id == product.id,
            CartItem.user_id == user.id if user else CartItem.user_id.is_(None),
        )
        if user is None and cart_session:
            stmt = stmt.where(CartItem.session_id == cart_session)
        existing = (await self.session.execute(stmt)).scalar_one_or_none()

        requested = payload.quantity + (existing.quantity if existing else 0)
        allowed = self._clamp_to_stock(product, requested)
        if allowed <= 0:
            raise InsufficientStockError(product.name, product.available_quantity)

        if existing is not None:
            existing.quantity = allowed
            row = existing
        else:
            row = CartItem(
                product_id=product.id,
                quantity=allowed,
                user_id=user.id if user else None,
                session_id=None if user else cart_session,
            )
            self.session.add(row)

        await self.session.flush()
        await self._commit()
        await self.session.refresh(row)
        row.product = product
        return await self.get_cart(
            user=user,
            cart_session=cart_session,
            notices=self._reduction_notices(
                product=product,
                requested=requested,
                allowed=allowed,
            ),
        )

    @staticmethod
    def _reduction_notices(*, product: Product, requested: int, allowed: int) -> list[CartNotice]:
        """Уведомление, если количество урезано по остатку.

        Раздел 5.8 требует показать покупателю сообщение, а не молча
        заменить заказанное количество доступным.
        """
        if requested <= allowed:
            return []
        return [
            CartNotice(
                product_id=product.id,
                product_name=product.name,
                requested=requested,
                available=allowed,
                # Формулировка из раздела 5.8 ТЗ, приводится дословно.
                message=(
                    f"Доступно только {allowed} {_plural(allowed)} товара: "
                    f"«{product.name}». В корзину добавлено {allowed}."
                ),
            )
        ]

    async def update_item(
        self,
        item_id: uuid.UUID,
        payload: UpdateCartItemRequest,
        *,
        user: User | None = None,
        cart_session: str | None = None,
    ) -> CartOut:
        row = await self._get_owned_item(item_id, user=user, cart_session=cart_session)
        product = row.product

        if product.is_active and product.status.is_purchasable:
            allowed = self._clamp_to_stock(product, payload.quantity)
            row.quantity = allowed
            await self._commit()
            return await self.get_cart(
                user=user,
                cart_session=cart_session,
                notices=self._reduction_notices(
                    product=product,
                    requested=payload.quantity,
                    allowed=allowed,
                ),
            )

        # Товар снят с продажи или отсутствует: уменьшать количество
        # бессмысленно, сообщаем о недоступности.
        raise InsufficientStockError(product.name, 0)

    async def remove_item(
        self,
        item_id: uuid.UUID,
        *,
        user: User | None = None,
        cart_session: str | None = None,
    ) -> CartOut:
        row = await self._get_owned_item(item_id, user=user, cart_session=cart_session)
        await self.session.delete(row)
        await self._commit()
        return await self.get_cart(user=user, cart_session=cart_session)

    async def clear(
        self,
        *,
        user: User | None = None,
        cart_session: str | None = None,
    ) -> CartOut:
        stmt = delete(CartItem).where(self._where_clause(user=user, cart_session=cart_session))
        await self.session.execute(stmt)
        await self._commit()
        return CartOut()

    # ── Слияние при входе (раздел 5.8) ──

    async def merge_guest_cart(
        self,
        user: User,
        cart_session: str | None,
    ) -> CartMergeResponse:
        """Переносит гостевую корзину в аккаунт пользователя.

        Вызывается сразу после успешного входа. Позиции с одинаковым товаром
        складываются, но итог обрезается по остатку: иначе в корзине мог бы
        оказаться товар, которого на складе нет.
        """
        if not cart_session:
            return CartMergeResponse()

        guest_items = await self._load_items(user=None, cart_session=cart_session)
        if not guest_items:
            return CartMergeResponse()

        owned = await self._load_items(user=user, cart_session=None)
        owned_by_product = {row.product_id: row for row in owned}

        merged = 0
        dropped = 0

        for guest_row in guest_items:
            product = guest_row.product
            available = product.available_quantity if product.is_purchasable else 0
            if available <= 0:
                await self.session.delete(guest_row)
                dropped += 1
                continue

            target = owned_by_product.get(product.id)
            if target is not None:
                target.quantity = self._clamp_to_stock(
                    product, target.quantity + guest_row.quantity
                )
                merged += 1
            else:
                # Гостевая строка переезжает в аккаунт целиком.
                guest_row.user_id = user.id
                guest_row.session_id = None
                merged += 1

            await self.session.flush()

        await self._commit()

        logger.info(
            "Слияние корзин для %s: позиций %s, отброшено без остатка %s",
            user.email,
            merged,
            dropped,
        )
        cart = await self.get_cart(user=user)
        return CartMergeResponse(
            items=cart.items,
            totals=cart.totals,
            merged_positions=merged,
            removed_for_stock=dropped,
        )

    # ── Вспомогательное ──

    def _where_clause(self, *, user: User | None, cart_session: str | None):
        if user is not None:
            return CartItem.user_id == user.id
        if cart_session:
            return (CartItem.user_id.is_(None)) & (CartItem.session_id == cart_session)
        return _nothing()

    async def _get_owned_item(
        self,
        item_id: uuid.UUID,
        *,
        user: User | None,
        cart_session: str | None,
    ) -> CartItem:
        stmt = (
            select(CartItem)
            .options(
                selectinload(CartItem.product).selectinload(Product.category),
                selectinload(CartItem.product).selectinload(Product.brand),
                selectinload(CartItem.product).selectinload(Product.images),
            )
            .where(CartItem.id == item_id)
        )
        stmt = stmt.where(self._where_clause(user=user, cart_session=cart_session))
        row = (await self.session.execute(stmt)).scalar_one_or_none()
        if row is None:
            # Чужую позицию не показываем как «несуществующую» — иначе можно
            # было бы перебором выяснить, что позиция с таким id у кого-то есть.
            raise NotFoundError("Позиция корзины не найдена", code="cart_item_not_found")
        return row

    async def _get_product(self, product_id: uuid.UUID) -> Product:
        stmt = (
            select(Product)
            .where(Product.id == product_id)
            .options(
                selectinload(Product.category),
                selectinload(Product.brand),
                selectinload(Product.images),
            )
        )
        product = (await self.session.execute(stmt)).scalar_one_or_none()
        if product is None or not product.is_active:
            raise NotFoundError("Товар не найден", code="product_not_found")
        return product

    def _ensure_purchasable(self, product: Product) -> None:
        if not product.is_purchasable:
            if product.status.value in {"discontinued", "on_order", "expected"}:
                raise ConflictError(
                    f"Товар «{product.name}» сейчас недоступен для заказа",
                    code="product_unavailable",
                )
            raise InsufficientStockError(product.name, product.available_quantity)

    def _clamp_to_stock(self, product: Product, requested: int) -> int:
        """Ограничивает количество реальным остатком."""
        available = product.available_quantity if product.is_purchasable else 0
        return max(0, min(requested, available))

    def _to_item(self, row: CartItem, product: Product) -> CartItemOut:
        available = product.available_quantity if product.is_purchasable else 0
        image = product.images[0] if product.images else None
        unit_price = product.price

        return CartItemOut(
            id=row.id,
            product_id=product.id,
            quantity=row.quantity,
            product_name=product.name,
            product_slug=product.slug,
            sku=product.sku,
            brand_name=product.brand.name if product.brand else None,
            category=CategoryRef(
                id=product.category.id,
                name=product.category.name,
                slug=product.category.slug,
                level=product.category.level,
            ),
            image_url=image.image_url if image else None,
            image_alt=(image.alt or product.name) if image else product.name,
            unit_price=unit_price,
            old_price=product.old_price,
            discount_percent=product.discount_percent,
            line_total=(unit_price * row.quantity).quantize(Decimal("0.01")),
            currency=product.currency,
            availability=effective_status(product.status, available, LOW_STOCK_THRESHOLD),
            available_quantity=available,
            exceeds_stock=row.quantity > available,
            added_at=row.created_at,
        )

    def _totals(self, items: list[CartItemOut]) -> CartTotals:
        """Итоги корзины.

        Скидка показывается справочно: расчёт по акционной цене уже учтён в
        ``line_total``, поэтому вычитать её второй раз нельзя.
        """
        subtotal = sum((item.unit_price * item.quantity for item in items), Decimal("0"))
        old_total = sum(
            (
                item.old_price * item.quantity
                for item in items
                if item.old_price is not None and item.old_price > item.unit_price
            ),
            Decimal("0"),
        )
        discount = (old_total - subtotal).quantize(Decimal("0.01")) if old_total else Decimal("0")

        delivery = Decimal("0")
        threshold = Decimal(settings.free_delivery_threshold or "0")
        if threshold > 0 and subtotal < threshold and items:
            delivery = Decimal(settings.default_delivery_cost)

        return CartTotals(
            items_count=sum(item.quantity for item in items),
            subtotal=subtotal.quantize(Decimal("0.01")),
            discount_amount=discount,
            delivery_cost=delivery,
            total=(subtotal + delivery).quantize(Decimal("0.01")),
        )


def _plural(count: int) -> str:
    """Русская форма числительного: 1 единица / 2 единицы / 5 единиц."""
    n = abs(count) % 100
    if 11 <= n <= 14:
        return "единиц"
    n %= 10
    if n == 1:
        return "единица"
    if 2 <= n <= 4:
        return "единицы"
    return "единиц"


def _nothing():
    """Заведомо ложное условие: «не выбирать ничего».

    Гостю без cookie-идентификатора корзина не принадлежит, и выдавать ему
    чужую нельзя — поэтому запрос обязан вернуть пустой результат, а не
    ошибку.
    """
    return and_(Product.id.is_(None), Product.id.is_not(None))
