"""Доступ к каталогу: товары, категории, бренды, характеристики и фасеты.

Все условия фильтрации собираются через SQLAlchemy Core; параметры
подставляются, а не склеиваются в строку, поэтому инъекция в параметрах
невозможна (раздел 10 ТЗ).
"""

from __future__ import annotations

import uuid
from decimal import Decimal, InvalidOperation

import sqlalchemy
from sqlalchemy import Select, and_, case, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

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
from app.schemas.catalog_query import AttributeFilter, ProductQuery, SortOption


class CatalogRepository:
    def __init__(
        self,
        session: AsyncSession,
        attribute_index: dict[str, tuple[uuid.UUID, AttributeDataType]] | None = None,
    ) -> None:
        self.session = session
        # Соответствие «ключ характеристики → (id, тип)» готовит сервис один
        # раз на запрос. Тип обязателен: у числовой характеристики значение
        # лежит в value_num, а у перечисления — в value_text, и фильтр по
        # точному значению обязан смотреть в ту колонку, где оно записано.
        # Хранится в экземпляре, а не в классе: репозиторий живёт один
        # запрос, и общий словарь при параллельных запросах перетирал бы себя.
        self.attribute_index = attribute_index or {}

    # ── Категории ──

    async def list_categories_flat(self, *, only_active: bool = True) -> list[Category]:
        """Все категории плоским списком, отсортированные как для дерева.

        Дерево собирает сервис, из обычных структур: складывать и��емени
        ORM-связь ``children`` здесь нельзя — обращение к коллекции вызывает
        ленивую загрузку, а она вне async-контекста падает с MissingGreenlet.
        """
        stmt = select(Category).order_by(Category.level, Category.sort_order, Category.name)
        if only_active:
            stmt = stmt.where(Category.is_active.is_(True))
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def get_category_by_slug(self, slug: str, *, only_active: bool = True) -> Category | None:
        stmt = (
            select(Category).where(Category.slug == slug).options(selectinload(Category.children))
        )
        if only_active:
            stmt = stmt.where(Category.is_active.is_(True))
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def get_category(self, category_id: uuid.UUID) -> Category | None:
        return await self.session.get(Category, category_id)

    async def get_category_descendants(self, category_id: uuid.UUID) -> list[uuid.UUID]:
        """Все потомки категории — для фильтра «включая подкатегории».

        Уровней всего два (раздел 6.2 ТЗ), поэтому одного запроса за детей
        достаточно; рекурсия была бы преждевременной сложностью.
        """
        result = await self.session.execute(
            select(Category.id).where(Category.parent_id == category_id)
        )
        return list(result.scalars().all())

    async def get_breadcrumb(self, category: Category) -> list[Category]:
        """Путь от корня до категории."""
        chain: list[Category] = [category]
        current = category
        while current.parent_id is not None:
            parent = await self.session.get(Category, current.parent_id)
            if parent is None:
                break
            chain.insert(0, parent)
            current = parent
        return chain

    # ── Бренды ──

    async def get_brands(self, *, only_active: bool = True) -> list[Brand]:
        stmt = select(Brand).order_by(Brand.name)
        if only_active:
            stmt = stmt.where(Brand.is_active.is_(True))
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def get_brand_by_slug(self, slug: str, *, only_active: bool = True) -> Brand | None:
        stmt = select(Brand).where(Brand.slug == slug)
        if only_active:
            stmt = stmt.where(Brand.is_active.is_(True))
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    # ── Характеристики ──

    async def get_filterable_attributes(
        self, category_ids: list[uuid.UUID] | None
    ) -> list[AttributeDef]:
        """Справочник фильтров: общие для всего каталога и специфичные для категории."""
        stmt = select(AttributeDef).where(AttributeDef.is_filterable.is_(True))
        if category_ids:
            stmt = stmt.where(
                or_(
                    AttributeDef.category_id.is_(None),
                    AttributeDef.category_id.in_(category_ids),
                )
            )
        stmt = stmt.order_by(AttributeDef.sort_order, AttributeDef.name)
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def get_attributes_for_product(
        self, product_id: uuid.UUID
    ) -> list[tuple[ProductSpec, AttributeDef]]:
        result = await self.session.execute(
            select(ProductSpec, AttributeDef)
            .join(AttributeDef, AttributeDef.id == ProductSpec.attribute_id)
            .where(ProductSpec.product_id == product_id)
            .order_by(AttributeDef.sort_order, AttributeDef.name)
        )
        return list(result.all())

    async def get_attribute_by_key(self, key: str) -> AttributeDef | None:
        result = await self.session.execute(select(AttributeDef).where(AttributeDef.key == key))
        return result.scalar_one_or_none()

    # ── Товары ──

    def _apply_filters(
        self,
        stmt: Select,
        query: ProductQuery,
        *,
        category_ids: list[uuid.UUID] | None = None,
    ) -> Select:
        """Навешивает условия выборки.

        ``available`` считается выражением прямо в SQL: колонки такого поля
        в таблице нет, и материализовать его значило бы рассинхронизировать
        с остатками вручную.
        """
        available = Product.stock_quantity - Product.reserved_quantity

        if category_ids:
            stmt = stmt.where(Product.category_id.in_(category_ids))

        if query.brand_slug:
            stmt = stmt.join(Brand, Brand.id == Product.brand_id).where(
                Brand.slug == query.brand_slug
            )

        if query.min_price is not None:
            stmt = stmt.where(Product.price >= query.min_price)
        if query.max_price is not None:
            stmt = stmt.where(Product.price <= query.max_price)

        if query.in_stock is True:
            stmt = stmt.where(
                available > 0,
                Product.status.in_([ProductStatus.IN_STOCK, ProductStatus.LOW_STOCK]),
            )
        elif query.in_stock is False:
            stmt = stmt.where(available <= 0)

        if query.min_rating is not None:
            stmt = stmt.where(Product.rating_avg >= query.min_rating)

        if query.has_discount is True:
            stmt = stmt.where(Product.old_price.is_not(None), Product.old_price > Product.price)
        elif query.has_discount is False:
            stmt = stmt.where(or_(Product.old_price.is_(None), Product.old_price <= Product.price))

        if query.warranty:
            stmt = stmt.where(Product.warranty_months.in_(query.warranty))

        if query.search:
            stmt = stmt.where(self._search_condition(query.search))

        for attribute_filter in query.attributes:
            stmt = self._apply_attribute_filter(stmt, attribute_filter)

        return stmt

    def _apply_attribute_filter(self, stmt: Select, attribute_filter: AttributeFilter) -> Select:
        """Ограничение по одной характеристике.

        Числовые значения сравниваются в ``value_num``, текстовые — в
        ``value_text``. Диапазон и список значений могут сочетаться: это
        «объём от 1 ТБ, и только Samsung».

        Важно: выбор конкретного значения у числовой характеристики тоже
        идёт в ``value_num``, а не в ``value_text``. Иначе фильтр
        ``attr.gpu.memory_size=24`` молча возвращал бы ноль товаров, хотя
        фасет рядом с этим значением показывал бы count: 1.
        """
        entry = self.attribute_index.get(attribute_filter.key)
        if entry is None:
            return stmt
        attribute_id, data_type = entry

        if attribute_filter.values:
            column = (
                ProductSpec.value_num
                if data_type is AttributeDataType.NUMBER
                else ProductSpec.value_text
            )
            values: list = list(attribute_filter.values)
            if data_type is AttributeDataType.NUMBER:
                try:
                    values = [Decimal(value) for value in values]
                except (InvalidOperation, ValueError):
                    # Невычислимое значение в числовом фильтре — это пустая
                    # выборка, а не 500: пользователь мог ввести что угодно.
                    return stmt.where(sqlalchemy.false())

            stmt = stmt.where(
                ProductSpec.product_id == Product.id,
                ProductSpec.attribute_id == attribute_id,
                column.in_(values),
            )
            return stmt

        if attribute_filter.min_value is not None or attribute_filter.max_value is not None:
            bounds = []
            if attribute_filter.min_value is not None:
                bounds.append(ProductSpec.value_num >= attribute_filter.min_value)
            if attribute_filter.max_value is not None:
                bounds.append(ProductSpec.value_num <= attribute_filter.max_value)
            stmt = stmt.where(
                ProductSpec.product_id == Product.id,
                ProductSpec.attribute_id == attribute_id,
                and_(*bounds),
            )
        return stmt

    def _search_condition(self, needle: str) -> object:
        """Поиск по названию, артикулу, модели и описанию (раздел 5.3).

        Используется ``ILIKE`` с подстрокой, а не расстояние до слова
        целиком: пользователь ищет «7800x3d», а не «Ryzen 7 7800X3D», и
        trgm-индекс по подстроке отрабатывает заметно быстрее на коротких
        запросах.
        """
        pattern = f"%{needle.strip()}%"
        return or_(
            Product.name.ilike(pattern),
            Product.sku.ilike(pattern),
            Product.model.ilike(pattern),
            Product.short_description.ilike(pattern),
        )

    def _order_clause(self, sort: SortOption) -> list:
        """Порядок выдачи каталога.

        Во всех вариантах последним условием идёт ``id`` — без него две
        строки с одинаковым значением сортировки могли бы «прыгать» между
        страницами, и пользователь увидел бы дубли и пропуски.
        """
        if sort == SortOption.PRICE_ASC:
            return [Product.price.asc(), Product.id.asc()]
        if sort == SortOption.PRICE_DESC:
            return [Product.price.desc(), Product.id.asc()]
        if sort == SortOption.RATING:
            return [Product.rating_avg.desc(), Product.rating_count.desc(), Product.id.asc()]
        if sort == SortOption.NEWEST:
            return [Product.created_at.desc(), Product.id.asc()]
        if sort == SortOption.DISCOUNT:
            discount = case(
                (
                    and_(
                        Product.old_price.is_not(None),
                        Product.old_price > Product.price,
                        Product.old_price > 0,
                    ),
                    100 * (Product.old_price - Product.price) / Product.old_price,
                ),
                else_=0,
            )
            return [discount.desc(), Product.id.asc()]
        # По популярности: продажи, затем рейтинг.
        return [
            Product.sales_count.desc(),
            Product.rating_count.desc(),
            Product.rating_avg.desc(),
            Product.id.asc(),
        ]

    async def list_products(
        self,
        query: ProductQuery,
        *,
        category_ids: list[uuid.UUID] | None = None,
        include_relations: bool = False,
    ) -> tuple[list[Product], int]:
        """Возвращает страницу товаров и общее количество по выборке.

        Количество считается тем же набором условий, что и выборка, — иначе
        пагинация показывала бы неверное число страниц.
        """
        base = select(Product).where(Product.is_active.is_(True))
        base = self._apply_filters(base, query, category_ids=category_ids)

        if include_relations:
            base = base.options(
                selectinload(Product.images),
                selectinload(Product.category),
                selectinload(Product.brand),
            )

        count_stmt = select(func.count()).select_from(base.subquery())
        total = (await self.session.execute(count_stmt)).scalar_one()

        page_stmt = base.order_by(*self._order_clause(query.sort))
        page_stmt = page_stmt.offset(query.offset).limit(query.limit)
        if not include_relations:
            page_stmt = page_stmt.options(
                selectinload(Product.category),
                selectinload(Product.brand),
            )

        result = await self.session.execute(page_stmt)
        return list(result.scalars().all()), int(total)

    async def get_product_by_slug(self, slug: str) -> Product | None:
        stmt = (
            select(Product)
            .where(Product.slug == slug)
            .options(
                selectinload(Product.images),
                selectinload(Product.category),
                selectinload(Product.brand),
            )
        )
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def get_product_images(self, product_id: uuid.UUID) -> list[ProductImage]:
        result = await self.session.execute(
            select(ProductImage)
            .where(ProductImage.product_id == product_id)
            .order_by(ProductImage.is_main.desc(), ProductImage.sort_order, ProductImage.created_at)
        )
        return list(result.scalars().all())

    async def get_related(self, product_id: uuid.UUID, kind: ProductRelationKind) -> list[Product]:
        stmt = (
            select(Product)
            .join(ProductRelation, ProductRelation.related_id == Product.id)
            .where(
                ProductRelation.product_id == product_id,
                ProductRelation.kind == kind,
                Product.is_active.is_(True),
            )
            .order_by(Product.sales_count.desc(), Product.rating_avg.desc())
            .limit(12)
            .options(selectinload(Product.category), selectinload(Product.brand))
        )
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def get_similar_by_category(
        self,
        category_id: uuid.UUID,
        exclude_id: uuid.UUID,
        limit: int = 12,
    ) -> list[Product]:
        """Похожие: та же категория, исключая сам товар (раздел 5.4)."""
        stmt = (
            select(Product)
            .where(
                Product.category_id == category_id,
                Product.id != exclude_id,
                Product.is_active.is_(True),
            )
            .order_by(Product.rating_avg.desc(), Product.sales_count.desc())
            .limit(limit)
            .options(selectinload(Product.category), selectinload(Product.brand))
        )
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def get_main_images(self, product_ids: list[uuid.UUID]) -> dict[uuid.UUID, ProductImage]:
        """Главное изображение для списка товаров — одним запросом.

        N+1 на списке из 24 карточек — это 24 дополнительных запроса на
        каждый открытый каталог.
        """
        if not product_ids:
            return {}
        stmt = (
            select(ProductImage)
            .where(ProductImage.product_id.in_(product_ids))
            .order_by(ProductImage.is_main.desc(), ProductImage.sort_order)
        )
        result = await self.session.execute(stmt)
        images: dict[uuid.UUID, ProductImage] = {}
        for image in result.scalars().all():
            if image.product_id not in images:
                images[image.product_id] = image
        return images

    # ── Фасеты ──

    async def price_bounds(
        self,
        query: ProductQuery,
        *,
        category_ids: list[uuid.UUID] | None = None,
    ) -> tuple[Decimal | None, Decimal | None]:
        stmt = select(func.min(Product.price), func.max(Product.price)).where(
            Product.is_active.is_(True)
        )
        stmt = self._apply_filters(stmt, query, category_ids=category_ids)
        # Границы цены считаем без самих ограничений цены: ползунок должен
        # показывать диапазон каталога, а не уже суженный пользователем.
        min_price, max_price = (await self.session.execute(stmt)).one()
        return min_price, max_price

    async def brand_facets(
        self,
        query: ProductQuery,
        *,
        category_ids: list[uuid.UUID] | None = None,
    ) -> list[tuple[Brand, int]]:
        stmt = (
            select(Brand, func.count(Product.id))
            .join(Product, Product.brand_id == Brand.id)
            .where(Product.is_active.is_(True))
            .group_by(Brand.id)
            .order_by(func.count(Product.id).desc())
        )
        stmt = self._apply_filters(stmt, query, category_ids=category_ids)
        return [(brand, int(count)) for brand, count in (await self.session.execute(stmt)).all()]

    async def availability_facets(
        self,
        query: ProductQuery,
        *,
        category_ids: list[uuid.UUID] | None = None,
    ) -> dict[ProductStatus, int]:
        """Сколько товаров в каждом состоянии доступности.

        Статус в БД и статус в интерфейсе — разные вещи: товар со
        статусом ``in_stock`` и остатком 2 должен показываться как «мало на
        складе». Пересчёт делается прямо в SQL одной агрегацией; забирать
        весь каталог и считать в Python нельзя — на реальном объёме это
        сотни тысяч строк на каждый открытый каталог.
        """
        available = Product.stock_quantity - Product.reserved_quantity
        low_threshold = 5

        effective = case(
            (
                Product.status.in_(
                    [ProductStatus.DISCONTINUED, ProductStatus.ON_ORDER, ProductStatus.EXPECTED]
                ),
                Product.status,
            ),
            (available <= 0, ProductStatus.OUT_OF_STOCK),
            (available <= low_threshold, ProductStatus.LOW_STOCK),
            else_=ProductStatus.IN_STOCK,
        )

        stmt = (
            select(effective.label("availability"), func.count(Product.id))
            .where(Product.is_active.is_(True))
            .group_by(effective)
        )
        stmt = self._apply_filters(stmt, query, category_ids=category_ids)
        rows = (await self.session.execute(stmt)).all()
        return {status: int(count) for status, count in rows}

    async def attribute_facets(
        self,
        attributes: list[AttributeDef],
        query: ProductQuery,
        *,
        category_ids: list[uuid.UUID] | None = None,
    ) -> dict[uuid.UUID, dict]:
        """Значения и границы каждой характеристики среди товаров выборки.

        Один запрос на характеристику, но не на товар: N+1 здесь означал бы
        сотни запросов на один список с пятью фильтрами.
        """
        result: dict[uuid.UUID, dict] = {}
        for attribute in attributes:
            column = (
                ProductSpec.value_num
                if attribute.data_type.value == "number"
                else ProductSpec.value_text
            )

            stmt = (
                select(column, func.count(ProductSpec.product_id))
                .join(Product, Product.id == ProductSpec.product_id)
                .where(ProductSpec.attribute_id == attribute.id, Product.is_active.is_(True))
                .group_by(column)
            )
            stmt = self._apply_filters(stmt, query, category_ids=category_ids)
            rows = (await self.session.execute(stmt)).all()
            values = [(value, int(count)) for value, count in rows if value is not None]

            if attribute.data_type.value == "number":
                numeric = [Decimal(str(value)) for value, _ in values]
                result[attribute.id] = {
                    "values": values,
                    "min": min(numeric) if numeric else None,
                    "max": max(numeric) if numeric else None,
                }
            else:
                result[attribute.id] = {
                    "values": sorted(values, key=lambda pair: (-pair[1], str(pair[0]))),
                    "min": None,
                    "max": None,
                }
        return result

    async def specs_map(
        self, product_ids: list[uuid.UUID]
    ) -> dict[uuid.UUID, list[tuple[ProductSpec, AttributeDef]]]:
        """Характеристики сразу для всех товаров выборки — одним запросом."""
        if not product_ids:
            return {}
        stmt = (
            select(ProductSpec, AttributeDef)
            .join(AttributeDef, AttributeDef.id == ProductSpec.attribute_id)
            .where(ProductSpec.product_id.in_(product_ids))
            .order_by(AttributeDef.sort_order, AttributeDef.name)
        )
        grouped: dict[uuid.UUID, list[tuple[ProductSpec, AttributeDef]]] = {}
        for spec, attribute in (await self.session.execute(stmt)).all():
            grouped.setdefault(spec.product_id, []).append((spec, attribute))
        return grouped

    # ── Витрина главной ──

    async def best_sellers(self, limit: int = 8) -> list[Product]:
        return await self._home_slice(limit, [Product.sales_count.desc()])

    async def newest(self, limit: int = 8) -> list[Product]:
        return await self._home_slice(limit, [Product.created_at.desc()])

    async def discounted(self, limit: int = 8) -> list[Product]:
        discount = case(
            (
                and_(
                    Product.old_price.is_not(None),
                    Product.old_price > Product.price,
                    Product.old_price > 0,
                ),
                100 * (Product.old_price - Product.price) / Product.old_price,
            ),
            else_=0,
        )
        return await self._home_slice(limit, [discount.desc()])

    async def recommended(self, limit: int = 8) -> list[Product]:
        """Рекомендации без отдельной модели рекомендаций (этап 3).

        Пока это «лучшее по рейтингу и популярности» — честная заглушка
        вместо выдачи, которая выглядит умной, но ничем не обоснована.
        Рекомендательный блок из раздела 16 появится на этапе 4.
        """
        return await self._home_slice(
            limit,
            [Product.rating_avg.desc(), Product.rating_count.desc(), Product.sales_count.desc()],
        )

    async def _home_slice(self, limit: int, order_by: list) -> list[Product]:
        stmt = (
            select(Product)
            .where(Product.is_active.is_(True))
            .order_by(*order_by)
            .limit(limit)
            .options(selectinload(Product.category), selectinload(Product.brand))
        )
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def suggest_categories(self, needle: str, limit: int = 5) -> list[Category]:
        pattern = f"%{needle}%"
        stmt = (
            select(Category)
            .where(Category.is_active.is_(True), Category.name.ilike(pattern))
            .order_by(Category.level, Category.sort_order)
            .limit(limit)
        )
        return list((await self.session.execute(stmt)).scalars().all())

    async def suggest_brands(self, needle: str, limit: int = 5) -> list[Brand]:
        pattern = f"%{needle}%"
        stmt = (
            select(Brand)
            .where(Brand.is_active.is_(True), Brand.name.ilike(pattern))
            .order_by(Brand.name)
            .limit(limit)
        )
        return list((await self.session.execute(stmt)).scalars().all())

    async def popular_searches(self, limit: int = 6) -> list[str]:
        """Подсказки из самых продаваемых товаров (раздел 5.3)."""
        stmt = (
            select(Product.name)
            .where(Product.is_active.is_(True), Product.sales_count > 0)
            .order_by(Product.sales_count.desc())
            .limit(limit)
        )
        return [row for row in (await self.session.execute(stmt)).scalars().all()]


def effective_status(
    status: ProductStatus, available: int, low_threshold: int = 5
) -> ProductStatus:
    """Статус товара для интерфейса.

    В баге состояние может быть устаревшим: остаток уменьшился, а статус
    остался ``in_stock``. Интерфейс показывает «мало на складе» или
    «отсутствует» по фактическому остатку, админка при этом видит реальное
    значение колонки и может его поправить.
    """
    if status is ProductStatus.DISCONTINUED or status is ProductStatus.ON_ORDER:
        return status
    if status is ProductStatus.EXPECTED:
        return status
    if available <= 0:
        return ProductStatus.OUT_OF_STOCK
    if available <= low_threshold:
        return ProductStatus.LOW_STOCK
    return status
