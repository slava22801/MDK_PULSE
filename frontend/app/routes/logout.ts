/**
 * Ресурсный роут выхода из аккаунта: `<Form method="post" action="/logout">`.
 *
 * Основной путь — сработавший в браузере обработчик в site-header: он знает
 * refresh-токен из стора, отзывает сессию на backend и чистит localStorage.
 * Этот action нужен для случая без JavaScript — тогда refresh-токен серверу
 * недоступен, поэтому отзыв идёт best-effort по access-токену.
 */
import { redirect } from "react-router";

import type { Route } from "./+types/logout";
import { serverFetch } from "~/lib/api.server";
import { clearAccessCookieHeader, readAccessToken } from "~/lib/auth-token";
import { useAuthStore } from "~/stores/auth";

/** GET /logout не должен быть ссылкой: выход — действие с побочным эффектом. */
export function loader() {
  throw redirect("/");
}

export async function action({ request }: Route.ActionArgs) {
  const token = readAccessToken(request, useAuthStore.getState().accessToken);

  if (token) {
    try {
      await serverFetch<void>("/auth/logout", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      // Сессия могла протухнуть или backend недоступен — пользователь всё равно
      // ожидает, что окажется на главной, поэтому ошибку глушим.
    }
  }

  return redirect("/", { headers: { "Set-Cookie": clearAccessCookieHeader() } });
}