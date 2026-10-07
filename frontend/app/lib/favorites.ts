/**
 * Контракт избранного.
 *
 * Отдельный модуль от `~/lib/cart`, потому что избранное — не гостевая
 * сущность: `/favorites` отвечает 401 анониму, и типы нужны в трёх местах
 * (корневой loader со счётчиком, страница избранного и виджет кнопки).
 *
 * Как и `~/lib/cart`, модуль изоморфный: только типы, без хуков и fetch.
 */
import type { ProductCard } from "./catalog";

/**
 * Позиция избранного — карточка товара плюс сигналы, ради которых её
 * вообще держат в избранном: изменилась цена или товар вернулся в наличие.
 */
export type FavoriteItem = ProductCard & {
  price_changed: boolean;
  /** Разница с ценой на момент добавления. Минус — подешевел. */
  price_delta: string | null;
  back_in_stock: boolean;
  added_at: string;
};

export type FavoritesOut = {
  items: FavoriteItem[];
  total: number;
  /** Сколько позиций требуют внимания (изменилась цена или вернулся товар). */
  attention_count: number;
};

/** Ответ на добавление или удаление избранного. */
export type FavoriteToggleOut = {
  product_id: string;
  is_favorite: boolean;
  total: number;
};

/**
 * Знак изменения цены: минус — подешевел, плюс — подорожал.
 *
 * Считаем сами из строки `price_delta`, потому что backend отдаёт её
 * беззнаковой строкой Decimal, а пользователю нужен явный смысл.
 */
export function priceDeltaLabel(delta: string | null): { text: string; tone: "down" | "up" } | null {
  if (delta === null) return null;
  const value = Number.parseFloat(delta);
  if (!Number.isFinite(value) || value === 0) return null;
  return { text: value < 0 ? `−${formatDelta(Math.abs(value))}` : `+${formatDelta(value)}`, tone: value < 0 ? "down" : "up" };
}

function formatDelta(value: number): string {
  return `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(value)} ₽`;
}