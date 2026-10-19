// @vitest-environment jsdom
import { act, cleanup, render, renderHook, waitFor } from "@testing-library/react";
import { AuthProvider } from "@/components/AuthProvider";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  announceSupabaseClient,
  resetSupabaseLazyForTests,
  SUPABASE_AUTH_STORAGE_KEY,
  type SupabaseBrowserClient,
} from "@/integrations/supabase/lazy";
import { identityErrorKind, SESSION_UNVERIFIED_MESSAGE, useAuth } from "./use-auth";

const mocks = vi.hoisted(() => ({
  client: null as unknown,
  failImport: false,
  getSession: vi.fn(),
  getUser: vi.fn(),
  profile: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  pathname: "/",
  callback: null as null | ((event: string, session: unknown) => void),
}));
vi.mock("next/navigation", () => ({ usePathname: () => mocks.pathname }));
vi.mock("@/integrations/supabase/client", () => ({
  get supabase() {
    if (mocks.failImport) throw new Error("Chunk indisponible");
    return mocks.client;
  },
}));
mocks.client = {
  auth: {
    getSession: mocks.getSession,
    getUser: mocks.getUser,
    onAuthStateChange: (callback: typeof mocks.callback) => {
      mocks.subscribe();
      mocks.callback = callback;
      return { data: { sub: null, subscription: { unsubscribe: mocks.unsubscribe } } };
    },
  },
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: mocks.profile }) }) }),
};
const session = (id: string) => ({ user: { id }, access_token: id });
beforeEach(() => {
  // Une session est stockée : le client Supabase est chargé dès l'arrivée sur la page.
  window.localStorage.setItem(SUPABASE_AUTH_STORAGE_KEY, "{}");
});
afterEach(() => {
  window.localStorage.clear();
  resetSupabaseLazyForTests();
  mocks.failImport = false;
  cleanup();
  vi.resetAllMocks();
  mocks.callback = null;
  mocks.pathname = "/";
});
describe("verified authentication state", () => {
  it("refreshes profile changes once in the background on navigation", async () => {
    mocks.getSession.mockResolvedValue({ data: { session: session("navigation") } });
    mocks.getUser.mockResolvedValue({ data: { user: { id: "navigation" } }, error: null });
    mocks.profile.mockResolvedValue({
      data: { user_id: "navigation", professional_status: "pending" },
      error: null,
    });
    const { result, rerender } = renderHook(() => useAuth(), { wrapper: AuthProvider });
    await waitFor(() => expect(result.current.profile?.professional_status).toBe("pending"));
    mocks.profile.mockResolvedValue({
      data: { user_id: "navigation", professional_status: "approved" },
      error: null,
    });
    mocks.pathname = "/publish";
    rerender();
    expect(result.current.loading).toBe(false);
    expect(result.current.user?.id).toBe("navigation");
    await waitFor(() => expect(result.current.profile?.professional_status).toBe("approved"));
    expect(mocks.subscribe).toHaveBeenCalledTimes(1);
    expect(mocks.getSession).toHaveBeenCalledTimes(1);
    expect(mocks.getUser).toHaveBeenCalledTimes(2);
    expect(mocks.profile).toHaveBeenCalledTimes(2);
  });
  it("reuses verified auth for consumers mounted after navigation and revalidates auth events", async () => {
    mocks.getSession.mockResolvedValue({ data: { session: session("shared-provider") } });
    mocks.getUser.mockResolvedValue({ data: { user: { id: "shared-provider" } }, error: null });
    mocks.profile.mockResolvedValue({ data: { user_id: "shared-provider" }, error: null });
    function Consumer({ name }: { name: string }) {
      const auth = useAuth();
      return (
        <span data-testid={name}>{auth.loading ? "loading" : (auth.user?.id ?? "signed-out")}</span>
      );
    }
    const view = render(
      <AuthProvider>
        <Consumer name="navbar" />
      </AuthProvider>,
    );
    await waitFor(() => expect(view.getByTestId("navbar").textContent).toBe("shared-provider"));
    view.rerender(
      <AuthProvider>
        <Consumer name="navbar" />
        <Consumer name="new-page" />
      </AuthProvider>,
    );
    expect(view.getByTestId("new-page").textContent).toBe("shared-provider");
    expect(mocks.subscribe).toHaveBeenCalledTimes(1);
    expect(mocks.getSession).toHaveBeenCalledTimes(1);
    expect(mocks.getUser).toHaveBeenCalledTimes(1);
    expect(mocks.profile).toHaveBeenCalledTimes(1);
    act(() => mocks.callback?.("TOKEN_REFRESHED", session("shared-provider")));
    await waitFor(() => expect(mocks.profile).toHaveBeenCalledTimes(2));
    act(() => mocks.callback?.("SIGNED_OUT", null));
    expect(view.getByTestId("navbar").textContent).toBe("signed-out");
    expect(view.getByTestId("new-page").textContent).toBe("signed-out");
    view.unmount();
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("clears the shared identity while a different account is being verified", async () => {
    mocks.getSession.mockResolvedValue({ data: { session: session("first-provider") } });
    mocks.getUser.mockResolvedValue({ data: { user: { id: "first-provider" } }, error: null });
    mocks.profile.mockResolvedValue({ data: { user_id: "first-provider" }, error: null });
    const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
    await waitFor(() => expect(result.current.user?.id).toBe("first-provider"));
    let finish!: (value: unknown) => void;
    mocks.getUser.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    act(() => mocks.callback?.("SIGNED_IN", session("second-provider")));
    expect(result.current).toMatchObject({
      loading: true,
      user: null,
      session: null,
      profile: null,
    });
    mocks.profile.mockResolvedValue({ data: { user_id: "second-provider" }, error: null });
    await act(async () => finish({ data: { user: { id: "second-provider" } }, error: null }));
    await waitFor(() => expect(result.current.user?.id).toBe("second-provider"));
    expect(result.current.profile?.user_id).toBe("second-provider");
  });
  it("ends initial loading when session storage fails", async () => {
    mocks.getSession.mockRejectedValue(new Error("Storage unavailable"));
    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.session).toBeNull();
    expect(result.current.authError).toBeTruthy();
  });
  it("keeps a verified identity usable when the profile request rejects", async () => {
    mocks.getSession.mockResolvedValue({ data: { session: session("verified") } });
    mocks.getUser.mockResolvedValue({ data: { user: { id: "verified" } }, error: null });
    mocks.profile.mockRejectedValue(new Error("Network unavailable"));
    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.user?.id).toBe("verified");
    expect(result.current.authError).toBeNull();
  });

  it("ends loading without exposing a session when identity verification rejects", async () => {
    mocks.getSession.mockResolvedValue({ data: { session: session("network-error") } });
    mocks.getUser.mockRejectedValue(new Error("Network unavailable"));
    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.session).toBeNull();
    expect(result.current.profile).toBeNull();
    expect(result.current.authError).toContain("session n’a pas pu être vérifiée");
    expect(mocks.profile).not.toHaveBeenCalled();
  });

  it("shares concurrent identity and profile reads without caching a later verification", async () => {
    mocks.getSession.mockResolvedValue({ data: { session: session("shared") } });
    mocks.getUser.mockResolvedValue({ data: { user: { id: "shared" } }, error: null });
    mocks.profile.mockResolvedValue({ data: { user_id: "shared" }, error: null });
    const first = renderHook(() => useAuth());
    const second = renderHook(() => useAuth());
    await waitFor(() => {
      expect(first.result.current.loading).toBe(false);
      expect(second.result.current.loading).toBe(false);
    });
    expect(mocks.getUser).toHaveBeenCalledTimes(1);
    expect(mocks.profile).toHaveBeenCalledTimes(1);
    act(() => mocks.callback?.("TOKEN_REFRESHED", session("shared")));
    await waitFor(() => expect(mocks.profile).toHaveBeenCalledTimes(2));
    expect(mocks.getUser).toHaveBeenCalledTimes(2);
  });

  it("keeps the current page mounted while the same account refreshes its token", async () => {
    mocks.getSession.mockResolvedValue({ data: { session: session("same") } });
    mocks.getUser.mockResolvedValue({ data: { user: { id: "same" } }, error: null });
    mocks.profile.mockResolvedValue({ data: { user_id: "same" }, error: null });
    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.loading).toBe(false));
    let finish!: (value: unknown) => void;
    mocks.getUser.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    act(() => mocks.callback?.("TOKEN_REFRESHED", session("same")));
    expect(result.current.loading).toBe(false);
    expect(result.current.user?.id).toBe("same");
    expect(result.current.session?.user.id).toBe("same");
    await act(async () => finish({ data: { user: { id: "same" } }, error: null }));
    expect(result.current.loading).toBe(false);
  });

  it("does not expose a session rejected by the auth server", async () => {
    mocks.getSession.mockResolvedValue({ data: { session: session("expired") } });
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: new Error("expired") });
    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.session).toBeNull();
    expect(result.current.user).toBeNull();
    expect(mocks.profile).not.toHaveBeenCalled();
  });

  it("ignores a profile response received after sign-out", async () => {
    let resolveProfile!: (value: unknown) => void;
    mocks.getSession.mockResolvedValue({ data: { session: session("first") } });
    mocks.getUser.mockResolvedValue({ data: { user: { id: "first" } }, error: null });
    mocks.profile.mockReturnValue(
      new Promise((resolve) => {
        resolveProfile = resolve;
      }),
    );
    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(mocks.profile).toHaveBeenCalled());
    act(() => mocks.callback?.("SIGNED_OUT", null));
    await act(async () => resolveProfile({ data: { user_id: "first" }, error: null }));
    expect(result.current).toMatchObject({
      session: null,
      user: null,
      profile: null,
      loading: false,
    });
  });

  it("keeps the latest account when an earlier verification finishes late", async () => {
    let resolveFirst!: (value: unknown) => void;
    mocks.getSession.mockResolvedValue({ data: { session: session("first") } });
    mocks.getUser
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockResolvedValue({ data: { user: { id: "second" } }, error: null });
    mocks.profile.mockResolvedValue({ data: { user_id: "second" }, error: null });
    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(mocks.getUser).toHaveBeenCalledTimes(1));
    act(() => mocks.callback?.("SIGNED_IN", session("second")));
    await waitFor(() => expect(result.current.user?.id).toBe("second"));
    await act(async () => resolveFirst({ data: { user: { id: "first" } }, error: null }));
    expect(result.current.session?.user.id).toBe("second");
    expect(result.current.profile?.user_id).toBe("second");
  });

  it("n'attend pas supabase-js pour un visiteur anonyme et ne charge pas le client", async () => {
    window.localStorage.clear();
    const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current).toMatchObject({ session: null, user: null, profile: null });
    expect(mocks.subscribe).not.toHaveBeenCalled();
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  it("charge le client quand l'adresse porte un retour d'authentification", async () => {
    window.localStorage.clear();
    window.history.replaceState(null, "", "/reinitialisation#access_token=abc&type=recovery");
    mocks.getSession.mockResolvedValue({ data: { session: session("recovery") } });
    mocks.getUser.mockResolvedValue({ data: { user: { id: "recovery" } }, error: null });
    mocks.profile.mockResolvedValue({ data: { user_id: "recovery" }, error: null });
    try {
      const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
      await waitFor(() => expect(result.current.user?.id).toBe("recovery"));
      expect(mocks.getSession).toHaveBeenCalledTimes(1);
    } finally {
      window.history.replaceState(null, "", "/");
    }
  });

  it("voit une connexion faite sur une page qui charge le client plus tard", async () => {
    window.localStorage.clear();
    mocks.getSession.mockResolvedValue({ data: { session: null } });
    mocks.getUser.mockResolvedValue({ data: { user: { id: "late" } }, error: null });
    mocks.profile.mockResolvedValue({ data: { user_id: "late" }, error: null });
    const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mocks.subscribe).not.toHaveBeenCalled();

    // La page de connexion importe le client : le fournisseur s'y abonne.
    act(() => announceSupabaseClient(mocks.client as SupabaseBrowserClient));
    await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(1));
    act(() => mocks.callback?.("SIGNED_IN", session("late")));
    await waitFor(() => expect(result.current.user?.id).toBe("late"));
    expect(result.current.profile?.user_id).toBe("late");
  });

  it("signale l'échec de chargement du client quand une session est stockée", async () => {
    mocks.failImport = true;
    const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.authError).toBeTruthy();
    expect(result.current.user).toBeNull();
  });

  describe("session impossible à vérifier", () => {
    it("distingue une session rejetée par le serveur d'une indisponibilité", () => {
      expect(identityErrorKind({ name: "AuthApiError", status: 401 })).toBe("expired");
      expect(identityErrorKind({ name: "AuthApiError", status: 403 })).toBe("expired");
      expect(identityErrorKind({ name: "AuthSessionMissingError", status: 400 })).toBe("expired");
      expect(identityErrorKind({ name: "AuthRetryableFetchError", status: 0 })).toBe("unavailable");
      expect(identityErrorKind({ name: "AuthRetryableFetchError", status: 503 })).toBe(
        "unavailable",
      );
      expect(identityErrorKind({ status: 408 })).toBe("unavailable");
      expect(identityErrorKind({ status: 429 })).toBe("unavailable");
      expect(identityErrorKind(new Error("Failed to fetch"))).toBe("unavailable");
      expect(identityErrorKind(null)).toBe("unavailable");
    });

    it("utilise un seul message neutre, sans renvoyer à l'annonce", async () => {
      mocks.getSession.mockResolvedValue({ data: { session: session("expired") } });
      mocks.getUser.mockResolvedValue({
        data: { user: null },
        error: { name: "AuthApiError", status: 401, message: "invalid JWT" },
      });
      const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
      await waitFor(() => expect(result.current.authError).toBe(SESSION_UNVERIFIED_MESSAGE));
      expect(SESSION_UNVERIFIED_MESSAGE).toBe("Votre session n’a pas pu être vérifiée.");
      expect(result.current.authErrorKind).toBe("expired");
      expect(result.current.session).toBeNull();
      expect(result.current.loading).toBe(false);
    });

    it("réessaie : le retour du réseau rétablit la session et efface l'erreur", async () => {
      mocks.getSession.mockResolvedValue({ data: { session: session("retry") } });
      mocks.getUser.mockRejectedValueOnce(new Error("Failed to fetch"));
      mocks.getUser.mockResolvedValue({ data: { user: { id: "retry" } }, error: null });
      mocks.profile.mockResolvedValue({ data: { user_id: "retry" }, error: null });
      const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
      await waitFor(() => expect(result.current.authErrorKind).toBe("unavailable"));
      expect(result.current.user).toBeNull();

      act(() => result.current.retry());
      await waitFor(() => expect(result.current.user?.id).toBe("retry"));
      expect(result.current.authError).toBeNull();
      expect(result.current.authErrorKind).toBeNull();
      // La session stockée est relue une seule fois : la revérification repart de celle en mémoire.
      expect(mocks.getSession).toHaveBeenCalledTimes(1);
      expect(mocks.getUser).toHaveBeenCalledTimes(2);
    });

    it("garde l'identité déjà vérifiée quand une revérification échoue faute de réseau", async () => {
      mocks.getSession.mockResolvedValue({ data: { session: session("blip") } });
      mocks.getUser.mockResolvedValue({ data: { user: { id: "blip" } }, error: null });
      mocks.profile.mockResolvedValue({ data: { user_id: "blip" }, error: null });
      const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
      await waitFor(() => expect(result.current.user?.id).toBe("blip"));

      mocks.getUser.mockRejectedValue(new Error("Failed to fetch"));
      act(() => mocks.callback?.("TOKEN_REFRESHED", session("blip")));
      await waitFor(() => expect(result.current.authErrorKind).toBe("unavailable"));
      // Ni la session ni le profil ne sont vidés, et la page n'attend pas : seul le bandeau paraît.
      expect(result.current.user?.id).toBe("blip");
      expect(result.current.session?.user.id).toBe("blip");
      expect(result.current.profile?.user_id).toBe("blip");
      expect(result.current.loading).toBe(false);

      mocks.getUser.mockResolvedValue({ data: { user: { id: "blip" } }, error: null });
      act(() => result.current.retry());
      await waitFor(() => expect(result.current.authError).toBeNull());
      expect(result.current.user?.id).toBe("blip");
    });

    it("retire l'identité quand le serveur rejette la session déjà vérifiée", async () => {
      mocks.getSession.mockResolvedValue({ data: { session: session("revoked") } });
      mocks.getUser.mockResolvedValue({ data: { user: { id: "revoked" } }, error: null });
      mocks.profile.mockResolvedValue({ data: { user_id: "revoked" }, error: null });
      const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
      await waitFor(() => expect(result.current.user?.id).toBe("revoked"));

      mocks.getUser.mockResolvedValue({
        data: { user: null },
        error: { name: "AuthApiError", status: 401, message: "session revoked" },
      });
      act(() => mocks.callback?.("TOKEN_REFRESHED", session("revoked")));
      await waitFor(() => expect(result.current.authErrorKind).toBe("expired"));
      expect(result.current.user).toBeNull();
      expect(result.current.session).toBeNull();
    });

    it("signale une session stockée que supabase-js n'a pas pu renouveler", async () => {
      mocks.getSession.mockResolvedValue({
        data: { session: null },
        error: { name: "AuthRetryableFetchError", status: 0, message: "Failed to fetch" },
      });
      const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
      await waitFor(() => expect(result.current.authErrorKind).toBe("unavailable"));
      expect(result.current.loading).toBe(false);

      mocks.getSession.mockResolvedValue({ data: { session: session("renewed") } });
      mocks.getUser.mockResolvedValue({ data: { user: { id: "renewed" } }, error: null });
      mocks.profile.mockResolvedValue({ data: { user_id: "renewed" }, error: null });
      act(() => result.current.retry());
      await waitFor(() => expect(result.current.user?.id).toBe("renewed"));
      expect(mocks.getSession).toHaveBeenCalledTimes(2);
    });

    it("relance le chargement du client quand il a échoué, sans rester bloqué en vérification", async () => {
      mocks.failImport = true;
      const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
      await waitFor(() => expect(result.current.authErrorKind).toBe("unavailable"));

      // Le chargement échoue encore : l'erreur est reposée et la page n'attend pas indéfiniment.
      act(() => result.current.retry());
      await waitFor(() => expect(result.current.authErrorKind).toBe("unavailable"));
      expect(result.current.loading).toBe(false);
      expect(result.current.user).toBeNull();
    });

    it("n'a rien à relancer pour un visiteur anonyme", async () => {
      window.localStorage.clear();
      const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.authError).toBeNull();
      expect(result.current.authErrorKind).toBeNull();
      expect(typeof result.current.retry).toBe("function");
    });
  });

  describe("visiteur anonyme : synchronisation avec les autres onglets", () => {
    function setVisibility(state: "visible" | "hidden") {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
    }
    function storageEvent(init: StorageEventInit) {
      return new StorageEvent("storage", { storageArea: window.localStorage, ...init });
    }
    function signedInElsewhere() {
      mocks.getSession.mockResolvedValue({ data: { session: session("other-tab") } });
      mocks.getUser.mockResolvedValue({ data: { user: { id: "other-tab" } }, error: null });
      mocks.profile.mockResolvedValue({ data: { user_id: "other-tab" }, error: null });
    }
    afterEach(() => {
      delete (document as { visibilityState?: unknown }).visibilityState;
    });

    it("charge le client et retrouve la session quand un autre onglet se connecte (storage)", async () => {
      window.localStorage.clear();
      signedInElsewhere();
      const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(mocks.getSession).not.toHaveBeenCalled();

      window.localStorage.setItem(SUPABASE_AUTH_STORAGE_KEY, "{}");
      act(() => {
        window.dispatchEvent(
          storageEvent({ key: SUPABASE_AUTH_STORAGE_KEY, oldValue: null, newValue: "{}" }),
        );
      });
      await waitFor(() => expect(result.current.user?.id).toBe("other-tab"));
      expect(mocks.subscribe).toHaveBeenCalledTimes(1);
      expect(mocks.getSession).toHaveBeenCalledTimes(1);
    });

    it("ignore les événements storage d'une autre clé ou sans nouvelle valeur", async () => {
      window.localStorage.clear();
      signedInElsewhere();
      const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
      await waitFor(() => expect(result.current.loading).toBe(false));

      act(() => {
        window.dispatchEvent(storageEvent({ key: "autre-cle", newValue: "x" }));
        window.dispatchEvent(
          storageEvent({ key: SUPABASE_AUTH_STORAGE_KEY, oldValue: "{}", newValue: null }),
        );
        window.dispatchEvent(storageEvent({ key: null, newValue: null }));
      });
      await act(async () => {});
      expect(mocks.subscribe).not.toHaveBeenCalled();
      expect(mocks.getSession).not.toHaveBeenCalled();
    });

    it("charge le client au retour de visibilité si un indice de session est apparu", async () => {
      window.localStorage.clear();
      signedInElsewhere();
      setVisibility("hidden");
      const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
      await waitFor(() => expect(result.current.loading).toBe(false));

      // Onglet caché, ou visible mais toujours sans indice : rien n'est chargé.
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      setVisibility("visible");
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await act(async () => {});
      expect(mocks.subscribe).not.toHaveBeenCalled();

      window.localStorage.setItem(SUPABASE_AUTH_STORAGE_KEY, "{}");
      setVisibility("hidden");
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await act(async () => {});
      expect(mocks.subscribe).not.toHaveBeenCalled();

      setVisibility("visible");
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await waitFor(() => expect(result.current.user?.id).toBe("other-tab"));
      expect(mocks.subscribe).toHaveBeenCalledTimes(1);
    });

    it("retire ses écouteurs une fois le client chargé et au démontage", async () => {
      window.localStorage.clear();
      const addWindow = vi.spyOn(window, "addEventListener");
      const removeWindow = vi.spyOn(window, "removeEventListener");
      const addDocument = vi.spyOn(document, "addEventListener");
      const removeDocument = vi.spyOn(document, "removeEventListener");
      const handler = (spy: typeof addWindow, type: string) =>
        spy.mock.calls.find(([name]) => name === type)?.[1];
      try {
        // Démontage avant tout chargement du client.
        const first = renderHook(() => useAuth());
        await waitFor(() => expect(first.result.current.loading).toBe(false));
        const onStorage = handler(addWindow, "storage");
        const onVisibility = handler(addDocument, "visibilitychange");
        expect(onStorage).toBeTypeOf("function");
        expect(onVisibility).toBeTypeOf("function");
        first.unmount();
        expect(handler(removeWindow, "storage")).toBe(onStorage);
        expect(handler(removeDocument, "visibilitychange")).toBe(onVisibility);

        // Client chargé par une autre page : les écouteurs sont retirés sans attendre le démontage.
        removeWindow.mockClear();
        removeDocument.mockClear();
        mocks.getSession.mockResolvedValue({ data: { session: null } });
        const second = renderHook(() => useAuth());
        await waitFor(() => expect(second.result.current.loading).toBe(false));
        act(() => announceSupabaseClient(mocks.client as SupabaseBrowserClient));
        await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(1));
        expect(handler(removeWindow, "storage")).toBeTypeOf("function");
        expect(handler(removeDocument, "visibilitychange")).toBeTypeOf("function");
        const removedOnce = removeWindow.mock.calls.filter(([name]) => name === "storage").length;
        second.unmount();
        expect(removeWindow.mock.calls.filter(([name]) => name === "storage")).toHaveLength(
          removedOnce,
        );

        // Après le démontage, un événement storage ne charge plus rien.
        mocks.subscribe.mockClear();
        window.dispatchEvent(
          storageEvent({ key: SUPABASE_AUTH_STORAGE_KEY, oldValue: null, newValue: "{}" }),
        );
        await act(async () => {});
        expect(mocks.subscribe).not.toHaveBeenCalled();
      } finally {
        addWindow.mockRestore();
        removeWindow.mockRestore();
        addDocument.mockRestore();
        removeDocument.mockRestore();
      }
    });
  });
});
