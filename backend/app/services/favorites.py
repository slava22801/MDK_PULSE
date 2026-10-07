"""Избранное (раздел 5.6 ТЗ).

Авторизованному пользователю избранное живёт на сервере, гостю — в
localStorage (это клиентская часть, сервер гостя не хранит). Здесь —
серверная часть плюс расчёт того, что изменилось с момента добавления:
раздел 5.6 требует показывать изменение цены и появление товара в наличии.
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime
from decimal import Decimal

from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.errors import NotFoundError
from app.models.catalog import Product
from app.models.order import Favorite
from app.models.user import User
from app.repositories.catalog import effective_status
from app.schemas.catalog import BrandRef, CategoryRef
from app.schemas.preferences import FavoriteItem, FavoriteListResponse, FavoriteStateResponse

logger = logging.getLogger(__name__)

LOW_STOCK_THRESHOLD = 5


class FavoritesService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def _commit(self) -> None:
        """Фиксирует изменения.

        Без коммита запись откатывалась бы в конце запроса: кнопка
        «в избранное» отвечала бы успехом, а товар не появлялся бы в списке.
        """
        await self.session.commit()

    async def list_favorites(self, user: User) -> FavoriteListResponse:
        stmt = (
            select(Favorite, Product)
            .join(Product, Product.id == Favorite.product_id)
            .where(Favorite.user_id == user.id, Product.is_active.is_(True))
            .order_by(Favorite.created_at.desc())
            .options(
                selectinload(Product.category),
                selectinload(Product.brand),
                # Галерею грузим явно: здесь Product приходит не корневой
                # сущностью запроса, и lazy="selectin" на связи images
                # не срабатывает — обращение к ней кончилось бы
                # MissingGreenlet при сериализации ответа.
                selectinload(Product.images),
            )
        )
        rows = (await self.session.execute(stmt)).all()
        items = [
            self._to_item(favorite, product, favorite.created_at) for favorite, product in rows
        ]

        return FavoriteListResponse(
            items=items,
            total=len(items),
            attention_count=sum(1 for item in items if item.price_changed or item.back_in_stock),
        )

    async def add(
        self,
        user: User,
        product_id: uuid.UUID,
    ) -> FavoriteStateResponse:
        product = await self._get_product(product_id)

        existing = await self.session.execute(
            select(Favorite).where(
                Favorite.user_id == user.id,
                Favorite.product_id == product_id,
            )
        )
        if existing.scalar_one_or_none() is None:
            self.session.add(
                Favorite(
                    user_id=user.id,
                    product_id=product_id,
                    # Цена запоминается на момент добавления: по ней
                    # избранное и поймёт, что цена изменилась.
                    price_at_add=product.price,
                )
            )
            try:
                await self._commit()
            except IntegrityError:
                # Гонка двух вкладок: товар уже добавлен — это не ошибка.
                await self.session.rollback()

        total = await self._count(user.id)
        return FavoriteStateResponse(product_id=product_id, is_favorite=True, total=total)

    async def remove(self, user: User, product_id: uuid.UUID) -> FavoriteStateResponse:
        await self.session.execute(
            delete(Favorite).where(
                Favorite.user_id == user.id,
                Favorite.product_id == product_id,
            )
        )
        await self._commit()
        total = await self._count(user.id)
        return FavoriteStateResponse(product_id=product_id, is_favorite=False, total=total)

    async def is_favorite(self, user: User, product_id: uuid.UUID) -> bool:
        result = await self.session.execute(
            select(func.count())
            .select_from(Favorite)
            .where(Favorite.user_id == user.id, Favorite.product_id == product_id)
        )
        return bool(result.scalar_one())

    async def _count(self, user_id: uuid.UUID) -> int:
        result = await self.session.execute(
            select(func.count()).select_from(Favorite).where(Favorite.user_id == user_id)
        )
        return int(result.scalar_one())

    async def _get_product(self, product_id: uuid.UUID) -> Product:
        product = await self.session.get(Product, product_id)
        if product is None or not product.is_active:
            raise NotFoundError("Товар не найден", code="product_not_found")
        return product

    def _to_item(self, favorite: Favorite, product: Product, added_at: datetime) -> FavoriteItem:
        """Карточка избранного с признаками изменений.

        ``price_delta`` — насколько цена ушла с момента добавления. Знак
        показывает направление: минус значит, что товар подешевел.
        """
        image = product.images[0] if product.images else None
        available = product.available_quantity

        delta: Decimal | None = None
        changed = False
        if favorite.price_at_add is not None and product.price != favorite.price_at_add:
            delta = (product.price - favorite.price_at_add).quantize(Decimal("0.01"))
            changed = True

        return FavoriteItem(
            id=product.id,
            slug=product.slug,
            name=product.name,
            sku=product.sku,
            brand=(
                BrandRef.model_validate(product.brand, from_attributes=True)
                if product.brand
                else None
            ),
            category=CategoryRef(
                id=product.category.id,
                name=product.category.name,
                slug=product.category.slug,
                level=product.category.level,
            ),
            price=product.price,
            old_price=product.old_price,
            discount_percent=product.discount_percent,
            currency=product.currency,
            image_url=image.image_url if image else None,
            image_alt=(image.alt or product.name) if image else product.name,
            availability=effective_status(product.status, available, LOW_STOCK_THRESHOLD),
            available_quantity=available,
            in_stock=product.is_purchasable,
            rating_avg=product.rating_avg,
            rating_count=product.rating_count,
            warranty_months=product.warranty_months,
            price_changed=changed,
            price_delta=delta,
            back_in_stock=available > 0 and not product.is_purchasable,
            added_at=added_at or datetime.now(UTC),
        )
