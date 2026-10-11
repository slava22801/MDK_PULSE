import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { data, redirect, useActionData } from "react-router";

import type { Route } from "./+types/login";
import type { AuthPayload, LoginValues, NormalizedError } from "~/lib/auth";
import { loginSchema, normalizeError, zodIssuesToFields } from "~/lib/auth";
import { ApiError, serverFetch } from "~/lib/api.server";
import { readAccessToken, serializeAccessCookie, serializeRefreshCookie, buildSetCookieHeaders } from "~/lib/auth-token";
import { useAuthStore } from "~/stores/auth";
import { FormField } from "~/widgets/form-field";
import { SiteHeader } from "~/widgets/site-header";

export function meta(): Route.MetaDescriptors {
  return [
    { title: "Вход — ПУЛЬС" },
    { name: "description", content: "Вход в личный кабинет интернет-магазина ПУЛЬС." },
    { name: "robots", content: "noindex" },
  ];
}

/** Cookie — единственный источник сессии на сервере, поэтому проверка до рендера. */
export function loader({ request }: Route.LoaderArgs) {
  if (readAccessToken(request, useAuthStore.getState().accessToken)) {
    throw redirect("/account");
  }
  return null;
}

/**
 * Вход без JavaScript — запасной путь для медленного мобильного интернета.
 *
 * Refresh-токен в этом пути не сохраняется: сервер не видит localStorage,
 * а класть его в ответ означало бы утечку в HTML документа. Такой сессии хватит
 * до истечения access-токена, дальше пользователь войдёт заново.
 */
export async function action({ request }: Route.ActionArgs) {
  const formData = await request.formData();
  const parsed = loginSchema.safeParse({
    email: String(formData.get("email") ?? ""),
    password: String(formData.get("password") ?? ""),
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
    const payload = await serverFetch<AuthPayload>("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: parsed.data.email, password: parsed.data.password }),
    });

    // Обе cookie обязательны: access-token живёт 30 минут, а серверный loader
    // после этого обновляет сессию по refresh-токену из httpOnly-cookie — без
    // неё пользователя выкидывало бы на /login каждые полчаса.
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

/** Поля формы: по ним раскладываем `fields` из ответа backend-а. */
const FIELDS = ["email", "password"] as const satisfies readonly (keyof LoginValues)[];

export default function Login() {
  const actionData = useActionData<typeof action>();
  const login = useAuthStore((state) => state.login);
  const [apiError, setApiError] = useState<NormalizedError | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const form = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
    mode: "onSubmit",
    reValidateMode: "onChange",
  });

  /** Ошибка приходит одним ответом сервера — раскладываем её по полям формы. */
  const applyServerError = (error: NormalizedError) => {
    setApiError(error);
    for (const field of FIELDS) {
      const message = error.fields[field];
      if (message) form.setError(field, { type: "server", message });
    }
  };

  const onSubmit = form.handleSubmit(async (values) => {
    setApiError(null);
    setSubmitting(true);
    try {
      await login(values);
      // Полная перезагрузка вместо клиентского перехода: loader /account ходит в
      // backend через serverFetch, который в браузере недоступен.
      window.location.assign("/account");
    } catch (cause) {
      applyServerError(normalizeError(cause));
      setSubmitting(false);
    }
  });

  const busy = submitting || form.formState.isSubmitting;

  return (
    <div className="flex min-h-full flex-col">
      <SiteHeader authenticated={false} />

      <main className="container-pulse flex flex-1 items-center justify-center py-10 sm:py-16">
        <div className="card w-full max-w-md p-6 sm:p-8">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Вход в кабинет</h1>
          <p className="mt-1.5 text-sm text-slate-600">
            Используйте e-mail и пароль, указанные при регистрации.
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
            <FormField
              id="email"
              label="E-mail"
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder="you@example.ru"
              required
              error={form.formState.errors.email?.message ?? actionData?.fields.email}
              {...form.register("email")}
            />

            <FormField
              id="password"
              label="Пароль"
              type="password"
              autoComplete="current-password"
              required
              error={form.formState.errors.password?.message ?? actionData?.fields.password}
              {...form.register("password")}
            />

            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-xl bg-pulse-600 px-5 py-3 text-base font-semibold text-white transition-colors hover:bg-pulse-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? "Входим…" : "Войти"}
            </button>
          </form>

          <p className="mt-6 text-center text-sm text-slate-600">
            Нет аккаунта?{" "}
            <a href="/register" className="font-semibold text-pulse-600 hover:text-pulse-700">
              Зарегистрироваться
            </a>
          </p>
        </div>
      </main>
    </div>
  );
}