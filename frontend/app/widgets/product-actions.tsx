import { useState } from "react";

import { ApiError } from "~/lib/api-browser";
import { normalizeError } from "~/lib/auth";
import { AVAILABILITY_LABEL } from "~/lib/catalog";
import { useCartStore } from "~/stores/cart";
import { useFavoritesStore } from "~/stores/favorites";

/**
 * Кнопки «В корзину» и «В избранное».
 *
 * Живут здесь, а не в самой карточке, потому что нужны в трёх местах: в сетке
 * каталога, на странице товара и в подборках — иначе логика «добавить»
 * разъехалась бы по файлам.
 *
 * Обе кнопки работают через браузерный `apiFetch`, а не через форму: карточка
 * не должна уводить со страницы, а серверный `serverFetch` в компоненте во
 * время SSR не выполняется. Ответ сервера целиком заменяет состояние стора —
 * счётчик в шапке меняется без перезагрузки.
 */

type ActionPhase = "idle" | "busy" | "done";

/**
 * Гость без корзины остаться не должен, но избранное у него недоступно
 * (`/favorites` отвечает 401). Поэтому 401 означает «войдите», и мы уводим на
 * /login с обратным адресом — терять контекст страницы незачем.
 */
function requireAuth(cause: unknown): null {
  if (cause instanceof ApiError && cause.status === 401) {
    if (typeof window !== "undefined") {
      const back = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.assign(`/login?back=${back}`);
    }
    return null;
  }
  throw cause;
}

export type AddToCartButtonProps = {
  productId: string;
  /** Нужен в подписи кнопки для скринридера: «В корзину» без товара непонятно. */
  productName: string;
  /** Товара нет в наличии — добавлять нечего, кнопка блокируется. */
  disabled?: boolean;
  compact?: boolean;
  className?: string;
};

export function AddToCartButton({
  productId,
  productName,
  disabled = false,
  compact = false,
  className,
}: AddToCartButtonProps) {
  const addItem = useCartStore((state) => state.addItem);
  const [phase, setPhase] = useState<ActionPhase>("idle");
  const [message, setMessage] = useState<string | null>(null);

  const handleClick = async () => {
    if (phase === "busy") return;
    setPhase("busy");
    setMessage(null);
    try {
      const cart = await addItem(productId, 1);
      setPhase("done");
      setMessage(
        cart.notices.length > 0
          ? cart.notices[0]?.message ?? "Добавлено с ограничением по остатку"
          : "Товар добавлен в корзину",
      );
    } catch (cause) {
      if (requireAuth(cause)) return;
      setPhase("idle");
      setMessage(normalizeError(cause).message);
    }
  };

  return (
    <div className={className}>
      <button
        type="button"
        onClick={handleClick}
        disabled={disabled || phase === "busy"}
        aria-label={`В корзину: ${productName}`}
        className={
          compact
            ? "flex w-full items-center justify-center gap-1 rounded-lg bg-pulse-600 px-2 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-pulse-700 disabled:cursor-not-allowed disabled:bg-slate-300"
            : "flex w-full items-center justify-center gap-1.5 rounded-xl bg-pulse-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-pulse-700 disabled:cursor-not-allowed disabled:bg-slate-300"
        }
      >
        {disabled ? "Нет в наличии" : phase === "busy" ? "Добавляем…" : "В корзину"}
      </button>
      {/* Статус сюда, а не в заголовок кнопки: иначе он перескакивал бы при
          каждом добавлении и мешал тем, кто читает только подпись. */}
      <p role="status" aria-live="polite" className="sr-only">
        {message}
      </p>
      {message && !compact ? (
        <p
          role="status"
          className={`mt-1.5 text-xs leading-snug ${phase === "done" ? "text-emerald-700" : "text-rose-600"}`}
        >
          {message}
        </p>
      ) : null}
    </div>
  );
}

export type FavoriteButtonProps = {
  productId: string;
  productName: string;
  compact?: boolean;
  className?: string;
};

export function FavoriteButton({ productId, productName, compact = false, className }: FavoriteButtonProps) {
  const ids = useFavoritesStore((state) => state.ids);
  const toggle = useFavoritesStore((state) => state.toggle);
  const isFavorite = ids.includes(productId);
  const [busy, setBusy] = useState(false);

  const handleClick = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await toggle(productId);
    } catch (cause) {
      requireAuth(cause);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={busy}
      // aria-pressed, а не только цвет: иначе состояние «в избранном» для
      // скринридера и голосового ввода не читается вообще.
      aria-pressed={isFavorite}
      aria-label={isFavorite ? `Убрать из избранного: ${productName}` : `В избранное: ${productName}`}
      className={[
        compact
          ? "flex w-full items-center justify-center rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-slate-600 transition-colors hover:border-pulse-400 hover:text-pulse-700 disabled:opacity-60"
          : "flex w-full items-center justify-center rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition-colors hover:border-pulse-400 hover:text-pulse-700 disabled:opacity-60",
        className ?? "",
      ].join(" ")}
    >
      <HeartIcon filled={isFavorite} />
      {!compact ? <span>{isFavorite ? "В избранном" : "В избранное"}</span> : null}
    </button>
  );
}

function HeartIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={`h-4 w-4 ${filled ? "fill-rose-600 text-rose-600" : "fill-none text-current"}`}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20.8 6.6a5 5 0 00-7.1 0L12 8.3l-1.7-1.7a5 5 0 10-7.1 7.1L12 22l8.8-8.3a5 5 0 000-7.1z" />
    </svg>
  );
}

/**
 * Подпись под кнопкой «В корзину» для товара вне наличия: по ТЗ сначала
 * честно говорим, что произойдёт, и только потом предлагаем действие.
 */
export function unavailableHint(availability: keyof typeof AVAILABILITY_LABEL): string | null {
  if (availability === "in_stock" || availability === "low_stock") return null;
  return `Товар недоступен: ${AVAILABILITY_LABEL[availability].toLowerCase()}.`;
}