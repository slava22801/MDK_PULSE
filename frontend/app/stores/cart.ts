/**
 * Стор корзины — КЭШ ответа сервера, а не источник правды.
 *
 * Корзина живёт на backend-е: у гостя она опознаётся cookie `pulse_cart`,
 * у авторизованного — привязана к аккаунту. Поэтому правило простое: любая
 * мутация возвращает полный `CartOut`, и он целиком заменяет состояние стора.
 * Никакого слияния локальных правок — это гарантирует, что счётчик в шапке и
 * страница /cart всегда показывают одно и то же.
 *
 * Слияние гостевой корзины с корзиной аккаунта делает сам backend при входе
 * (`POST /auth/login` возвращает `merged_cart` — раздел 5.8 ТЗ). Фронтенд после
 * входа перезагружает страницу, поэтому корневой loader и loader /cart
 * подхватывают уже слитую корзину — вручную ничего переносить не нужно.
 */
import { create } from "zustand";

import type { Cart } from "~/lib/cart";
import { emptyCart } from "~/lib/cart";
import { apiFetch } from "~/lib/api-browser";
import { normalizeError } from "~/lib/auth";

type CartStatus = "idle" | "loading" | "ready" | "error";

type CartState = {
  cart: Cart;
  status: CartStatus;
  error: string | null;

  /** Принять ответ loader'а: страница остаётся источником правды при SSR. */
  hydrate: (cart: Cart) => void;
  /**
   * Принять только счётчик из корневого loader'а.
   *
   * Корневой loader смотрит `/cart` ради числа в шапке и не отдаёт его в
   * компоненты; полную корзину приносит loader той страницы, которая её
   * показывает. Счётчик нужен сразу после гидратации, чтобы шапка не мигала
   * нулём, а список позиций при этом остаётся пустым и честным.
   */
  seedCount: (count: number) => void;
  /**
   * Добавить товар. Единственная мутация, которая нужна вне action'а страницы:
   * карточка товара — не форма, и её кнопка работает через браузерный apiFetch.
   */
  addItem: (productId: string, quantity?: number) => Promise<Cart>;
};

/**
 * Общая часть мутаций: пометка «загрузка», замена состояния ответом сервера
 * и единообразная ошибка. Ошибку отдаём наружу (вызывающий покажет её рядом с
 * кнопкой) и кладём в стор — чтобы шапка могла её тоже увидеть.
 */
async function mutate(
  set: (partial: Partial<CartState>) => void,
  run: () => Promise<Cart>,
): Promise<Cart> {
  set({ status: "loading", error: null });
  try {
    const cart = await run();
    set({ cart, status: "ready", error: null });
    return cart;
  } catch (cause) {
    set({ status: "error", error: normalizeError(cause).message });
    throw cause;
  }
}

export const useCartStore = create<CartState>()((set) => ({
  cart: emptyCart(),
  status: "idle",
  error: null,

  hydrate: (cart) => set({ cart, status: "ready", error: null }),

  seedCount: (count) =>
    set((state) => ({ cart: { ...state.cart, totals: { ...state.cart.totals, items_count: count } } })),

  addItem: async (productId, quantity = 1) =>
    mutate(set, () =>
      apiFetch<Cart>("/cart/items", {
        method: "POST",
        json: { product_id: productId, quantity },
      }),
    ),
}));