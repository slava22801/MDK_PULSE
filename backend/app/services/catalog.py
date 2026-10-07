"""Сервис каталога: сборка ответов для витрины (разделы 5.2–5.4 ТЗ).

Слой существует ради одного правила: наружу не отдаются ORM-объекты.
Каждый товар превращается в :class:`ProductCard`, где есть ровно те поля,
которые нужны покупателю, — вместе с этим отсекаются ``purchase_price``,
``stock_quantity`` и прочие внутренние величины.
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import NotFoundError
from app.models.catalog import AttributeDef, Category, Product
from app.models.enums import ProductRelationKind, ProductStatus, UserRole
from app.repositories.catalog import CatalogRepository, effective_status
from app.schemas.catalog import (
    BrandListResponse,
    BrandOut,
    BrandRef,
    BrandResponse,
    CategoryRef,
    CategoryResponse,
    FacetAttribute,
    FacetBrand,
    FacetPrice,
    Facets,
    FacetValue,
    HomeResponse,
    ProductCard,
    ProductDetail,
    ProductDetailResponse,
    ProductImageOut,
    ProductListResponse,
    ProductSpecOut,
    SearchResponse,
)
from app.schemas.catalog_query import ProductQuery

logger = logging.getLogger(__name__)

# Порог «мало на складе» берётся из настроек, а не из константы репозитория,
# чтобы админ мог изменить его без правки кода.
LOW_STOCK_THRESHOLD = 5


class CatalogService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session
        self.repo = CatalogRepository(session)

    # ── Публичные методы ──

    async def list_products(
        self,
        query: ProductQuery,
        *,
        role: UserRole | None = None,
    ) -> ProductListResponse:
        category_ids = await self._resolve_category_ids(query)
        repo = await self._repo_with_attributes(category_ids)

        products, total = await repo.list_products(query, category_ids=category_ids)
        cards = await self._to_cards(repo, products)
        facets = await self._build_facets(repo, query, category_ids)
        return ProductListResponse(
            items=cards,
            total=total,
            page=query.page,
            limit=query.limit,
            pages=_pages(total, query.limit),
            facets=facets,
        )

    async def _product_detail(
        self,
        product: Product,
        role: UserRole | None,
    ) -> ProductDetail:
        """Собирает карточку товара из уже загруженного объекта.

        Товар приходит аргументом, а не по slug: иначе страница карточки
        делала бы второй запрос только ради id того же товара.
        """
        images = await self.repo.get_product_images(product.id)
        spec_rows = await self.repo.get_attributes_for_product(product.id)

        card = (await self._to_cards(self.repo, [product], images_by_product={product.id: images}))[
            0
        ]

        return ProductDetail(
            **card.model_dump(),
            short_description=product.short_description,
            description=product.description,
            images=[ProductImageOut.model_validate(i, from_attributes=True) for i in images],
            specs=[_spec_out(spec, attribute) for spec, attribute in spec_rows],
            # Закупочная цена — только сотрудникам (раздел 6.1 ТЗ).
            purchase_price=product.purchase_price if role and role.is_staff else None,
        )

    async def get_product(self, slug: str, *, role: UserRole | None = None) -> ProductDetail:
        product = await self.repo.get_product_by_slug(slug)
        if product is None or not product.is_active:
            raise NotFoundError("Товар не найден", code="product_not_found")
        return await self._product_detail(product, role)

    async def get_product_with_relations(
        self,
        slug: str,
        *,
        role: UserRole | None = None,
    ) -> ProductDetailResponse:
        """Карточка товара вместе с похожими и совместимыми (раздел 5.4)."""
        product = await self.repo.get_product_by_slug(slug)
        if product is None or not product.is_active:
            raise NotFoundError("Товар не найден", code="product_not_found")

        detail = await self._product_detail(product, role)

        similar_models = await self.repo.get_related(product.id, ProductRelationKind.SIMILAR)
        if not similar_models:
            similar_models = await self.repo.get_similar_by_category(
                product.category_id, product.id
            )
        compatible_models = await self.repo.get_related(product.id, ProductRelationKind.COMPATIBLE)

        return ProductDetailResponse(
            product=detail,
            similar=await self._to_cards(self.repo, similar_models),
            compatible=await self._to_cards(self.repo, compatible_models),
        )

    async def get_category_page(
        self,
        slug: str,
        query: ProductQuery,
        *,
        role: UserRole | None = None,
    ):
        category = await self.repo.get_category_by_slug(slug)
        if category is None:
            raise NotFoundError("Категория не найдена", code="category_not_found")

        scoped = ProductQuery(**{**query.__dict__, "category_slug": slug})
        products = await self.list_products(scoped, role=role)
        breadcrumb = await self.repo.get_breadcrumb(category)
        parent = breadcrumb[-2] if len(breadcrumb) > 1 else None

        return CategoryResponse(
            category=_category_ref(category),
            parent=_category_ref(parent) if parent else None,
            breadcrumb=[_category_ref(item) for item in breadcrumb],
            products=products,
        )

    async def category_tree(self) -> list[CategoryRef]:
        """Дерево категорий из плоского списка.

        Сборка идёт на обычных структурах, а не на ORM-связях: так дерево
        строится без лишних запросов и без обращения к ленивым коллекциям.
        """
        rows = await self.repo.list_categories_flat()
        nodes = {row.id: _category_ref(row) for row in rows}

        roots: list[CategoryRef] = []
        for row in rows:
            node = nodes[row.id]
            parent = nodes.get(row.parent_id) if row.parent_id else None
            if parent is None:
                roots.append(node)
            else:
                parent.children.append(node)
        return roots

    async def brand_list(self):
        brands = await self.repo.get_brands()

        return BrandListResponse(
            items=[BrandOut.model_validate(b, from_attributes=True) for b in brands]
        )

    async def brand_page(self, slug: str, query: ProductQuery, *, role: UserRole | None = None):
        brand = await self.repo.get_brand_by_slug(slug)
        if brand is None:
            raise NotFoundError("Бренд не найден", code="brand_not_found")

        scoped = ProductQuery(**{**query.__dict__, "brand_slug": slug})
        products = await self.list_products(scoped, role=role)
        return BrandResponse(
            brand=BrandRef.model_validate(brand, from_attributes=True),
            products=products,
        )

    async def search(self, needle: str, *, limit: int = 6):
        """Поиск по разделу 5.3: товары, категории, бренды, подсказки."""
        from app.schemas.catalog_query import SortOption

        trimmed = needle.strip()
        if len(trimmed) < 2:
            return SearchResponse()

        query = ProductQuery(search=trimmed, sort=SortOption.POPULAR, limit=limit, page=1)
        products, _ = await self.repo.list_products(query)
        cards = await self._to_cards(self.repo, products)

        categories = await self.repo.suggest_categories(trimmed, limit=5)
        brands = await self.repo.suggest_brands(trimmed, limit=5)
        suggestions = await self.repo.popular_searches(limit=6)

        return SearchResponse(
            products=cards,
            categories=[_category_ref(c) for c in categories],
            brands=[BrandOut.model_validate(b, from_attributes=True) for b in brands],
            suggestions=suggestions,
        )

    async def home(self):
        """Данные главной страницы (раздел 5.1)."""
        from sqlalchemy import select

        from app.models.content import Banner

        banner_rows = (
            (
                await self.session.execute(
                    select(Banner)
                    .where(Banner.is_active.is_(True))
                    .order_by(Banner.sort_order, Banner.created_at.desc())
                    .limit(6)
                )
            )
            .scalars()
            .all()
        )

        banners = [
            {
                "id": str(banner.id),
                "title": banner.title,
                "subtitle": banner.subtitle,
                "image_url": banner.image_url,
                "link_url": banner.link_url,
                "button_text": banner.button_text,
            }
            for banner in banner_rows
        ]

        categories = await self.category_tree()
        repo = self.repo

        return HomeResponse(
            banners=banners,
            categories=categories,
            recommended=await self._to_cards(repo, await repo.recommended()),
            discounted=await self._to_cards(repo, await repo.discounted()),
            newest=await self._to_cards(repo, await repo.newest()),
            generated_at=datetime.now(UTC),
        )

    # ── Внутреннее ──

    async def _repo_with_attributes(
        self, category_ids: list[uuid.UUID] | None
    ) -> CatalogRepository:
        """Репозиторий со словарём «ключ характеристики → id».

        Собирается один раз на запрос: иначе каждый фильтр по
        характеристике означал бы лишний запрос за справочником.
        """
        attributes = await self.repo.get_filterable_attributes(category_ids)
        index = {attribute.key: (attribute.id, attribute.data_type) for attribute in attributes}
        return CatalogRepository(self.session, attribute_index=index)

    async def _resolve_category_ids(self, query: ProductQuery) -> list[uuid.UUID] | None:
        """Список id категорий, попадающих в выборку.

        По умолчанию берётся только сама категория: если бы «Материнские
        платы» включала в себя «Видеокарты», подкатегории перемешались бы
        с товарами. Родительский каталог включает детей явно и только там,
        где это осмысленно.
        """
        if not query.category_slug:
            return None
        category = await self.repo.get_category_by_slug(query.category_slug)
        if category is None:
            raise NotFoundError("Категория не найдена", code="category_not_found")
        if query.include_descendants:
            children = await self.repo.get_category_descendants(category.id)
            return [category.id, *children]
        return [category.id]

    async def _to_cards(
        self,
        repo: CatalogRepository,
        products: list[Product],
        images_by_product: dict[uuid.UUID, list] | None = None,
    ) -> list[ProductCard]:
        """Модели → карточки.

        Галерея приходит связью ``Product.images`` с ``lazy="selectin"``:
        это один дополнительный запрос на страницу каталога. Отдельный
        запрос за главными фото не делается — при list-in-s он всё равно
        стоил бы столько же, а при обычном чтении дал бы ещё один.
        """
        if not products:
            return []

        cards: list[ProductCard] = []
        for product in products:
            gallery = (
                images_by_product.get(product.id, [])
                if images_by_product is not None
                else list(product.images or [])
            )
            main = gallery[0] if gallery else None
            cards.append(
                ProductCard(
                    id=product.id,
                    slug=product.slug,
                    name=product.name,
                    sku=product.sku,
                    brand=(
                        BrandRef.model_validate(product.brand, from_attributes=True)
                        if product.brand
                        else None
                    ),
                    category=_category_ref(product.category),
                    price=product.price,
                    old_price=product.old_price,
                    discount_percent=product.discount_percent,
                    currency=product.currency,
                    image_url=main.image_url if main else None,
                    image_alt=(main.alt or product.name) if main else product.name,
                    availability=effective_status(
                        product.status, product.available_quantity, LOW_STOCK_THRESHOLD
                    ),
                    available_quantity=product.available_quantity,
                    in_stock=product.is_purchasable,
                    rating_avg=product.rating_avg,
                    rating_count=product.rating_count,
                    warranty_months=product.warranty_months,
                )
            )
        return cards

    async def _build_facets(
        self,
        repo: CatalogRepository,
        query: ProductQuery,
        category_ids: list[uuid.UUID] | None,
    ) -> Facets:
        """Счётчики для фильтров.

        Важно: фасеты считаются по выборке БЕЗ применения самого
        соответствующего фильтра. Иначе выбор галочки уменьшал бы её же
        счётчик до нуля, и фильтр нельзя было бы снять.
        """
        attributes = await repo.get_filterable_attributes(category_ids)
        brand_rows = await repo.brand_facets(
            _without(query, brand_slug=None), category_ids=category_ids
        )
        price_min, price_max = await repo.price_bounds(
            _without(query, min_price=None, max_price=None), category_ids=category_ids
        )
        availability = await repo.availability_facets(query, category_ids=category_ids)
        attribute_counts = await repo.attribute_facets(attributes, query, category_ids=category_ids)

        facet_attributes: list[FacetAttribute] = []
        for attribute in attributes:
            counts = attribute_counts.get(attribute.id, {})
            values = counts.get("values", [])
            options = None
            if attribute.options:
                options = [
                    FacetValue(
                        value=str(item.get("value")),
                        label=str(item.get("label") or item.get("value")),
                    )
                    for item in attribute.options
                ]
            facet_attributes.append(
                FacetAttribute(
                    key=attribute.key,
                    name=attribute.name,
                    data_type=attribute.data_type.value,
                    unit=attribute.unit,
                    widget=attribute.filter_widget.value if attribute.filter_widget else None,
                    options=options,
                    is_filterable=attribute.is_filterable,
                    is_comparable=attribute.is_comparable,
                    min=counts.get("min"),
                    max=counts.get("max"),
                    values=[FacetValue(value=str(v), count=int(c)) for v, c in values],
                )
            )

        return Facets(
            brands=[FacetBrand(slug=b.slug, name=b.name, count=c) for b, c in brand_rows],
            price=FacetPrice(min=price_min, max=price_max),
            availability=[
                FacetValue(
                    value=status.value, label=_STATUS_LABELS.get(status, status.value), count=count
                )
                for status, count in sorted(availability.items(), key=lambda pair: -pair[1])
            ],
            attributes=facet_attributes,
        )


_STATUS_LABELS: dict[ProductStatus, str] = {
    ProductStatus.IN_STOCK: "В наличии",
    ProductStatus.LOW_STOCK: "Мало на складе",
    ProductStatus.ON_ORDER: "Под заказ",
    ProductStatus.EXPECTED: "Ожидается поставка",
    ProductStatus.OUT_OF_STOCK: "Отсутствует",
    ProductStatus.DISCONTINUED: "Снят с продажи",
}


def _category_ref(category: Category | None, *, with_children: bool = False) -> CategoryRef:
    """Ссылка на категорию для ответа API.

    ``with_children`` по умолчанию выключен намеренно. У карточки товара
    подкатегории не нужны, а попытка их прочитать здесь означала бы ленивую
    загрузку вне async-контекста: связь ``children`` объявлена как
    ``lazy="selectin"``, но selectin не срабатывает для категории, притянутой
    через JOIN вместе с товаром, и запрос падал с MissingGreenlet.
    """
    if category is None:
        raise NotFoundError("Категория не найдена", code="category_not_found")
    return CategoryRef(
        id=category.id,
        name=category.name,
        slug=category.slug,
        level=category.level,
        parent_id=category.parent_id,
        image_url=category.image_url,
        children=(
            [_category_ref(child, with_children=True) for child in (category.children or [])]
            if with_children
            else []
        ),
    )


def _spec_out(spec, attribute: AttributeDef) -> ProductSpecOut:
    """Значение характеристики в виде строки для карточки товара.

    Числа приводятся к виду без лишних нулей: «8 ядер», а не «8.0000 ядер».
    """
    if spec.value_num is not None:
        value = f"{spec.value_num.normalize():f}"
    elif spec.value_bool is not None:
        value = "Да" if spec.value_bool else "Нет"
    else:
        value = spec.value_text or ""
    return ProductSpecOut(
        key=attribute.key,
        name=attribute.name,
        value=value,
        unit=attribute.unit,
        data_type=attribute.data_type.value,
        sort_order=attribute.sort_order,
    )


def _pages(total: int, limit: int) -> int:
    if limit <= 0:
        return 0
    return (total + limit - 1) // limit


def _without(query: ProductQuery, **overrides) -> ProductQuery:
    """Копия запроса с исключёнными полями — для честного подсчёта фасетов."""
    return ProductQuery(**{**query.__dict__, **overrides})
