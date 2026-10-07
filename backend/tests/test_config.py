"""Настройки и безопасность логов: разделы 10 и 13 ТЗ."""

from __future__ import annotations

import logging

import pytest
from pydantic import ValidationError

from app.core.config import Settings
from app.core.logging import REDACTED, SecretRedactingFilter, redact


class TestSettings:
    def test_cors_origins_are_parsed_into_list(self) -> None:
        settings = Settings(cors_origins="http://a.test, http://b.test ,http://c.test")
        assert settings.cors_origin_list == ["http://a.test", "http://b.test", "http://c.test"]

    def test_sync_database_url_is_converted_to_asyncpg(self) -> None:
        """Alembic и приложение должны говорить с БД одним драйвером."""
        settings = Settings(database_url="postgresql://user:pass@db:5432/shop")
        assert settings.async_database_url == "postgresql+asyncpg://user:pass@db:5432/shop"

    def test_production_rejects_default_secrets(self) -> None:
        """Раздел 10: дефолтный SECRET_KEY в production — уязвимость, а не мелочь."""
        with pytest.raises(ValidationError, match="Недопустимые секреты"):
            Settings(
                app_env="production",
                secret_key="change_me",
                jwt_secret_key="change_me",
                payment_webhook_secret="change_me",
            )

    def test_production_rejects_short_secrets(self) -> None:
        with pytest.raises(ValidationError, match="Недопустимые секреты"):
            Settings(
                app_env="production",
                secret_key="short",
                jwt_secret_key="short",
                payment_webhook_secret="short",
            )

    def test_production_accepts_real_secrets(self) -> None:
        long_secret = "a" * 32
        settings = Settings(
            app_env="production",
            debug=False,
            secret_key=long_secret,
            jwt_secret_key=long_secret,
            payment_webhook_secret=long_secret,
        )
        assert settings.is_production is True

    def test_development_allows_default_secrets(self) -> None:
        settings = Settings(app_env="development")
        assert settings.is_production is False

    def test_max_compare_items_matches_tz_limit(self) -> None:
        """Раздел 5.5 ТЗ: не более 4 товаров в сравнении."""
        assert Settings().max_compare_items == 4


class TestSecretRedaction:
    def test_password_is_redacted(self) -> None:
        assert redact({"password": "hunter2"})["password"] == REDACTED

    def test_nested_tokens_are_redacted(self) -> None:
        payload = {"data": {"refresh_token": "abc.def.ghi"}}
        assert redact(payload)["data"]["refresh_token"] == REDACTED

    def test_token_inside_list_is_redacted(self) -> None:
        assert redact([{"access_token": "secret"}])[0]["access_token"] == REDACTED

    def test_bearer_header_is_masked(self) -> None:
        assert redact("Bearer eyJhbGciOi.JIUzI1NiJ9") == f"Bearer {REDACTED}"

    def test_business_fields_survive_redaction(self) -> None:
        payload = {"product_id": 42, "price": "5900.00", "quantity": 3}
        assert redact(payload) == payload

    def test_filter_cleans_dict_message(self) -> None:
        record = logging.LogRecord(
            name="test",
            level=logging.INFO,
            pathname=__file__,
            lineno=1,
            msg={"password": "hunter2", "email": "a@b.c"},
            args=(),
            exc_info=None,
        )
        SecretRedactingFilter().filter(record)
        assert record.msg["password"] == REDACTED
        assert record.msg["email"] == "a@b.c"

    def test_filter_cleans_dict_args(self) -> None:
        # logging нормализует единственный dict-аргумент: args становится самим dict.
        record = logging.LogRecord(
            name="test",
            level=logging.INFO,
            pathname=__file__,
            lineno=1,
            msg="login attempt",
            args=({"password": "hunter2", "ip": "10.0.0.1"},),
            exc_info=None,
        )
        SecretRedactingFilter().filter(record)
        assert record.args["password"] == REDACTED
        assert record.args["ip"] == "10.0.0.1"

    def test_filter_cleans_tuple_args(self) -> None:
        record = logging.LogRecord(
            name="test",
            level=logging.INFO,
            pathname=__file__,
            lineno=1,
            msg="order %s created for %s",
            args=("PL-2026-0001", {"access_token": "abc"}),
            exc_info=None,
        )
        SecretRedactingFilter().filter(record)
        assert record.args[0] == "PL-2026-0001"
        assert record.args[1]["access_token"] == REDACTED
