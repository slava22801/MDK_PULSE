"""Резерв и списание товарных остатков (раздел 10 ТЗ).

Ключевое требование: «проверка остатков в транзакции» и «резервирование
товара только на backend». Поэтому все операции идут через
``SELECT ... FOR UPDATE`` — без блокировки строки два одновременных
заказа могли бы суммарно превысить остаток.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import ConflictError, InsufficientStockError
from app.models.catalog import Product
from app.models.enums import ProductStatus

logger = logging.getLogger(__name__)


@dataclass
class StockLine:
    """Запрошенная позиция: сколько хотим зарезервировать."""

    product_id: uuid.UUID
    product_name: str
    quantity: int
    available: int


@dataclass
class StockResult:
    """Результат проверки остатков до изменения данных."""

    lines: list[StockLine]
    reserved: int = 0

    @property
    def insufficient(self) -> list[StockLine]:
        """Позиции, где запрошено больше, чем есть (раздел 5.8)."""
        return [line for line in self.lines if line.quantity > line.available]

    @property
    def has_insufficient(self) -> bool:
        return bool(self.insufficient)


class StockService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def lock_products(self, product_ids: list[uuid.UUID]) -> dict[uuid.UUID, Product]:
        """Читает товары с блокировкой строк до конца транзакции.

        Блокировка нужна на всё время транзакции заказа: пока она держится,
        параллельный заказ того же товара упрётся в ожидание и увидит уже
        обновлённый остаток.
        """
        if not product_ids:
            return {}

        result = await self.session.execute(
            select(Product)
            .where(Product.id.in_(product_ids))
            # Блокируем только саму таблицу products. У товара есть
            # lazy="joined" связи на категорию и бренд, они присоединяются
            # через LEFT JOIN, а PostgreSQL запрещает FOR UPDATE на
            # nullable-стороне внешнего соединения. `of=Product` ограничивает
            # блокировку нужной таблицей.
            .with_for_update(of=Product)
        )
        return {product.id: product for product in result.scalars().all()}

    async def _lock(self, product_id: uuid.UUID) -> Product | None:
        """Читает товар с блокировкой строки на запись.

        ``FOR UPDATE OF products`` обязателен: у модели есть внешние
        соединения, и общий ``FOR UPDATE`` PostgreSQL не принимает.
        """
        result = await self.session.execute(
            select(Product).where(Product.id == product_id).with_for_update(of=Product)
        )
        return result.scalar_one_or_none()

    async def check_availability(
        self,
        requested: dict[uuid.UUID, int],
    ) -> StockResult:
        """Проверяет, хватает ли товара, ничего не изменяя.

        Блокировку берём уже здесь: между проверкой и резервом может
        вклиниться другой заказ, и без блокировки проверка станет
        недействительной к моменту списания.
        """
        products = await self.lock_products(list(requested))

        lines: list[StockLine] = []
        for product_id, quantity in requested.items():
            product = products.get(product_id)
            if product is None or not product.is_active:
                raise ConflictError(
                    "Товар недоступен для заказа",
                    code="product_unavailable",
                    fields={"product_id": str(product_id)},
                )
            if not product.status.is_purchasable:
                raise ConflictError(
                    f"«{product.name}» сейчас недоступен для заказа",
                    code="product_unavailable",
                    fields={"product_id": str(product_id)},
                )
            lines.append(
                StockLine(
                    product_id=product_id,
                    product_name=product.name,
                    quantity=quantity,
                    available=product.available_quantity,
                )
            )
        return StockResult(lines=lines)

    async def reserve(
        self,
        requested: dict[uuid.UUID, int],
        *,
        reservation_hours: int = 48,
    ) -> StockResult:
        """Резервирует товар под заказ.

        Резерв — это не списание: остаток не меняется, увеличивается только
        ``reserved_quantity``. Реальное списание происходит при оплате, а
        брони с истёкшим TTL освобождаются отдельной задачей.
        """
        check = await self.check_availability(requested)
        if check.has_insufficient:
            line = check.insufficient[0]
            # Формулировка раздела 5.8 ТЗ — общая для корзины и заказа,
            # чтобы покупатель не получал разные формулировки одного и того же.
            raise InsufficientStockError(line.product_name, line.available)

        for product_id, quantity in requested.items():
            product = await self._lock(product_id)
            if product is not None:
                product.reserved_quantity += quantity

        await self.session.flush()
        return check

    async def release(self, reserved: dict[uuid.UUID, int]) -> None:
        """Снимает резерв: отмена заказа или истёкшее время ожидания оплаты."""
        for product_id, quantity in reserved.items():
            product = await self._lock(product_id)
            if product is None:
                continue
            # Резерв не может стать отрицательным: к моменту снятия его
            # могли уже списать.
            product.reserved_quantity = max(0, product.reserved_quantity - quantity)
        await self.session.flush()

    async def commit_sale(self, reserved: dict[uuid.UUID, int]) -> None:
        """Списывает товар при переходе заказа в оплаченный статус.

        Остаток уменьшается, резерв уменьшается — свободный остаток
        (stock - reserved) не меняется, как и должно быть: товар уже
        продан, но ещё не отгружен.
        """
        for product_id, quantity in reserved.items():
            product = await self._lock(product_id)
            if product is None:
                continue
            product.reserved_quantity = max(0, product.reserved_quantity - quantity)
            product.stock_quantity = max(0, product.stock_quantity - quantity)
            product.sales_count += quantity
            # Остаток ушёл в ноль — товар надо показать как отсутствующий,
            # а не как «в наличии» с нулевым количеством.
            if product.stock_quantity == 0:
                product.status = ProductStatus.OUT_OF_STOCK
        await self.session.flush()

    async def return_to_stock(self, sold: dict[uuid.UUID, int]) -> None:
        """Возвращает товар при оформлении возврата."""
        for product_id, quantity in sold.items():
            product = await self._lock(product_id)
            if product is None:
                continue
            product.stock_quantity += quantity
            product.sales_count = max(0, product.sales_count - quantity)
            if product.status is ProductStatus.OUT_OF_STOCK and product.stock_quantity > 0:
                product.status = ProductStatus.IN_STOCK
        await self.session.flush()

    @staticmethod
    def reservation_deadline(hours: int) -> datetime:
        """Момент, после которого резерв считается просроченным."""
        return datetime.now(UTC) + timedelta(hours=hours)


def reserved_map(items) -> dict[uuid.UUID, int]:
    """Собирает карту «товар → количество» из позиций заказа."""
    result: dict[uuid.UUID, int] = {}
    for item in items:
        product_id = item.product_id
        if product_id is None:
            continue
        result[product_id] = result.get(product_id, 0) + item.quantity
    return result
