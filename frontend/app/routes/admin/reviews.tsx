import { data, Form, useActionData, useNavigation, useSearchParams } from "react-router";

import type { Route } from "./+types/reviews";

import type { AdminPage, AdminReviewListItem } from "~/lib/admin";
import type { ApiErrorInfo } from "~/lib/api-error";
import { describeApiError } from "~/lib/api-error";
import { serverFetch } from "~/lib/api.server";
import { queryString, requireAdminSession } from "~/lib/admin.server";
import {
  REVIEW_STATUS_LABEL,
  REVIEW_STATUS_VALUES,
  isReviewStatus,
  parseLimit,
  parsePage,
} from "~/lib/admin";
import {
  ADMIN_INPUT,
  ActionButton,
  AdminCell,
  AdminNotice,
  AdminPagination,
  AdminTable,
  DateCell,
  EmptyState,
  FilterBar,
  FilterField,
  LoadError,
  StatusBadge,
  statusTone,
} from "~/widgets/admin-ui";

export function meta(): Route.MetaDescriptors {
  return [{ title: "Отзывы — Админ-панель — ПУЛЬС" }];
}

/**
 * Модерация отзывов.
 *
 * Раздел только для администратора (ТЗ 3.4).
 *
 * Статусы берём из `REVIEW_STATUS_VALUES` — тот же словарь, что на витрине, иначе
 * один и тот же отзыв назывался бы в двух местах по-разному.
 */

type ReviewActionResult = {
  ok?: string;
  error?: string;
  errorCode?: string;
  fields?: Record<string, string>;
};

/** Кнопка решения → статус, который уходит в `PATCH /admin/reviews/{id}`. */
const REVIEW_ACTION_STATUS: Record<string, string> = {
  publish: "published",
  reject: "rejected",
  hide: "hidden",
};

export async function loader({ request }: Route.LoaderArgs) {
  const session = await requireAdminSession(request, { section: "reviews" });
  const url = new URL(request.url);
  const page = parsePage(url.searchParams.get("page"));
  const limit = parseLimit(url.searchParams.get("limit"));
  const status = (url.searchParams.get("status") ?? "").trim();

  const list = await serverFetch<AdminPage<AdminReviewListItem>>(
    `/admin/reviews${queryString({ page, limit, status })}`,
    { headers: session.headers },
  ).catch((cause: unknown) => cause as ApiErrorInfo);

  const error = list instanceof Error ? describeApiError(list, "Не удалось загрузить отзывы") : null;

  return {
    status,
    reviews: error ? null : (list as AdminPage<AdminReviewListItem>),
    error,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const session = await requireAdminSession(request, { section: "reviews" });

  const form = await request.formData();
  const field = (name: string): string => String(form.get(name) ?? "").trim();
  const reviewId = field("review_id");

  // Значение кнопки и есть целевой статус: три кнопки отличаются только им,
  // поэтому отдельный <select> не нужен.
  const status = REVIEW_ACTION_STATUS[String(form.get("intent") ?? "")] ?? "";

  if (!reviewId || !isReviewStatus(status)) {
    return data<ReviewActionResult>({ error: "Не указан отзыв или статус" }, { status: 400 });
  }

  try {
    await serverFetch(`/admin/reviews/${encodeURIComponent(reviewId)}`, {
      method: "PATCH",
      headers: session.jsonHeaders,
      body: JSON.stringify({ status }),
    });
    return data<ReviewActionResult>(
      { ok: `Отзыв переведён в статус «${REVIEW_STATUS_LABEL[status] ?? status}»` },
      { status: 200 },
    );
  } catch (cause) {
    const info = describeApiError(cause, "Не удалось сохранить решение по отзыву");
    return data<ReviewActionResult>(
      {
        error: info.code === "insufficient_role" ? "Раздел доступен только администратору." : info.message,
        errorCode: info.code,
        fields: info.fields,
      },
      { status: info.status >= 400 && info.status < 500 ? info.status : 400 },
    );
  }
}

export default function AdminReviews({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<typeof action>() as ReviewActionResult | undefined;
  const navigation = useNavigation();
  const [searchParams] = useSearchParams();
  const { status, reviews, error } = loaderData;

  const busy = navigation.state !== "idle";
  const currentSearch = new URLSearchParams(searchParams);

  return (
    <>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">Отзывы</h1>
        <p className="mt-1 text-sm text-slate-600">
          Модерация: публикация, отклонение или скрытие. Отзыв без пометки о покупке виден всем.
        </p>
      </div>

      <AdminNotice ok={actionData?.ok} error={actionData?.error} errorCode={actionData?.errorCode} />

      <FilterBar action="/admin/reviews">
        <FilterField id="reviews-status" label="Статус">
          <select id="reviews-status" name="status" defaultValue={status} className={ADMIN_INPUT}>
            <option value="">Все статусы</option>
            {REVIEW_STATUS_VALUES.map((value) => (
              <option key={value} value={value}>
                {REVIEW_STATUS_LABEL[value]}
              </option>
            ))}
          </select>
        </FilterField>

        <button
          type="submit"
          className="rounded-xl bg-pulse-600 px-4 py-2 text-sm font-semibold text-white hover:bg-pulse-700"
        >
          Применить
        </button>
        <a
          href="/admin/reviews?status=pending"
          className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Только на модерации
        </a>
      </FilterBar>

      {error ? (
        <div className="mt-5">
          <LoadError error={error} />
        </div>
      ) : reviews && reviews.items.length > 0 ? (
        <>
          <AdminTable
            caption="Список отзывов"
            headers={["Отзыв", "Товар", "Покупатель", "Оценка", "Дата", "Статус", "Решение"]}
          >
            {reviews.items.map((review) => (
              <tr key={review.id} className="align-top hover:bg-slate-50">
                <AdminCell>
                  <p className="font-medium text-slate-900">{review.title}</p>
                  <p className="mt-0.5 text-xs text-slate-700">{review.text}</p>
                </AdminCell>
                <AdminCell>
                  {/* Ссылку на товар не даём: витрина открывает карточку по
                      `slug`, а в отзыве лежит только `product_id` — подставлять
                      его в адрес означало бы вести на 404. */}
                  <span className="text-sm text-slate-800">
                    {review.product_name ?? "Товар удалён"}
                  </span>
                </AdminCell>
                <AdminCell nowrap>
                  <span className="text-sm text-slate-800">{review.user_email ?? "—"}</span>
                  {review.is_verified_purchase ? (
                    <p className="text-xs text-emerald-700">проверенная покупка</p>
                  ) : null}
                </AdminCell>
                <AdminCell nowrap>{review.rating} / 5</AdminCell>
                <AdminCell nowrap>
                  <DateCell value={review.created_at} />
                </AdminCell>
                <AdminCell nowrap>
                  <StatusBadge
                    label={REVIEW_STATUS_LABEL[review.status] ?? review.status}
                    tone={statusTone(review.status)}
                  />
                </AdminCell>
                <AdminCell nowrap>
                  <ReviewActions review={review} busy={busy} />
                </AdminCell>
              </tr>
            ))}
          </AdminTable>

          <AdminPagination
            pathname="/admin/reviews"
            search={currentSearch}
            page={reviews.page}
            pages={reviews.pages}
            total={reviews.total}
          />
        </>
      ) : (
        <div className="mt-5">
          <EmptyState
            title="Отзывов нет"
            hint={status ? "В этом статусе ничего не нашлось — снимите фильтр." : "Отзывы появятся после покупок."}
          />
        </div>
      )}
    </>
  );
}

/**
 * Решение по отзыву: три кнопки-интента в одной форме.
 *
 * Здесь одна форма уместна: у всех трёх действий ровно одно поле — статус, и
 * различаются они только значением кнопки.
 */
function ReviewActions({ review, busy }: { review: AdminReviewListItem; busy: boolean }) {
  return (
    <Form method="post" className="flex flex-wrap gap-1.5">
      <input type="hidden" name="review_id" value={review.id} />

      {/* Кнопки несут статус в `intent` — см. REVIEW_ACTION_STATUS в action'е. */}
      <ActionButton intent="publish" busy={busy} busyLabel="…" disabled={review.status === "published"}>
        Опубликовать
      </ActionButton>
      <ActionButton intent="reject" tone="danger" busy={busy} busyLabel="…" disabled={review.status === "rejected"}>
        Отклонить
      </ActionButton>
      <ActionButton intent="hide" tone="ghost" busy={busy} busyLabel="…" disabled={review.status === "hidden"}>
        Скрыть
      </ActionButton>
    </Form>
  );
}