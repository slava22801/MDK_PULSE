import type { ProductCard as ProductCardData } from "~/lib/catalog";
import { AVAILABILITY_LABEL, categoryTone, productInitials } from "~/lib/catalog";
import { formatPrice, plural } from "~/lib/format";
import { AddToCartButton, FavoriteButton } from "~/widgets/product-actions";

/**
 * Карточка товара для сетки каталога и витрины.
 *
 * Ссылки здесь — обычные `<a>`, а не `<Link>`: loader-ы страниц ходят в
 * backend через serverFetch, и полная перезагрузка гарантирует, что такой
 * loader выполнится на сервере, где доступен `API_INTERNAL_URL`
 * (та же осторожность, что в site-header).
 */

type Tone = { text: string; dot: string };

const AVAILABILITY_TONE: Record<ProductCardData["availability"], Tone> = {
  in_stock: { text: "text-emerald-700", dot: "bg-emerald-500" },
  low_stock: { text: "text-amber-700", dot: "bg-amber-500" },
  on_order: { text: "text-sky-700", dot: "bg-sky-500" },
  expected: { text: "text-violet-700", dot: "bg-violet-500" },
  out_of_stock: { text: "text-rose-700", dot: "bg-rose-500" },
  discontinued: { text: "text-slate-500", dot: "bg-slate-400" },
};

function warrantyLabel(months: number): string {
  return `Гарантия ${months} ${plural(months, "месяц", "месяца", "месяцев")}`;
}

/** Число рейтинга из строки «4.90»: не-NaN округляем до целого для закраски звёзд. */
function filledStars(rating: string): number {
  const value = Number.parseFloat(rating);
  if (!Number.isFinite(value)) return 0;
  return Math.min(5, Math.max(0, Math.round(value)));
}

function Star({ filled }: { filled: boolean }) {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" className="h-3.5 w-3.5 shrink-0">
      <path
        d="M10 1.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8L10 14.9l-5.3 2.7 1-5.8L1.5 7.7l5.9-.9L10 1.5z"
        className={filled ? "fill-amber-400" : "fill-slate-200"}
      />
    </svg>
  );
}

export function RatingRow({ product }: { product: ProductCardData }) {
  const stars = filledStars(product.rating_avg);
  const rating = Number.parseFloat(product.rating_avg);

  return (
    <div className="flex items-center gap-1.5">
      <span className="flex items-center gap-0.5" aria-hidden="true">
        {Array.from({ length: 5 }, (_, index) => (
          <Star key={index} filled={index < stars} />
        ))}
      </span>
      {product.rating_count > 0 ? (
        <span className="text-xs text-slate-500">
          {Number.isFinite(rating) ? rating.toFixed(2).replace(".", ",") : "—"}
          <span className="sr-only"> из 5, </span>
          {product.rating_count}{" "}
          <span className="sr-only">отзывов</span>
          {plural(product.rating_count, "отзыв", "отзыва", "отзывов")}
        </span>
      ) : (
        <span className="text-xs text-slate-400">Нет отзывов</span>
      )}
    </div>
  );
}

type ProductImageFrameProps = {
  product: Pick<ProductCardData, "name" | "image_url" | "image_alt" | "category">;
  /** `card` — плитка в сетке, `hero` — главный кадр на странице товара. */
  size?: "card" | "hero";
  className?: string;
};

/** Статус наличия: цвет и текст одинаковы в карточке и на странице товара. */
export function AvailabilityBadge({
  availability,
  quantity,
  className,
}: {
  availability: ProductCardData["availability"];
  quantity?: number;
  className?: string;
}) {
  const tone = AVAILABILITY_TONE[availability];
  // Малое остаток показываем числом: «осталось 3 шт» полезнее слова «мало».
  const lowStock = availability === "low_stock" && quantity !== undefined && quantity > 0;

  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${tone.text} ${className ?? ""}`}>
      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} />
      {AVAILABILITY_LABEL[availability]}
      {lowStock ? (
        <span className="text-slate-500">
          — осталось {quantity} {plural(quantity, "шт.", "шт.", "шт.")}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Изображение товара с заглушкой.
 *
 * У сид-товаров `image_url` ещё null, поэтому вместо пустоты показываем
 * инициалы на фоне, подобранном по категории: сетка остаётся цветной и
 * карточки не «сливаются» в безликую ленту. Собственное изображение, когда
 * оно появится, заменит заглушку без изменения вёрстки.
 */
export function ProductImageFrame({ product, size = "card", className }: ProductImageFrameProps) {
  const box = size === "hero" ? "aspect-square" : "aspect-[4/3]";

  if (product.image_url) {
    return (
      <img
        src={product.image_url}
        alt={product.image_alt ?? product.name}
        loading="lazy"
        decoding="async"
        className={`${box} w-full object-contain ${className ?? ""}`}
      />
    );
  }

  const tone = categoryTone(product.category);

  return (
    <div
      role="img"
      aria-label={`Изображение товара: ${product.name}`}
      className={`${box} flex w-full items-center justify-center bg-gradient-to-br ${tone.from} ${tone.to} ${
        className ?? ""
      }`}
    >
      <span
        className={
          size === "hero"
            ? "text-6xl font-bold tracking-tight text-white/90"
            : "text-4xl font-bold tracking-tight text-white/90"
        }
      >
        {productInitials(product.name)}
      </span>
    </div>
  );
}

export type ProductCardTileProps = {
  product: ProductCardData;
  /** `sm` — в сетке каталога, `xs` — в горизонтальных лентах главной. */
  size?: "sm" | "xs";
  className?: string;
};

export function ProductCardTile({ product, size = "sm", className }: ProductCardTileProps) {
  const hasDiscount = product.discount_percent > 0 && product.old_price !== null;
  const compact = size === "xs";

  return (
    <article
      className={`card group flex h-full flex-col overflow-hidden transition-shadow hover:shadow-card-hover ${
        className ?? ""
      }`}
    >
      {/* Ссылка не оборачивает кнопки: кнопка внутри <a> — невалидный HTML и
          ломает переход по карточке, поэтому действия живут отдельной строкой. */}
      <a href={`/product/${product.slug}`} className="flex flex-1 flex-col focus-visible:outline-offset-4">
        <div className="relative bg-slate-100">
          <ProductImageFrame product={product} />
          {hasDiscount ? (
            <span className="absolute top-2 left-2 rounded-lg bg-rose-600 px-2 py-0.5 text-xs font-bold text-white">
              −{product.discount_percent}%
            </span>
          ) : null}
        </div>

        <div className={`flex flex-1 flex-col ${size === "xs" ? "gap-1 p-3" : "gap-1.5 p-3.5 sm:p-4"}`}>
          {product.brand ? (
            <p className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
              {product.brand.name}
            </p>
          ) : (
            <p className="text-xs font-semibold tracking-wide text-slate-400 uppercase">Без бренда</p>
          )}

          <h3
            className={`font-medium text-slate-900 group-hover:text-pulse-700 ${
              size === "xs" ? "line-clamp-2 text-sm" : "line-clamp-3 text-sm sm:text-[0.95rem]"
            }`}
          >
            {product.name}
          </h3>

          <RatingRow product={product} />

          <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span
              className={
                size === "xs"
                  ? "text-base font-bold text-slate-900"
                  : "text-lg font-bold text-slate-900 sm:text-xl"
              }
            >
              {formatPrice(product.price)}
            </span>
            {hasDiscount ? (
              <span className="text-sm text-slate-400 line-through">
                {formatPrice(product.old_price)}
              </span>
            ) : null}
          </div>

          <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 pt-2 text-xs">
            <AvailabilityBadge
              availability={product.availability}
              quantity={product.available_quantity}
            />
            <span className="text-slate-400">{warrantyLabel(product.warranty_months)}</span>
          </div>
        </div>
      </a>

      <div className={`flex gap-1.5 border-t border-slate-100 ${compact ? "p-2" : "p-3 sm:p-3.5"}`}>
        <AddToCartButton
          productId={product.id}
          productName={product.name}
          // Под заказ и «ожидается» оформляются отдельно, а снятый с продажи
          // товар добавлять бессмысленно — поэтому кнопка гасится заранее.
          disabled={product.availability === "discontinued" || product.availability === "out_of_stock"}
          compact={compact}
          className="min-w-0 flex-1"
        />
        <FavoriteButton
          productId={product.id}
          productName={product.name}
          compact={compact}
          className="shrink-0"
        />
      </div>
    </article>
  );
}

/**
 * Сетка товаров.
 *
 * `xs` — четыре колонки даже на узком экране: ленты главной показывают
 * по четыре компактные карточки и не должны превращаться в длинную колонку.
 */
export function ProductGrid({
  products,
  size = "sm",
  className,
}: {
  products: readonly ProductCardData[];
  size?: "sm" | "xs";
  className?: string;
}) {
  return (
    <div
      className={
        size === "xs"
          ? `grid grid-cols-2 gap-3 sm:grid-cols-4 ${className ?? ""}`
          : `grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4 ${className ?? ""}`
      }
    >
      {products.map((product) => (
        <ProductCardTile key={product.id} product={product} size={size} />
      ))}
    </div>
  );
}

/** Карточка-заглушка на время загрузки: та же сетка, чтобы контент не прыгал. */
export function ProductCardSkeleton({ size = "sm" }: { size?: "sm" | "xs" }) {
  return (
    <div className="card overflow-hidden" aria-hidden="true">
      <div className={`skeleton rounded-none ${size === "xs" ? "aspect-square" : "aspect-[4/3]"}`} />
      <div className={`space-y-2 ${size === "xs" ? "p-3" : "p-3.5 sm:p-4"}`}>
        <div className="skeleton h-3 w-1/3" />
        <div className="skeleton h-4 w-full" />
        <div className="skeleton h-4 w-2/3" />
        <div className="skeleton h-5 w-1/2" />
      </div>
    </div>
  );
}

export function ProductGridSkeleton({ count = 8, size = "sm" }: { count?: number; size?: "sm" | "xs" }) {
  return (
    <div
      className={
        size === "xs"
          ? "grid grid-cols-2 gap-3 sm:grid-cols-4"
          : "grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4"
      }
    >
      {Array.from({ length: count }, (_, index) => (
        <ProductCardSkeleton key={index} size={size} />
      ))}
    </div>
  );
}
