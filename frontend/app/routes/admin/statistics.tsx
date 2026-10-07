import type { ReactNode } from "react";

import type { Route } from "./+types/statistics";

import type { AdminStatistics } from "~/lib/admin";
import type { ApiErrorInfo } from "~/lib/api-error";
import { describeApiError } from "~/lib/api-error";
import { serverFetch } from "~/lib/api.server";
import { requireAdminSession } from "~/lib/admin.server";
import { formatDate } from "~/lib/format";
import {
  ADMIN_INPUT,
  AdminCell,
  AdminPageHeader,
  AdminTable,
  EmptyState,
  FilterBar,
  FilterField,
  LoadError,
  MoneyCell,
} from "~/widgets/admin-ui";

export function meta(): Route.MetaDescriptors {
  return [{ title: "Статистика — Админ-панель — ПУЛЬС" }];
}

/**
 * Статистика: выручка, заказы, средний чек, бестселлеры, остатки, продажи.
 *
 * Раздел доступен менеджеру и администратору (ТЗ 3.3/3.4).
 *
 * График продаж — простой SVG без библиотек: подключать chart-ради этого
 * раздела нельзя (новые зависимости запрещены), а таблица рядом всё равно
 * нужна для точных цифр — по ней сотрудник и сверяет график.
 */

/** Варианты периода: чем длиннее период, тем больше данных, тем мельче столбики. */
const PERIOD_OPTIONS = [
  { days: 7, label: "7 дней" },
  { days: 30, label: "30 дней" },
  { days: 90, label: "90 дней" },
  { days: 365, label: "Год" },
] as const;

export async function loader({ request }: Route.LoaderArgs) {
  const session = await requireAdminSession(request, { section: "statistics" });
  const url = new URL(request.url);

  const raw = Number.parseInt(url.searchParams.get("period_days") ?? "", 10);
  const periodDays = PERIOD_OPTIONS.some((option) => option.days === raw) ? raw : 30;

  const stats = await serverFetch<AdminStatistics>(`/admin/statistics?period_days=${periodDays}`, {
    headers: session.headers,
  }).catch((cause: unknown) => cause as ApiErrorInfo);

  const error = stats instanceof Error ? describeApiError(stats, "Не удалось загрузить статистику") : null;

  return {
    periodDays,
    stats: error ? null : (stats as AdminStatistics),
    error,
  };
}

export default function AdminStatisticsRoute({ loaderData }: Route.ComponentProps) {
  const { periodDays, stats, error } = loaderData;

  if (error) {
    return (
      <>
        <AdminPageHeader title="Статистика" description="Показатели магазина за выбранный период." />
        <LoadError error={error} />
      </>
    );
  }

  // После ветки ошибки TS знает, что `stats` не `null`.
  if (!stats) return null;

  return (
    <>
      <AdminPageHeader title="Статистика" description="Показатели магазина за выбранный период." />

      <FilterBar action="/admin/statistics">
        <FilterField id="stats-period" label="Период">
          <select id="stats-period" name="period_days" defaultValue={String(periodDays)} className={ADMIN_INPUT}>
            {PERIOD_OPTIONS.map((option) => (
              <option key={option.days} value={option.days}>
                {option.label}
              </option>
            ))}
          </select>
        </FilterField>

        <button
          type="submit"
          className="rounded-xl bg-pulse-600 px-4 py-2 text-sm font-semibold text-white hover:bg-pulse-700"
        >
          Показать
        </button>
      </FilterBar>

      <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard
          label={`Выручка за ${periodDays} дн.`}
          value={stats.revenue_period}
          hint={`За всё время: ${stats.revenue_total}`}
        />
        <MetricCard label="Средний чек" value={stats.average_order_value} hint="По завершённым заказам" />
        <MetricCard
          label="Заказов всего"
          value={String(stats.orders_total)}
          hint={`В ожидании: ${stats.orders_pending}`}
        />
        <MetricCard
          label="Покупателей"
          value={String(stats.customers_total)}
          hint={`Новых за период: ${stats.new_customers_period}`}
        />
        <MetricCard label="Выполнено" value={String(stats.orders_completed)} />
        <MetricCard label="Отменено" value={String(stats.orders_cancelled)} />
        <MetricCard label="Товаров в каталоге" value={String(stats.products_total)} />
        <MetricCard
          label="Отзывов на модерации"
          value={String(stats.reviews_pending)}
          hint={
            stats.reviews_pending > 0 ? (
              <a href="/admin/reviews?status=pending" className="font-medium text-pulse-700 hover:underline">
                Открыть модерацию
              </a>
            ) : undefined
          }
        />
      </div>

      <SalesChart points={stats.sales_by_day} periodDays={periodDays} />

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <BestSellers items={stats.best_sellers} />
        <LowStock items={stats.low_stock_items} productsOutOfStock={stats.products_out_of_stock} />
      </div>
    </>
  );
}

/** Плитка показателя: сумма через `formatPrice`, целое число — как есть. */
function MetricCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: ReactNode;
}) {
  const isMoney = value.includes(".");

  return (
    <div className="card p-4">
      <p className="text-xs text-slate-600">{label}</p>
      <p className="mt-1 text-xl font-bold text-slate-900">
        {isMoney ? <MoneyCell value={value} /> : value}
      </p>
      {hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}

/**
 * Столбиковая диаграмма продаж по дням на чистом SVG.
 *
 * Подписи дат отдаём текстом скринридеру через `<title>` и `aria-label` на
 * каждом столбике: иначе график был бы недоступен с клавиатуры и озвучки, а
 * раздел 9 ТЗ требует доступности.
 */
function SalesChart({
  points,
  periodDays,
}: {
  points: AdminStatistics["sales_by_day"];
  periodDays: number;
}) {
  const max = points.reduce((top, point) => Math.max(top, Number.parseFloat(point.amount) || 0), 0);

  return (
    <section aria-labelledby="sales-chart" className="card mt-8 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="sales-chart" className="text-lg font-semibold text-slate-900">
          Продажи по дням
        </h2>
        <p className="text-sm text-slate-600">За {periodDays} дн. · дней с продажами: {points.length}</p>
      </div>

      {points.length === 0 ? (
        <div className="mt-4">
          <EmptyState title="Продаж за период не было" hint="График появится после первого заказа." />
        </div>
      ) : (
        <>
          <div className="mt-4 overflow-x-auto">
            <svg
              viewBox={`0 0 ${Math.max(points.length * 24, 240)} 140`}
              className="h-40 w-full min-w-[16rem]"
              role="img"
              aria-label={`Продажи по дням за ${periodDays} дн. Точные суммы — в таблице ниже.`}
            >
              {/* Базовая линия и подписи оси Y: без них столбики не с чем сравнить. */}
              <line x1="0" y1="120" x2={Math.max(points.length * 24, 240)} y2="120" stroke="#cbd5e1" strokeWidth="1" />
              {[0.25, 0.5, 0.75, 1].map((ratio) => (
                <g key={ratio}>
                  <line
                    x1="0"
                    y1={120 - ratio * 100}
                    x2={Math.max(points.length * 24, 240)}
                    y2={120 - ratio * 100}
                    stroke="#e2e8f0"
                    strokeWidth="1"
                  />
                  <text x="2" y={117 - ratio * 100} fontSize="9" fill="#94a3b8">
                    {Math.round(max * ratio)}
                  </text>
                </g>
              ))}

              {points.map((point, index) => {
                const amount = Number.parseFloat(point.amount) || 0;
                // Ноль высоты дал бы невидимый столбик: рисуем минимальную линию.
                const height = max > 0 ? Math.max((amount / max) * 100, 2) : 2;
                return (
                  <g key={point.date}>
                    <title>
                      {formatDate(point.date)}: {amount} ₽, заказов {point.orders}
                    </title>
                    <rect
                      x={index * 24 + 6}
                      y={120 - height}
                      width="14"
                      height={height}
                      rx="2"
                      className="fill-pulse-500"
                    />
                  </g>
                );
              })}
            </svg>
          </div>

          <AdminTable caption="Продажи по дням" headers={["Дата", "Заказы", "Сумма"]}>
            {points.map((point) => (
              <tr key={point.date}>
                <AdminCell nowrap>{formatDate(point.date)}</AdminCell>
                <AdminCell nowrap>{point.orders}</AdminCell>
                <AdminCell nowrap>
                  <MoneyCell value={point.amount} />
                </AdminCell>
              </tr>
            ))}
          </AdminTable>
        </>
      )}
    </section>
  );
}

function BestSellers({ items }: { items: AdminStatistics["best_sellers"] }) {
  return (
    <section aria-labelledby="best-sellers" className="card p-5">
      <h2 id="best-sellers" className="text-lg font-semibold text-slate-900">
        Бестселлеры
      </h2>
      {items.length === 0 ? (
        <div className="mt-4">
          <EmptyState title="Продаж ещё не было" />
        </div>
      ) : (
        <AdminTable caption="Бестселлеры" headers={["Товар", "Артикул", "Продано"]}>
          {items.map((item) => (
            <tr key={item.id}>
              <AdminCell>{item.name}</AdminCell>
              <AdminCell nowrap>
                <span className="text-slate-600">{item.sku ?? "—"}</span>
              </AdminCell>
              <AdminCell nowrap>{item.sold}</AdminCell>
            </tr>
          ))}
        </AdminTable>
      )}
    </section>
  );
}

function LowStock({
  items,
  productsOutOfStock,
}: {
  items: AdminStatistics["low_stock_items"];
  productsOutOfStock: number;
}) {
  return (
    <section aria-labelledby="low-stock" className="card p-5">
      <h2 id="low-stock" className="text-lg font-semibold text-slate-900">
        Мало на складе
      </h2>
      <p className="mt-1 text-sm text-slate-600">Товаров, которых нет вовсе: {productsOutOfStock}.</p>
      {items.length === 0 ? (
        <div className="mt-4">
          <EmptyState title="Всех товаров достаточно" />
        </div>
      ) : (
        <AdminTable caption="Товары с низким остатком" headers={["Товар", "Артикул", "Доступно"]}>
          {items.map((item) => (
            <tr key={item.id}>
              <AdminCell>{item.name}</AdminCell>
              <AdminCell nowrap>
                <span className="text-slate-600">{item.sku ?? "—"}</span>
              </AdminCell>
              <AdminCell nowrap>
                <span className={item.available === 0 ? "font-semibold text-rose-600" : ""}>
                  {item.available}
                </span>
              </AdminCell>
            </tr>
          ))}
        </AdminTable>
      )}
      <p className="mt-4 text-sm text-slate-600">
        <a href="/admin/import" className="font-medium text-pulse-700 hover:underline">
          Пополнить склад импортом
        </a>
      </p>
    </section>
  );
}

