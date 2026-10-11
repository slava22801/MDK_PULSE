/**
 * Зеркало access-токена в cookie — единственный способ защитить маршруты на SSR.
 *
 * Токены живут в localStorage (их читает Zustand-стор), но localStorage серверу
 * недоступен: loader не увидит сессию и выкинет авторизованного пользователя на
 * /login. Cookie решает эту задачу — она уезжает вместе с запросом, поэтому
 * серверный loader может сам проверить сессию через /auth/me.
 *
 * Известное ограничение: cookie доступна скриптам, поэтому от XSS она токен не
 * защищает так же, как httpOnly. Здесь это осознанный компромисс — refresh-токен
 * всё равно пришлось бы держать в JS-хранилище, чтобы браузер мог обновить
 * access-токен по контракту `POST /auth/refresh` с телом `{ refresh_token }`.
 * Переход на httpOnly-cookie целиком возможен, когда backend начнёт принимать
 * refresh из httpOnly-cookie вместо тела запроса.
 */

/** Имя cookie совпадает с ключом хранения стора — так проще искать токен в DevTools. */
export const ACCESS_TOKEN_COOKIE = "pulse_at";

/**
 * Время жизни access-токена по умолчанию, если backend не прислал `expires_in`.
 *
 * Должно быть НЕ МЕНЬШЕ `JWT_ACCESS_EXPIRE_MINUTES` в backend (сейчас 30 минут),
 * с запасом сверху. Раньше здесь стояло 15 минут — вдвое меньше токена, и это
 * давало ровно тот баг, о котором сообщали: cookie умирала на 15-й минуте,
 * токен в localStorage продолжал показывать авторизованного пользователя, а
 * любой серверный loader — не видя cookie — уводил на /login. Обратная
 * асимметрия (cookie живёт дольше токена) безопасна: лишний запрос получит
 * 401 и штатный редирект.
 */
export const DEFAULT_MAX_AGE_SECONDS = 60 * 60;

/**
 * Собирает Set-Cookie для ответа сервера.
 *
 * Флаг Secure намеренно не выставлен: стенд разворачивается по http
 * (docker-compose без TLS), а cookie с Secure браузер отбросит и защита
 * маршрутов начнёт редиректить на /login. На https нужно включить Secure —
 * это отдельная задача вместе с сертификатом.
 */
export function serializeAccessCookie(value: string, maxAgeSeconds = DEFAULT_MAX_AGE_SECONDS): string {
  const maxAge = Math.max(0, Math.floor(maxAgeSeconds));
  return `${ACCESS_TOKEN_COOKIE}=${encodeURIComponent(value)}; Path=/; SameSite=Lax; Max-Age=${maxAge}`;
}

/** Обнуление cookie — после выхода из аккаунта и при отказе backend-а в /auth/me. */
export function clearAccessCookieHeader(): string {
  return `${ACCESS_TOKEN_COOKIE}=; Path=/; SameSite=Lax; Max-Age=0`;
}

/** Запись cookie из браузера: SSR-путь ставит её через Set-Cookie, этот — из клиента. */
export function writeAccessCookie(value: string, maxAgeSeconds = DEFAULT_MAX_AGE_SECONDS): void {
  if (typeof document === "undefined") return;
  document.cookie = serializeAccessCookie(value, maxAgeSeconds);
}

export function clearAccessCookie(): void {
  if (typeof document === "undefined") return;
  document.cookie = clearAccessCookieHeader();
}

/** Достаёт access-токен из заголовка Cookie запроса. */
export function readAccessCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [rawName, ...rest] = part.trim().split("=");
    if (rawName === ACCESS_TOKEN_COOKIE) {
      return decodeURIComponent(rest.join("=")) || null;
    }
  }
  return null;
}

/* ─────────────────────── refresh-токен для SSR ─────────────────────── */

/**
 * Refresh-токен в отдельной httpOnly-cookie.
 *
 * Зачем он серверу: access-токен живёт 30 минут, refresh — 30 дней. Раньше
 * refresh лежал только в localStorage, куда сервер заглянуть не может, поэтому
 * после истечения access-токена SSR-loader не мог продлить сессию и уводил
 * на /login, хотя сессия была жива. Теперь сервер умеет обменять refresh на
 * новую пару токенов прямо в loader'е.
 *
 * Именно httpOnly, в отличие от `pulse_at`: значение нужно только backend'у и
 * серверу рендера, в JS оно не требуется, поэтому скриптам его видеть не нужно.
 */
export const REFRESH_TOKEN_COOKIE = "pulse_rt";

/** Refresh хранится неделями; Max-Age с запасом над `JWT_REFRESH_EXPIRE_DAYS`. */
export const REFRESH_MAX_AGE_SECONDS = 60 * 60 * 24 * 45;

export function serializeRefreshCookie(value: string, maxAgeSeconds = REFRESH_MAX_AGE_SECONDS): string {
  const maxAge = Math.max(0, Math.floor(maxAgeSeconds));
  return `${REFRESH_TOKEN_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearRefreshCookieHeader(): string {
  return `${REFRESH_TOKEN_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/**
 * Кладёт несколько cookie в один ответ.
 *
 * Через `append`, а не склейкой строки: cookie — единственный заголовок, который
 * по RFC разрешено повторять, и его нельзя объединять через запятую — само
 * значение cookie запятой может содержать. Склейка молча ломала бы такие cookie.
 * Возвращаемый Headers годится и для `redirect({ headers })`, и для
 * `data(..., { headers })`: там React Router разбирает объект Headers сам.
 */
export function buildSetCookieHeaders(...cookies: string[]): Headers {
  const headers = new Headers();
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return headers;
}

export function readRefreshCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [rawName, ...rest] = part.trim().split("=");
    if (rawName === REFRESH_TOKEN_COOKIE) {
      return decodeURIComponent(rest.join("=")) || null;
    }
  }
  return null;
}

/**
 * Токен для loader/action с учётом обоих контекстов.
 *
 * На сервере (первый запрос, full page load) работает cookie. На клиенте
 * (переход по <Link> после логина) заголовка Cookie в request нет — React Router
 * не подставляет cookie в клиентский запрос, поэтому нужен запасной источник:
 * стор, который уже держит токен в памяти.
 */
export function readAccessToken(request: Request, fallback?: string | null): string | null {
  return readAccessCookie(request.headers.get("Cookie")) ?? fallback ?? null;
}