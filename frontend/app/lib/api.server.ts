/**
 * Обращения к API из SSR-рендера.
 *
 * Сервер ходит в backend по внутренней docker-сети (`API_INTERNAL_URL`),
 * браузер — по относительному `/api/v1`, который проксирует Nginx.
 * Поэтому один и тот же компонент работает в обоих контекстах.
 */

const SERVER_API_URL = (process.env.API_INTERNAL_URL ?? "http://localhost:8000").replace(
  /\/+$/,
  "",
);

export const API_PREFIX = "/api/v1";

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
}

/** Собирает абсолютный URL для серверного запроса. */
export function serverApiUrl(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return normalized.startsWith(API_PREFIX)
    ? `${SERVER_API_URL}${normalized}`
    : `${SERVER_API_URL}${API_PREFIX}${normalized}`;
}

/**
 * Бросает `ApiError` при ошибке — вызывающий код решает, что показать.
 * Не вызывать в клиентском компоненте: только loader/action.
 */
export async function serverFetch<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(serverApiUrl(path), {
      ...init,
      headers: { Accept: "application/json", ...init?.headers },
      signal: init?.signal ?? AbortSignal.timeout(8000),
    });
  } catch (cause) {
    throw new ApiError(0, "network_error", "Сервер недоступен", {
      _root: cause instanceof Error ? cause.message : String(cause),
    });
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const error = (payload as { error?: { code?: string; message?: string; fields?: unknown } })
      ?.error;
    throw new ApiError(
      response.status,
      error?.code ?? "http_error",
      error?.message ?? `Ошибка ${response.status}`,
      (error?.fields as Record<string, string>) ?? {},
    );
  }

  return payload as T;
}