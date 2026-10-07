# ПУЛЬС — монорепозиторий интернет-магазина компьютерных комплектующих
# Основной интерфейс для Linux/macOS/CI. На Windows используйте
# либо Git Bash, либо прямые команды из README.md.

.DEFAULT_GOAL := help
SHELL := /bin/bash

COMPOSE := docker compose
BACKEND  := $(COMPOSE) exec -T backend
UVICORN  := $(BACKEND) uv run uvicorn app.main:app --reload

.PHONY: help up down restart logs ps build rebuild \
        migrate revision seed shell psql test test-api lint fmt typecheck check \
        backup restore clean

help: ## Показать список доступных команд
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

# ── Docker ───────────────────────────────────────────────────

up: ## Поднять всё окружение (db, redis, backend, frontend, nginx)
	@test -f .env || (cp .env.example .env && echo "Создан .env из .env.example — проверьте SECRET_KEY")
	$(COMPOSE) up -d --build
	@echo "Магазин:  http://localhost:$${HOST_WEB_PORT:-8090}"
	@echo "Swagger:  http://localhost:$${HOST_WEB_PORT:-8090}/docs"

down: ## Остановить окружение (данные сохраняются)
	$(COMPOSE) down

restart: ## Перезапустить сервисы
	$(COMPOSE) restart

build: ## Собрать образы
	$(COMPOSE) build

rebuild: ## Пересобрать образы без кэша
	$(COMPOSE) build --no-cache

ps: ## Статус сервисов
	$(COMPOSE) ps

logs: ## Логи всех сервисов
	$(COMPOSE) logs -f --tail=200

shell: ## Shell внутри контейнера backend
	$(COMPOSE) exec backend /bin/bash

psql: ## psql к базе проекта
	$(COMPOSE) exec db psql -U $${POSTGRES_USER:-pulse} -d $${POSTGRES_DB:-pulse_shop}

# ── Backend: миграции и данные ───────────────────────────────

migrate: ## Применить миграции Alembic
	$(BACKEND) uv run alembic upgrade head

revision: ## Создать авто-генерацию миграции (make revision m="описание")
	$(BACKEND) uv run alembic revision --autogenerate -m "$(m)"

seed: ## Загрузить категории и бренды (этап 2)
	$(BACKEND) uv run python -m app.cli seed

seed-catalog: ## Наполнить каталог товарами и характеристиками (этап 3)
	$(BACKEND) uv run python -m app.cli seed-catalog

release-reservations: ## Снять брони неоплаченных заказов (планировщик, раз в час)
	$(BACKEND) uv run python -m app.cli release-reservations

seed-full: ## Полное наполнение демо-данными с нуля
	$(BACKEND) uv run python -m app.cli seed-catalog --force

# ── Backend: качество ────────────────────────────────────────

test-db: ## Создать базу для тестов (нужна один раз)
	$(COMPOSE) exec -T db psql -U $${POSTGRES_USER:-pulse} -d postgres \
		-c "CREATE DATABASE pulse_test" 2>/dev/null || echo "База pulse_test уже существует"

test: ## Прогнать backend-тесты
	$(BACKEND) uv run pytest -q

test-api: ## Тесты, требующие поднятой БД
	$(BACKEND) uv run pytest -q -m integration

lint: ## Статические проверки backend
	$(BACKEND) uv run ruff check .

fmt: ## Автоформатирование backend
	$(BACKEND) uv run ruff format . && $(BACKEND) uv run ruff check --fix .

# ── Frontend ─────────────────────────────────────────────────

typecheck: ## Проверка типов frontend
	$(COMPOSE) exec -T frontend npm run typecheck

# ── Проверки и обслуживание ───────────────────────────────────

check: lint test typecheck ## Полная проверка проекта

backup: ## Дамп базы в ./backups
	@mkdir -p backups
	$(COMPOSE) exec -T db pg_dump -U $${POSTGRES_USER:-pulse} $${POSTGRES_DB:-pulse_shop} \
		| gzip > backups/pulse_$$(date +%Y%m%d_%H%M%S).sql.gz
	@echo "Дамп сохранён в ./backups"

restore: ## Восстановить базу из последнего дампа (make restore f=backups/xxx.sql.gz)
	@test -n "$(f)" || (echo "Укажите файл: make restore f=backups/pulse_....sql.gz" && exit 1)
	gunzip -c "$(f)" | $(COMPOSE) exec -T db psql -U $${POSTGRES_USER:-pulse} -d $${POSTGRES_DB:-pulse_shop}
	@echo "База восстановлена из $(f)"

clean: ## Удалить контейнеры и тома (БД БУДЕТ ПОТЕРЯНА)
	$(COMPOSE) down -v