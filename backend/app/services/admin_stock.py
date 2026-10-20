"""Управление остатками из админки (раздел 6.1 ТЗ).

Отдельный сервис от `AdminProductsService` не по архитектуре, а по правам:
правка количества — ежедневная операция менеджера, а карточка товара
(цены, закупочная цена, характеристики, SEO) остаётся администраторской.

Два числа живут рядом, и их важно не путать:

* `stock_quantity` — сколько единиц физически на складе;
* `reserved_quantity` — сколько уже ушло в корзины и неоплаченные заказы;
* `available_quantity` — сколько можно продать сейчас, это
  `stock_quantity - reserved_quantity`.

Сотрудник правит именно последнее: «осталось пять штук» — это про то,
сколько ещё можно продать, а не про то, что лежит в корзинах.
"""

from __future__ import annotations

import logging
import uuid

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import NotFoundError
from app.models.catalog import Product
from app.models.enums import ProductStatus
from app.models.user import User
from app.repositories.catalog import effective_status
from app.schemas.admin import AdminStockItem
from app.services.audit import AuditService

logger = logging.getLogger(__name__)

# Порог «мало на складе»: тот же, что на витрине (см. `LOW_STOCK_THRESHOLD`
# в сервисах каталога и корзины), иначе админка и витрина показывали бы
# разное состояние одного и того же товара.
LOW_STOCK_THRESHOLD = 5


class AdminStockService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session
        self.audit = AuditService(session)

    # ── Чтение ──

    async def list_stock(
        self,
        *,
        page: int = 1,
        limit: int = 25,
        search: str | None = None,
        category_id: uuid.UUID | None = None,
        only_low: bool = False,
    ) -> tuple[list[AdminStockItem], int]:
        """Список позиций раздела «Остатки».

        Сортировка — по количеству, которое осталось продать: пустые и
        заканчивающиеся товары должны быть сверху, а не в случайном порядке
        страницы. Фильтр `only_low` оставляет ровно их.
        """
        conditions = []
        if search:
            pattern = f"%{search.strip()}%"
            conditions.append(
                or_(
                    Product.name.ilike(pattern),
                    Product.sku.ilike(pattern),
                    Product.model.ilike(pattern),
                )
            )
        if category_id is not None:
            conditions.append(Product.category_id == category_id)

        # Доступно к продаже = остаток минус резерв. В SQL это тот же
        # `max(0, ...)` из модели, но без обёртки: отрицательное значение
        # тоже «не в наличии», и считать его нужно одинаково.
        available = Product.stock_quantity - Product.reserved_quantity
        if only_low:
            conditions.append(
                or_(available <= 0, available <= Product.min_stock)
            )

        total = int(
            (
                await self.session.execute(
                    select(func.count()).select_from(Product).where(*conditions)
                )
            ).scalar_one()
        )

        rows = (
            (
                await self.session.execute(
                    select(Product)
                    .where(*conditions)
                    .order_by(available.asc(), Product.name.asc())
                    .offset((page - 1) * limit)
                    .limit(limit)
                )
            )
            .scalars()
            .all()
        )

        return [self._to_item(product) for product in rows], total

    # ── Изменение ──

    async def set_available(
        self,
        product_id: uuid.UUID,
        available_quantity: int,
        *,
        actor: User,
        reason: str | None = None,
        ip_address: str | None = None,
    ) -> AdminStockItem:
        """Задаёт количество товара, доступное для продажи.

        Сотрудник вводит абсолютное число («осталось 5 штук»), поэтому сервис
        сам пересчитывает его в изменение остатка: новый остаток на складе
        равен «доступно» плюс то, что уже в резерве.

        Так резервы не теряются: поставить «0» нельзя отменить уже
        зарезервированные корзины, товар просто перестаёт продаваться.
        """
        product = await self._lock(product_id)

        reserved = product.reserved_quantity
        before_stock = product.stock_quantity
        before_available = max(0, before_stock - reserved)

        target_stock = available_quantity + reserved

        product.stock_quantity = target_stock
        # Товар, у которого остаток появился снова, возвращается в продажу —
        # как и при обычном приходе от поставщика.
        if before_stock == 0 < target_stock and product.status is ProductStatus.OUT_OF_STOCK:
            product.status = ProductStatus.IN_STOCK

        await self.session.flush()

        # Значения для журнала и лога читаем ДО commit: после него атрибуты
        # экземпляра просрочены, и обращение к ним потребовало бы IO в
        # синхронном контексте — это `MissingGreenlet`.
        sku = product.sku

        await self.audit.record(
            actor,
            action="product.stock_set",
            entity_type="product",
            entity_id=product_id,
            details={
                "sku": sku,
                "available_before": before_available,
                "available_after": available_quantity,
                "stock_before": before_stock,
                "stock_after": target_stock,
                "reserved": reserved,
                "reason": reason,
            },
            ip_address=ip_address,
        )
        await self.session.commit()

        logger.info(
            "Остаток товара %s: доступно %s -> %s (склад %s -> %s, резерв %s)",
            sku,
            before_available,
            available_quantity,
            before_stock,
            target_stock,
            reserved,
        )

        # Возвращаем свежее чтение: после commit старый экземпляр просрочен,
        # и его связи (категория, бренд) пришлось бы догружать в синхронном
        # контексте — так и происходит `MissingGreenlet`.
        return self._to_item(await self._reload(product_id))

    # ── Вспомогательные ──

    async def _lock(self, product_id: uuid.UUID) -> Product:
        """Читает товар с блокировкой строки на запись.

        Блокировка обязательна: остаток меняют два сотрудника одновременно,
        и без неё второй посчитал бы дельту по уже устаревшему числу —
        результат «осталось 5» оказался бы не тем, что в базе.
        """
        result = await self.session.execute(
            select(Product)
            .where(Product.id == product_id)
            .with_for_update(of=Product)
        )
        product = result.scalar_one_or_none()
        if product is None:
            raise NotFoundError("Товар не найден", code="product_not_found")
        return product

    async def _reload(self, product_id: uuid.UUID) -> Product:
        """Перечитывает товар после commit.

        `populate_existing=True` обновляет и уже загруженные связи: без него
        SQLAlchemy вернул бы прежний, просроченный экземпляр.
        """
        result = await self.session.execute(
            select(Product)
            .where(Product.id == product_id)
            .execution_options(populate_existing=True)
        )
        product = result.scalar_one_or_none()
        if product is None:
            raise NotFoundError("Товар не найден", code="product_not_found")
        return product

    def _to_item(self, product: Product) -> AdminStockItem:
        """Собирает позицию раздела из товара.

        `available_quantity` считается здесь же, а не берётся из колонки:
        доступного количества в базе нет, оно производное — ровно так же,
        как на витрине.
        """
        available = product.available_quantity
        return AdminStockItem(
            id=product.id,
            name=product.name,
            sku=product.sku,
            category_name=product.category.name if product.category else "—",
            brand_name=product.brand.name if product.brand else None,
            stock_quantity=product.stock_quantity,
            reserved_quantity=product.reserved_quantity,
            available_quantity=available,
            min_stock=product.min_stock,
            status=product.status,
            availability=effective_status(product.status, available, LOW_STOCK_THRESHOLD),
            is_active=product.is_active,
            updated_at=product.updated_at,
        )
