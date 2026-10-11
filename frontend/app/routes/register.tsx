import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { data, redirect, useActionData } from "react-router";

import type { Route } from "./+types/register";
import type { AuthPayload, NormalizedError, RegisterValues } from "~/lib/auth";
import { normalizeError, registerSchema, zodIssuesToFields } from "~/lib/auth";
import { ApiError, serverFetch } from "~/lib/api.server";
import { readAccessToken, serializeAccessCookie, serializeRefreshCookie, buildSetCookieHeaders } from "~/lib/auth-token";
import { useAuthStore } from "~/stores/auth";
import { FormField } from "~/widgets/form-field";
import { SiteHeader } from "~/widgets/site-header";

export function meta(): Route.MetaDescriptors {
  return [
    { title: "Регистрация — ПУЛЬС" },
    { name: "description", content: "Регистрация в интернет-магазине компьютерных комплектующих ПУЛЬС." },
    { name: "robots", content: "noindex" },
  ];
}

export function loader({ request }: Route.LoaderArgs) {
  if (readAccessToken(request, useAuthStore.getState().accessToken)) {
    throw redirect("/account");
  }
  return null;
}

/** Без JS чекбокс приходит строкой "on" — приводим к boolean до валидации Zod. */
function formValue(formData: FormData, name: string): string | boolean {
  const value = formData.get(name);
  return typeof value === "string" ? value : false;
}

/** Регистрация без JavaScript. Ограничения пароля проверяет та же схема, что и клиент. */
export async function action({ request }: Route.ActionArgs) {
  const formData = await request.formData();
  const parsed = registerSchema.safeParse({
    first_name: String(formData.get("first_name") ?? ""),
    last_name: String(formData.get("last_name") ?? ""),
    email: String(formData.get("email") ?? ""),
    phone: String(formData.get("phone") ?? ""),
    password: String(formData.get("password") ?? ""),
    password_confirm: String(formData.get("password_confirm") ?? ""),
    accept_policy: formValue(formData, "accept_policy"),
  });

  if (!parsed.success) {
    const error: NormalizedError = {
      code: "validation_error",
      message: "Проверьте правильность заполнения полей",
      fields: zodIssuesToFields(parsed.error),
    };
    return data(error, { status: 400 });
  }

  try {
    const payload = await serverFetch<AuthPayload>("/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        first_name: parsed.data.first_name,
        last_name: parsed.data.last_name,
        email: parsed.data.email,
        phone: parsed.data.phone,
        password: parsed.data.password,
        password_confirm: parsed.data.password_confirm,
        accept_policy: parsed.data.accept_policy,
      }),
    });

    // Refresh-токен — в httpOnly-cookie, чтобы сервер мог продлить сессию
    // после истечения access-токена. см. комментарий в login.tsx.
    return redirect("/account", {
      headers: buildSetCookieHeaders(
        serializeAccessCookie(payload.tokens.access_token, payload.tokens.expires_in),
        serializeRefreshCookie(payload.tokens.refresh_token),
      ),
    });
  } catch (cause) {
    const error = normalizeError(cause);
    const status = cause instanceof ApiError && cause.status > 0 ? cause.status : 400;
    return data(error, { status });
  }
}

/** Имена полей формы: по ним раскладываем `fields` из ответа backend-а. */
const FIELDS = [
  "first_name",
  "last_name",
  "email",
  "phone",
  "password",
  "password_confirm",
  "accept_policy",
] as const satisfies readonly (keyof RegisterValues)[];

export default function Register() {
  const actionData = useActionData<typeof action>();
  const register = useAuthStore((state) => state.register);
  const [apiError, setApiError] = useState<NormalizedError | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const form = useForm<RegisterValues>({
    resolver: zodResolver(registerSchema),
    defaultValues: {
      first_name: "",
      last_name: "",
      email: "",
      phone: "",
      password: "",
      password_confirm: "",
      accept_policy: false,
    },
    mode: "onSubmit",
    reValidateMode: "onChange",
  });

  const applyServerError = (error: NormalizedError) => {
    setApiError(error);
    for (const field of FIELDS) {
      const message = error.fields[field];
      if (message) form.setError(field, { type: "server", message });
    }

    // 409 по контракту возвращается без `fields`: показываем текст у e-mail,
    // иначе пользователь не поймёт, что именно не так.
    if (error.code === "email_already_exists" && !error.fields.email) {
      form.setError("email", { type: "server", message: error.message });
    }
  };

  const onSubmit = form.handleSubmit(async (values) => {
    setApiError(null);
    setSubmitting(true);
    try {
      await register(values);
      window.location.assign("/account");
    } catch (cause) {
      applyServerError(normalizeError(cause));
      setSubmitting(false);
    }
  });

  const busy = submitting || form.formState.isSubmitting;
  const errors = form.formState.errors;

  return (
    <div className="flex min-h-full flex-col">
      <SiteHeader authenticated={false} />

      <main className="container-pulse flex flex-1 items-center justify-center py-10 sm:py-16">
        <div className="card w-full max-w-2xl p-6 sm:p-8">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Регистрация</h1>
          <p className="mt-1.5 text-sm text-slate-600">
            Один аккаунт для заказов, отзывов и истории покупок.
          </p>

          {(apiError ?? actionData) ? (
            <p
              role="alert"
              className="mt-5 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-3 text-sm font-medium text-rose-700"
            >
              {(apiError ?? actionData)?.message}
            </p>
          ) : null}

          <form method="post" onSubmit={onSubmit} noValidate className="mt-6 space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                id="first_name"
                label="Имя"
                autoComplete="given-name"
                required
                error={errors.first_name?.message ?? actionData?.fields.first_name}
                {...form.register("first_name")}
              />
              <FormField
                id="last_name"
                label="Фамилия"
                autoComplete="family-name"
                required
                error={errors.last_name?.message ?? actionData?.fields.last_name}
                {...form.register("last_name")}
              />
            </div>

            <FormField
              id="email"
              label="E-mail"
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder="you@example.ru"
              required
              error={errors.email?.message ?? actionData?.fields.email}
              {...form.register("email")}
            />

            <FormField
              id="phone"
              label="Телефон"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder="+7 900 000-00-00"
              hint="Нужен для подтверждения заказа и уведомлений о доставке."
              required
              error={errors.phone?.message ?? actionData?.fields.phone}
              {...form.register("phone")}
            />

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                id="password"
                label="Пароль"
                type="password"
                autoComplete="new-password"
                hint="Минимум 8 символов, хотя бы одна буква и одна цифра."
                required
                error={errors.password?.message ?? actionData?.fields.password}
                {...form.register("password")}
              />
              <FormField
                id="password_confirm"
                label="Повторите пароль"
                type="password"
                autoComplete="new-password"
                required
                error={errors.password_confirm?.message ?? actionData?.fields.password_confirm}
                {...form.register("password_confirm")}
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="accept_policy" className="flex items-start gap-2.5 text-sm text-slate-700">
                <input
                  id="accept_policy"
                  type="checkbox"
                  aria-invalid={errors.accept_policy ? true : undefined}
                  aria-describedby={errors.accept_policy ? "accept_policy-error" : undefined}
                  className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 accent-pulse-600"
                  {...form.register("accept_policy")}
                />
                <span>
                  Я согласен с политикой обработки персональных данных и обработкой моих данных для
                  оформления заказов.
                </span>
              </label>
              {errors.accept_policy?.message ? (
                <p id="accept_policy-error" className="text-sm font-medium text-rose-600">
                  {errors.accept_policy.message}
                </p>
              ) : null}
            </div>

            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-xl bg-pulse-600 px-5 py-3 text-base font-semibold text-white transition-colors hover:bg-pulse-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? "Создаём аккаунт…" : "Зарегистрироваться"}
            </button>
          </form>

          <p className="mt-6 text-center text-sm text-slate-600">
            Уже есть аккаунт?{" "}
            <a href="/login" className="font-semibold text-pulse-600 hover:text-pulse-700">
              Войти
            </a>
          </p>
        </div>
      </main>
    </div>
  );
}