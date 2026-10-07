"""Хранилище изображений товаров (раздел 2.3 ТЗ — S3-совместимое хранилище).

Два драйвера, переключение через ``STORAGE_DRIVER``:

* ``local`` — файлы на диске, раздаются backend-ом с ``/media``. Ноль внешних
  зависимостей, поэтому dev-стек поднимается где угодно.
* ``s3``   — любое S3-совместимое хранилище через boto3 (MinIO, Yandex Object
  Storage, AWS S3). Тот же интерфейс, продакшен ничего не знает о разнице.
"""

from __future__ import annotations

import hashlib
import mimetypes
import os
import shutil
from abc import ABC, abstractmethod
from functools import lru_cache
from pathlib import Path

from app.core.config import settings

MAX_IMAGE_BYTES = 10 * 1024 * 1024
ALLOWED_CONTENT_TYPES = frozenset(
    {"image/jpeg", "image/png", "image/webp", "image/avif", "image/gif"}
)


class StorageError(Exception):
    """Ошибка уровня хранилища. Наверх уходит как 400/500 без внутренних деталей."""


class StorageDriver(ABC):
    """Минимальный контракт: положить, прочитать, удалить, получить URL."""

    @abstractmethod
    def save(self, key: str, data: bytes, content_type: str) -> str:
        """Сохраняет содержимое и возвращает публичный URL."""

    @abstractmethod
    def read(self, key: str) -> bytes: ...

    @abstractmethod
    def delete(self, key: str) -> None: ...

    @abstractmethod
    def url_for(self, key: str) -> str: ...


class LocalStorage(StorageDriver):
    """Файлы в каталоге ``media_root``. Каталог монтируется томом Docker."""

    def __init__(self, root: Path, public_base_url: str) -> None:
        self.root = root
        self.public_base_url = public_base_url.rstrip("/")

    def _path(self, key: str) -> Path:
        # Защита от выхода за пределы каталога через «../» в ключе.
        target = (self.root / key).resolve()
        if not str(target).startswith(str(self.root.resolve())):
            raise StorageError("Некорректный ключ файла")
        return target

    def save(self, key: str, data: bytes, content_type: str) -> str:
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return self.url_for(key)

    def read(self, key: str) -> bytes:
        path = self._path(key)
        if not path.is_file():
            raise StorageError("Файл не найден")
        return path.read_bytes()

    def delete(self, key: str) -> None:
        path = self._path(key)
        if path.is_file():
            path.unlink()

    def url_for(self, key: str) -> str:
        return f"{self.public_base_url}/media/{key}"


class S3Storage(StorageDriver):
    """Любое S3-совместимое хранилище. Бакет создаётся при первом обращении."""

    def __init__(self) -> None:
        import boto3
        from botocore.client import Config

        self.bucket = settings.s3_bucket
        self.public_base_url = settings.s3_public_url.rstrip("/")
        self.client = boto3.client(
            "s3",
            endpoint_url=settings.s3_endpoint or None,
            aws_access_key_id=settings.s3_access_key or None,
            aws_secret_access_key=settings.s3_secret_key or None,
            region_name=settings.s3_region,
            config=Config(signature_version="s3v4"),
        )
        self._ensure_bucket()

    def _ensure_bucket(self) -> None:
        from botocore.exceptions import ClientError

        try:
            self.client.head_bucket(Bucket=self.bucket)
        except ClientError:
            self.client.create_bucket(Bucket=self.bucket)
            try:
                self.client.put_bucket_policy(
                    Bucket=self.bucket,
                    Policy=(
                        '{"Version":"2012-10-17","Statement":[{"Effect":"Allow",'
                        '"Principal":"*","Action":["s3:GetObject"],'
                        f'"Resource":"arn:aws:s3:::{self.bucket}/*"}}]}}'
                    ),
                )
            except ClientError:
                # Политика может быть запрещена политикой бакета — не критично.
                pass

    def save(self, key: str, data: bytes, content_type: str) -> str:
        self.client.put_object(
            Bucket=self.bucket,
            Key=key,
            Body=data,
            ContentType=content_type,
            CacheControl="public, max-age=31536000, immutable",
        )
        return self.url_for(key)

    def read(self, key: str) -> bytes:
        return self.client.get_object(Bucket=self.bucket, Key=key)["Body"].read()

    def delete(self, key: str) -> None:
        self.client.delete_object(Bucket=self.bucket, Key=key)

    def url_for(self, key: str) -> str:
        return f"{self.public_base_url}/{key}"


def build_image_key(product_slug: str, filename: str, data: bytes) -> str:
    """Ключ вида ``products/rtx-4070/8f2c….webp``.

    Хеш от содержимого даёт дедупликацию: один и тот же файл, загруженный
    дважды, не занимает место дважды.
    """
    extension = os.path.splitext(filename)[1].lower() or (
        mimetypes.guess_extension("image/webp") or ".webp"
    )
    digest = hashlib.sha256(data).hexdigest()[:16]
    return f"products/{product_slug}/{digest}{extension}"


def validate_image(data: bytes, content_type: str) -> None:
    """Раздел 10 ТЗ: проверка типа и размера загружаемого файла."""
    if content_type not in ALLOWED_CONTENT_TYPES:
        raise StorageError(
            f"Недопустимый тип файла: {content_type}. "
            f"Разрешены: {', '.join(sorted(ALLOWED_CONTENT_TYPES))}"
        )
    if len(data) > MAX_IMAGE_BYTES:
        raise StorageError(f"Файл больше {MAX_IMAGE_BYTES // (1024 * 1024)} МБ")
    if not data:
        raise StorageError("Пустой файл")


@lru_cache(maxsize=1)
def get_storage() -> StorageDriver:
    """Драйвер хранилища, выбранный настройками. Кэшируется на процесс."""
    if settings.storage_driver == "s3":
        return S3Storage()
    return LocalStorage(
        root=Path(settings.media_root),
        public_base_url=settings.public_base_url or "",
    )


def clear_media_dir() -> None:
    """Очистка каталога dev-хранилища. Используется в тестах и при сбросе."""
    shutil.rmtree(settings.media_root, ignore_errors=True)
