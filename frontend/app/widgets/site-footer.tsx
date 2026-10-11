import { Cpu, PackageCheck, ShieldCheck, Truck, Zap } from "~/widgets/icons";

/**
 * Подвал магазина по макету: тёмная поверхность #20242B, три полосы —
 * рассылка, ссылки и контакты, правовая информация.
 */

const LINK_GROUPS = [
  {
    title: "Покупателям",
    links: ["Доставка и оплата", "Гарантия и возврат", "Бонусная программа", "Вопросы и ответы"],
  },
  {
    title: "Комплектующие",
    links: ["Комплектующие", "Мониторы и периферия", "Кабели и аксессуары", "Акции и скидки"],
  },
  {
    title: "О магазине",
    links: ["О Пульсе", "Наши магазины", "Контакты", "Для бизнеса"],
  },
] as const;

/** Короткий список преимуществ над подвалом — полоса «Коротко о сервисе». */
const BENEFITS = [
  { icon: Truck, label: "Доставка завтра" },
  { icon: ShieldCheck, label: "Официальная гарантия" },
  { icon: PackageCheck, label: "Проверка перед выдачей" },
  { icon: Cpu, label: "Поможем собрать ПК" },
] as const;

export function SiteBenefits({ className }: { className?: string }) {
  return (
    <ul
      className={`flex flex-wrap items-center justify-between gap-4 py-3.5 ${className ?? ""}`}
    >
      {BENEFITS.map((benefit) => (
        <li key={benefit.label} className="flex items-center gap-2.5">
          <benefit.icon className="h-5 w-5 shrink-0 text-pulse-600" />
          <span className="text-[0.8125rem] font-medium text-slate-900">{benefit.label}</span>
        </li>
      ))}
    </ul>
  );
}

export function SiteFooter() {
  const year = new Date().getFullYear();

  return (
    <footer className="mt-auto bg-ink-900 text-white">
      <div className="flex flex-col gap-8 px-4 py-10 lg:px-8 xl:px-16">
        {/* Рассылка */}
        <div className="flex flex-col items-start justify-between gap-6 md:flex-row md:items-center">
          <div className="flex flex-col gap-1.5">
            <p className="text-2xl font-bold text-white">
              Хорошие цены. Без лишнего шума.
            </p>
            <p className="max-w-xl text-sm text-ink-muted">
              Новые поступления и предложения для вашей сборки — в одной рассылке.
            </p>
          </div>

          {/* Форма без action: рассылка в проекте не подключена, поэтому
              отправка не должна уводить на несуществующий адрес. */}
          <form className="flex w-full max-w-md gap-2" onSubmit={(event) => event.preventDefault()}>
            <label htmlFor="footer-email" className="sr-only">
              Электронная почта
            </label>
            <input
              id="footer-email"
              type="email"
              name="email"
              placeholder="Ваш e-mail"
              className="h-11 w-full min-w-0 flex-1 rounded-control border border-white/20 bg-white/5 px-3 text-sm text-white placeholder:text-ink-muted focus:border-pulse-400 focus:outline-none"
            />
            <button
              type="submit"
              className="h-11 shrink-0 rounded-control bg-pulse-600 px-[1.125rem] text-[0.9375rem] font-semibold text-white transition-colors hover:bg-pulse-700"
            >
              Подписаться
            </button>
          </form>
        </div>

        <hr className="border-white/10" />

        {/* Ссылки и контакты */}
        <div className="flex flex-col gap-12 lg:flex-row lg:gap-16">
          <div className="flex w-full max-w-[17.5rem] flex-col gap-3.5">
            <a href="/" className="flex items-center gap-2.5">
              <span className="flex h-9 w-9 items-center justify-center rounded-control bg-pulse-600 text-white">
                <Zap className="h-6 w-6" strokeWidth={2} />
              </span>
              <span className="text-[1.8125rem] leading-none font-extrabold tracking-tight text-white">
                пульс
              </span>
            </a>
            <p className="text-sm text-ink-muted">Комплектующие для ваших идей.</p>
            <a
              href="tel:88007002424"
              className="text-[1.375rem] font-bold text-white transition-opacity hover:opacity-70"
            >
              8 800 700-24-24
            </a>
            <p className="text-[0.8125rem] whitespace-pre-line text-ink-muted">
              Ежедневно, 9:00–21:00{"\n"}help@puls-pc.ru
            </p>
          </div>

          <div className="grid flex-1 grid-cols-1 gap-8 sm:grid-cols-3">
            {LINK_GROUPS.map((group) => (
              <div key={group.title} className="flex flex-col gap-3">
                <p className="text-[0.9375rem] font-semibold text-white">{group.title}</p>
                {group.links.map((link) => (
                  <a
                    key={link}
                    href="/catalog"
                    className="text-[0.8125rem] text-ink-muted transition-colors hover:text-white"
                  >
                    {link}
                  </a>
                ))}
              </div>
            ))}
          </div>
        </div>

        <hr className="border-white/10" />

        {/* Правовая информация */}
        <div className="flex flex-col gap-2 text-[0.6875rem] text-ink-muted sm:flex-row sm:items-center sm:justify-between">
          <p>© {year} Пульс. Интернет-магазин компьютерных комплектующих.</p>
          <p className="flex flex-wrap gap-2">
            <a href="/catalog" className="transition-colors hover:text-white">
              Политика конфиденциальности
            </a>
            <span aria-hidden="true">·</span>
            <a href="/catalog" className="transition-colors hover:text-white">
              Публичная оферта
            </a>
            <span aria-hidden="true">·</span>
            <span>МИР / VISA</span>
          </p>
        </div>
      </div>
    </footer>
  );
}