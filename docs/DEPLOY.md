# Развёртывание ПУЛЬС

Документ покрывает раздел 19 ТЗ: инструкция по запуску, развёртыванию на сервере,
резервному копированию и восстановлению.

## 1. Локальный запуск

```bash
cp .env.example .env
docker compose up -d --build
docker compose ps
```

Проверка:

```bash
curl http://localhost:8090/nginx-health   # Nginx
curl http://localhost:8090/healthz         # Frontend SSR
curl http://localhost:8090/api/v1/health   # Backend
curl http://localhost:8090/api/v1/health/ready
```

`/api/v1/health/ready` возвращает 503, если недоступны PostgreSQL или Redis,
и 200 со списком проверок, если всё живо. Этот эндпоинт идёт в мониторинг.

## 2. Переменные окружения

Полный список — в корневом `.env.example`. Обязательные для production:

| Переменная | Требование |
|---|---|
| `APP_ENV` | `production` |
| `DEBUG` | `false` |
| `SECRET_KEY` | случайная строка ≥ 32 символов |
| `JWT_SECRET_KEY` | случайная строка ≥ 32 символов |
| `PAYMENT_WEBHOOK_SECRET` | случайная строка ≥ 32 символов |
| `DATABASE_URL` | с паролем, отличным от dev |
| `CORS_ORIGINS` | только домены магазина |

Приложение **не стартует**, если в production остались `change_me` или слишком
короткие секреты — это проверка в `app/core/config.py`.

Генерация секретов:

```bash
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

## 3. Хранилище изображений

По умолчанию `STORAGE_DRIVER=local`: файлы лежат в томе `media-data`, backend
раздаёт их с `/media`. Этого достаточно для разработки и внутреннего стенда.

Для продакшена переключаем на S3 (раздел 2.3 ТЗ):

```bash
STORAGE_DRIVER=s3
S3_ENDPOINT=https://storage.yandexcloud.net
S3_PUBLIC_URL=https://cdn.example.com
S3_ACCESS_KEY=...
S3_SECRET_KEY=...
S3_BUCKET=pulse-media
```

Бакет создаётся автоматически при первом обращении, если это разрешено
политикой доступа. Перед переключением перенесите существующие файлы —
миграция выполняется скриптом `scripts/migrate_media.py` (появится на этапе 3).

## 4. SSL

Вариант A — termination на внешнем балансировщике или в панели хостинга.

Вариант B — certbot перед Nginx:

```bash
apt-get install -y certbot
certbot certonly --standalone -d shop.example.com -d www.example.com
```

Затем добавьте в `deploy/nginx/default.conf` сервер на 443 с редиректом
с 80 и `ssl_certificate` на выпущенные файлы, а compose дополните
сертификатами через `volumes`.

## 5. Обновление проекта

```bash
git pull
docker compose build --pull
docker compose up -d
docker compose exec backend alembic upgrade head
docker compose restart backend frontend
```

Миграции применяются автоматически сервисом `migrate` при каждом `up`.

## 6. Резервное копирование

**Обязательно** копировать: базу данных, каталог изображений и `.env`.

### База данных

```bash
make backup
```

Или вручную с выгрузкой на внешний диск:

```bash
docker compose exec -T db pg_dump -U pulse -Fc pulse_shop > pulse_$(date +%F).dump
```

`pg_dump -Fc` — формат PostgreSQL custom: сжатый и пригодный для выборочного
восстановления.

### Файлы изображений

```bash
docker run --rm -v pulse_media-data:/data -v $(pwd)/backups:/backup alpine \
  tar czf /backup/media_$(date +%F).tar.gz -C /data .
```

### Расписание

```cron
# Бэкап БД и медиа каждый день в 03:17, хранение 30 дней
17 3 * * * cd /opt/pulse && make backup >> /var/log/pulse-backup.log 2>&1
17 3 * * * cd /opt/pulse && docker run --rm -v pulse_media-data:/data -v /opt/pulse/backups:/backup alpine tar czf /backup/media_$(date +\%F).tar.gz -C /data . >> /var/log/pulse-backup.log 2>&1
30 4 * * * find /opt/pulse/backups -name '*.gz' -mtime +30 -delete
```

## 7. Восстановление

```bash
docker compose down
docker compose up -d db
# Дождаться healthy

# Восстановить БД
gunzip -c backups/pulse_2026-10-06.sql.gz | docker compose exec -T db psql -U pulse -d pulse_shop
# или из custom-формата:
cat backups/pulse_2026-10-06.dump | docker compose exec -T db pg_restore -U pulse -d pulse_shop --clean --if-exists

# Восстановить изображения
docker run --rm -v pulse_media-data:/data -v /opt/pulse/backups:/backup alpine \
  tar xzf /backup/media_2026-10-06.tar.gz -C /data

docker compose up -d
curl http://localhost:8090/api/v1/health/ready
```

Восстановление на чистую БД всегда безопаснее: сначала поднимите пустой
`postgres`, залейте дамп, затем запускайте остальной стек.

## 8. Мониторинг

Что отслеживать (раздел 13 ТЗ):

| Что | Где смотреть |
|---|---|
| Ошибки API и 5xx | `docker compose logs backend` |
| Действия администраторов | таблица `admin_audit_log` |
| Изменения остатков | `docker compose logs backend \| grep stock` |
| Здоровье зависимостей | `GET /api/v1/health/ready` |
| Загрузка диска | `df -h` на хосте |

Подключение Sentry выполняется через переменные окружения `SENTRY_DSN`
и инициализацию в `app/main.py` (добавится на этапе 8).

## 9. Проверка после развёртывания

- [ ] `/api/v1/health/ready` отвечает 200
- [ ] Главная страница открывается по HTTPS
- [ ] `robots.txt` и `sitemap.xml` отдаются (этап 3)
- [ ] Регистрация и вход работают (этап 2)
- [ ] Каталог и карточка товара открываются (этап 3)
- [ ] Тестовый заказ оформляется и появляется в админке (этап 5)
- [ ] Восстановление из дампа проверено на копии стенда