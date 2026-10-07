"""Сервис авторизации: вход, регистрация, сессии, одноразовые токены (раздел 5.7 ТЗ)."""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import ConflictError, ForbiddenError, UnauthorizedError
from app.core.security import (
    create_access_token,
    create_refresh_token,
    decode_token,
    generate_secure_token,
    hash_password,
    hash_token,
    token_expiry,
    verify_password,
)
from app.models.enums import TokenPurpose
from app.models.user import EmailToken, User, UserSession
from app.repositories.user import UserRepository
from app.schemas.auth import TokenPair

logger = logging.getLogger(__name__)

# Хеш для выравнивания времени ответа: без него «нет такого email» отвечает
# мгновенно, а «есть, но неверный пароль» — после bcrypt, что позволяет
# перебором узнать, какие адреса зарегистрированы.
_TIMING_EQUALIZER_HASH = hash_password("pulse-timing-equalizer")

# Больше десяти живых сессий на пользователя — почти наверняка утёкший пароль.
MAX_ACTIVE_SESSIONS = 10


class AuthService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session
        self.users = UserRepository(session)

    async def _commit(self) -> None:
        """Фиксирует изменения.

        Коммит здесь, а не в middleware, намеренно: мутации обязаны быть
        атомарными с точки зрения вызывающего кода. Без явного ``commit``
        сессия откатывалась бы в конце запроса, и пользователь получил бы
        успешный ответ о регистрации, которого не существует в базе.
        """
        await self.session.commit()

    # ── Регистрация ──

    async def register(
        self,
        *,
        email: str,
        first_name: str,
        last_name: str,
        phone: str,
        password: str,
    ) -> tuple[User, TokenPair, str]:
        """Создаёт покупателя, выдаёт пару токенов и возвращает токен
        подтверждения email.

        Токен возвращается наружу, а не логируется внутри: вызывающий код
        решает, что с ним делать — сейчас это отладочный вывод, на этапе 5
        письмо. Иначе сервис молча привязан к способу доставки.

        Проверка «почта занята» до вставки — только удобный путь: уникальный
        индекс всё равно может сработать при гонке двух одновременных
        регистраций, поэтому IntegrityError превращается в тот же 409,
        а не в 500.
        """
        normalized_email = email.lower().strip()
        if await self.users.email_exists(normalized_email):
            raise ConflictError(
                "Пользователь с таким email уже зарегистрирован",
                code="email_already_exists",
            )

        user = User(
            email=normalized_email,
            password_hash=hash_password(password),
            first_name=first_name,
            last_name=last_name,
            phone=phone,
            email_verified=False,
            is_active=True,
        )
        try:
            await self.users.add(user)
            await self.session.flush()
        except IntegrityError as exc:
            await self.session.rollback()
            raise ConflictError(
                "Пользователь с таким email уже зарегистрирован",
                code="email_already_exists",
            ) from exc

        verification_token = await self.issue_email_token(user, TokenPurpose.EMAIL_VERIFICATION)
        tokens = await self.create_session(user)
        await self._commit()
        logger.info("Зарегистрирован пользователь %s (%s)", user.email, user.id)
        return user, tokens, verification_token

    # ── Вход ──

    async def login(
        self,
        *,
        email: str,
        password: str,
        user_agent: str | None = None,
        ip: str | None = None,
    ) -> tuple[User, TokenPair]:
        """Проверяет пароль и открывает сессию.

        Для «нет такого email» и «неверный пароль» — один и тот же ответ:
        разные сообщения превращают форму входа в инструмент проверки,
        какие адреса зарегистрированы (раздел 10 ТЗ).
        """
        normalized_email = email.lower().strip()
        user = await self.users.get_by_email(normalized_email)

        if user is None:
            verify_password(password, _TIMING_EQUALIZER_HASH)
            raise UnauthorizedError("Неверный email или пароль", code="invalid_credentials")

        if not verify_password(password, user.password_hash):
            logger.info("Неудачная попытка входа для %s", normalized_email)
            raise UnauthorizedError("Неверный email или пароль", code="invalid_credentials")

        if not user.is_active or user.blocked_at is not None:
            raise ForbiddenError(
                "Учётная запись заблокирована. Обратитесь в поддержку.",
                code="account_blocked",
            )

        user.last_login_at = datetime.now(UTC)
        await self.users.update(user)
        tokens = await self.create_session(user, user_agent=user_agent, ip=ip)
        await self._commit()
        logger.info("Вход пользователя %s (%s)", user.email, user.id)
        return user, tokens

    # ── Сессии ──

    async def create_session(
        self,
        user: User,
        *,
        user_agent: str | None = None,
        ip: str | None = None,
    ) -> TokenPair:
        """Открывает сессию и возвращает пару токенов.

        Идентификатор сессии генерируется заранее и кладётся в JWT: сервер
        обязан знать, какую запись отозвать при refresh и logout, а искать
        сессию по самому токену значило бы хранить токен в открытом виде.
        """
        session_id = uuid.uuid4()
        refresh_token, expires_at = create_refresh_token(user.id, session_id)

        await self.users.add_session(
            UserSession(
                id=session_id,
                user_id=user.id,
                refresh_token_hash=hash_token(refresh_token),
                user_agent=(user_agent or "")[:512] or None,
                ip_address=ip,
                expires_at=expires_at,
                last_used_at=datetime.now(UTC),
            )
        )
        await self._prune_sessions(user)

        access_token, expires_in = create_access_token(user.id, user.role.value)
        return TokenPair(
            access_token=access_token,
            refresh_token=refresh_token,
            expires_in=expires_in,
        )

    async def refresh(self, refresh_token: str) -> tuple[User, TokenPair]:
        """Обновляет пару токенов с обязательной ротацией refresh-токена.

        Если refresh-токен украли, первое же использование кражи отзывает
        исходную сессию, и второе честное обновление падает с
        ``session_revoked``. Без ротации токен жил бы все 30 дней.
        """
        decode_token(refresh_token, "refresh")
        session_row = await self.users.get_session_by_token_hash(hash_token(refresh_token))

        if session_row is None:
            raise UnauthorizedError("Сессия не найдена", code="invalid_refresh_token")
        if session_row.revoked_at is not None:
            logger.warning(
                "Повторное использование отозванного refresh-токена (user=%s)",
                session_row.user_id,
            )
            raise UnauthorizedError("Сессия завершена", code="session_revoked")

        user = await self.users.get_by_id(session_row.user_id)
        if user is None or not user.is_active:
            raise UnauthorizedError("Пользователь недоступен", code="user_not_found")

        session_row.revoked_at = datetime.now(UTC)
        await self.session.flush()

        tokens = await self.create_session(
            user,
            user_agent=session_row.user_agent,
            ip=session_row.ip_address,
        )
        await self._commit()
        return user, tokens

    async def logout(self, refresh_token: str) -> None:
        """Отзывает сессию.

        Неизвестный или уже отозванный токен — не ошибка: выход должен быть
        идемпотентным, иначе кнопка «выйти» ломается при обрыве сети.
        """
        session_row = await self.users.get_session_by_token_hash(hash_token(refresh_token))
        if session_row is None or session_row.revoked_at is not None:
            return
        session_row.revoked_at = datetime.now(UTC)
        await self._commit()

    async def list_sessions(self, user: User) -> list[UserSession]:
        return await self.users.list_active_sessions(user.id)

    async def revoke_session(self, user: User, session_id: uuid.UUID) -> bool:
        """Отзывает конкретную сессию. Возвращает False, если её уже нет."""
        session_row = await self.session.get(UserSession, session_id)
        if session_row is None or session_row.user_id != user.id:
            return False
        if session_row.revoked_at is None:
            session_row.revoked_at = datetime.now(UTC)
            await self._commit()
        return True

    async def _prune_sessions(self, user: User) -> None:
        """Оставляет не больше ``MAX_ACTIVE_SESSIONS`` живых сессий."""
        rows = await self.users.list_active_sessions(user.id)
        now = datetime.now(UTC)
        for row in rows[MAX_ACTIVE_SESSIONS:]:
            row.revoked_at = now
        if len(rows) > MAX_ACTIVE_SESSIONS:
            await self._commit()

    # ── Одноразовые токены ──

    async def issue_email_token(self, user: User, purpose: TokenPurpose) -> str:
        """Выдаёт одноразовый токен, гася предыдущий для той же цели.

        Токены намеренно не JWT: они случайные, хранятся в БД и должны
        отзываться. JWT без БД отозвать нельзя, а значит скомпрометированное
        подтверждение email останется рабочим до конца срока.
        """
        raw = generate_secure_token()

        previous = await self.session.execute(
            select(EmailToken).where(
                EmailToken.user_id == user.id,
                EmailToken.purpose == purpose,
            )
        )
        now = datetime.now(UTC)
        for row in previous.scalars().all():
            row.used_at = now

        self.session.add(
            EmailToken(
                user_id=user.id,
                purpose=purpose,
                token_hash=hash_token(raw),
                expires_at=token_expiry(purpose.value),
            )
        )
        await self._commit()
        return raw

    async def consume_email_token(self, token: str, expected: TokenPurpose) -> EmailToken:
        """Находит токен, проверяет назначение и срок, помечает использованным."""
        result = await self.session.execute(
            select(EmailToken).where(EmailToken.token_hash == hash_token(token))
        )
        row = result.scalar_one_or_none()

        if row is None:
            raise UnauthorizedError("Токен не найден", code="invalid_token")
        if row.purpose != expected:
            raise UnauthorizedError(
                "Токен предназначен для другой операции",
                code="invalid_token_purpose",
            )
        if not row.is_usable:
            raise UnauthorizedError(
                "Срок действия токена истёк или он уже использован",
                code="token_expired",
            )

        row.used_at = datetime.now(UTC)
        await self.session.flush()
        return row

    async def verify_email(self, token: str) -> User:
        row = await self.consume_email_token(token, TokenPurpose.EMAIL_VERIFICATION)
        user = row.user
        user.email_verified = True
        await self.users.update(user)
        await self._commit()
        logger.info("Email подтверждён для %s", user.email)
        return user

    async def reset_password(self, token: str, new_password: str) -> User:
        row = await self.consume_email_token(token, TokenPurpose.PASSWORD_RESET)
        user = row.user
        user.password_hash = hash_password(new_password)
        await self.users.update(user)
        # Пароль мог быть скомпрометирован — все прежние устройства теряют доступ.
        revoked = await self.users.revoke_all_sessions(user.id)
        await self._commit()
        logger.info("Пароль сброшен для %s, отозвано сессий: %s", user.email, revoked)
        return user

    async def change_password(self, user: User, current_password: str, new_password: str) -> int:
        if not verify_password(current_password, user.password_hash):
            raise UnauthorizedError("Текущий пароль указан неверно", code="wrong_password")
        user.password_hash = hash_password(new_password)
        await self.users.update(user)
        revoked = await self.users.revoke_all_sessions(user.id)
        await self._commit()
        return revoked


async def delete_account(session: AsyncSession, user: User, password: str) -> None:
    """Удаление аккаунта (раздел 5.7 ТЗ).

    Пароль спрашивается намеренно: один случайный клик в кабинете не должен
    стирать историю покупок. Сотрудников удалить самостоятельно нельзя —
    иначе можно убрать единственного администратора.
    """
    if not verify_password(password, user.password_hash):
        raise UnauthorizedError("Пароль указан неверно", code="wrong_password")
    if user.role.is_staff:
        raise ForbiddenError(
            "Учётную запись сотрудника нельзя удалить самостоятельно",
            code="staff_account_protected",
        )
    await session.delete(user)
    await session.commit()
    logger.info("Аккаунт удалён: %s", user.id)


async def create_admin_account(
    session: AsyncSession,
    *,
    email: str,
    password: str,
    first_name: str,
    last_name: str,
) -> User:
    """Создание администратора из CLI — единственный путь выдать первую роль."""
    users = UserRepository(session)
    if await users.email_exists(email):
        raise ConflictError("Пользователь с таким email уже существует")

    user = User(
        email=email.lower().strip(),
        password_hash=hash_password(password),
        first_name=first_name,
        last_name=last_name,
        role="admin",
        email_verified=True,
        is_active=True,
    )
    await users.add(user)
    await session.commit()
    logger.info("Создан администратор %s (%s)", user.email, user.id)
    return user
