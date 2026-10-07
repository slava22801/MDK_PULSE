/**
 * Приведение ошибки backend-а к тексту для пользователя.
 *
 * Модуль намеренно НЕ импортирует `ApiError` из `api.server`: тот файл имеет
 * суффикс `.server` и вырезается из клиентского бандла, поэтому импорт здесь
 * дал бы в браузере `undefined`. Вместо этого класс ошибки читается по форме
 * (`status`, `code`, `fields`) — структура у него ровно такая, что описана
 * в `api.server.ts`.
 *
 * Тексты 5xx намеренно обобщённые: в сообщение вида «MissingGreenlet: …» или
 * «AttributeError: …» пользователю полезной информации нет, а детали
 * утекать не должны. Ошибки 4xx наоборот показываем дословно — они относятся
 * к самому запросу и подсказывают, что именно исправить.
 */

export type ApiErrorInfo = {
  status: number;
  code: string;
  message: string;
  fields: Record<string, string>;
};

function readString(source: Record<string, unknown>, name: string): string {
  const value = source[name];
  return typeof value === "string" ? value : "";
}

export function describeApiError(cause: unknown, fallback: string): ApiErrorInfo {
  if (!(cause instanceof Error)) {
    return { status: 0, code: "unknown_error", message: fallback, fields: {} };
  }

  const source = cause as Error & Record<string, unknown>;
  const status = typeof source.status === "number" ? source.status : 0;
  const code = readString(source, "code") || "unknown_error";
  const rawFields = source.fields;
  const fields: Record<string, string> =
    typeof rawFields === "object" && rawFields !== null
      ? Object.fromEntries(
          Object.entries(rawFields as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : {};

  if (status === 0) {
    return {
      status,
      code,
      message: "Не удалось связаться с сервером каталога. Проверьте соединение и обновите страницу.",
      fields,
    };
  }

  if (status >= 500) {
    return {
      status,
      code,
      message: "Каталог временно недоступен. Мы уже знаем о проблеме — попробуйте обновить страницу.",
      fields,
    };
  }

  return { status, code, message: cause.message || fallback, fields };
}
