import type { Config } from "@react-router/dev/config";

export default {
  // SSR обязателен: раздел 11 ТЗ требует индексацию карточек товаров,
  // sitemap.xml и уникальные title/description на каждой публичной странице.
  ssr: true,
  appDirectory: "app",
  buildDirectory: "build",
} satisfies Config;