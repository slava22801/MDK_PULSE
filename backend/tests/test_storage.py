"""Драйверы хранилища изображений (разделы 2.3 и 10 ТЗ)."""

from __future__ import annotations

from pathlib import Path

import pytest

from app.storage import (
    MAX_IMAGE_BYTES,
    LocalStorage,
    StorageError,
    build_image_key,
    validate_image,
)

PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"0" * 64


@pytest.fixture
def storage(tmp_path: Path) -> LocalStorage:
    return LocalStorage(root=tmp_path, public_base_url="http://localhost:8080")


class TestLocalStorage:
    def test_save_returns_public_url(self, storage: LocalStorage, tmp_path: Path) -> None:
        url = storage.save("products/rtx-4070/aabbcc.webp", PNG_BYTES, "image/webp")
        assert url == "http://localhost:8080/media/products/rtx-4070/aabbcc.webp"
        assert (tmp_path / "products" / "rtx-4070" / "aabbcc.webp").read_bytes() == PNG_BYTES

    def test_read_returns_saved_bytes(self, storage: LocalStorage) -> None:
        storage.save("products/x/1.webp", PNG_BYTES, "image/webp")
        assert storage.read("products/x/1.webp") == PNG_BYTES

    def test_read_missing_file_raises(self, storage: LocalStorage) -> None:
        with pytest.raises(StorageError, match="не найден"):
            storage.read("products/nope.webp")

    def test_delete_removes_file(self, storage: LocalStorage, tmp_path: Path) -> None:
        storage.save("products/x/2.webp", PNG_BYTES, "image/webp")
        storage.delete("products/x/2.webp")
        assert not (tmp_path / "products" / "x" / "2.webp").exists()

    def test_delete_missing_file_is_noop(self, storage: LocalStorage) -> None:
        storage.delete("products/never-existed.webp")

    def test_path_traversal_is_blocked(self, storage: LocalStorage) -> None:
        """Ключ из пользовательского ввода не должен уводить запись за пределы каталога."""
        with pytest.raises(StorageError, match="Некорректный ключ"):
            storage.save("../../../etc/passwd", b"x", "image/png")

    def test_traversal_is_blocked_on_read(self, storage: LocalStorage) -> None:
        with pytest.raises(StorageError):
            storage.read("../../secrets.env")

    def test_url_for_is_stable(self, storage: LocalStorage) -> None:
        assert storage.url_for("products/a/1.png") == (
            "http://localhost:8080/media/products/a/1.png"
        )


class TestImageKey:
    def test_key_contains_slug_and_hash(self) -> None:
        key = build_image_key("rtx-4070-super", "photo.jpg", b"payload")
        assert key.startswith("products/rtx-4070-super/")
        assert key.endswith(".jpg")

    def test_same_content_yields_same_key(self) -> None:
        """Дедупликация: одинаковый файл не должен занимать место дважды."""
        first = build_image_key("ssd", "a.webp", b"same-bytes")
        second = build_image_key("ssd", "renamed.webp", b"same-bytes")
        assert first == second

    def test_different_content_yields_different_key(self) -> None:
        assert build_image_key("ssd", "a.webp", b"one") != build_image_key("ssd", "a.webp", b"two")

    def test_missing_extension_is_filled(self) -> None:
        assert build_image_key("ssd", "noext", b"x").endswith(".webp")


class TestValidation:
    def test_valid_png_passes(self) -> None:
        validate_image(PNG_BYTES, "image/png")

    def test_executable_content_type_is_rejected(self) -> None:
        """Раздел 10: исполняемый файл не должен попасть в хранилище."""
        with pytest.raises(StorageError, match="Недопустимый тип"):
            validate_image(b"MZ\x90\x00", "application/x-msdownload")

    def test_svg_is_rejected(self) -> None:
        # SVG может содержать <script> — XSS-риск (раздел 10).
        with pytest.raises(StorageError, match="Недопустимый тип"):
            validate_image(b"<svg onload=alert(1)>", "image/svg+xml")

    def test_oversized_file_is_rejected(self) -> None:
        with pytest.raises(StorageError, match="больше"):
            validate_image(b"0" * (MAX_IMAGE_BYTES + 1), "image/png")

    def test_empty_file_is_rejected(self) -> None:
        with pytest.raises(StorageError, match="Пустой файл"):
            validate_image(b"", "image/png")
