import { useEffect, useId, useState } from "react";

import type { FacetValue, Facets, FilterPatch, FilterSelection } from "~/lib/catalog";
import {
  facetOptionLabel,
  formatPriceBound,
  parseFacets,
  toInputNumber,
} from "~/lib/catalog";
import { plural } from "~/lib/format";
import { SlidersHorizontal } from "~/widgets/icons";

/**
 * Панель фильтров каталога.
 *
 * Всё состояние живёт в URL: панель не хранит фильтры у себя, а сообщает
 * родителю патч, который превращается в новую query-строку. Поэтому страница
 * остаётся рабочей без JavaScript (внешние ссылки и кнопка «Назад» приводят
 * к тому же набору товаров), а SSR и браузер всегда согласны.
 *
 * Набор блоков не захардкожен: числовые характеристики приходят как
 * `range`/`slider`, перечисления — как `checkbox`/`select`, и всё это рисуется
 * из `facets.attributes`. Новый фильтр в справочнике backend-а заработает
 * здесь без правок кода.
 */

export type FilterPanelProps = {
  facets: Facets;
  selection: FilterSelection;
  onPatch: (patch: FilterPatch) => void;
  /** Сброс всех фильтров. Поисковый запрос и категория при этом сохраняются. */
  onReset: () => void;
  /** Префикс для id полей: на мобильном панель открыта вместе с десктопной. */
  idPrefix?: string;
  /** Число товаров в выдаче — показывается в заголовке панели. */
  resultCount?: number;
};

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, "-");
}

const INPUT_CLASS =
  "h-9 w-full rounded-control border border-slate-200 bg-white px-2.5 text-xs text-slate-900 " +
  "placeholder:text-slate-600 focus-visible:outline-2 focus-visible:outline-offset-2 " +
  "focus-visible:outline-pulse-600 disabled:cursor-not-allowed disabled:bg-slate-50";

const CHECKBOX_CLASS =
  "h-4 w-4 shrink-0 rounded-[0.25rem] border-slate-300 text-pulse-600 accent-pulse-600 " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pulse-600";

function FilterGroup({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <fieldset className="border-b border-slate-200 py-4 first:pt-0 last:border-b-0 last:pb-0">
      <legend className="w-full pb-2.5 text-sm font-semibold text-slate-900">{title}</legend>
      {hint ? <p className="mb-2 text-[0.6875rem] text-slate-600">{hint}</p> : null}
      {children}
    </fieldset>
  );
}

function CheckRow({
  id,
  checked,
  disabled,
  label,
  count,
  onChange,
}: {
  id: string;
  checked: boolean;
  disabled: boolean;
  label: string;
  count?: number;
  onChange: () => void;
}) {
  return (
    <label
      htmlFor={id}
      title={disabled && !checked ? "Нет товаров под это значение" : undefined}
      className={`flex items-center gap-2.5 py-1 text-[0.8125rem] ${
        disabled && !checked ? "cursor-not-allowed" : "cursor-pointer"
      }`}
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled && !checked}
        onChange={onChange}
        className={CHECKBOX_CLASS}
      />
      <span className={disabled && !checked ? "text-slate-400" : "text-slate-900"}>{label}</span>
      {count !== undefined ? (
        <span className="ml-auto text-[0.6875rem] text-slate-600">{count}</span>
      ) : null}
    </label>
  );
}

/**
 * Два числовых поля «от … до …» с единицами измерения.
 *
 * Значение уходит в URL не на каждый символ, а по blur или Enter: иначе на
 * 320px один запрос на страницу отправлял бы новый запрос к backend-а на
 * каждую цифру. Черновик живёт локально и откатывается, если сервер вернул
 * другое значение (например, отфильтровал пустое).
 */
function NumberRange({
  id,
  name,
  unit,
  boundMin,
  boundMax,
  valueMin,
  valueMax,
  onApply,
}: {
  id: string;
  name: string;
  unit: string | null;
  boundMin: string | null;
  boundMax: string | null;
  valueMin: string;
  valueMax: string;
  onApply: (min: string, max: string) => void;
}) {
  const [minDraft, setMinDraft] = useState(() => toInputNumber(valueMin));
  const [maxDraft, setMaxDraft] = useState(() => toInputNumber(valueMax));

  // Ответ сервера — источник истины: если значение пришло другим, черновик
  // подстраивается под него, иначе после сброса фильтра поле осталось бы
  // с прошлыми цифрами.
  useEffect(() => setMinDraft(toInputNumber(valueMin)), [valueMin]);
  useEffect(() => setMaxDraft(toInputNumber(valueMax)), [valueMax]);

  const commit = (): void => {
    const min = minDraft.trim();
    const max = maxDraft.trim();
    if (min === toInputNumber(valueMin) && max === toInputNumber(valueMax)) return;
    onApply(min, max);
  };

  const suffix = unit ? `, ${unit}` : "";

  return (
    <div>
      <div className="flex items-center gap-2">
        <input
          id={`${id}-min`}
          type="number"
          inputMode="numeric"
          value={minDraft}
          min={boundMin ? toInputNumber(boundMin) : undefined}
          placeholder={toInputNumber(boundMin) || "от"}
          aria-label={`${name}: от${suffix}`}
          onChange={(event) => setMinDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          className={INPUT_CLASS}
        />
        <span aria-hidden="true" className="shrink-0 text-slate-400">
          —
        </span>
        <input
          id={`${id}-max`}
          type="number"
          inputMode="numeric"
          value={maxDraft}
          max={boundMax ? toInputNumber(boundMax) : undefined}
          placeholder={toInputNumber(boundMax) || "до"}
          aria-label={`${name}: до${suffix}`}
          onChange={(event) => setMaxDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          className={INPUT_CLASS}
        />
      </div>
      {unit ? <p className="mt-1 text-[0.6875rem] text-slate-600">Единица: {unit}</p> : null}
    </div>
  );
}

function ChoiceList({
  options,
  isSelected,
  onToggle,
  idFor,
}: {
  options: readonly FacetValue[];
  isSelected: (value: string) => boolean;
  onToggle: (value: string, selected: boolean) => void;
  idFor: (value: string) => string;
}) {
  return (
    <div className="max-h-64 overflow-y-auto pr-1">
      {options.map((option) => {
        const selected = isSelected(option.value);
        return (
          <CheckRow
            key={option.value}
            id={idFor(option.value)}
            checked={selected}
            disabled={option.count === 0 && !selected}
            label={facetOptionLabel(option)}
            count={option.count}
            onChange={() => onToggle(option.value, !selected)}
          />
        );
      })}
    </div>
  );
}

const WARRANTY_OPTIONS = [12, 24, 36] as const;
const RATING_OPTIONS = [
  { value: "", label: "Любой" },
  { value: "4", label: "4,0 и выше" },
  { value: "4.5", label: "4,5 и выше" },
] as const;

export function FilterPanel({
  facets,
  selection,
  onPatch,
  onReset,
  idPrefix = "f",
  resultCount,
}: FilterPanelProps) {
  const uid = useId();
  const parsed = parseFacets(facets);
  const key = (raw: string): string => `${idPrefix}-${uid.replace(/[^a-zA-Z0-9]+/g, "")}-${safeId(raw)}`;

  const inStock = facets.availability.find((item) => item.value === "in_stock") ?? null;
  const outOfStock = facets.availability.find((item) => item.value === "out_of_stock") ?? null;
  const otherStatuses = facets.availability.filter(
    (item) => item.value !== "in_stock" && item.value !== "out_of_stock",
  );

  return (
    <div className="rounded-card border border-slate-200 bg-white p-5">
      <div className="flex items-center justify-between gap-3 border-b border-slate-200 pb-4">
        <h2 className="text-[1.1875rem] font-bold text-slate-900">Фильтры</h2>
        <SlidersHorizontal className="h-5 w-5 text-slate-400" aria-hidden="true" />
      </div>

      {resultCount !== undefined ? (
        <p className="pt-3 text-[0.6875rem] text-slate-600">
          Подходит {resultCount} {plural(resultCount, "товар", "товара", "товаров")}
        </p>
      ) : null}

      <div className="mt-4">
      <FilterGroup title="Производитель" hint="Выбирается один бренд за раз.">
        <ChoiceList
          options={facets.brands.map((brand) => ({
            value: brand.slug,
            label: brand.name,
            count: brand.count,
          }))}
          isSelected={(value) => selection.brand === value}
          onToggle={(value, selected) => onPatch({ kind: "brand", value: selected ? value : null })}
          idFor={(value) => key(`brand-${value}`)}
        />
      </FilterGroup>

      <FilterGroup title="Цена" hint={`В каталоге: от ${formatPriceBound(facets.price.min)} до ${formatPriceBound(facets.price.max)}`}>
        <NumberRange
          id={key("price")}
          name="Цена, ₽"
          unit={null}
          boundMin={facets.price.min}
          boundMax={facets.price.max}
          valueMin={selection.priceMin}
          valueMax={selection.priceMax}
          onApply={(min, max) => onPatch({ kind: "price", min, max })}
        />
      </FilterGroup>

      {inStock || outOfStock ? (
        <FilterGroup title="Наличие">
          <div className="space-y-0.5">
            {inStock ? (
              <CheckRow
                id={key("stock-in")}
                checked={selection.inStock === true}
                disabled={inStock.count === 0 && selection.inStock !== true}
                label={inStock.label ?? "Только в наличии"}
                count={inStock.count}
                onChange={() => onPatch({ kind: "inStock", value: selection.inStock === true ? null : true })}
              />
            ) : null}
            {outOfStock ? (
              <CheckRow
                id={key("stock-out")}
                checked={selection.inStock === false}
                disabled={outOfStock.count === 0 && selection.inStock !== false}
                label={outOfStock.label ?? "Нет в наличии"}
                count={outOfStock.count}
                onChange={() => onPatch({ kind: "inStock", value: selection.inStock === false ? null : false })}
              />
            ) : null}
          </div>
          {otherStatuses.length > 0 ? (
            <p className="mt-2 text-[0.6875rem] text-slate-600">
              В подборке также:{" "}
              {otherStatuses
                .map((item) => `${item.label ?? item.value} (${item.count})`)
                .join(", ")}
            </p>
          ) : null}
        </FilterGroup>
      ) : null}

      {parsed.ranges.map((range) => (
        <FilterGroup key={range.key} title={range.name}>
          <NumberRange
            id={key(range.key)}
            name={range.name}
            unit={range.unit}
            boundMin={range.min}
            boundMax={range.max}
            valueMin={selection.attributeRanges[range.key]?.min ?? ""}
            valueMax={selection.attributeRanges[range.key]?.max ?? ""}
            onApply={(min, max) => onPatch({ kind: "attributeRange", key: range.key, min, max })}
          />
        </FilterGroup>
      ))}

      {parsed.choices.map((choice) =>
        choice.widget === "select" ? (
          <FilterGroup key={choice.key} title={choice.name}>
            <label htmlFor={key(choice.key)} className="sr-only">
              {choice.name}
            </label>
            <select
              id={key(choice.key)}
              value={selection.attributes[choice.key]?.[0] ?? ""}
              onChange={(event) =>
                onPatch({
                  kind: "attributeSelect",
                  key: choice.key,
                  value: event.target.value || null,
                })
              }
              className={INPUT_CLASS}
            >
              <option value="">Не выбрано</option>
              {choice.options.map((option) => (
                <option
                  key={option.value}
                  value={option.value}
                  disabled={option.count === 0 && option.value !== selection.attributes[choice.key]?.[0]}
                >
                  {facetOptionLabel(option)}
                  {option.count > 0 ? ` (${option.count})` : " — нет товаров"}
                </option>
              ))}
            </select>
          </FilterGroup>
        ) : (
          <FilterGroup key={choice.key} title={choice.name}>
            <ChoiceList
              options={choice.options}
              isSelected={(value) => (selection.attributes[choice.key] ?? []).includes(value)}
              onToggle={(value, selected) => onPatch({ kind: "attributeValue", key: choice.key, value, selected })}
              idFor={(value) => key(`${choice.key}-${value}`)}
            />
          </FilterGroup>
        ),
      )}

      <FilterGroup title="Дополнительно">
        <div className="space-y-2.5">
          <CheckRow
            id={key("discount")}
            checked={selection.hasDiscount === true}
            disabled={false}
            label="Только со скидкой"
            onChange={() => onPatch({ kind: "hasDiscount", value: selection.hasDiscount === true ? null : true })}
          />

          <div>
            <label htmlFor={key("rating")} className="mb-1 block text-[0.8125rem] font-medium text-slate-900">
              Рейтинг
            </label>
            <select
              id={key("rating")}
              value={selection.minRating}
              onChange={(event) => onPatch({ kind: "minRating", value: event.target.value })}
              className={INPUT_CLASS}
            >
              {RATING_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor={key("warranty")} className="mb-1 block text-[0.8125rem] font-medium text-slate-900">
              Гарантия
            </label>
            <select
              id={key("warranty")}
              value={selection.warranty[0] !== undefined ? String(selection.warranty[0]) : ""}
              onChange={(event) => {
                const raw = event.target.value;
                onPatch({
                  kind: "warranty",
                  value: raw ? Number.parseInt(raw, 10) : null,
                });
              }}
              className={INPUT_CLASS}
            >
              <option value="">Любая</option>
              {WARRANTY_OPTIONS.map((months) => (
                <option key={months} value={months}>
                  {months} мес.
                </option>
              ))}
            </select>
          </div>
        </div>
      </FilterGroup>
      </div>

      <button
        type="button"
        onClick={onReset}
        className="mt-5 inline-flex h-11 w-full items-center justify-center rounded-control border border-slate-200 bg-white px-4 text-[0.9375rem] font-semibold text-slate-900 transition-colors hover:border-pulse-400 hover:text-pulse-600"
      >
        Сбросить фильтры
      </button>
    </div>
  );
}
