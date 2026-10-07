"""Публичные маршруты каталога (разделы 8.2–8.4 ТЗ).

Здесь только разбор запроса и вызов сервиса. Вся бизнес-логика — в слое
сервисов, вся работа с базой — в репозитории: так правила ценообразования
и остатков невозможно случайно продублировать в роутере.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request

from app.core.deps import DbSession, OptionalUser
from app.schemas.catalog import (
    BrandListResponse,
    BrandResponse,
    CategoryListResponse,
    CategoryResponse,
    HomeResponse,
    ProductDetailResponse,
    ProductListResponse,
    SearchResponse,
)
from app.schemas.catalog_query import SORT_LABELS, parse_product_query
from app.services.catalog import CatalogService

router = APIRouter(tags=["Каталог"])


async def get_catalog(session: DbSession) -> CatalogService:
    return CatalogService(session)


CatalogServiceDep = Annotated[CatalogService, Depends(get_catalog)]


@router.get(
    "/categories",
    response_model=CategoryListResponse,
    summary="Дерево категорий",
)
async def list_categories(service: CatalogServiceDep) -> CategoryListResponse:
    return CategoryListResponse(items=await service.category_tree())


@router.get(
    "/categories/{slug}",
    response_model=CategoryResponse,
    summary="Категория со списком товаров",
)
async def get_category(
    slug: str,
    request: Request,
    session: DbSession,
) -> CategoryResponse:
    """Товары категории вместе с той же фильтрацией, что и у общего каталога.

    Отдельный маршрут, а не переиспользование ``/products`` с параметром:
    он возвращает хлебные крошки и данные родителя, которые нужны странице
    категории, но не нужны никому другому.
    """
    service = CatalogService(session)
    return await service.get_category_page(slug, parse_product_query(request.query_params))


@router.get("/brands", response_model=BrandListResponse, summary="Список брендов")
async def list_brands(service: CatalogServiceDep) -> BrandListResponse:
    return await service.brand_list()


@router.get(
    "/brands/{slug}",
    response_model=BrandResponse,
    summary="Бренд со списком товаров",
)
async def get_brand(
    slug: str,
    request: Request,
    session: DbSession,
) -> BrandResponse:
    service = CatalogService(session)
    return await service.brand_page(slug, parse_product_query(request.query_params))


@router.get(
    "/products",
    response_model=ProductListResponse,
    summary="Каталог товаров с фильтрами, сортировкой и фасетами",
)
async def list_products(
    request: Request,
    session: DbSession,
    user: OptionalUser,
    sort: Annotated[str | None, Query(description="Вариант сортировки")] = None,
) -> ProductListResponse:
    """Основной каталог.

    ``limit`` ограничен 100 на уровне разбора: без потолка клиент мог бы
    запросить весь каталог одним ответом (раздел 12 ТЗ).
    """
    service = CatalogService(session)
    query = parse_product_query(request.query_params)
    role = user.role if user else None
    return await service.list_products(query, role=role)


@router.get(
    "/products/{slug}",
    response_model=ProductDetailResponse,
    summary="Карточка товара",
)
async def get_product(
    slug: str,
    session: DbSession,
    user: OptionalUser,
) -> ProductDetailResponse:
    service = CatalogService(session)
    return await service.get_product_with_relations(slug, role=user.role if user else None)


@router.get("/search", response_model=SearchResponse, summary="Поиск по каталогу")
async def search(
    session: DbSession,
    q: Annotated[str, Query(min_length=0, max_length=200)],
    limit: Annotated[int, Query(ge=1, le=20)] = 6,
) -> SearchResponse:
    return await CatalogService(session).search(q, limit=limit)


@router.get(
    "/sort-options",
    summary="Доступные варианты сортировки",
)
async def sort_options() -> dict[str, str]:
    """Справочник сортировок — чтобы подписи в интерфейсе не дублировались
    в двух местах и не разъехались с backend."""
    return {key.value: label for key, label in SORT_LABELS.items()}


@router.get(
    "/home",
    response_model=HomeResponse,
    summary="Данные главной страницы",
)
async def home(session: DbSession) -> HomeResponse:
    return await CatalogService(session).home()
