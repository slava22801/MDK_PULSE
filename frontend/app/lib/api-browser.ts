/**
 * Браузерный клиент API: авторизация из стора и прозрачное обновление access-токена.
 *
 * Отдельный модуль от `api.server`, потому что `.server`-модули React Router
 * вырезаются из клиентского бандла — импортировать их в компонент нельзя.
 * Поэтому здесь своя копия класса ошибки с той же структурой.
 *
 * Имя файла специально НЕ `api.client.ts`: суффикс `.client` означает для
 * React Router «только браузер», и такой модуль вырезается из серверного
 * бандла. Стор импортирует этот файл, поэтому SSR-сервер получил бы вместо
 * `apiFetch` значение `undefined` и падал бы при первом обращении к нему.
 */
import type { NormalizedError, TokenPair } from "./auth";
import { readErrorBody } from "./auth";

/** Дублирует API_PREFIX из `api.server` — по той же причине, что и класс ошибки. */
const API_PREFIX = "/api/v1";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields: Record<string, string> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** Структурный вид для `normalizeError` из `~/lib/auth`. */
  toNormalized(): NormalizedError {
    return { code: this.code, message: this.message, fields: this.fields };
  }
}

/**
 * Мост к Zustand-стору.
 *
 * Стор импортирует этот модуль (login/register/logout ходят через apiFetch),
 * поэтому прямой импорт стора здесь создал бы цикл. Вместо цикла стор
 * регистрирует свои методы один раз при инициализации модуля.
 */
export type AuthBridge = {
  getAccessToken: () => string | null;
  getRefreshToken: () => string | null;
  applyTokens: (tokens: TokenPair) => void;
  clear: () => void;
};

let bridge: AuthBridge | null = null;

export function registerAuthBridge(next: AuthBridge): void {
  bridge = next;
}

export type ApiOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Тело запроса: сериализуется в JSON. */
  json?: unknown;
  signal?: AbortSignal;
  /** Не повторять запрос после refresh — нужно для самого refresh-вызова. */
  retryOnUnauthorized?: boolean;
};

async function send(path: string, options: ApiOptions, accessToken: string | null): Promise<Response> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (options.json !== undefined) headers["Content-Type"] = "application/json";

  try {
    return await fetch(`${API_PREFIX}${path.startsWith("/") ? path : `/${path}`}`, {
      method: options.method ?? "GET",
      headers,
      body: options.json === undefined ? undefined : JSON.stringify(options.json),
      signal: options.signal,
      credentials: "same-origin",
    });
  } catch {
    // fetch сам не различает «нет сети» и «сервер упал» — для формы это одно
    // и то же состояние, поэтому отдельный код не даёт пользователю пользы.
    throw new ApiError(0, "network_error", "Нет соединения с сервером");
  }
}

async function parseResponse<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const { code, message, fields } = readErrorBody(payload);
    throw new ApiError(response.status, code, message || `Ошибка ${response.status}`, fields);
  }

  return payload as T;
}

/**
 * Один refresh на всех параллельных запросов.
 *
 * Без этой блокировки пять одновременных запросов с истёкшим токеном получили бы
 * пять POST /auth/refresh, а backend в ответ на второй, с уже ротированным
 * refresh-токеном, вернул бы 401 — и пользователя выбросило бы из аккаунта.
 */
let refreshInFlight: Promise<string | null> | null = null;

function refreshAccessToken(): Promise<string | null> {
  refreshInFlight ??= performRefresh().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function performRefresh(): Promise<string | null> {
  const current = bridge;
  const refreshToken = current?.getRefreshToken() ?? null;
  if (!current || !refreshToken) return null;

  try {
    // Refresh идёт без Authorization: старый access-токен уже недействителен
    // и лишь мешал бы backend-у отличить «просрочен» от «невалиден».
    const response = await send(
      "/auth/refresh",
      { method: "POST", json: { refresh_token: refreshToken }, retryOnUnauthorized: false },
      null,
    );
    if (!response.ok) throw new Error("refresh rejected");

    const payload = (await response.json()) as { tokens?: TokenPair };
    const tokens = payload.tokens;
    if (!tokens) throw new Error("refresh: токены не получены");

    current.applyTokens(tokens);
    return tokens.access_token;
  } catch {
    // Refresh-токен протух или отозван — сессии больше нет, чистим её честно.
    current.clear();
    redirectToLogin();
    return null;
  }
}

function redirectToLogin(): void {
  if (typeof window === "undefined") return;
  if (window.location.pathname === "/login" || window.location.pathname === "/register") return;
  window.location.assign("/login");
}

export async function apiFetch<T>(path: string, options: ApiOptions = {}): Promise<T> {
  let response = await send(path, options, bridge?.getAccessToken() ?? null);

  if (response.status === 401 && options.retryOnUnauthorized !== false) {
    const refreshed = await refreshAccessToken();
    // Повтор ровно один раз: если и новый токен отвергнут, запрос не повторяем,
    // иначе получим бесконечный цикл refresh -> запрос -> refresh.
    if (refreshed) response = await send(path, options, refreshed);
  }

  return parseResponse<T>(response);
}