/**
 * Продление сессии на сервере: обмен refresh-токена на новую пару токенов.
 *
 * Зачем модуль: access-токен живёт 30 минут, refresh — 30 дней. Раньше SSR
 * не имел доступа к refresh (он лежал только в localStorage) и при истечении
 * access-токена loader уводил на /login — то есть ��олного пользователя выкидывало
 * из админки каждые полчаса, хотя сессия была жива. Клиентский `apiFetch` умел
 * обновить токен сам, но клиентские loader'ы в этом проекте не используются:
 * админка ходит по обычным `<a href>`, то есть это всегда полная загрузка
 * документа, где нужен именно серверный обмен.
 *
 * Ошибки намеренно глотаются: если refresh не сработал, вызывающий код решает,
 * что делать (редирект на /login), а этот модуль не должен бросать исключения
 * поверх логики роута.
 */
import { serverFetch } from "~/lib/api.server";
import { clearRefreshCookieHeader, readRefreshCookie } from "~/lib/auth-token";
import type { TokenPair } from "~/lib/auth";

export type RefreshOutcome =
  | { ok: true; tokens: TokenPair }
  | { ok: false; /** Refresh непригоден — cookie, которые надо обнулить. */
      clearCookies: string[] };

/**
 * Обмены refresh в процессе, ключ — сам refresh-токен.
 *
 * Обязательно, а не оптимизация. React Router запускает loader'ы параллельно:
 * на странице админки это layout-loader и loader'ы разделов, и при протухшем
 * access-токене они все разом получат 401 и все пойдут обновлять сессию. Но
 * backend ротирует refresh-токен при каждом обмене — первая из параллельных
 * заявок заберёт новый refresh и сделает старый недействительным, а вторая
 * придёт с уже отозванным токеном, получит 401 и уведёт пользователя на
 * /login. То есть без этогоmap'а продление сессии само воспроизводило бы
 * исходный баг при каждом переходе. Здесь работает тот же приём, что и в
 * клиентском `api-browser.ts`: один refresh на всех, остальные ждут его.
 */
const inFlight = new Map<string, Promise<RefreshOutcome>>();

/**
 * Обменивает refresh-токен из cookie на новую пару токенов.
 *
 * Backend ротирует refresh-токен на каждом обмене: старый становится недействи-
 * тепным. Поэтому новый refresh обязан уехать в ответ вместе с access, иначе
 * второй вызов подряд уже не сработал бы.
 */
export function refreshSession(request: Request): Promise<RefreshOutcome> {
  const refreshToken = readRefreshCookie(request.headers.get("Cookie"));
  if (!refreshToken) {
    // Refresh-cookie нет вовсе — чистить нечего, но и продолжать не с чем.
    return Promise.resolve({ ok: false, clearCookies: [] });
  }

  const existing = inFlight.get(refreshToken);
  if (existing) return existing;

  const attempt = performRefresh(refreshToken).finally(() => {
    inFlight.delete(refreshToken);
  });
  inFlight.set(refreshToken, attempt);
  return attempt;
}

async function performRefresh(refreshToken: string): Promise<RefreshOutcome> {
  try {
    // Refresh идёт БЕЗ Authorization: протухший access-токен только мешал бы
    // backend-у отличить «просрочен» от «невалиден».
    const payload = await serverFetch<{ tokens?: TokenPair }>("/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });

    const tokens = payload.tokens;
    if (!tokens?.access_token || !tokens.refresh_token) {
      return { ok: false, clearCookies: [clearRefreshCookieHeader()] };
    }

    return { ok: true, tokens };
  } catch {
    // Refresh протух или отозван — сессии больше нет, чистим её честно.
    return { ok: false, clearCookies: [clearRefreshCookieHeader()] };
  }
}