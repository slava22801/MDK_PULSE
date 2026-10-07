/**
 * Ресурсный роут для Docker healthcheck.
 *
 * Намеренно не ходит в backend: контейнер считается живым по факту работы
 * SSR-сервера, а не по доступности API (иначе падение БД роняет и фронтенд).
 */
import type { Route } from "./+types/healthz";

export function loader(_: Route.LoaderArgs) {
  return new Response("ok", {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}