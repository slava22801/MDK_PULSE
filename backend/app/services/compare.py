"""Сравнение товаров (раздел 5.5 ТЗ).

Ограничения из ТЗ соблюдаются строго: не больше четырёх товаров и только
одной категории. Главная ценность страницы — не сами товары, а разница
между ними, поэтому строки с одинаковыми значениями помечаются отдельно и
интерфейс может их свернуть.
"""

from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.config import settings
from app.core.errors import BadRequestError, NotFoundError
from app.models.catalog import AttributeDef, Product, ProductSpec
from app.repositories.catalog import effective_status
from app.schemas.catalog import BrandRef, CategoryRef
from app.schemas.preferences import CompareAttributeRow, CompareProduct, CompareResponse

LOW_STOCK_THRESHOLD = 5


class CompareService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def compare(self, product_ids: list[uuid.UUID]) -> CompareResponse:
        unique_ids = list(dict.fromkeys(product_ids))

        if len(unique_ids) > settings.max_compare_items:
            raise BadRequestError(
                f"Сравнить можно не более {settings.max_compare_items} товаров (раздел 5.5 ТЗ)",
                code="too_many_products_to_compare",
                fields={"product_ids": f"передано {len(unique_ids)}"},
            )

        stmt = (
            select(Product)
            .where(Product.id.in_(unique_ids), Product.is_active.is_(True))
            .options(
                selectinload(Product.category),
                selectinload(Product.brand),
                selectinload(Product.images),
            )
        )
        products = list((await self.session.execute(stmt)).scalars().unique().all())

        if len(products) != len(unique_ids):
            raise NotFoundError("Часть товаров не найдена", code="product_not_found")

        category = products[0].category
        if any(product.category_id != category.id for product in products[1:]):
            raise BadRequestError(
                "Сравнивать можно только товары одной категории",
                code="mixed_categories",
                fields={"category": category.name},
            )

        # Порядок как во входном списке: пользователь выбирал именно так.
        by_id = {product.id: product for product in products}
        ordered = [by_id[product_id] for product_id in unique_ids]

        spec_map = await self._specs_map([product.id for product in ordered])
        definitions = await self._attribute_definitions()

        rows: list[CompareAttributeRow] = []
        compare_products: list[CompareProduct] = []

        for product in ordered:
            specs = spec_map.get(product.id, {})
            compare_products.append(self._to_product(product, specs, definitions))

        for definition in definitions:
            values = [
                _format_spec(spec_map.get(product.id, {}).get(definition.key), definition)
                for product in ordered
            ]
            present = [value for value in values if value is not None]
            if not present:
                continue
            different = len(set(present)) > 1
            rows.append(
                CompareAttributeRow(
                    key=definition.key,
                    name=definition.name,
                    unit=definition.unit,
                    values=values,
                    is_different=different,
                )
            )

        return CompareResponse(
            category=CategoryRef(
                id=category.id,
                name=category.name,
                slug=category.slug,
                level=category.level,
            ),
            products=compare_products,
            attributes=rows,
            identical_count=sum(1 for row in rows if not row.is_different),
            different_count=sum(1 for row in rows if row.is_different),
        )

    async def _specs_map(
        self, product_ids: list[uuid.UUID]
    ) -> dict[uuid.UUID, dict[str, ProductSpec]]:
        """Значения характеристик всех сравниваемых товаров одним запросом."""
        stmt = (
            select(ProductSpec, AttributeDef)
            .join(AttributeDef, AttributeDef.id == ProductSpec.attribute_id)
            .where(ProductSpec.product_id.in_(product_ids), AttributeDef.is_comparable.is_(True))
        )
        result: dict[uuid.UUID, dict[str, ProductSpec]] = {
            product_id: {} for product_id in product_ids
        }
        for spec, definition in (await self.session.execute(stmt)).all():
            result[spec.product_id][definition.key] = spec
        return result

    async def _attribute_definitions(self) -> list[AttributeDef]:
        """Справочник сравниваемых характеристик в порядке показа.

        Порядок задан вручную через ``sort_order``: строки характеристик,
        где у товара значения нет, пропускаются, поэтому лишних пустых строк
        в таблице не появляется.
        """
        stmt = (
            select(AttributeDef)
            .where(AttributeDef.is_comparable.is_(True))
            .order_by(AttributeDef.sort_order, AttributeDef.name)
        )
        return list((await self.session.execute(stmt)).scalars().all())

    def _to_product(
        self,
        product: Product,
        specs: dict[str, ProductSpec],
        definitions: list[AttributeDef],
    ) -> CompareProduct:
        image = product.images[0] if product.images else None
        available = product.available_quantity
        values = {
            key: value
            for key, value in (
                (definition.key, _format_spec(specs.get(definition.key), definition))
                for definition in definitions
            )
            if value is not None
        }
        return CompareProduct(
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
            specs=values,
        )


def _format_spec(spec: ProductSpec | None, definition: AttributeDef) -> str | None:
    """Значение характеристики строкой; ``None``, если его нет у товара."""
    if spec is None:
        return None
    if spec.value_num is not None:
        return f"{spec.value_num.normalize():f}"
    if spec.value_bool is not None:
        return "Да" if spec.value_bool else "Нет"
    return spec.value_text
