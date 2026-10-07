/**
 * Стор избранного: множество id товаров и переключение.
 *
 * В отличие от корзины избранное живёт не на cookie, а в аккаунте, поэтому
 * гостю хранить его негде — при 401 кнопка предлагает войти, а не молчит.
 *
 * Список id нужен виджету карточки, который рендерится в каталоге, в подборках
 * и на странице товара: без него сердечко всегда выглядело бы «не выбранным».
 * Наполняется он из корневого loader'а (см. `app/root.tsx`).
 */
import { create } from "zustand";

import type { FavoriteToggleOut } from "~/lib/favorites";
import { apiFetch } from "~/lib/api-browser";

type FavoritesState = {
  ids: string[];
  /** Принять набор id из loader'а (первый рендер и каждый переход). */
  sync: (ids: readonly string[]) => void;
  /** Переключить «в избранное». Возвращает итоговое состояние товара. */
  toggle: (productId: string) => Promise<boolean>;
};

export const useFavoritesStore = create<FavoritesState>()((set, get) => ({
  ids: [],

  sync: (ids) => set({ ids: [...ids] }),

  toggle: async (productId) => {
    const wasFavorite = get().ids.includes(productId);
    // Ответ сервера — единственный источник правды: оптимистичное обновление
    // без него оставило бы сердечко в состоянии, которого на сервере нет.
    const response = await apiFetch<FavoriteToggleOut>(`/favorites/${encodeURIComponent(productId)}`, {
      method: wasFavorite ? "DELETE" : "POST",
    });

    const ids = response.is_favorite
      ? [...get().ids, productId]
      : get().ids.filter((id) => id !== productId);
    set({ ids });
    return response.is_favorite;
  },
}));