/**
 * Типы каталога и работа с query-строкой фильтров.
 *
 * Модуль общий для loader'ов и виджетов, поэтому здесь нет ни serverFetch,
 * ни хуков: только чистые функции. Так один и тот же разбор URL используется
 * и на сервере (loader), и в браузере (панель фильтров), и расхождение
 * «что показано» / «что отправлено» исключено.
 *
 * Имя файла намеренно без суффикса `.client`: такой суффикс вырезает модуль
 * из серверного бандла, и loader получил бы undefined вместо функции.
 */

import { formatPrice } from "./format";

/* ─────────────────────────── типы ответа API ─────────────────────────── */

/** Статус наличия. Список совпадает с `product_status` на backend-е. */
export type Availability =
  | "in_stock"
  | "low_stock"
  | "on_order"
  | "expected"
  | "out_of_stock"
  | "discontinued";

export const AVAILABILITY_LABEL: Record<Availability, string> = {
  in_stock: "В наличии",
  low_stock: "Осталось мало",
  on_order: "Под заказ",
  expected: "Ожидается",
  out_of_stock: "Нет в наличии",
  discontinued: "Снят с производства",
};

export type CategoryNode = {
  id: string;
  name: string;
  slug: string;
  level: number;
  parent_id: string | null;
  image_url: string | null;
  children: CategoryNode[];
};

export type BrandRef = {
  id: string;
  name: string;
  slug: string;
  logo_url: string | null;
};

export type BrandOut = BrandRef & {
  description: string | null;
};

/**
 * Карточка товара для сетки каталога.
 *
 * Денежные поля — строки: на backend-е это `Decimal`, и во float его
 * превращать нельзя. Форматирует их `formatPrice`.
 */
export type ProductCard = {
  id: string;
  slug: string;
  name: string;
  sku: string | null;
  brand: BrandRef | null;
  category: CategoryNode;
  price: string;
  old_price: string | null;
  discount_percent: number;
  currency: string;
  image_url: string | null;
  image_alt: string | null;
  availability: Availability;
  available_quantity: number;
  in_stock: boolean;
  rating_avg: string;
  rating_count: number;
  warranty_months: number;
};

export type ProductImage = {
  id: string;
  image_url: string;
  alt: string | null;
  sort_order: number;
  is_main: boolean;
};

export type ProductSpec = {
  key: string;
  name: string;
  value: string;
  unit: string | null;
  data_type: string;
  sort_order: number;
};

/** `purchase_price` приходит только сотруднику, гостю — всегда null. */
export type ProductDetail = ProductCard & {
  short_description: string | null;
  description: string | null;
  images: ProductImage[];
  specs: ProductSpec[];
  purchase_price: string | null;
};

export type FacetValue = {
  value: string;
  label: string | null;
  count: number;
};

export type FacetBrand = {
  slug: string;
  name: string;
  count: number;
};

export type FacetPrice = {
  min: string | null;
  max: string | null;
};

export type FacetAttribute = {
  key: string;
  name: string;
  data_type: "text" | "number" | "bool" | "enum";
  unit: string | null;
  widget: "range" | "checkbox" | "select" | "slider" | null;
  options: FacetValue[] | null;
  is_filterable: boolean;
  is_comparable: boolean;
  min: string | null;
  max: string | null;
  values: FacetValue[];
};

export type Facets = {
  brands: FacetBrand[];
  price: FacetPrice;
  availability: FacetValue[];
  attributes: FacetAttribute[];
};

export type ProductList = {
  items: ProductCard[];
  total: number;
  page: number;
  limit: number;
  pages: number;
  facets: Facets;
};

export type CategoryResponse = {
  category: CategoryNode;
  parent: CategoryNode | null;
  breadcrumb: CategoryNode[];
  products: ProductList;
};

export type SearchResponse = {
  products: ProductCard[];
  categories: CategoryNode[];
  brands: BrandOut[];
  suggestions: string[];
};

export type HomeBanner = {
  id: string;
  title: string;
  subtitle: string | null;
  image_url: string | null;
  link_url: string | null;
  button_text: string | null;
};

export type HomeResponse = {
  banners: HomeBanner[];
  categories: CategoryNode[];
  recommended: ProductCard[];
  discounted: ProductCard[];
  newest: ProductCard[];
  generated_at: string;
};

export type SortKey = "popular" | "price_asc" | "price_desc" | "rating" | "newest" | "discount";

/** Подписи сортировки приходят с backend: язык магазина задаётся там. */
export type SortOptions = Record<SortKey, string>;

export const SORT_KEYS: readonly SortKey[] = [
  "popular",
  "price_asc",
  "price_desc",
  "rating",
  "newest",
  "discount",
];

/** Подстановка, если `/sort-options` недоступен: страница не должна падать из-за подписей. */
export const FALLBACK_SORT_OPTIONS: SortOptions = {
  popular: "по популярности",
  price_asc: "сначала дешёвые",
  price_desc: "сначала дорогие",
  rating: "по рейтингу",
  newest: "по новизне",
  discount: "по размеру скидки",
};

const SORT_SET: ReadonlySet<string> = new Set<string>(SORT_KEYS);

export function parseSort(raw: string | null): SortKey {
  return raw !== null && SORT_SET.has(raw) ? (raw as SortKey) : "popular";
}

/* ─────────────────────── состояние фильтров в URL ────────────────────── */

export type AttributeRange = { min: string; max: string };

/**
 * Разобранная query-строка каталога.
 *
 * Пустая строка означает «фильтр не задан»: так его нельзя случайно отправить
 * как 0, что на backend-е отсекло бы товары дешевле нуля.
 */
export type FilterSelection = {
  q: string;
  category: string | null;
  brand: string | null;
  priceMin: string;
  priceMax: string;
  inStock: boolean | null;
  hasDiscount: boolean | null;
  minRating: string;
  warranty: number[];
  /** `attr.<key>` → выбранные значения (множественный выбор). */
  attributes: Record<string, string[]>;
  /** `attr.<key>.min` / `attr.<key>.max`. */
  attributeRanges: Record<string, AttributeRange>;
  sort: SortKey;
  page: number;
  limit: number;
};

const ATTR_PREFIX = "attr.";
const RANGE_SUFFIX = ".min";

function parseBooleanParam(raw: string | null): boolean | null {
  if (raw === "true") return true;
  if (raw === "false") return false;
  return null;
}

function parsePositiveInt(raw: string | null, fallback: number): number {
  const value = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * URL → состояние фильтров. Обратная операция к `buildProductQuery`:
 * вместе они гарантируют, что форма показывает ровно то, что уходит на сервер.
 */
export function parseFilters(search: URLSearchParams, defaults?: { category?: string | null }): FilterSelection {
  const attributes: Record<string, string[]> = {};
  const attributeRanges: Record<string, AttributeRange> = {};

  // URLSearchParams итерируется с повторами, поэтому множественный выбор
  // (`attr.cpu.socket=AM5&attr.cpu.socket=LGA1700`) собирается в цикле.
  for (const [rawKey, rawValue] of search) {
    if (!rawKey.startsWith(ATTR_PREFIX)) continue;
    const body = rawKey.slice(ATTR_PREFIX.length);
    if (!body) continue;

    if (body.endsWith(RANGE_SUFFIX) || body.endsWith(".max")) {
      const key = body.slice(0, body.lastIndexOf("."));
      if (!key) continue;
      const range = attributeRanges[key] ?? { min: "", max: "" };
      if (body.endsWith(RANGE_SUFFIX)) range.min = rawValue;
      else range.max = rawValue;
      attributeRanges[key] = range;
      continue;
    }

    const bucket = attributes[body] ?? [];
    if (rawValue) bucket.push(rawValue);
    attributes[body] = bucket;
  }

  const warranty: number[] = [];
  for (const raw of search.getAll("warranty")) {
    const months = Number.parseInt(raw, 10);
    if (Number.isFinite(months) && months > 0 && !warranty.includes(months)) warranty.push(months);
  }
  warranty.sort((a, b) => a - b);

  return {
    q: (search.get("q") ?? "").trim(),
    category: search.get("category") ?? defaults?.category ?? null,
    brand: search.get("brand"),
    priceMin: search.get("min_price") ?? "",
    priceMax: search.get("max_price") ?? "",
    inStock: parseBooleanParam(search.get("in_stock")),
    hasDiscount: parseBooleanParam(search.get("has_discount")),
    minRating: search.get("min_rating") ?? "",
    warranty,
    attributes,
    attributeRanges,
    sort: parseSort(search.get("sort")),
    page: parsePositiveInt(search.get("page"), 1),
    limit: parsePositiveInt(search.get("limit"), 24),
  };
}

/** Состояние фильтров → query-строка для запроса к `/products`. */
export function buildProductQuery(selection: FilterSelection): string {
  const search = new URLSearchParams();

  if (selection.q) search.set("q", selection.q);
  if (selection.category) search.set("category", selection.category);
  if (selection.brand) search.set("brand", selection.brand);
  if (selection.priceMin) search.set("min_price", selection.priceMin);
  if (selection.priceMax) search.set("max_price", selection.priceMax);
  if (selection.inStock !== null) search.set("in_stock", String(selection.inStock));
  if (selection.hasDiscount !== null) search.set("has_discount", String(selection.hasDiscount));
  if (selection.minRating) search.set("min_rating", selection.minRating);
  for (const months of selection.warranty) search.append("warranty", String(months));

  for (const [key, values] of Object.entries(selection.attributes)) {
    for (const value of values) search.append(`${ATTR_PREFIX}${key}`, value);
  }
  for (const [key, range] of Object.entries(selection.attributeRanges)) {
    if (range.min) search.set(`${ATTR_PREFIX}${key}.min`, range.min);
    if (range.max) search.set(`${ATTR_PREFIX}${key}.max`, range.max);
  }

  search.set("sort", selection.sort);
  search.set("page", String(selection.page));
  search.set("limit", String(selection.limit));

  return search.toString();
}

/** Изменение одного фильтра поверх текущего URL. Страница всегда сбрасывается на 1. */
export type FilterPatch =
  | { kind: "brand"; value: string | null }
  | { kind: "price"; min: string; max: string }
  | { kind: "inStock"; value: boolean | null }
  | { kind: "hasDiscount"; value: boolean | null }
  | { kind: "minRating"; value: string }
  | { kind: "warranty"; value: number | null }
  | { kind: "attributeValue"; key: string; value: string; selected: boolean }
  /** Виджет `select`: значение одно, поэтому заменяет весь набор по ключу. */
  | { kind: "attributeSelect"; key: string; value: string | null }
  | { kind: "attributeRange"; key: string; min: string; max: string }
  | { kind: "sort"; value: SortKey };

function setOrDelete(search: URLSearchParams, name: string, value: string): void {
  if (value) search.set(name, value);
  else search.delete(name);
}

export function applyPatch(source: URLSearchParams, patch: FilterPatch): URLSearchParams {
  const next = new URLSearchParams(source);

  switch (patch.kind) {
    case "brand":
      setOrDelete(next, "brand", patch.value ?? "");
      break;
    case "price":
      setOrDelete(next, "min_price", patch.min);
      setOrDelete(next, "max_price", patch.max);
      break;
    case "inStock":
      setOrDelete(next, "in_stock", patch.value === null ? "" : String(patch.value));
      break;
    case "hasDiscount":
      setOrDelete(next, "has_discount", patch.value === null ? "" : String(patch.value));
      break;
    case "minRating":
      setOrDelete(next, "min_rating", patch.value);
      break;
    case "warranty":
      next.delete("warranty");
      if (patch.value !== null) next.append("warranty", String(patch.value));
      break;
    case "attributeValue": {
      const name = `${ATTR_PREFIX}${patch.key}`;
      const current = next.getAll(name).filter((item) => item !== patch.value);
      next.delete(name);
      // Выбранное значение держим в конце списка — так порядок в URL стабилен
      // и ссылку можно копировать без «прыгающего» набора параметров.
      if (patch.selected) current.push(patch.value);
      for (const value of current) next.append(name, value);
      break;
    }
    case "attributeSelect": {
      const name = `${ATTR_PREFIX}${patch.key}`;
      next.delete(name);
      if (patch.value !== null) next.append(name, patch.value);
      break;
    }
    case "attributeRange":
      setOrDelete(next, `${ATTR_PREFIX}${patch.key}.min`, patch.min);
      setOrDelete(next, `${ATTR_PREFIX}${patch.key}.max`, patch.max);
      break;
    case "sort":
      next.set("sort", patch.value);
      break;
  }

  // Любое изменение фильтра означает другой набор товаров — с первой страницы.
  next.delete("page");
  return next;
}

/** Ссылка на конкретную страницу пагинации со всеми фильтрами на месте. */
export function pageHref(pathname: string, source: URLSearchParams, page: number): string {
  const next = new URLSearchParams(source);
  if (page <= 1) next.delete("page");
  else next.set("page", String(page));
  const query = next.toString();
  return query ? `${pathname}?${query}` : pathname;
}

/** Сколько фильтров активно — для счётчика на мобильной кнопке «Фильтры». */
export function activeFilterCount(selection: FilterSelection): number {
  let count = 0;
  if (selection.brand) count += 1;
  if (selection.priceMin || selection.priceMax) count += 1;
  if (selection.inStock !== null) count += 1;
  if (selection.hasDiscount !== null) count += 1;
  if (selection.minRating) count += 1;
  count += selection.warranty.length;
  for (const values of Object.values(selection.attributes)) {
    count += values.length;
  }
  for (const range of Object.values(selection.attributeRanges)) {
    if (range.min || range.max) count += 1;
  }
  return count;
}

/* ───────────────────── разбор facets в виджеты формы ──────────────────── */

export type RangeFacet = {
  key: string;
  name: string;
  unit: string | null;
  min: string | null;
  max: string | null;
};

export type ChoiceFacet = {
  key: string;
  name: string;
  unit: string | null;
  widget: "checkbox" | "select";
  options: FacetValue[];
};

export type ParsedFacets = {
  ranges: RangeFacet[];
  choices: ChoiceFacet[];
};

/** Границы числового диапазона: `min`/`max`, а если их нет — крайние `values`. */
function numericBounds(attribute: FacetAttribute): { min: string | null; max: string | null } {
  if (attribute.min !== null || attribute.max !== null) {
    return { min: attribute.min, max: attribute.max };
  }

  let low: number | null = null;
  let high: number | null = null;
  for (const value of attribute.values) {
    const parsed = Number.parseFloat(value.value);
    if (!Number.isFinite(parsed)) continue;
    low = low === null ? parsed : Math.min(low, parsed);
    high = high === null ? parsed : Math.max(high, parsed);
  }

  return { min: low === null ? null : String(low), max: high === null ? null : String(high) };
}

/**
 * Facets → виджеты формы.
 *
 * Форма строится целиком из ответа backend-а: новый фильтр появляется
 * в справочнике характеристик и работает без правок фронтенда.
 *
 * Числовые характеристики всегда рисуются диапазоном «от … до …», даже если
 * backend объявил для них widget: select. Проверено живым запросом: отбор
 * по точному значению числовой характеристики (attr.gpu.memory_size=24)
 * возвращает пустую выдачу, тогда как attr.gpu.memory_size.min / .max
 * отбирает товары верно. «Мёртвый» фильтр, всегда дающий ноль товаров,
 * хуже отсутствующего — поэтому для чисел берём рабочий путь.
 */
export function parseFacets(facets: Facets): ParsedFacets {
  const ranges: RangeFacet[] = [];
  const choices: ChoiceFacet[] = [];

  for (const attribute of facets.attributes) {
    if (!attribute.is_filterable) continue;

    // Тип важнее объявленного виджета: число фильтруется только границами,
    // поэтому числовые характеристики рисуются «от … до …» при любом виджете.
    if (attribute.data_type === "number") {
      const bounds = numericBounds(attribute);
      if (bounds.min === null && bounds.max === null) continue;
      ranges.push({
        key: attribute.key,
        name: attribute.name,
        unit: attribute.unit,
        min: bounds.min,
        max: bounds.max,
      });
      continue;
    }

    if (attribute.widget === "range" || attribute.widget === "slider") {
      ranges.push({
        key: attribute.key,
        name: attribute.name,
        unit: attribute.unit,
        min: attribute.min,
        max: attribute.max,
      });
      continue;
    }

    if (attribute.widget === "checkbox" || attribute.widget === "select") {
      // `values` — то, что посчитал backend под текущий запрос; `options` —
      // справочник целиком. Значения с товарами есть только в values.
      const options = attribute.values.length > 0 ? attribute.values : (attribute.options ?? []);
      if (options.length === 0) continue;
      choices.push({
        key: attribute.key,
        name: attribute.name,
        unit: attribute.unit,
        widget: attribute.widget,
        options,
      });
    }
  }

  return { ranges, choices };
}

/** Подпись значения фасета: сервер может прислать готовый label, а может нет. */
export function facetOptionLabel(option: FacetValue): string {
  return option.label ?? option.value;
}

/* ─────────────────────────── форматирование ──────────────────────────── */

/** Границы цены из фасета: строки приходят с backend, показываем в рублях. */
export function formatPriceBound(value: string | null): string {
  return value ? formatPrice(value) : "—";
}

/** Человеческое число для полей ввода: `12490.00` → `12490`. */
export function toInputNumber(value: string | null): string {
  if (!value) return "";
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? String(parsed) : "";
}

/**
 * Тон карточки по категории товара.
 *
 * У сид-товаров `image_url` ещё null, поэтому заглушка не может быть одной
 * серой: оттенок подбирается по категории, и сетка остаётся читаемой.
 * Классы заданы литералами — Tailwind собирает только то, что видит в коде.
 */
const CATEGORY_TONES: ReadonlyArray<{ match: RegExp; from: string; to: string }> = [
  { match: /процессор|cpu/i, from: "from-slate-700", to: "to-slate-500" },
  { match: /видеокарт|gpu/i, from: "from-indigo-700", to: "to-indigo-500" },
  { match: /материнск|плата|mb/i, from: "from-teal-700", to: "to-teal-500" },
  { match: /памят|ram/i, from: "from-violet-700", to: "to-violet-500" },
  { match: /ssd|hdd|накопител|storage/i, from: "from-slate-600", to: "to-slate-400" },
  { match: /питани|psu|блок/i, from: "from-amber-700", to: "to-amber-500" },
  { match: /корпус|case/i, from: "from-zinc-700", to: "to-zinc-500" },
  { match: /охлажд|cooling|кулер/i, from: "from-cyan-700", to: "to-cyan-500" },
  { match: /монитор|display/i, from: "from-blue-700", to: "to-blue-500" },
  { match: /клавиатур|мыш|гарнитур|перифер/i, from: "from-rose-700", to: "to-rose-500" },
  { match: /кабел|аксессуар/i, from: "from-emerald-700", to: "to-emerald-500" },
];

export function categoryTone(category: Pick<CategoryNode, "name" | "slug">): {
  from: string;
  to: string;
} {
  const haystack = `${category.name} ${category.slug}`;
  for (const tone of CATEGORY_TONES) {
    if (tone.match.test(haystack)) return { from: tone.from, to: tone.to };
  }
  return { from: "from-slate-700", to: "to-slate-500" };
}

/** Инициалы для заглушки изображения. */
export function productInitials(name: string): string {
  const words = name.split(/[\s\-()]+/u).filter(Boolean);
  // Слова на буквах полезнее слов на цифрах: из «Samsung 990 PRO» получается
  // «SP», а не «S9», и метка выглядит как марка, а не как артикул.
  const letters = words.filter((word) => /[\p{L}]/u.test(word));
  const source = letters.length > 0 ? letters : words;
  const first = source[0]?.[0] ?? "";
  const second = source[1]?.[0] ?? "";
  const initials = `${first}${second}`.toUpperCase();
  return initials || "PC";
}
