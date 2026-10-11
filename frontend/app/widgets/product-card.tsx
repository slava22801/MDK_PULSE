import type { ProductCard as ProductCardData } from "~/lib/catalog";
import { AVAILABILITY_LABEL, categoryTone, productInitials } from "~/lib/catalog";
import { formatPrice, plural } from "~/lib/format";
import { ChartColumn, Star } from "~/widgets/icons";
import { AddToCartButton, FavoriteButton } from "~/widgets/product-actions";

/**
 * Карточка товара для сетки каталога и витрины.
 *
 * Разметка повторяет карточку макета: метка скидки и действия поверх
 * фотографии, затем бренд, название, характеристики, рейтинг, цена, наличие
 * и кнопка «В корзину» на всю ширину.
 *
 * Ссылки здесь — обычные `<a>`, а не `<Link>`: loader-ы страниц ходят в
 * backend через serverFetch, и полная перезагрузка гарантирует, что такой
 * loader выполнится на сервере, где доступен `API_INTERNAL_URL`
 * (та же осторожность, что в site-header).
 */

type Tone = { text: string; dot: string };

const AVAILABILITY_TONE: Record<ProductCardData["availability"], Tone> = {
  in_stock: { text: "text-brand-ink", dot: "bg-pulse-600" },
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

export function RatingRow({ product }: { product: ProductCardData }) {
  const stars = filledStars(product.rating_avg);
  const rating = Number.parseFloat(product.rating_avg);

  return (
    <div className="flex items-center gap-1.5">
      <Star className="h-3.5 w-3.5 shrink-0 fill-pulse-600 text-pulse-600" strokeWidth={0} />
      <span className="text-[0.8125rem] font-semibold text-slate-900">
        {Number.isFinite(rating) ? rating.toFixed(1).replace(".", ",") : "—"}
      </span>
      <span className="text-xs text-slate-600">
        <span className="sr-only"> из 5, </span>
        {product.rating_count > 0
          ? `${product.rating_count} ${plural(product.rating_count, "отзыв", "отзыва", "отзывов")}`
          : "нет отзывов"}
      </span>
      {/* Скрытый ряд звёзд держит прежнюю точность оценки для скринридера. */}
      <span className="sr-only">{`Рейтинг ${Number.isFinite(rating) ? rating.toFixed(2).replace(".", ",") : "—"} из 5, закрашено звёзд: ${stars}`}</span>
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
    <span className={`inline-flex items-center gap-1.5 text-[0.6875rem] font-medium ${tone.text} ${className ?? ""}`}>
      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} />
      {AVAILABILITY_LABEL[availability]}
      {lowStock ? (
        <span className="text-slate-600">
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
  const box = size === "hero" ? "aspect-square" : "h-40";

  if (product.image_url) {
    return (
      <img
        src={product.image_url}
        alt={product.image_alt ?? product.name}
        loading="lazy"
        decoding="async"
        className={`${box} w-full rounded-control object-cover ${className ?? ""}`}
      />
    );
  }

  const tone = categoryTone(product.category);

  return (
    <div
      role="img"
      aria-label={`Изображение товара: ${product.name}`}
      className={`${box} flex w-full items-center justify-center rounded-control bg-gradient-to-br ${tone.from} ${tone.to} ${
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
      className={`group relative flex h-full flex-col overflow-hidden rounded-card border border-slate-200 bg-white transition-shadow hover:shadow-card-hover ${
        className ?? ""
      }`}
    >
      {/* Ссылка не оборачивает кнопки: кнопка внутри <a> — невалидный HTML и
          ломает переход по карточке, поэтому действия живут отдельным слоем. */}
      <a
        href={`/product/${product.slug}`}
        className="flex flex-1 flex-col gap-2.5 p-4 focus-visible:outline-offset-4"
      >
        <div className="relative">
          <ProductImageFrame product={product} />

          {hasDiscount ? (
            <span className="absolute top-3 left-3 rounded-badge bg-brand-tint px-2 py-[3px] text-[0.6875rem] font-semibold text-pulse-600">
              −{product.discount_percent}%
            </span>
          ) : null}
        </div>

        {product.brand ? (
          <p className="text-[0.6875rem] font-bold text-slate-600">{product.brand.name}</p>
        ) : (
          <p className="text-[0.6875rem] font-bold text-slate-400">Без бренда</p>
        )}

        <h3
          className={`line-clamp-2 font-semibold text-slate-900 group-hover:text-pulse-700 ${
            compact ? "text-sm leading-[1.35]" : "text-[0.9375rem] leading-[1.4667em]"
          }`}
        >
          {product.name}
        </h3>

        <RatingRow product={product} />

        <div className="mt-auto flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 pt-1">
          <span className="text-2xl font-bold text-slate-900">{formatPrice(product.price)}</span>
          {hasDiscount ? (
            <span className="text-xs text-slate-600 line-through">
              {formatPrice(product.old_price)}
            </span>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.6875rem]">
          <AvailabilityBadge
            availability={product.availability}
            quantity={product.available_quantity}
          />
          <span className="text-slate-600">{warrantyLabel(product.warranty_months)}</span>
        </div>
      </a>

      {/* Действия лежат поверх фотографии отдельным слоем: вложить их в ссылку
          нельзя, а накрыть ссылкой — значит сделать их некликабельными. */}
      <div className="absolute top-3 right-3 flex items-center gap-3">
        <FavoriteButton productId={product.id} productName={product.name} iconOnly />
        <a
          href="/compare"
          aria-label={`Сравнить: ${product.name}`}
          className="flex h-9 w-9 items-center justify-center rounded-pill bg-white/90 text-slate-600 backdrop-blur transition-colors hover:bg-white hover:text-pulse-600"
        >
          <ChartColumn className="h-[1.125rem] w-[1.125rem]" />
        </a>
      </div>

      <div className="px-4 pb-4">
        <AddToCartButton
          productId={product.id}
          productName={product.name}
          // Под заказ и «ожидается» оформляются отдельно, а снятый с продажи
          // товар добавлять бессмысленно — поэтому кнопка гасится заранее.
          disabled={product.availability === "discontinued" || product.availability === "out_of_stock"}
          compact={compact}
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
          ? `grid grid-cols-2 gap-4 sm:grid-cols-4 ${className ?? ""}`
          : `grid grid-cols-2 gap-4 sm:grid-cols-2 xl:grid-cols-3 ${className ?? ""}`
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
    <div
      className="overflow-hidden rounded-card border border-slate-200 bg-white"
      aria-hidden="true"
    >
      <div className={`skeleton rounded-none ${size === "xs" ? "h-40" : "h-40"}`} />
      <div className="space-y-2 p-4">
        <div className="skeleton h-3 w-1/3" />
        <div className="skeleton h-4 w-full" />
        <div className="skeleton h-4 w-2/3" />
        <div className="skeleton h-6 w-1/2" />
        <div className="skeleton h-11 w-full" />
      </div>
    </div>
  );
}

export function ProductGridSkeleton({ count = 8, size = "sm" }: { count?: number; size?: "sm" | "xs" }) {
  return (
    <div
      className={
        size === "xs"
          ? "grid grid-cols-2 gap-4 sm:grid-cols-4"
          : "grid grid-cols-2 gap-4 sm:grid-cols-2 xl:grid-cols-3"
      }
    >
      {Array.from({ length: count }, (_, index) => (
        <ProductCardSkeleton key={index} size={size} />
      ))}
    </div>
  );
}