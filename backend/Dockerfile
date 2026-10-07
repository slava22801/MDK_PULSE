# syntax=docker/dockerfile:1

# ── Слой зависимостей: меняется только при правке pyproject/uv.lock ──
FROM python:3.12-slim AS builder

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PATH="/opt/venv/bin:$PATH"

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir uv

WORKDIR /app
COPY pyproject.toml uv.lock ./
# --no-install-project: пакет app не устанавливаем, он монтируется исходником.
RUN uv sync --no-install-project --locked

# ── Рантайм: только venv, без компилятора ──
FROM python:3.12-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/opt/venv/bin:$PATH" \
    # Кэш ruff кладём в /tmp: рабочий каталог /app принадлежит root,
    # и пользователь pulse не может создать в нём служебные каталоги.
    RUFF_CACHE_DIR=/tmp/ruff-cache \
    MPLCONFIGDIR=/tmp/matplotlib

# curl нужен healthcheck-у Docker
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --shell /usr/sbin/nologin pulse

WORKDIR /app

COPY --from=builder --chown=pulse:pulse /opt/venv /opt/venv

COPY --chown=pulse:pulse alembic.ini ./
COPY --chown=pulse:pulse pyproject.toml ./
COPY --chown=pulse:pulse alembic ./alembic
COPY --chown=pulse:pulse app ./app
COPY --chown=pulse:pulse tests ./tests

# Каталог под локальное хранилище изображений. Docker переносит права
# на свежий именованный том, поэтому внутри контейнера он доступен пользователю pulse.
RUN mkdir -p /app/media && chown pulse:pulse /app/media

USER pulse

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://localhost:8000/health || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]