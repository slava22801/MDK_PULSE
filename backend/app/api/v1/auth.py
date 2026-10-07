"""Роутеры авторизации (раздел 8.1 ТЗ).

Маршруты: register, login, refresh, logout, forgot-password,
reset-password, me.
"""

from __future__ import annotations

import logging
import uuid

from fastapi import APIRouter, Request, status

from app.core.config import settings
from app.core.deps import CartSession, CurrentUser, DbSession, RequestIP
from app.core.errors import ValidationFailedError
from app.core.rate_limit import auth_rate_key, check_rate_limit
from app.models.enums import TokenPurpose
from app.schemas.auth import (
    AuthResponse,
    ChangePasswordRequest,
    ChangePasswordResponse,
    DeleteAccountRequest,
    ForgotPasswordRequest,
    LoginRequest,
    LogoutRequest,
    MessageResponse,
    RefreshRequest,
    RefreshResponse,
    RegisterRequest,
    ResetPasswordRequest,
    SessionOut,
    UserOut,
    VerifyEmailRequest,
)
from app.schemas.cart import CartMergeResponse
from app.services.auth import AuthService, delete_account
from app.services.cart import CartService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["Авторизация"])


def _user_agent(request: Request) -> str | None:
    return request.headers.get("User-Agent")


def _log_dev_token(kind: str, email: str, raw_token: str) -> None:
    """Показывает одноразовый токен только в dev-режиме.

    Отправка писем в MVP не подключена (раздел 16 ТЗ), иначе подтверждение
    email и сброс пароля были бы непроходимы. Значение пишется на уровне
    DEBUG, который в production отключён, — иначе компрометацию аккаунта
    можно было бы провести одним чтением логов.
    """
    logger.info("%s для %s: письмо отправляется только в dev-режиме", kind, email)
    if settings.debug:
        logger.debug("dev: %s для %s = %s", kind, email, raw_token)


@router.post(
    "/register",
    response_model=AuthResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Регистрация покупателя",
)
async def register(
    payload: RegisterRequest,
    session: DbSession,
    ip: RequestIP,
) -> AuthResponse:
    await check_rate_limit(
        auth_rate_key(ip, "register"),
        limit=5,
        window_seconds=3600,
    )

    problems = payload.password_problems()
    if not payload.accept_policy:
        problems["accept_policy"] = "Нужно принять политику обработки данных"
    if problems:
        raise ValidationFailedError(
            "Проверьте правильность заполнения полей",
            fields=problems,
        )

    service = AuthService(session)
    user, tokens, verification_token = await service.register(
        email=payload.email,
        first_name=payload.first_name,
        last_name=payload.last_name,
        phone=payload.phone,
        password=payload.password,
    )
    _log_dev_token("Токен подтверждения email", user.email, verification_token)
    return AuthResponse(user=UserOut.model_validate(user), tokens=tokens)


@router.post("/login", response_model=AuthResponse, summary="Вход по email и паролю")
async def login(
    payload: LoginRequest,
    request: Request,
    session: DbSession,
    ip: RequestIP,
    cart_session: CartSession,
) -> AuthResponse:
    await check_rate_limit(
        auth_rate_key(ip, payload.email),
        limit=settings.rate_limit_auth_attempts,
        window_seconds=settings.rate_limit_window_seconds,
    )

    service = AuthService(session)
    user, tokens = await service.login(
        email=payload.email,
        password=payload.password,
        user_agent=_user_agent(request),
        ip=ip,
    )

    # Раздел 5.8 ТЗ: гостевая корзина объединяется с серверной аккаунта.
    # Ошибка слияния не должна ломать вход: человек уже аутентифицирован,
    # потеря пары позиций переносится на запись гостевой корзины, которую он
    # всё ещё видит и может добавить заново.
    merged = None
    if cart_session:
        try:
            merged = await CartService(session).merge_guest_cart(user, cart_session)
        except Exception as exc:  # noqa: BLE001 — вход важнее слияния
            logger.warning("Не удалось слить гостевую корзину для %s: %s", user.email, exc)
            await session.rollback()

    return AuthResponse(
        user=UserOut.model_validate(user),
        tokens=tokens,
        merged_cart=(
            CartMergeResponse(
                items=merged.items,
                totals=merged.totals,
                merged_positions=merged.merged_positions,
                removed_for_stock=merged.removed_for_stock,
            )
            if merged
            else None
        ),
    )


@router.post("/refresh", response_model=RefreshResponse, summary="Обновить пару токенов")
async def refresh(payload: RefreshRequest, session: DbSession) -> RefreshResponse:
    user, tokens = await AuthService(session).refresh(payload.refresh_token)
    return RefreshResponse(tokens=tokens)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT, summary="Выход из аккаунта")
async def logout(payload: LogoutRequest, session: DbSession) -> None:
    await AuthService(session).logout(payload.refresh_token)


@router.get("/me", response_model=UserOut, summary="Текущий пользователь")
async def me(user: CurrentUser) -> UserOut:
    return UserOut.model_validate(user)


@router.post("/change-password", response_model=ChangePasswordResponse, summary="Смена пароля")
async def change_password(
    payload: ChangePasswordRequest,
    user: CurrentUser,
    session: DbSession,
) -> ChangePasswordResponse:
    problems = payload.password_problems()
    if problems:
        raise ValidationFailedError("Проверьте правильность заполнения полей", fields=problems)

    revoked = await AuthService(session).change_password(
        user,
        current_password=payload.current_password,
        new_password=payload.password,
    )
    return ChangePasswordResponse(
        message="Пароль изменён. Войдите заново на других устройствах.",
        revoked_sessions=revoked,
    )


@router.post(
    "/forgot-password",
    response_model=MessageResponse,
    summary="Запрос на восстановление пароля",
)
async def forgot_password(payload: ForgotPasswordRequest, session: DbSession) -> MessageResponse:
    """Всегда отвечает одинаково — иначе форму можно использовать для
    выяснения, какие email зарегистрированы (раздел 10 ТЗ)."""
    service = AuthService(session)
    user = await service.users.get_by_email(payload.email)

    if user is not None and user.is_active:
        raw_token = await service.issue_email_token(user, TokenPurpose.PASSWORD_RESET)
        logger.info("Запрошено восстановление пароля для %s", user.email)
        _log_dev_token("Токен сброса пароля", user.email, raw_token)

    return MessageResponse(
        message=(
            "Если такой email зарегистрирован, на него отправлена ссылка для восстановления пароля."
        )
    )


@router.post(
    "/reset-password",
    response_model=MessageResponse,
    summary="Установка нового пароля по токену",
)
async def reset_password(payload: ResetPasswordRequest, session: DbSession) -> MessageResponse:
    problems = payload.password_problems()
    if problems:
        raise ValidationFailedError("Проверьте правильность заполнения полей", fields=problems)

    await AuthService(session).reset_password(payload.token, payload.password)
    return MessageResponse(message="Пароль обновлён. Теперь войдите с новым паролем.")


@router.post(
    "/verify-email",
    response_model=MessageResponse,
    summary="Подтверждение email",
)
async def verify_email(payload: VerifyEmailRequest, session: DbSession) -> MessageResponse:
    await AuthService(session).verify_email(payload.token)
    return MessageResponse(message="Email подтверждён.")


@router.get("/sessions", response_model=list[SessionOut], summary="Активные сессии")
async def list_sessions(user: CurrentUser, session: DbSession) -> list[SessionOut]:
    rows = await AuthService(session).list_sessions(user)
    return [
        SessionOut(
            id=row.id,
            user_agent=row.user_agent,
            ip_address=row.ip_address,
            created_at=row.created_at,
            last_used_at=row.last_used_at,
            expires_at=row.expires_at,
            is_current=False,
        )
        for row in rows
    ]


@router.delete(
    "/sessions/{session_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Завершить сессию",
)
async def revoke_session(
    session_id: uuid.UUID,
    user: CurrentUser,
    session: DbSession,
) -> None:
    await AuthService(session).revoke_session(user, session_id)


@router.delete(
    "/account",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Удаление аккаунта",
)
async def delete_my_account(
    payload: DeleteAccountRequest,
    user: CurrentUser,
    session: DbSession,
) -> None:
    await delete_account(session, user, payload.password)
