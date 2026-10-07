import { Form } from "react-router";

import type { Route } from "./+types/home";
import { describeApiError } from "~/lib/api-error";
import { serverFetch } from "~/lib/api.server";
import type { HomeResponse } from "~/lib/catalog";
import { readAccessToken } from "~/lib/auth-token";
import { ProductGrid } from "~/widgets/product-card";
import { SiteHeader } from "~/widgets/site-header";

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

/** Одна секция витрины: заголовок, подпись и четыре карточки. */
function Section({
  title,
  subtitle,
  products,
  href,
}: {
  title: string;
  subtitle: string;
  products: HomeResponse["recommended"];
  href: string;
}) {
  if (products.length === 0) return null;

  return (
    <section className="mt-10">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-slate-900 sm:text-2xl">{title}</h2>
          <p className="mt-1 text-sm text-slate-600">{subtitle}</p>
        </div>
        <a
          href={href}
          className="text-sm font-semibold text-pulse-600 hover:text-pulse-700"
        >
          Все товары →
        </a>
      </div>
      <ProductGrid products={products.slice(0, 4)} size="xs" className="mt-4" />
    </section>
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

  return (
    <div className="flex min-h-full flex-col">
      <SiteHeader authenticated={authenticated} />

      <main className="flex-1">
        <section className="border-b border-slate-200 bg-white">
          <div className="container-pulse py-12 sm:py-16">
            <p className="text-sm font-semibold tracking-wide text-pulse-600 uppercase">
              Интернет-магазин комплектующих
            </p>
            <h1 className="mt-3 max-w-3xl text-3xl font-bold tracking-tight text-slate-900 sm:text-5xl">
              {banner ? banner.title : "Соберите ПК, который тянет ваши задачи"}
            </h1>
            <p className="mt-4 max-w-2xl text-base text-slate-600 sm:text-lg">
              {banner?.subtitle ??
                "Процессоры, видеокарты, накопители и всё остальное для сборки — с официальной гарантией и проверкой совместимости."}
            </p>

            <div className="mt-6 flex flex-wrap items-center gap-3">
              {banner?.button_text && banner.link_url ? (
                <a
                  href={banner.link_url}
                  className="rounded-xl bg-pulse-600 px-5 py-3 text-base font-semibold text-white transition-colors hover:bg-pulse-700"
                >
                  {banner.button_text}
                </a>
              ) : (
                <a
                  href="/catalog"
                  className="rounded-xl bg-pulse-600 px-5 py-3 text-base font-semibold text-white transition-colors hover:bg-pulse-700"
                >
                  Открыть каталог
                </a>
              )}
              {authenticated ? (
                <a
                  href="/account"
                  className="rounded-xl border border-slate-300 bg-white px-5 py-3 text-base font-semibold text-slate-800 transition-colors hover:bg-slate-50"
                >
                  Личный кабинет
                </a>
              ) : (
                <a
                  href="/register"
                  className="rounded-xl border border-slate-300 bg-white px-5 py-3 text-base font-semibold text-slate-800 transition-colors hover:bg-slate-50"
                >
                  Регистрация
                </a>
              )}
            </div>

            {/* GET-форма: поиск ведёт в каталог и работает без JavaScript. */}
            <Form
              method="get"
              action="/catalog"
              role="search"
              className="mt-8 flex max-w-2xl gap-2"
            >
              <label htmlFor="home-search" className="sr-only">
                Поиск товаров
              </label>
              <input
                id="home-search"
                type="search"
                name="q"
                placeholder="Например: Ryzen 7 7800X3D или Samsung 990 Pro 2TB"
                className="w-full rounded-xl border border-slate-300 px-4 py-3 text-base text-slate-900 placeholder:text-slate-400"
              />
              <button
                type="submit"
                className="shrink-0 rounded-xl bg-slate-900 px-6 py-3 font-semibold text-white transition-colors hover:bg-slate-800"
              >
                Найти
              </button>
            </Form>
          </div>
        </section>

        {!loaderData.ok ? (
          <section className="container-pulse py-12">
            <div role="alert" className="card border-rose-200 bg-rose-50 p-6 text-center">
              <h2 className="text-lg font-semibold text-slate-900">Витрина временно недоступна</h2>
              <p className="mx-auto mt-2 max-w-md text-sm text-slate-700">
                {loaderData.error.message}
              </p>
              <a
                href="/catalog"
                className="mt-5 inline-block rounded-xl bg-pulse-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-pulse-700"
              >
                Перейти в каталог
              </a>
            </div>
          </section>
        ) : null}

        {tiles.length > 0 ? (
          <section className="container-pulse py-10">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-xl font-bold tracking-tight text-slate-900 sm:text-2xl">
                Категории
              </h2>
              {onlyRoot && onlyRoot.children.length > 0 ? (
                <a href={`/catalog/${onlyRoot.slug}`} className="text-sm font-semibold text-pulse-600 hover:text-pulse-700">
                  Все товары →
                </a>
              ) : null}
            </div>
            <ul className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {tiles.map((category) => (
                <li key={category.id}>
                  <a
                    href={`/catalog/${category.slug}`}
                    className="card flex items-center justify-between gap-2 px-4 py-3.5 text-sm font-medium text-slate-700 transition-colors hover:border-pulse-300 hover:text-pulse-700"
                  >
                    {category.name}
                    <span aria-hidden="true" className="text-slate-300">
                      →
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {data ? (
          <section className="container-pulse pb-14">
            <Section
              title="Рекомендуемые"
              subtitle="Подборка магазина — популярные позиции по категориям."
              products={data.recommended}
              href="/catalog?sort=popular"
            />
            <Section
              title="Со скидкой"
              subtitle="Цены, сниженные по сравнению с прошлой."
              products={data.discounted}
              href="/catalog?has_discount=true&sort=discount"
            />
            <Section
              title="Новинки"
              subtitle="Недавно поступившие в магазин товары."
              products={data.newest}
              href="/catalog?sort=newest"
            />
          </section>
        ) : null}
      </main>

      <footer className="border-t border-slate-200 bg-white">
        <div className="container-pulse flex flex-col gap-2 py-6 text-sm text-slate-500 sm:flex-row sm:items-center sm:justify-between">
          <p>© {new Date().getFullYear()} ПУЛЬС — интернет-магазин комплектующих</p>
          <p>Каталог, характеристики и совместимость</p>
        </div>
      </footer>
    </div>
  );
}
