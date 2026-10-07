"""Управление товарами из админки (раздел 6.1 ТЗ).

Отличие от витрины: админ видит закупочную цену, правит характеристики
по ключам справочника и управляет статусом продаж.
"""

from __future__ import annotations

import logging
import uuid

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import BadRequestError, ConflictError, NotFoundError
from app.models.catalog import (
    AttributeDef,
    Brand,
    Category,
    Product,
    ProductImage,
    ProductRelation,
    ProductSpec,
)
from app.models.enums import AttributeDataType, ProductRelationKind, ProductStatus
from app.models.user import User
from app.repositories.user import UserRepository
from app.schemas.admin import (
    AdminProductDetail,
    AdminProductListItem,
    ProductCreate,
    ProductUpdate,
)
from app.services.audit import AuditService

logger = logging.getLogger(__name__)


class AdminProductsService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session
        self.audit = AuditService(session)
        self.users = UserRepository(session)

    # ── Чтение ──

    async def list_products(
        self,
        *,
        page: int = 1,
        limit: int = 25,
        search: str | None = None,
        category_id: uuid.UUID | None = None,
        brand_id: uuid.UUID | None = None,
        status: ProductStatus | None = None,
        in_stock: bool | None = None,
    ) -> tuple[list[AdminProductListItem], int]:
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
        if brand_id is not None:
            conditions.append(Product.brand_id == brand_id)
        if status is not None:
            conditions.append(Product.status == status)
        if in_stock is True:
            conditions.append(Product.stock_quantity - Product.reserved_quantity > 0)
        elif in_stock is False:
            conditions.append(Product.stock_quantity - Product.reserved_quantity <= 0)

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
                    .order_by(Product.updated_at.desc())
                    .offset((page - 1) * limit)
                    .limit(limit)
                )
            )
            .scalars()
            .all()
        )

        return [AdminProductListItem.model_validate(item) for item in rows], total

    async def get_product(self, product_id: uuid.UUID) -> tuple[AdminProductDetail, dict]:
        product = await self._get(product_id)
        specs = await self._specs_of(product.id)
        detail = AdminProductDetail.model_validate(product)
        return detail, specs

    # ── Изменение ──

    async def create_product(
        self,
        payload: ProductCreate,
        *,
        actor: User,
        ip_address: str | None = None,
    ) -> AdminProductDetail:
        if await self._sku_exists(payload.sku):
            raise ConflictError(
                f"Артикул «{payload.sku}» уже занят",
                code="sku_exists",
                fields={"sku": "уже используется"},
            )
        await self._ensure_references(payload.category_id, payload.brand_id)

        data = payload.model_dump(exclude={"specs", "image_urls", "compatible_product_ids"})
        product = Product(**data)
        if not product.slug:
            product.slug = await self._unique_slug(payload.name)

        self.session.add(product)
        await self.session.flush()

        await self._write_specs(product.id, payload.specs, replace=True)
        await self._write_images(product.id, payload.image_urls)
        await self._write_relations(product.id, payload.compatible_product_ids)

        await self.audit.record(
            actor,
            action="product.created",
            entity_type="product",
            entity_id=product.id,
            details={"sku": product.sku, "price": str(product.price)},
            ip_address=ip_address,
        )
        await self.session.commit()
        detail, _ = await self.get_product(product.id)
        return detail

    async def update_product(
        self,
        product_id: uuid.UUID,
        payload: ProductUpdate,
        *,
        actor: User,
        ip_address: str | None = None,
    ) -> AdminProductDetail:
        product = await self._get(product_id)
        changes = payload.model_dump(exclude_unset=True)

        new_sku = changes.get("sku")
        if new_sku and new_sku != product.sku and await self._sku_exists(new_sku):
            raise ConflictError(
                f"Артикул «{new_sku}» уже занят",
                code="sku_exists",
                fields={"sku": "уже используется"},
            )

        if "old_price" in changes and changes["old_price"] is not None:
            current_price = changes.get("price", product.price)
            if changes["old_price"] <= current_price:
                raise BadRequestError(
                    "Старая цена должна быть выше текущей",
                    code="invalid_old_price",
                    fields={"old_price": "должна быть больше новой цены"},
                )

        if changes.get("category_id"):
            await self._ensure_references(changes["category_id"], changes.get("brand_id"))

        for key, value in changes.items():
            if key in {"specs", "image_urls", "compatible_product_ids"}:
                continue
            setattr(product, key, value)

        if "specs" in changes and changes["specs"] is not None:
            await self._write_specs(product.id, changes["specs"], replace=True)
        if changes.get("image_urls") is not None:
            await self._write_images(product.id, changes["image_urls"])
        if changes.get("compatible_product_ids") is not None:
            await self._write_relations(product.id, changes["compatible_product_ids"])

        await self.session.flush()
        await self.audit.record(
            actor,
            action="product.updated",
            entity_type="product",
            entity_id=product.id,
            details={"sku": product.sku, "fields": sorted(changes)},
            ip_address=ip_address,
        )
        await self.session.commit()
        detail, _ = await self.get_product(product.id)
        return detail

    async def adjust_stock(
        self,
        product_id: uuid.UUID,
        delta: int,
        *,
        actor: User,
        reason: str | None = None,
        ip_address: str | None = None,
    ) -> AdminProductDetail:
        """Изменение остатка приходом или списанием (раздел 6.1).

        Остаток не может стать отрицательным: списание больше, чем есть,
        — ошибка данных, а не «минус две штуки».
        """
        product = await self._get(product_id)
        before = product.stock_quantity
        after = before + delta
        if after < 0:
            raise BadRequestError(
                f"На складе {before} шт — списать {abs(delta)} нельзя",
                code="negative_stock",
                fields={"delta": "приведёт к отрицательному остатку"},
            )

        product.stock_quantity = after
        # Товар, у которого остаток появился снова, возвращается в продажу.
        if before == 0 < after and product.status is ProductStatus.OUT_OF_STOCK:
            product.status = ProductStatus.IN_STOCK

        await self.session.flush()
        await self.audit.record(
            actor,
            action="product.stock_adjusted",
            entity_type="product",
            entity_id=product.id,
            details={"sku": product.sku, "before": before, "after": after, "reason": reason},
            ip_address=ip_address,
        )
        await self.session.commit()
        detail, _ = await self.get_product(product.id)
        return detail

    async def delete_product(
        self,
        product_id: uuid.UUID,
        *,
        actor: User,
        ip_address: str | None = None,
    ) -> None:
        """Удаление товара.

        Товар, который уже заказывали, не удаляется: иначе исторические
        заказы потеряли бы позиции. Раздел 6.1 предусматривает «скрыть
        товар» — это и есть штатный способ снять его с продажи.
        """
        product = await self._get(product_id)

        from app.models.order import OrderItem

        ordered = await self.session.execute(
            select(func.count()).select_from(OrderItem).where(OrderItem.product_id == product_id)
        )
        if int(ordered.scalar_one()) > 0:
            raise ConflictError(
                "Товар уже есть в заказах — его нельзя удалить, только скрыть",
                code="product_in_orders",
                fields={"is_active": "Снимите товар с продажи, скрыв его"},
            )

        sku = product.sku
        await self.session.delete(product)
        await self.session.flush()
        await self.audit.record(
            actor,
            action="product.deleted",
            entity_type="product",
            entity_id=product_id,
            details={"sku": sku},
            ip_address=ip_address,
        )
        await self.session.commit()

    # ── Характеристики ──

    async def _write_specs(
        self,
        product_id: uuid.UUID,
        values: dict[str, str],
        *,
        replace: bool,
    ) -> None:
        """Записывает характеристики, раскладывая значения по типам.

        Тип берётся из справочника, а не из вида строки: иначе «8» попало бы в
        text-колонку, и по нему нельзя было бы построить диапазонный фильтр.
        """
        definitions = {
            definition.key: definition
            for definition in (await self.session.execute(select(AttributeDef))).scalars().all()
        }

        if replace:
            existing = (
                (
                    await self.session.execute(
                        select(ProductSpec).where(ProductSpec.product_id == product_id)
                    )
                )
                .scalars()
                .all()
            )
            for spec in existing:
                if spec.attribute_id not in [
                    definitions[key].id for key in values if key in definitions
                ]:
                    await self.session.delete(spec)
            await self.session.flush()

        for key, raw in values.items():
            definition = definitions.get(key)
            if definition is None:
                logger.info("Характеристика «%s» отсутствует в справочнике — пропущена", key)
                continue

            numeric = text_value = bool_value = None
            if definition.data_type is AttributeDataType.NUMBER:
                try:
                    numeric = float(str(raw).replace(",", "."))
                except ValueError:
                    raise BadRequestError(
                        f"«{definition.name}» должно быть числом, получено «{raw}»",
                        code="invalid_spec_value",
                        fields={key: "ожидается число"},
                    ) from None
            elif definition.data_type is AttributeDataType.BOOL:
                bool_value = str(raw).strip().lower() in {"1", "true", "да", "yes"}
            else:
                text_value = str(raw)

            existing = (
                await self.session.execute(
                    select(ProductSpec).where(
                        ProductSpec.product_id == product_id,
                        ProductSpec.attribute_id == definition.id,
                    )
                )
            ).scalar_one_or_none()

            if existing is None:
                self.session.add(
                    ProductSpec(
                        product_id=product_id,
                        attribute_id=definition.id,
                        value_num=numeric,
                        value_text=text_value,
                        value_bool=bool_value,
                        sort_order=definition.sort_order,
                    )
                )
            else:
                existing.value_num = numeric
                existing.value_text = text_value
                existing.value_bool = bool_value

        await self.session.flush()

    async def _specs_of(self, product_id: uuid.UUID) -> dict[str, str]:
        rows = (
            await self.session.execute(
                select(ProductSpec, AttributeDef)
                .join(AttributeDef, AttributeDef.id == ProductSpec.attribute_id)
                .where(ProductSpec.product_id == product_id)
                .order_by(AttributeDef.sort_order, AttributeDef.name)
            )
        ).all()
        result: dict[str, str] = {}
        for spec, definition in rows:
            if spec.value_num is not None:
                result[definition.key] = str(spec.value_num.normalize())
            elif spec.value_bool is not None:
                result[definition.key] = "1" if spec.value_bool else "0"
            else:
                result[definition.key] = spec.value_text or ""
        return result

    async def _write_images(self, product_id: uuid.UUID, urls: list[str]) -> None:
        current = (
            (
                await self.session.execute(
                    select(ProductImage).where(ProductImage.product_id == product_id)
                )
            )
            .scalars()
            .all()
        )
        for image in current:
            await self.session.delete(image)
        await self.session.flush()

        for index, url in enumerate(urls):
            if not url.strip():
                continue
            self.session.add(
                ProductImage(
                    product_id=product_id,
                    image_url=url.strip(),
                    alt=None,
                    sort_order=index,
                    is_main=index == 0,
                )
            )
        await self.session.flush()

    async def _write_relations(self, product_id: uuid.UUID, related_ids: list[uuid.UUID]) -> None:
        current = (
            (
                await self.session.execute(
                    select(ProductRelation).where(ProductRelation.product_id == product_id)
                )
            )
            .scalars()
            .all()
        )
        for relation in current:
            await self.session.delete(relation)
        await self.session.flush()

        for related_id in related_ids:
            if related_id == product_id:
                continue
            self.session.add(
                ProductRelation(
                    product_id=product_id,
                    related_id=related_id,
                    kind=ProductRelationKind.COMPATIBLE,
                )
            )
        await self.session.flush()

    # ── Вспомогательные ──

    async def _get(self, product_id: uuid.UUID) -> Product:
        """Читает товар со свежими значениями.

        ``populate_existing=True`` обязателен: после ``commit`` колонки с
        ``onupdate`` (например ``updated_at``) становятся просроченными, и
        обращение к ним из сериализатора вызвало бы ленивую перезагрузку
        вне async-контекста — запрос падал бы с MissingGreenlet.
        """
        stmt = (
            select(Product)
            .where(Product.id == product_id)
            .execution_options(populate_existing=True)
        )
        product = (await self.session.execute(stmt)).scalar_one_or_none()
        if product is None:
            raise NotFoundError("Товар не найден", code="product_not_found")
        return product

    async def _sku_exists(self, sku: str) -> bool:
        result = await self.session.execute(
            select(func.count()).select_from(Product).where(Product.sku == sku)
        )
        return bool(result.scalar_one())

    async def _ensure_references(
        self,
        category_id: uuid.UUID,
        brand_id: uuid.UUID | None,
    ) -> None:
        if await self.session.get(Category, category_id) is None:
            raise BadRequestError(
                "Категория не найдена", code="category_not_found", fields={"category_id": ""}
            )
        if brand_id is not None and await self.session.get(Brand, brand_id) is None:
            raise BadRequestError(
                "Бренд не найден", code="brand_not_found", fields={"brand_id": ""}
            )

    async def _unique_slug(self, name: str) -> str:
        """Генерирует slug, не конфликтуя с уже существующими."""
        base = slugify(name) or f"product-{uuid.uuid4().hex[:8]}"
        candidate = base
        suffix = 1
        while await self._slug_exists(candidate):
            suffix += 1
            candidate = f"{base}-{suffix}"
        return candidate

    async def _slug_exists(self, slug: str) -> bool:
        result = await self.session.execute(
            select(func.count()).select_from(Product).where(Product.slug == slug)
        )
        return bool(result.scalar_one())


_TRANSLIT = str.maketrans(
    {
        "а": "a",
        "б": "b",
        "в": "v",
        "г": "g",
        "д": "d",
        "е": "e",
        "ё": "e",
        "ж": "zh",
        "з": "z",
        "и": "i",
        "й": "y",
        "к": "k",
        "л": "l",
        "м": "m",
        "н": "n",
        "о": "o",
        "п": "p",
        "р": "r",
        "с": "s",
        "т": "t",
        "у": "u",
        "ф": "f",
        "х": "h",
        "ц": "c",
        "ч": "ch",
        "ш": "sh",
        "щ": "sch",
        "ъ": "",
        "ы": "y",
        "ь": "",
        "э": "e",
        "ю": "yu",
        "я": "ya",
    }
)


def slugify(value: str) -> str:
    """Человекочитаемый URL из названия (раздел 11 ТЗ)."""
    translit = value.lower().translate(_TRANSLIT)
    slug = "".join(ch if ch.isalnum() or ch in " -" else " " for ch in translit)
    return "-".join(slug.split())[:180].rstrip("-")
