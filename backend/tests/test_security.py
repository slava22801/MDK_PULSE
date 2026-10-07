"""Хеширование паролей и JWT — фундамент безопасности (разделы 5.7 и 10 ТЗ)."""

from __future__ import annotations

import uuid

import pytest

from app.core.errors import UnauthorizedError
from app.core.security import (
    create_access_token,
    create_refresh_token,
    decode_token,
    hash_password,
    hash_token,
    validate_password,
    verify_password,
)


class TestPasswordHashing:
    def test_verified_password_matches(self) -> None:
        password_hash = hash_password("parol123")
        assert verify_password("parol123", password_hash)

    def test_wrong_password_does_not_match(self) -> None:
        password_hash = hash_password("parol123")
        assert not verify_password("parol124", password_hash)

    def test_hashes_are_salted(self) -> None:
        """Два одинаковых пароля должны давать разные хеши — иначе радужная
        таблица раскрывает пароли всех пользователей сразу."""
        assert hash_password("parol123") != hash_password("parol123")

    def test_hash_is_not_the_password(self) -> None:
        assert "parol123" not in hash_password("parol123")

    def test_long_password_is_not_truncated(self) -> None:
        """bcrypt обрезает вход длиннее 72 байт. Без предварительного sha256
        два разных длинных пароля дали бы один хеш."""
        base = "a" * 80
        password_hash = hash_password(base + "X")
        assert not verify_password(base + "Y", password_hash)
        assert verify_password(base + "X", password_hash)

    def test_cyrillic_password_works(self) -> None:
        assert verify_password("пароль123", hash_password("пароль123"))

    def test_broken_hash_returns_false_instead_of_raising(self) -> None:
        assert verify_password("parol123", "не-хеш") is False


class TestPasswordPolicy:
    """Требования раздела 5.7 ТЗ: минимум 8 символов, буква и цифра."""

    def test_valid_password_has_no_problems(self) -> None:
        assert validate_password("parol123") == []

    @pytest.mark.parametrize(
        ("password", "expected_code"),
        [
            ("abc12", "password_too_short"),
            ("12345678", "password_no_letter"),
            ("abcdefgh", "password_no_digit"),
        ],
    )
    def test_policy_violations_are_reported(self, password: str, expected_code: str) -> None:
        codes = {problem.code for problem in validate_password(password)}
        assert expected_code in codes

    def test_mismatch_is_reported_separately(self) -> None:
        codes = {p.code for p in validate_password("parol123", "parol124")}
        assert "password_mismatch" in codes

    def test_all_problems_returned_together(self) -> None:
        codes = {p.code for p in validate_password("ab")}
        assert {"password_too_short", "password_no_digit"} <= codes

    def test_eight_chars_with_letter_and_digit_is_valid(self) -> None:
        assert validate_password("abcdefg1") == []


class TestAccessToken:
    def test_roundtrip_preserves_subject_and_role(self) -> None:
        user_id = uuid.uuid4()
        token, _ = create_access_token(user_id, "admin")
        payload = decode_token(token, "access")
        assert uuid.UUID(payload["sub"]) == user_id
        assert payload["role"] == "admin"

    def test_refresh_token_is_accepted_as_access(self) -> None:
        """Подмена типа токена — самая частая ошибка в JWT-реализациях."""
        token, _ = create_refresh_token(uuid.uuid4(), uuid.uuid4())
        with pytest.raises(UnauthorizedError) as exc:
            decode_token(token, "access")
        assert exc.value.code == "invalid_token_type"

    def test_garbage_token_is_rejected(self) -> None:
        with pytest.raises(UnauthorizedError) as exc:
            decode_token("не.jwt.значение", "access")
        assert exc.value.code == "invalid_token"

    def test_token_signed_with_other_key_is_rejected(self) -> None:
        import jwt

        forged = jwt.encode(
            {"sub": str(uuid.uuid4()), "type": "access", "iat": 0, "exp": 9999999999},
            "чужой-секрет",
            algorithm="HS256",
        )
        with pytest.raises(UnauthorizedError):
            decode_token(forged, "access")

    def test_expired_token_is_rejected(self) -> None:
        import jwt

        from app.core.config import settings

        expired = jwt.encode(
            {
                "sub": str(uuid.uuid4()),
                "type": "access",
                "iat": 1,
                "exp": 2,
            },
            settings.jwt_secret_key,
            algorithm=settings.jwt_algorithm,
        )
        with pytest.raises(UnauthorizedError) as exc:
            decode_token(expired, "access")
        assert exc.value.code == "token_expired"

    def test_token_without_subject_is_rejected(self) -> None:
        import jwt

        from app.core.config import settings

        no_sub = jwt.encode(
            {"type": "access", "iat": 0, "exp": 9999999999},
            settings.jwt_secret_key,
            algorithm=settings.jwt_algorithm,
        )
        with pytest.raises(UnauthorizedError):
            decode_token(no_sub, "access")

    def test_expires_in_is_positive_and_reasonable(self) -> None:
        _, expires_in = create_access_token(uuid.uuid4(), "customer")
        assert 0 < expires_in <= 60 * 60


class TestTokenHashing:
    def test_hash_is_deterministic(self) -> None:
        assert hash_token("abc") == hash_token("abc")

    def test_hash_differs_from_token(self) -> None:
        assert hash_token("secret-token") != "secret-token"

    def test_different_tokens_have_different_hashes(self) -> None:
        assert hash_token("a") != hash_token("b")
