/**
 * Стор сессии: пользователь, токены, login/register/logout и гидрация из
 * localStorage.
 *
 * Токены дублируются в cookie (см. `~/lib/auth-token`), потому что SSR-loader
 * не видит localStorage. Источник истины — localStorage, cookie нужна только
 * для серверных loader/action.
 *
 * Имя модуля HTTP-клиента — `api-browser`, а НЕ `api.client`: React Router
 * вырезает из серверного бандла всё, что оканчивается на `.client.ts`,
 * и импорт превратился бы в `undefined` — падение было бы отложенным
 * (только при первом вызове в браузере после успешного SSR).
 */
import { create } from "zustand";

import type { AuthPayload, LoginInput, RegisterInput, TokenPair, UserOut } from "~/lib/auth";
import { apiFetch, registerAuthBridge } from "~/lib/api-browser";
import {
  DEFAULT_MAX_AGE_SECONDS,
  clearAccessCookie,
  writeAccessCookie,
} from "~/lib/auth-token";

const STORAGE_KEY = "pulse.auth.v1";

type PersistedState = {
  user: UserOut | null;
  accessToken: string | null;
  refreshToken: string | null;
  /** Момент протухания access-токена (мс). Нужен, чтобы cookie не пережила токен. */
  expiresAt: number | null;
};

type AuthStatus = "anonymous" | "loading" | "authenticated";

type AuthState = PersistedState & {
  status: AuthStatus;
  /** Читает токены из localStorage. Вызывается один раз на клиенте из SiteHeader. */
  hydrate: () => void;
  setUser: (user: UserOut) => void;
  setSession: (payload: AuthPayload) => void;
  applyTokens: (tokens: TokenPair) => void;
  clear: () => void;
  login: (input: LoginInput) => Promise<void>;
  register: (input: RegisterInput) => Promise<void>;
  logout: () => Promise<void>;
  fetchMe: () => Promise<void>;
};

/** Читает состояние из localStorage: мусор в хранилище не должен ронять рендер. */
function readPersisted(): PersistedState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const candidate = parsed as Partial<PersistedState>;
    return {
      user: candidate.user && typeof candidate.user === "object" ? candidate.user : null,
      accessToken: typeof candidate.accessToken === "string" ? candidate.accessToken : null,
      refreshToken: typeof candidate.refreshToken === "string" ? candidate.refreshToken : null,
      expiresAt: typeof candidate.expiresAt === "number" ? candidate.expiresAt : null,
    };
  } catch {
    return null;
  }
}

function writePersisted(state: PersistedState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Приватный режим и переполненное хранилище не должны ломать авторизацию:
    // сессия живёт в памяти до конца вкладки, cookie тоже продублирован.
  }
}

/** Есть ли уже токены — тогда повторная гидрация не нужна. */
let hydrated = false;

/** Остаток жизни access-токена в секундах — им задаётся Max-Age cookie. */
function remainingSeconds(expiresAt: number | null): number {
  if (!expiresAt) return DEFAULT_MAX_AGE_SECONDS;
  return Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
}

export const useAuthStore = create<AuthState>()((set, get) => {
  /**
   * Единственная точка, где состояние синхронизируется с localStorage и cookie.
   * Cookie живёт ровно столько же, сколько токен: иначе серверный loader будет
   * считать пользователя гостем либо, наоборот, предъявлять заведомо мёртвый токен.
   */
  const persist = (state: PersistedState) => {
    writePersisted(state);
    if (state.accessToken) {
      // Max-Age считаем по остатку жизни токена, но не меньше часа: cookie,
      // которая умерла бы раньше токена, оставляет страницы без сессии, хотя
      // токен ещё жив (см. DEFAULT_MAX_AGE_SECONDS в `~/lib/auth-token`).
      const remaining = remainingSeconds(state.expiresAt);
      writeAccessCookie(state.accessToken, Math.max(remaining, DEFAULT_MAX_AGE_SECONDS));
    } else {
      clearAccessCookie();
    }
  };

  const snapshot = (): PersistedState => ({
    user: get().user,
    accessToken: get().accessToken,
    refreshToken: get().refreshToken,
    expiresAt: get().expiresAt,
  });

  return {
    user: null,
    accessToken: null,
    refreshToken: null,
    expiresAt: null,
    status: "anonymous",

    hydrate: () => {
      // На сервере localStorage не существует: SSR работает с cookie,
      // а клиент дозаполняет стор из хранилища после монтирования.
      if (hydrated || typeof window === "undefined") return;
      hydrated = true;

      const stored = readPersisted();
      if (!stored?.accessToken) return;

      set({ ...stored, status: "authenticated" });
      // Cookie могла истечь или быть удалена вручную — восстанавливаем её,
      // иначе следующая серверная загрузка выкинет пользователя на /login.
      writeAccessCookie(stored.accessToken, remainingSeconds(stored.expiresAt));
    },

    setUser: (user) => {
      set({ user });
      persist(snapshot());
    },

    setSession: ({ user, tokens }) => {
      set({
        user,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: Date.now() + tokens.expires_in * 1000,
        status: "authenticated",
      });
      persist(snapshot());
    },

    applyTokens: (tokens) => {
      set({
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: Date.now() + tokens.expires_in * 1000,
        status: "authenticated",
      });
      persist(snapshot());
    },

    clear: () => {
      set({ user: null, accessToken: null, refreshToken: null, expiresAt: null, status: "anonymous" });
      persist(snapshot());
    },

    login: async (input) => {
      const payload = await apiFetch<AuthPayload>("/auth/login", {
        method: "POST",
        json: { email: input.email, password: input.password },
      });
      get().setSession(payload);
    },

    register: async (input) => {
      const payload = await apiFetch<AuthPayload>("/auth/register", {
        method: "POST",
        json: {
          first_name: input.first_name,
          last_name: input.last_name,
          email: input.email,
          phone: input.phone,
          password: input.password,
          password_confirm: input.password_confirm,
          accept_policy: input.accept_policy,
        },
      });
      get().setSession(payload);
    },

    logout: async () => {
      const { refreshToken } = get();
      try {
        await apiFetch<void>("/auth/logout", {
          method: "POST",
          json: { refresh_token: refreshToken },
          // Отказ logout не должен мешать выйти из аккаунта: сессия всё равно
          // заканчивается локально, поэтому ошибку глушим и чистим стор.
          retryOnUnauthorized: false,
        });
      } catch {
        // ignore — локальная очистка ниже всё равно выполнится
      }
      get().clear();
    },

    fetchMe: async () => {
      const user = await apiFetch<UserOut>("/auth/me");
      get().setUser(user);
    },
  };
});

// Регистрируем мост после создания стора: api.client читает токены через него,
// а не импортирует стор напрямую — иначе возник бы цикл module-ов.
registerAuthBridge({
  getAccessToken: () => useAuthStore.getState().accessToken,
  getRefreshToken: () => useAuthStore.getState().refreshToken,
  applyTokens: (tokens) => useAuthStore.getState().applyTokens(tokens),
  clear: () => useAuthStore.getState().clear(),
});