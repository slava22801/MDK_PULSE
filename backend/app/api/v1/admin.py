"""Административные маршруты (разделы 6 и 8.9–8.10 ТЗ).

Каждый маршрут закрыт проверкой роли: менеджер видит заказы, администратор —
ещё и каталог с пользователями (раздел 3.3 и 3.4 ТЗ).
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, Query, UploadFile, status
from sqlalchemy import func, select

from app.core.deps import CurrentUser, DbSession, RequestIP, require_admin, require_staff
from app.core.errors import BadRequestError, ConflictError, NotFoundError
from app.models.catalog import Brand, Category
from app.models.content import AdminAuditLog
from app.models.enums import (
    OrderStatus,
    ProductStatus,
    ReviewStatus,
    UserRole,
)
from app.models.review import Review
from app.schemas.admin import (
    AdminListResponse,
    AdminOrderDetail,
    AdminOrderUpdate,
    AdminProductDetail,
    AdminStockItem,
    AdminUserListItem,
    BrandCreate,
    CategoryCreate,
    ImportReport,
    ProductCreate,
    ProductUpdate,
    PromoCheckRequest,
    PromoCheckResponse,
    PromoCodeCreate,
    PromoCodeOut,
    PromoCodeUpdate,
    ReviewOut,
    ReviewUpdate,
    StatisticsResponse,
    StockAdjust,
    StockSet,
)
from app.services.admin import (
    AdminOrdersService,
    AdminPromoService,
    AdminUsersService,
    StatisticsService,
)
from app.services.admin_products import AdminProductsService, slugify
from app.services.admin_stock import AdminStockService
from app.services.audit import AuditService
from app.services.catalog import CatalogService
from app.services.import_products import ProductImporter

logger = logging.getLogger(__name__)

# Два роутера вместо проверки роли в сигнатуре каждой функции: зависимость
# объявляется один раз на группу маршрутов, и OpenAPI не засоряется
# предупреждениями о несериализуемых значениях по умолчанию.
staff_router = APIRouter(
    prefix="/admin",
    tags=["Администрирование — заказы"],
    dependencies=[Depends(require_staff)],
)
admin_router = APIRouter(
    prefix="/admin",
    tags=["Администрирование"],
    dependencies=[Depends(require_admin)],
)
# Остатки — отдельный роутер: правка количества нужна менеджеру (раздел 6.1),
# а каталог с ценами и характеристиками остаётся администраторским. Смешивать
# их в одном роутере нельзя — у них разный набор ролей.
stock_router = APIRouter(
    prefix="/admin",
    tags=["Администрирование — остатки"],
    dependencies=[Depends(require_staff)],
)

# Все роутеры подключаются в api/v1/router.py: у них разные требования к роли.
__all__ = ["admin_router", "staff_router", "stock_router"]

# 5 МБ — заведомо больше типового прайс-листа поставщика и меньше,
# чем достаточно, чтобы забить память при загрузке.
MAX_IMPORT_BYTES = 5 * 1024 * 1024


def _pages(total: int, limit: int, page: int) -> int:
    return (total + limit - 1) // limit if limit else 0


# ── Заказы ──


@staff_router.get("/orders", response_model=AdminListResponse, summary="Список заказов")
async def list_orders(
    session: DbSession,
    page: Annotated[int, Query(ge=1)] = 1,
    limit: Annotated[int, Query(ge=1, le=100)] = 25,
    status_filter: Annotated[OrderStatus | None, Query(alias="status")] = None,
    search: Annotated[str | None, Query(max_length=100)] = None,
    date_from: Annotated[datetime | None, Query()] = None,
    date_to: Annotated[datetime | None, Query()] = None,
) -> AdminListResponse:
    items, total = await AdminOrdersService(session).list_orders(
        page=page,
        limit=limit,
        status=status_filter,
        search=search,
        date_from=date_from,
        date_to=date_to,
    )
    return AdminListResponse(
        items=items, total=total, page=page, limit=limit, pages=_pages(total, limit, page)
    )


@staff_router.get("/orders/{order_id}", response_model=AdminOrderDetail, summary="Карточка заказа")
async def get_order(
    order_id: uuid.UUID,
    session: DbSession,
) -> AdminOrderDetail:
    return await AdminOrdersService(session).get_order(order_id)


@staff_router.patch("/orders/{order_id}", response_model=AdminOrderDetail, summary="Изменить заказ")
async def update_order(
    order_id: uuid.UUID,
    payload: AdminOrderUpdate,
    session: DbSession,
    actor: CurrentUser,
    ip: RequestIP,
) -> AdminOrderDetail:
    """Смена статуса проходит через статусную машину этапа 5.

    Недопустимый переход даёт 409 со списком разрешённых — сотрудник видит,
    что можно сделать вместо этого.
    """
    service = AdminOrdersService(session)
    if payload.status is not None:
        return await service.change_status(
            order_id,
            to=payload.status,
            actor=actor,
            tracking_number=payload.tracking_number,
            comment=payload.manager_comment,
            ip_address=ip,
        )

    order = await service.get_order(order_id)
    if payload.tracking_number is not None or payload.manager_comment is not None:
        await service.change_status(
            order_id,
            to=order.status,
            actor=actor,
            tracking_number=payload.tracking_number,
            comment=payload.manager_comment,
            ip_address=ip,
        )
    return await service.get_order(order_id)


@staff_router.post(
    "/orders/{order_id}/comment",
    response_model=AdminOrderDetail,
    summary="Добавить комментарий к заказу",
)
async def add_order_comment(
    order_id: uuid.UUID,
    comment: Annotated[str, Form(min_length=1, max_length=1000)],
    session: DbSession,
    actor: CurrentUser,
    ip: RequestIP,
) -> AdminOrderDetail:
    return await AdminOrdersService(session).add_comment(
        order_id,
        comment=comment,
        actor=actor,
        ip_address=ip,
    )


# ── Товары ──


@admin_router.get("/products", response_model=AdminListResponse, summary="Список товаров")
async def list_products(
    session: DbSession,
    page: Annotated[int, Query(ge=1)] = 1,
    limit: Annotated[int, Query(ge=1, le=100)] = 25,
    search: Annotated[str | None, Query(max_length=100)] = None,
    category_id: uuid.UUID | None = None,
    brand_id: uuid.UUID | None = None,
    status_filter: Annotated[ProductStatus | None, Query(alias="status")] = None,
    in_stock: bool | None = None,
) -> AdminListResponse:
    items, total = await AdminProductsService(session).list_products(
        page=page,
        limit=limit,
        search=search,
        category_id=category_id,
        brand_id=brand_id,
        status=status_filter,
        in_stock=in_stock,
    )
    return AdminListResponse(
        items=items, total=total, page=page, limit=limit, pages=_pages(total, limit, page)
    )


@admin_router.post(
    "/products",
    response_model=AdminProductDetail,
    status_code=status.HTTP_201_CREATED,
    summary="Создать товар",
)
async def create_product(
    payload: ProductCreate,
    session: DbSession,
    actor: CurrentUser,
    ip: RequestIP,
) -> AdminProductDetail:
    return await AdminProductsService(session).create_product(payload, actor=actor, ip_address=ip)


@admin_router.get("/products/{product_id}", summary="Товар с характеристиками")
async def get_product(
    product_id: uuid.UUID,
    session: DbSession,
) -> dict:
    detail, specs = await AdminProductsService(session).get_product(product_id)
    return {"product": detail.model_dump(mode="json"), "specs": specs}


@admin_router.patch(
    "/products/{product_id}", response_model=AdminProductDetail, summary="Изменить товар"
)
async def update_product(
    product_id: uuid.UUID,
    payload: ProductUpdate,
    session: DbSession,
    actor: CurrentUser,
    ip: RequestIP,
) -> AdminProductDetail:
    return await AdminProductsService(session).update_product(
        product_id, payload, actor=actor, ip_address=ip
    )


@admin_router.post(
    "/products/{product_id}/stock",
    response_model=AdminProductDetail,
    summary="Изменить остаток",
)
async def adjust_stock(
    product_id: uuid.UUID,
    payload: StockAdjust,
    session: DbSession,
    actor: CurrentUser,
    ip: RequestIP,
) -> AdminProductDetail:
    return await AdminProductsService(session).adjust_stock(
        product_id,
        payload.delta,
        actor=actor,
        reason=payload.reason,
        ip_address=ip,
    )


@admin_router.delete(
    "/products/{product_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Удалить товар",
)
async def delete_product(
    product_id: uuid.UUID,
    session: DbSession,
    actor: CurrentUser,
    ip: RequestIP,
) -> None:
    await AdminProductsService(session).delete_product(product_id, actor=actor, ip_address=ip)


# ── Остатки (доступны менеджеру) ──


@stock_router.get(
    "/stock",
    response_model=AdminListResponse,
    summary="Остатки товаров",
)
async def list_stock(
    session: DbSession,
    page: Annotated[int, Query(ge=1)] = 1,
    limit: Annotated[int, Query(ge=1, le=100)] = 25,
    search: Annotated[str | None, Query(max_length=100)] = None,
    category_id: uuid.UUID | None = None,
    only_low: Annotated[bool, Query()] = False,
) -> AdminListResponse:
    """Список остатков.

    Доступен сотруднику, а не только администратору: пересчёт остатков —
    ежедневная операция менеджера (раздел 6.1).
    """
    items, total = await AdminStockService(session).list_stock(
        page=page,
        limit=limit,
        search=search,
        category_id=category_id,
        only_low=only_low,
    )
    return AdminListResponse(
        items=items, total=total, page=page, limit=limit, pages=_pages(total, limit, page)
    )


@stock_router.patch(
    "/stock/{product_id}",
    response_model=AdminStockItem,
    summary="Задать остаток товара",
)
async def set_stock(
    product_id: uuid.UUID,
    payload: StockSet,
    session: DbSession,
    actor: CurrentUser,
    ip: RequestIP,
) -> AdminStockItem:
    """Задаёт количество товара, доступное для продажи.

    Сотрудник вводит абсолютное число, а сервис сам пересчитывает его в
    изменение остатка с учётом резервов — так занять резервы нельзя.
    """
    return await AdminStockService(session).set_available(
        product_id,
        payload.available_quantity,
        actor=actor,
        reason=payload.reason,
        ip_address=ip,
    )


@admin_router.post("/products/import", response_model=ImportReport, summary="Импорт товаров")
async def import_products(
    session: DbSession,
    actor: CurrentUser,
    ip: RequestIP,
    file: Annotated[UploadFile, File(description="Файл .csv или .xlsx")],
    dry_run: Annotated[bool, Form()] = True,
) -> ImportReport:
    """Импорт по разделу 14 ТЗ.

    По умолчанию ``dry_run=True``: файл только проверяется, сотрудник видит
    отчёт и отдельным действием запускает реальную загрузку.
    """
    content = await file.read()
    if len(content) > MAX_IMPORT_BYTES:
        raise BadRequestError(
            f"Файл больше {MAX_IMPORT_BYTES // (1024 * 1024)} МБ",
            code="file_too_large",
            fields={"file": "разделите файл на части"},
        )
    if not content:
        raise BadRequestError("Файл пуст", code="empty_file")

    importer = ProductImporter(session)
    rows = importer.parse_file(file.filename or "import.csv", content)
    categories, brands = await importer.validate(rows)
    return await importer.run(
        rows,
        categories=categories,
        brands=brands,
        dry_run=dry_run,
        actor=actor,
        ip_address=ip,
    )


# ── Пользователи ──


@admin_router.get("/users", response_model=AdminListResponse, summary="Список пользователей")
async def list_users(
    session: DbSession,
    page: Annotated[int, Query(ge=1)] = 1,
    limit: Annotated[int, Query(ge=1, le=100)] = 25,
    search: Annotated[str | None, Query(max_length=100)] = None,
    role: UserRole | None = None,
    is_blocked: bool | None = None,
) -> AdminListResponse:
    items, total = await AdminUsersService(session).list_users(
        page=page, limit=limit, search=search, role=role, is_blocked=is_blocked
    )
    return AdminListResponse(
        items=items, total=total, page=page, limit=limit, pages=_pages(total, limit, page)
    )


@admin_router.patch(
    "/users/{user_id}", response_model=AdminUserListItem, summary="Изменить пользователя"
)
async def update_user(
    user_id: uuid.UUID,
    session: DbSession,
    actor: CurrentUser,
    ip: RequestIP,
    role: UserRole | None = None,
    is_blocked: bool | None = None,
    password: Annotated[str | None, Query(min_length=8, max_length=128)] = None,
) -> AdminUserListItem:
    """Смена роли, блокировка и сброс пароля (раздел 6.4).

    Значение передаётся query-параметрами, а не телом: это не массовая
    операция, а точечное действие сотрудника, и его удобно отправить
    ссылкой из чата поддержки, не собирая JSON.
    """
    return await AdminUsersService(session).update_user(
        user_id,
        actor=actor,
        role=role,
        is_blocked=is_blocked,
        password=password,
        ip_address=ip,
    )


# ── Промокоды ──


@admin_router.get("/promocodes", response_model=AdminListResponse, summary="Список промокодов")
async def list_promocodes(
    session: DbSession,
    page: Annotated[int, Query(ge=1)] = 1,
    limit: Annotated[int, Query(ge=1, le=100)] = 25,
    is_active: bool | None = None,
) -> AdminListResponse:
    rows, total = await AdminPromoService(session).list_promos(
        page=page, limit=limit, is_active=is_active
    )
    items = [
        PromoCodeOut(
            id=row.id,
            code=row.code,
            description=row.description,
            discount_type=row.discount_type.value,
            discount_value=row.discount_value,
            min_order_amount=row.min_order_amount,
            max_discount_amount=row.max_discount_amount,
            usage_limit=row.usage_limit,
            used_count=row.used_count,
            usage_limit_per_user=row.usage_limit_per_user,
            valid_from=row.valid_from,
            valid_to=row.valid_to,
            is_active=row.is_active,
        )
        for row in rows
    ]
    return AdminListResponse(
        items=items, total=total, page=page, limit=limit, pages=_pages(total, limit, page)
    )


@admin_router.post(
    "/promocodes",
    response_model=PromoCodeOut,
    status_code=status.HTTP_201_CREATED,
    summary="Создать промокод",
)
async def create_promocode(
    payload: PromoCodeCreate,
    session: DbSession,
    actor: CurrentUser,
    ip: RequestIP,
) -> PromoCodeOut:
    promo = await AdminPromoService(session).create_promo(payload, actor=actor, ip_address=ip)
    return PromoCodeOut(
        id=promo.id,
        code=promo.code,
        description=promo.description,
        discount_type=promo.discount_type.value,
        discount_value=promo.discount_value,
        min_order_amount=promo.min_order_amount,
        max_discount_amount=promo.max_discount_amount,
        usage_limit=promo.usage_limit,
        used_count=promo.used_count,
        usage_limit_per_user=promo.usage_limit_per_user,
        valid_from=promo.valid_from,
        valid_to=promo.valid_to,
        is_active=promo.is_active,
    )


@admin_router.patch(
    "/promocodes/{promo_id}", response_model=PromoCodeOut, summary="Изменить промокод"
)
async def update_promocode(
    promo_id: uuid.UUID,
    payload: PromoCodeUpdate,
    session: DbSession,
    actor: CurrentUser,
    ip: RequestIP,
) -> PromoCodeOut:
    promo = await AdminPromoService(session).update_promo(
        promo_id, payload, actor=actor, ip_address=ip
    )
    return PromoCodeOut(
        id=promo.id,
        code=promo.code,
        description=promo.description,
        discount_type=promo.discount_type.value,
        discount_value=promo.discount_value,
        min_order_amount=promo.min_order_amount,
        max_discount_amount=promo.max_discount_amount,
        usage_limit=promo.usage_limit,
        used_count=promo.used_count,
        usage_limit_per_user=promo.usage_limit_per_user,
        valid_from=promo.valid_from,
        valid_to=promo.valid_to,
        is_active=promo.is_active,
    )


@admin_router.delete(
    "/promocodes/{promo_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Удалить промокод",
)
async def delete_promocode(
    promo_id: uuid.UUID,
    session: DbSession,
    actor: CurrentUser,
    ip: RequestIP,
) -> None:
    await AdminPromoService(session).delete_promo(promo_id, actor=actor, ip_address=ip)


@staff_router.post(
    "/promocodes/check",
    response_model=PromoCheckResponse,
    summary="Проверить промокод",
)
async def check_promocode(
    payload: PromoCheckRequest,
    session: DbSession,
) -> PromoCheckResponse:
    """Проверка без оформления заказа (раздел 8.10)."""
    valid, message, discount = await AdminPromoService(session).check_promo(
        payload.code, payload.total
    )
    return PromoCheckResponse(
        valid=valid,
        message=message,
        discount_amount=discount,
        promo_code=payload.code.upper() if valid else None,
    )


# ── Статистика и отзывы ──


@staff_router.get("/statistics", response_model=StatisticsResponse, summary="Статистика магазина")
async def statistics(
    session: DbSession,
    period_days: Annotated[int, Query(ge=1, le=365)] = 30,
) -> StatisticsResponse:
    return await StatisticsService(session).collect(period_days)


@admin_router.get("/reviews", response_model=AdminListResponse, summary="Отзывы на модерации")
async def list_reviews(
    session: DbSession,
    page: Annotated[int, Query(ge=1)] = 1,
    limit: Annotated[int, Query(ge=1, le=100)] = 25,
    status_filter: Annotated[ReviewStatus | None, Query(alias="status")] = None,
) -> AdminListResponse:

    conditions = []
    if status_filter is not None:
        conditions.append(Review.status == status_filter)

    total = int(
        (
            await session.execute(select(func.count()).select_from(Review).where(*conditions))
        ).scalar_one()
    )
    rows = (
        (
            await session.execute(
                select(Review)
                .where(*conditions)
                .order_by(Review.created_at.desc())
                .offset((page - 1) * limit)
                .limit(limit)
            )
        )
        .scalars()
        .all()
    )

    items = [ReviewOut.model_validate(row) for row in rows]
    return AdminListResponse(
        items=items, total=total, page=page, limit=limit, pages=_pages(total, limit, page)
    )


@admin_router.patch("/reviews/{review_id}", response_model=ReviewOut, summary="Модерировать отзыв")
async def moderate_review(
    review_id: uuid.UUID,
    payload: ReviewUpdate,
    session: DbSession,
    actor: CurrentUser,
    ip: RequestIP,
) -> ReviewOut:
    from datetime import UTC

    review = await session.get(Review, review_id)
    if review is None:
        raise NotFoundError("Отзыв не найден", code="review_not_found")

    previous = review.status
    review.status = payload.status
    review.moderation_comment = payload.comment
    review.moderated_by_id = actor.id
    review.moderated_at = datetime.now(UTC)
    await session.flush()

    await AuditService(session).record(
        actor,
        action="review.moderated",
        entity_type="review",
        entity_id=review.id,
        details={"from": previous.value, "to": payload.status.value},
        ip_address=ip,
    )
    await session.commit()
    return ReviewOut.model_validate(review)


# ── Справочники ──


@admin_router.get("/categories", response_model=AdminListResponse, summary="Категории")
async def list_categories(
    session: DbSession,
) -> AdminListResponse:

    items = await CatalogService(session).category_tree()
    return AdminListResponse(items=items, total=len(items), limit=100)


@admin_router.post("/categories", response_model=dict, summary="Создать категорию")
async def create_category(
    payload: CategoryCreate,
    session: DbSession,
    actor: CurrentUser,
    ip: RequestIP,
) -> dict:

    slug = payload.slug or slugify(payload.name)
    existing = (
        await session.execute(select(Category).where(Category.slug == slug))
    ).scalar_one_or_none()
    if existing is not None:
        raise ConflictError("Категория с таким адресом уже есть", code="slug_exists")

    level = 1 if payload.parent_id else 0
    if payload.parent_id:
        parent = await session.get(Category, payload.parent_id)
        if parent is None:
            raise BadRequestError("Родительская категория не найдена", code="category_not_found")
        if parent.level >= 1:
            # Раздел 6.2: максимум два уровня, «Комплектующие → SSD».
            raise BadRequestError(
                "Вложенность ограничена двумя уровнями (раздел 6.2 ТЗ)",
                code="nesting_too_deep",
                fields={"parent_id": "выберите категорию первого уровня"},
            )

    category = Category(**payload.model_dump(exclude={"slug"}), slug=slug, level=level)
    session.add(category)
    await session.flush()

    await AuditService(session).record(
        actor,
        action="category.created",
        entity_type="category",
        entity_id=category.id,
        details={"name": category.name, "slug": category.slug},
        ip_address=ip,
    )
    await session.commit()
    return {"id": str(category.id), "name": category.name, "slug": category.slug}


@admin_router.get("/brands", response_model=AdminListResponse, summary="Бренды")
async def list_brands(session: DbSession) -> AdminListResponse:

    rows = (await session.execute(select(Brand).order_by(Brand.name))).scalars().all()
    items = [
        {"id": str(row.id), "name": row.name, "slug": row.slug, "is_active": row.is_active}
        for row in rows
    ]
    return AdminListResponse(items=items, total=len(items), limit=200)


@admin_router.post("/brands", response_model=dict, summary="Создать бренд")
async def create_brand(
    payload: BrandCreate,
    session: DbSession,
    actor: CurrentUser,
    ip: RequestIP,
) -> dict:

    slug = payload.slug or slugify(payload.name)
    existing = (await session.execute(select(Brand).where(Brand.slug == slug))).scalar_one_or_none()
    if existing is not None:
        raise ConflictError("Бренд с таким адресом уже есть", code="slug_exists")

    brand = Brand(**payload.model_dump(exclude={"slug"}), slug=slug)
    session.add(brand)
    await session.flush()

    await AuditService(session).record(
        actor,
        action="brand.created",
        entity_type="brand",
        entity_id=brand.id,
        details={"name": brand.name},
        ip_address=ip,
    )
    await session.commit()
    return {"id": str(brand.id), "name": brand.name, "slug": brand.slug}


@admin_router.get(
    "/audit-log", response_model=AdminListResponse, summary="Журнал действий сотрудников"
)
async def audit_log(
    session: DbSession,
    page: Annotated[int, Query(ge=1)] = 1,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
) -> AdminListResponse:
    """Журнал из раздела 10 ТЗ: кто, что и когда менял."""

    total = int(
        (await session.execute(select(func.count()).select_from(AdminAuditLog))).scalar_one()
    )
    rows = (
        (
            await session.execute(
                select(AdminAuditLog)
                .order_by(AdminAuditLog.created_at.desc())
                .offset((page - 1) * limit)
                .limit(limit)
            )
        )
        .scalars()
        .all()
    )

    items = [
        {
            "id": str(row.id),
            "user_id": str(row.user_id) if row.user_id else None,
            "action": row.action,
            "entity_type": row.entity_type,
            "entity_id": row.entity_id,
            "details": row.details,
            "ip_address": row.ip_address,
            "created_at": row.created_at.isoformat(),
        }
        for row in rows
    ]
    return AdminListResponse(
        items=items, total=total, page=page, limit=limit, pages=_pages(total, limit, page)
    )
