/**
 * Серверная часть админки: проверка сессии и роли перед любым запросом к `/admin/*`.
 *
 * Здесь — только то, что обязано выполняться на сервере: чтение токена из cookie
 * и обращение к backend. Компоненты этот модуль не импортируют: суффикс
 * `.server` вырезает его из клиентского бандла, и импорт дал бы `undefined`
 * ровно в момент кликов по кнопкам.
 *
 * Почему проверка роли именно здесь, а не только в меню: скрытый пункт меню —
 * это удобство, а не защита. Роль проверяет backend, но помощник нужен и
 * фронту, чтобы не показывать менеджеру пустую страницу товаров вместо
 * внятного «доступ закрыт».
 */
import { ApiError, serverFetch } from "~/lib/api.server";
import type { AdminSection } from "~/lib/admin";
import type { UserOut } from "~/lib/auth";
import { readAccessToken, clearAccessCookieHeader, clearRefreshCookieHeader, buildSetCookieHeaders, serializeAccessCookie, serializeRefreshCookie } from "~/lib/auth-token";
import { refreshSession } from "~/lib/session.server";
import { canAccessSection, isStaffRole } from "~/lib/admin";
import { useAuthStore } from "~/stores/auth";

/** Готовая сессия админки: токен, заголовки и профиль сотрудника. */
/**
 * Редирект на /login с обнулением cookie.
 *
 * Отдельная функция, потому что `Location` и `Set-Cookie` живут в одном
 * объекте `Headers`, а собирать его руками в трёх местах — верный способ
 * забыть про `Location`: React Router падает с «Redirects must have a Location
 * header», и страница отдаёт 500 вместо редиректа.
 */
function redirectToLogin(clearedCookies: string[]): Response {
  const headers = buildSetCookieHeaders(...clearedCookies);
  headers.set("Location", "/login");
  return new Response(null, { status: 302, headers });
}

export type AdminSession = {
  token: string;
  headers: { Authorization: string };
  jsonHeaders: { Authorization: string; "Content-Type": "application/json" };
  user: UserOut;
  /**
   * Обновлённые cookie после серверного refresh.
   *
   * Приходят через Response любого роута: loader не может изменить заголовки
   * уже начатого ответа, поэтому cookie передаются наружу и приклеиваются на
   * выходе. `null`, если refresh не понадобился.
   */
  setCookie: Headers | null;
};

/**
 * Что требуется от роли: конкретный раздел или явный список ролей.
 *
 * Явный список нужен странице промокодов: проверять промокод на сумме имеет
 * право и менеджер, хотя как админский раздел промокоды — его. Разрешения
 * берутся из той же `ADMIN_NAV`, что рисует меню, — иначе «пункт в меню есть,
 * а loader отказывает» станет реальным расхождением.
 */
export type AdminAccess = { section: AdminSection } | { roles: readonly string[] };

/**
 * Проверка доступа к разделу или к списку ролей.
 *
 * Источник истины один — `ADMIN_NAV` из `~/lib/admin`: он же рисует меню.
 * Вторая таблица ролей разошлась бы с меню при первой же правке ТЗ, и
 * сотрудник увидел бы пункт в меню, который открывается отказом 403.
 */
function hasAccess(role: string, access: AdminAccess): boolean {
  return "section" in access ? canAccessSection(role, access.section) : access.roles.includes(role);
}

/**
 * Достаёт сессию сотрудника или выбрасывает наружу.
 *
 * Три исхода, и все три важны:
 *  - токена нет → редирект на /login (пользователь просто не авторизован);
 *  - токен есть, но роль не сотрудника → 403, а не редирект: логин исправен,
 *    прав нет, и молча уводить на главную значит не объяснить причину;
 *  - токен протух, но refresh жив → сессия продлевается и запрос повторяется;
 *  - refresh непригоден → редирект на /login со сбросом обеих cookie, иначе
 *    следующая загрузка снова предъявит заведомо мёртвый токен.
 */
export async function requireAdminSession(
  request: Request,
  access?: AdminAccess,
): Promise<AdminSession> {
  // Запасной источник — стор: при клиентском переходе заголовка Cookie в
  // request нет, но сессия ещё жива (см. `readAccessToken`).
  let token = readAccessToken(request, useAuthStore.getState().accessToken);

  // Токена нет вовсе — свежий refresh не поможет, идти незачем.
  if (!token) throw new Response(null, { status: 302, headers: { Location: "/login" } });

  const buildHeaders = (value: string) => ({ Authorization: `Bearer ${value}` });

  let user: UserOut;
  let setCookie: Headers | null = null;
  try {
    user = await serverFetch<UserOut>("/auth/me", { headers: buildHeaders(token) });
  } catch (cause) {
    if (!(cause instanceof ApiError && cause.status === 401)) throw cause;

    // Access-токен протух, но refresh-токен (30 дней) может быть ещё жив.
    // Раньше здесь был безусловный редирект на /login — из-за этого живого
    // пользователя выкидывало из админки каждые 30 минут. Теперь пробуем
    // продлить сессию и повторить запрос с новым токеном.
    const refreshed = await refreshSession(request);
    if (!refreshed.ok) {
      // Сессия действительно закончилась: чистим cookie, иначе следующая
      // загрузка снова предъявит заведомо мёртвый токен.
      throw redirectToLogin([
        clearAccessCookieHeader(),
        ...(refreshed.clearCookies.length > 0 ? refreshed.clearCookies : [clearRefreshCookieHeader()]),
      ]);
    }

    token = refreshed.tokens.access_token;
    setCookie = buildSetCookieHeaders(
      serializeAccessCookie(refreshed.tokens.access_token, refreshed.tokens.expires_in),
      serializeRefreshCookie(refreshed.tokens.refresh_token),
    );

    try {
      user = await serverFetch<UserOut>("/auth/me", { headers: buildHeaders(token) });
    } catch (retryCause) {
      // Обновились, но запрос всё равно не прошёл — считаем сессию мёртвой,
      // чтобы не оставлять пользователя на странице с битым состоянием.
      if (retryCause instanceof ApiError && retryCause.status === 401) {
        throw redirectToLogin([clearAccessCookieHeader(), clearRefreshCookieHeader()]);
      }
      throw retryCause;
    }
  }

  if (!isStaffRole(user.role)) throw new Response("Недостаточно прав", { status: 403 });

  if (access && !hasAccess(user.role, access)) {
    throw new Response("Недостаточно прав", { status: 403 });
  }

  // Литеральный тип `"application/json"` нужен самому объекту: иначе
  // `session.jsonHeaders` не подошёл бы к типу поля `headers` в `serverFetch`,
  // где TypeScript ждёт точное строковое значение, а не `string`.
  const headers = buildHeaders(token);
  const jsonHeaders = { ...headers, "Content-Type": "application/json" } as const;

  return { token, headers, jsonHeaders, user, setCookie };
}

/** Собирает query-строку, пропуская пустые значения (backend трактует их как null). */
export function queryString(params: Record<string, string | number | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === "") continue;
    search.set(key, String(value));
  }
  const result = search.toString();
  return result ? `?${result}` : "";
}