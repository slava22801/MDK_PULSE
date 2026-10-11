import type { Route } from "./+types/home";
import { describeApiError } from "~/lib/api-error";
import { serverFetch } from "~/lib/api.server";
import type { CategoryNode, HomeResponse } from "~/lib/catalog";
import { readAccessToken } from "~/lib/auth-token";
import {
  ArrowRight,
  ArrowUpRight,
  Cable,
  Cpu,
  Fan,
  Gpu,
  HardDrive,
  Monitor,
  PcCase,
  Plus,
  Usb,
} from "~/widgets/icons";
import { ProductGrid } from "~/widgets/product-card";
import { SiteHeader } from "~/widgets/site-header";
import { SiteBenefits, SiteFooter } from "~/widgets/site-footer";

export function meta(): Route.MetaDescriptors {
  return [{ title: "ПУЛЬС — интернет-магазин компьютерных комплектующих" }];
}

/**
 * Главная страница.
 *
 * Данные — из `GET /home`: баннеры, дерево категорий и три подборки товаров,
 * которые backend считает сам. Считать их на фронте значило бы либо дублировать
 * логику сортировки, либо грузить весь каталог.
 *
 * Ошибка не бросается наружу, а возвращается в данных: витрина остаётся
 * navigable, а пользователь видит текст вместо белого экрана.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const authenticated = Boolean(readAccessToken(request));

  try {
    const data = await serverFetch<HomeResponse>("/home");
    return { ok: true as const, authenticated, data };
  } catch (cause) {
    return {
      ok: false as const,
      authenticated,
      error: describeApiError(cause, "Не удалось загрузить витрину"),
    };
  }
}

/** Заголовок раздела со ссылкой в правом углу — как в макете. */
function SectionHeader({
  title,
  eyebrow,
  href,
  linkLabel,
}: {
  title: string;
  eyebrow?: string;
  href: string;
  linkLabel: string;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="flex flex-col gap-1">
        {eyebrow ? <span className="eyebrow text-pulse-600">{eyebrow}</span> : null}
        <h2 className="section-title">{title}</h2>
      </div>
      <a
        href={href}
        className="inline-flex items-center gap-1.5 text-[0.9375rem] font-semibold text-pulse-600 transition-colors hover:text-pulse-700"
      >
        {linkLabel}
        <ArrowRight className="h-5 w-5" />
      </a>
    </div>
  );
}

/** Одна товарная полка: заголовок, ссылка и четыре карточки. */
function ProductShelf({
  title,
  eyebrow,
  products,
  href,
  linkLabel,
  className,
}: {
  title: string;
  eyebrow?: string;
  products: HomeResponse["recommended"];
  href: string;
  linkLabel: string;
  className?: string;
}) {
  if (products.length === 0) return null;

  return (
    <section className={className}>
      <SectionHeader title={title} eyebrow={eyebrow} href={href} linkLabel={linkLabel} />
      <ProductGrid products={products.slice(0, 4)} size="xs" className="mt-5" />
    </section>
  );
}

/** Иконка для небольшой плитки категории: подбирается по slug. */
function categoryIcon(slug: string) {
  const key = slug.toLowerCase();
  if (key.includes("hdd") || key.includes("nakopitel")) return HardDrive;
  if (key.includes("pit")) return Gpu;
  if (key.includes("ventil") || key.includes("ohlazh")) return Fan;
  if (key.includes("monitor") || key.includes("display")) return Monitor;
  if (key.includes("korp")) return PcCase;
  if (key.includes("kabel") || key.includes("provod")) return Cable;
  if (key.includes("aksess")) return Usb;
  return Cpu;
}

/** Плитка категории: пять крупных с фото, остальные — компактные с иконкой. */
function CategoryTiles({ categories }: { categories: readonly CategoryNode[] }) {
  const [featured, ...rest] = categories;

  return (
    <div className="mt-5 flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {featured ? (
          <a
            href={`/catalog/${featured.slug}`}
            className="group col-span-2 flex flex-col gap-1.5 rounded-card border border-slate-200 bg-white p-4 transition-shadow hover:shadow-card-hover sm:col-span-1"
          >
            <div className="relative h-[5.875rem] w-full overflow-hidden rounded-control bg-slate-100">
              <img
                src={featured.image_url ?? "/img/cat-videocards.png"}
                alt=""
                loading="lazy"
                decoding="async"
                className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
              />
            </div>
            <span className="mt-1 text-[0.9375rem] font-semibold text-slate-900">{featured.name}</span>
            <span className="text-xs text-slate-600">
              {featured.children.length > 0
                ? `${featured.children.length} разделов`
                : "Смотреть"}
            </span>
          </a>
        ) : null}

        {rest.slice(0, 4).map((category) => (
          <a
            key={category.id}
            href={`/catalog/${category.slug}`}
            className="group col-span-2 flex flex-col gap-1.5 rounded-card border border-slate-200 bg-white p-4 transition-shadow hover:shadow-card-hover sm:col-span-1"
          >
            <div className="relative h-[5.875rem] w-full overflow-hidden rounded-control bg-slate-100">
              <img
                src={category.image_url ?? "/img/cat-processors.png"}
                alt=""
                loading="lazy"
                decoding="async"
                className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
              />
            </div>
            <span className="mt-1 text-[0.9375rem] font-semibold text-slate-900">{category.name}</span>
            <span className="text-xs text-slate-600">
              {category.children.length > 0
                ? `${category.children.length} разделов`
                : "Смотреть"}
            </span>
          </a>
        ))}
      </div>

      {rest.length > 4 ? (
        <ul className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5">
          {rest.slice(4, 9).map((category) => {
            const Icon = categoryIcon(category.slug);
            return (
              <li key={category.id}>
                <a
                  href={`/catalog/${category.slug}`}
                  className="flex h-[4.5rem] items-center gap-3 rounded-card border border-slate-200 bg-white p-3 transition-shadow hover:shadow-card-hover"
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-control bg-slate-50 text-slate-900">
                    <Icon className="h-[1.4375rem] w-[1.4375rem]" />
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-[0.8125rem] font-semibold text-slate-900">
                      {category.name}
                    </span>
                    <span className="text-[0.6875rem] text-slate-600">
                      {category.children.length > 0
                        ? `${category.children.length} разделов`
                        : "Смотреть"}
                    </span>
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const { authenticated } = loaderData;
  const data = loaderData.ok ? loaderData.data : null;

  const banner = data?.banners[0] ?? null;

  // Дерево категорий может выглядеть по-разному: либо несколько корней,
  // либо один корень («Комплектующие») с разделами внутри. Показываем то, на
  // что покупатель ходит: при единственном корне — его разделы.
  const roots = data ? data.categories.filter((item) => item.parent_id === null) : [];
  const onlyRoot = roots.length === 1 ? roots[0] : undefined;
  const tiles = onlyRoot && onlyRoot.children.length > 0 ? onlyRoot.children : roots;

  const heroTitle = banner?.title ?? "Больше кадров. Больше побед.";
  const heroText = banner?.subtitle ?? "GeForce RTX 4070 SUPER — новый уровень вашей игры. Уже в Пульсе.";
  const heroHref = banner?.link_url ?? "/catalog";
  const heroCta = banner?.button_text ?? "Выбрать видеокарту";
  const heroPrice = banner
    ? banner.title.match(/(\d[\d\s ]*₽)/)?.[1]?.trim() ?? "от 69 990 ₽"
    : "от 69 990 ₽";

  return (
    <div className="flex min-h-full flex-col">
      <SiteHeader authenticated={authenticated} />

      <main className="flex-1">
        {/* Предложения недели: главный баннер и узкая карточка рядом.
            Пропорция 2:1 — как в макете (894 px и 456 px при контейнере 1440). */}
        <section className="px-4 pt-7 pb-6 lg:px-8 xl:px-16">
          <div className="flex flex-col gap-5 lg:flex-row">
            <div className="relative overflow-hidden rounded-panel bg-ink-900 p-7 sm:p-9 lg:flex-[2_1_0]">
              {/* Колонка текста ограничена так, чтобы не заезжать под фото:
                  при контейнере 1440 карточка шириной ~875, текст занимает
                  36…404, а фотография начинается с 451. */}
              <div className="relative z-10 max-w-[23rem]">
                <span className="inline-block rounded-badge bg-ink-700 px-2.5 py-1 text-[0.6875rem] font-bold text-accent-500">
                  АПГРЕЙД БЕЗ КОМПРОМИССОВ
                </span>

                <h1 className="mt-4 text-[2.875rem] leading-[1.06] font-normal text-white">
                  {heroTitle}
                </h1>

                <p className="mt-4 text-[0.9375rem] leading-[1.45] text-[#C3C9D2]">
                  {heroText}
                </p>

                <div className="mt-5 flex flex-wrap items-center gap-4.5">
                  <a
                    href={heroHref}
                    className="inline-flex h-11 items-center gap-2 rounded-control bg-pulse-600 px-[1.125rem] text-[0.9375rem] font-semibold text-white transition-colors hover:bg-pulse-700"
                  >
                    {heroCta}
                  </a>
                  <span className="text-xl font-bold text-white">{heroPrice}</span>
                </div>
              </div>

              {/* Слайды в макете декоративны: прокрутка не должна уводить вниз. */}
              <div className="relative z-10 mt-6 flex gap-1.5" aria-hidden="true">
                <span className="h-1 w-6 rounded-full bg-pulse-600" />
                <span className="h-1 w-1.5 rounded-full bg-white/25" />
                <span className="h-1 w-1.5 rounded-full bg-white/25" />
              </div>

              {/* Фото уходит в правый край карточки по всей высоте. Показываем его от
                  xl: на более узких экранах карточка уже не вмещает текст (368 px)
                  и снимок (304 px) рядом — там он наезжал бы на заголовок. */}
              <img
                src="/img/hero-videocard.png"
                alt=""
                aria-hidden="true"
                loading="lazy"
                decoding="async"
                className="pointer-events-none absolute inset-y-0 right-0 hidden w-[19rem] object-cover object-right xl:block"
              />
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0 left-0 hidden w-1/2 bg-gradient-to-r from-ink-900 to-transparent xl:block"
              />
            </div>

            <div className="flex flex-col gap-2.5 rounded-panel bg-[#E7EBF0] p-7 lg:flex-[1_1_0]">
              <span className="text-[0.6875rem] font-bold text-pulse-600">
                БЫСТРЕЕ С КАЖДЫМ КЛИКОМ
              </span>
              <h2 className="text-[1.75rem] leading-[1.15] font-bold text-slate-900">
                Скорость, которую чувствуешь
              </h2>
              <p className="text-[0.8125rem] text-slate-600">
                Samsung 990 PRO · скидки до 13%
              </p>

              <div className="mt-1 h-[8.125rem] w-full overflow-hidden rounded-control bg-slate-200">
                <img
                  src="/img/offer-ssd.png"
                  alt="Накопитель Samsung 990 PRO"
                  loading="lazy"
                  decoding="async"
                  className="h-full w-full object-cover"
                />
              </div>

              <div className="mt-auto flex items-center justify-between gap-3 pt-2">
                <a
                  href="/catalog"
                  className="text-[0.8125rem] font-semibold text-slate-900 transition-colors hover:text-pulse-600"
                >
                  Смотреть предложение
                </a>
                <span className="flex h-10 w-10 items-center justify-center rounded-control bg-pulse-600 text-white">
                  <ArrowUpRight className="h-5 w-5" />
                </span>
              </div>
            </div>
          </div>

          <SiteBenefits className="mt-2 border-t border-slate-200" />
        </section>

        {!loaderData.ok ? (
          <section className="px-4 pb-12 lg:px-8 xl:px-16">
            <div role="alert" className="rounded-card border border-rose-200 bg-rose-50 p-6 text-center">
              <h2 className="text-lg font-semibold text-slate-900">Витрина временно недоступна</h2>
              <p className="mx-auto mt-2 max-w-md text-sm text-slate-700">{loaderData.error.message}</p>
              <a
                href="/catalog"
                className="mt-5 inline-block rounded-control bg-pulse-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-pulse-700"
              >
                Перейти в каталог
              </a>
            </div>
          </section>
        ) : null}

        {tiles.length > 0 ? (
          <section className="px-4 pt-3 pb-8 lg:px-8 xl:px-16">
            <SectionHeader
              title="Всё для вашей системы"
              href="/catalog"
              linkLabel="Весь каталог"
            />
            <CategoryTiles categories={tiles} />
          </section>
        ) : null}

        {data ? (
          <>
            <ProductShelf
              className="px-4 pt-6 pb-8 lg:px-8 xl:px-16"
              title="Выбор тех, кто разбирается"
              products={data.recommended}
              href="/catalog?sort=popular"
              linkLabel="Все рекомендации"
            />

            <ProductShelf
              className="bg-[#F0FDF4] px-4 pt-6 pb-8 lg:px-8 xl:px-16"
              eyebrow="СКИДКИ НЕДЕЛИ"
              title="Мощный апгрейд. Лёгкая цена."
              products={data.discounted}
              href="/catalog?has_discount=true&sort=discount"
              linkLabel="Все акции"
            />

            {/* Конфигуратор сборки. */}
            <section className="px-4 py-8 lg:px-8 xl:px-16">
              <div className="flex flex-col gap-9 rounded-panel bg-ink-900 p-9 lg:flex-row lg:items-center">
                <div className="flex max-w-[35.625rem] flex-col gap-3.5">
                  <span className="text-[0.6875rem] font-bold text-accent-500">
                    ВАША СБОРКА НАЧИНАЕТСЯ ЗДЕСЬ
                  </span>
                  <h2 className="text-[2.25rem] leading-[1.15] font-bold text-white">
                    Соберите ПК под себя. Всё остальное проверим мы.
                  </h2>
                  <p className="text-sm text-ink-muted">
                    Проверим совместимость, мощность блока питания и размеры корпуса — подберём
                    детали, которые точно подружатся.
                  </p>
                  <div className="mt-1.5 flex flex-wrap gap-3">
                    <a
                      href="/catalog"
                      className="inline-flex h-11 items-center gap-2 rounded-control bg-pulse-600 px-[1.125rem] text-[0.9375rem] font-semibold text-white transition-colors hover:bg-pulse-700"
                    >
                      <Plus className="h-5 w-5" />
                      Начать сборку
                    </a>
                    <a
                      href="/catalog"
                      className="inline-flex h-11 items-center rounded-control border border-slate-200 bg-white px-[1.125rem] text-[0.9375rem] font-semibold text-slate-900 transition-colors hover:bg-slate-50"
                    >
                      Готовые решения
                    </a>
                  </div>
                </div>

                <img
                  src="/img/build-pc.png"
                  alt="Игровой компьютер"
                  loading="lazy"
                  decoding="async"
                  className="mx-auto h-auto w-full max-w-[22.5rem] rounded-panel object-cover"
                />

                <ol className="flex flex-1 flex-col gap-5.5 lg:pl-6">
                  {[
                    { icon: Cpu, label: "Выберите детали" },
                    { icon: Gpu, label: "Проверьте совместимость" },
                    { icon: Monitor, label: "Получите готовый ПК" },
                  ].map((step, index) => (
                    <li key={step.label} className="flex items-center gap-3">
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-control bg-white/10 text-white">
                        <step.icon className="h-5 w-5" />
                      </span>
                      <span className="flex flex-col">
                        <span className="text-[0.8125rem] font-medium text-[#97A0AC]">
                          Шаг {index + 1}
                        </span>
                        <span className="text-[0.8125rem] font-medium text-white">{step.label}</span>
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
            </section>

            <ProductShelf
              className="px-4 pt-6 pb-12 lg:px-8 xl:px-16"
              title="Новое железо — уже здесь"
              products={data.newest}
              href="/catalog?sort=newest"
              linkLabel="Все новинки"
            />
          </>
        ) : null}
      </main>

      <SiteFooter />
    </div>
  );
}