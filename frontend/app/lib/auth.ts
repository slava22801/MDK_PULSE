/**
 * Доменная часть авторизации: типы контракта, схемы форм и нормализация ошибок.
 *
 * Модуль намеренно изоморфный — его импортируют и серверные loader/action,
 * и клиентские компоненты форм, поэтому здесь не должно быть ничего,
 * что доступно только в Node или только в браузере.
 */
import { z } from "zod";

export type UserRole = "customer" | "manager" | "admin";

export type UserOut = {
  id: number;
  email: string;
  first_name: string;
  last_name: string;
  phone: string | null;
  role: UserRole;
  is_active: boolean;
  email_verified: boolean;
  created_at: string;
};

export type TokenPair = {
  access_token: string;
  refresh_token: string;
  token_type: "bearer";
  expires_in: number;
};

export type AuthPayload = {
  user: UserOut;
  tokens: TokenPair;
};

export type LoginInput = {
  email: string;
  password: string;
};

export type RegisterInput = {
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  password: string;
  password_confirm: string;
  accept_policy: boolean;
};

/** Ошибки по конкретным полям: ключ — имя поля формы. */
export type FieldErrors = Record<string, string>;

export type NormalizedError = {
  code: string;
  message: string;
  fields: FieldErrors;
};

/**
 * Схемы форм живут здесь, чтобы action (серверная валидация без JS) и
 * react-hook-form (клиентская валидация) проверяли одни и те же правила:
 * расхождение схем даёт «форму, которая проходит на клиенте и падает на API».
 */
export const loginSchema = z.object({
  // zod 3, а не 4: @hookform/resolvers 4.x разбирает ZodError через `.errors`,
  // которых в v4 нет, и падает на любой ошибке формы.
  email: z.string().email("Укажите корректный email").max(254, "Слишком длинный адрес"),
  password: z.string().min(1, "Введите пароль"),
});

export type LoginValues = z.infer<typeof loginSchema>;

export const registerSchema = z
  .object({
    first_name: z.string().trim().min(2, "Имя: минимум 2 символа").max(64, "Имя слишком длинное"),
    last_name: z.string().trim().min(2, "Фамилия: минимум 2 символа").max(64, "Фамилия слишком длинная"),
    email: z.string().email("Укажите корректный email").max(254, "Слишком длинный адрес"),
    // Поле обязательное по контракту, но формат не зафиксирован ТЗ — проверяем
    // только длину, жёсткий regex забрал бы валидные номера с кодом города.
    phone: z.string().trim().min(10, "Телефон: минимум 10 цифр").max(32, "Телефон слишком длинный"),
    // Пункт 5.7 ТЗ: не короче 8 символов, минимум одна буква и одна цифра.
    password: z
      .string()
      .min(8, "Пароль: минимум 8 символов")
      .regex(/[A-Za-zА-Яа-яЁё]/, "Пароль должен содержать хотя бы одну букву")
      .regex(/\d/, "Пароль должен содержать хотя бы одну цифру"),
    password_confirm: z.string().min(1, "Подтвердите пароль"),
    // Именно boolean, а не z.literal(true): тип literal-а заставил бы объявить
    // defaultValues.accept_policy = true, и чекбокс был бы отмечен по умолчанию.
    accept_policy: z.boolean().refine((accepted) => accepted, {
      message: "Без согласия на обработку данных регистрация невозможна",
    }),
  })
  .superRefine((values, ctx) => {
    if (values.password !== values.password_confirm) {
      ctx.addIssue({
        code: "custom",
        path: ["password_confirm"],
        message: "Пароли не совпадают",
      });
    }
  });

export type RegisterValues = z.infer<typeof registerSchema>;

function isStringRecord(value: unknown): value is FieldErrors {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === "string")
  );
}

/** Разбор единого формата ошибок backend: `{ "error": { code, message, fields? } }`. */
export function readErrorBody(payload: unknown): NormalizedError {
  const body = payload as { error?: { code?: unknown; message?: unknown; fields?: unknown } } | null;
  const error = body?.error;
  return {
    code: typeof error?.code === "string" ? error.code : "http_error",
    message: typeof error?.message === "string" ? error.message : "",
    fields: isStringRecord(error?.fields) ? error.fields : {},
  };
}

/**
 * Приводит любое исключение к `{ code, message, fields }`.
 *
 * Нужна, потому что серверный `ApiError` и клиентский лежат в разных модулях
 * (`.server`-модуль нельзя импортировать в браузерный бандл): проверять
 * `instanceof` каждого класса в формах нельзя, а структура у них одинаковая.
 */
export function normalizeError(error: unknown): NormalizedError {
  if (error instanceof Error) {
    const candidate = error as { code?: unknown; fields?: unknown };
    return {
      code: typeof candidate.code === "string" ? candidate.code : "unknown_error",
      message: error.message || "Что-то пошло не так",
      fields: isStringRecord(candidate.fields) ? candidate.fields : {},
    };
  }
  return { code: "unknown_error", message: "Что-то пошло не так", fields: {} };
}

/** Раскладывает issues Zod в `{ поле: сообщение }` — по первому issue на поле. */
export function zodIssuesToFields(error: z.ZodError): FieldErrors {
  const fields: FieldErrors = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "_root");
    fields[key] ??= issue.message;
  }
  return fields;
}