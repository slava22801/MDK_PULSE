"""Платёжные провайдеры (раздел 5.9 ТЗ).

Контракт один на всех: магазин не знает, кто именно принимает деньги.
Реальный провайдер добавляется реализацией :class:`PaymentProvider` —
сервисы заказов при этом не меняются.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import secrets
import uuid
from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal

from app.core.config import settings

logger = logging.getLogger(__name__)

# Разделитель полей токена — «~», а не «.»: сумма вида «36560.00» содержит
# точку, и при разборе по точкам дробная часть уезжала в отдельный элемент —
# подпись не сходилась, и подтверждение оплаты отклонялось.
_TOKEN_SEPARATOR = "~"


@dataclass
class PaymentIntent:
    """Запрос на оплату, возвращённый провайдером."""

    provider: str
    external_id: str
    amount: Decimal
    status: str
    # URL, на который покупатель уходит платить. Для фейкового
    # провайдера — страница подтверждения внутри магазина.
    redirect_url: str | None = None
    confirmation_token: str | None = None


@dataclass
class WebhookEvent:
    """Событие от платёжной системы."""

    provider: str
    external_id: str
    status: str
    amount: Decimal | None = None
    signature_valid: bool = True
    payload: dict | None = None


class PaymentProvider(ABC):
    """Контракт платёжного провайдера."""

    name: str = "base"

    @abstractmethod
    async def create_payment(
        self,
        *,
        order_id: uuid.UUID,
        order_number: str,
        amount: Decimal,
        email: str,
        description: str,
    ) -> PaymentIntent: ...

    @abstractmethod
    async def verify_webhook(self, raw_body: bytes, signature: str) -> WebhookEvent: ...

    @abstractmethod
    def is_ready_to_capture(self, status: str) -> bool:
        """Считается ли платёж успешно оплаченным."""


class FakePaymentProvider(PaymentProvider):
    """Провайдер для MVP и тестов (раздел 16 ТЗ).

    Работает как настоящий с точки зрения протокола: выдаёт идентификатор
    платежа, требует подписи на вебхуке и переводит заказ в оплаченный
    только после явного подтверждения. Разница одна — деньги не уходят,
    и страница подтверждения находится внутри магазина.
    """

    name = "fake"

    def __init__(self) -> None:
        self._secret = settings.payment_webhook_secret.encode()

    async def create_payment(
        self,
        *,
        order_id: uuid.UUID,
        order_number: str,
        amount: Decimal,
        email: str,
        description: str,
    ) -> PaymentIntent:
        external_id = f"fake_{uuid.uuid4().hex[:20]}"
        token = self._make_token(external_id, amount)
        logger.info(
            "Создан платёж %s на %s ₽ (заказ %s) — фейковый провайдер",
            external_id,
            amount,
            order_number,
        )
        return PaymentIntent(
            provider=self.name,
            external_id=external_id,
            amount=amount,
            status="pending",
            # Страница подтверждения: покупатель нажимает «Оплатить» и
            # backend отправляет вебхук самому себе — полный цикл.
            redirect_url=f"/payment/{order_id}?token={token}",
            confirmation_token=token,
        )

    async def verify_webhook(self, raw_body: bytes, signature: str) -> WebhookEvent:
        """Проверяет подпись, как это делает настоящая платёжная система."""
        expected = hmac.new(self._secret, raw_body, hashlib.sha256).hexdigest()
        valid = hmac.compare_digest(expected, signature or "")

        import json

        try:
            payload = json.loads(raw_body or b"{}")
        except ValueError:
            payload = {}

        if not valid:
            # Подпись не совпала — событие обрабатывать нельзя. Именно
            # это защищает от поддельных вебхуков (раздел 10 ТЗ).
            logger.warning("Вебхук с неверной подписью отклонён")
            return WebhookEvent(
                provider=self.name,
                external_id="",
                status="rejected",
                signature_valid=False,
                payload=payload,
            )

        amount = payload.get("amount")
        return WebhookEvent(
            provider=self.name,
            external_id=str(payload.get("external_id", "")),
            status=str(payload.get("status", "pending")),
            amount=Decimal(str(amount)) if amount is not None else None,
            payload=payload,
        )

    def is_ready_to_capture(self, status: str) -> bool:
        return status in {"succeeded", "paid", "captured"}

    def _make_token(self, external_id: str, amount: Decimal) -> str:
        """Подписанный токен подтверждения — подделать без секрета нельзя."""
        expires = int(datetime.now(UTC).timestamp()) + 1800
        payload = _TOKEN_SEPARATOR.join([external_id, str(amount), str(expires)])
        signature = hmac.new(self._secret, payload.encode(), hashlib.sha256).hexdigest()[:32]
        return f"{payload}{_TOKEN_SEPARATOR}{signature}"

    def verify_token(self, token: str, external_id: str, amount: Decimal) -> bool:
        """Проверяет токен страницы оплаты."""
        parts = token.split(_TOKEN_SEPARATOR)
        if len(parts) != 4:
            return False
        token_external, token_amount, token_expires, signature = parts
        if token_external != external_id or Decimal(token_amount) != amount:
            return False
        if int(token_expires) < datetime.now(UTC).timestamp():
            return False
        payload = _TOKEN_SEPARATOR.join([token_external, token_amount, token_expires])
        expected = hmac.new(self._secret, payload.encode(), hashlib.sha256).hexdigest()[:32]
        return hmac.compare_digest(expected, signature)

    def sign_webhook(self, raw_body: bytes) -> str:
        """Подпись для тестового вызова вебхука."""
        return hmac.new(self._secret, raw_body, hashlib.sha256).hexdigest()

    @staticmethod
    def new_idempotency_key() -> str:
        return secrets.token_urlsafe(16)


_REGISTRY: dict[str, type[PaymentProvider]] = {
    FakePaymentProvider.name: FakePaymentProvider,
}


def get_provider(name: str | None = None) -> PaymentProvider:
    """Возвращает провайдера по настройке ``PAYMENT_PROVIDER``."""
    key = (name or settings.payment_provider or "fake").lower()
    provider_class = _REGISTRY.get(key)
    if provider_class is None:
        # Неизвестное имя провайдера не должно ронять магазин: в dev это
        # почти всегда опечатка в настройках, а не отказ клиенту.
        logger.warning("Неизвестный платёжный провайдер «%s», используется fake", key)
        provider_class = FakePaymentProvider
    return provider_class()
