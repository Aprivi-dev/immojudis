// @vitest-environment jsdom
import { act, cleanup, render, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "@/components/AuthProvider";
import { resetSupabaseLazyForTests } from "@/integrations/supabase/lazy";
import { useAuth } from "./use-auth";

// Le client Supabase est simulé derrière `getSupabase` : on compte les chargements du client et
// les vérifications d'identité (`getUser`) pour s'assurer que le magasin partagé n'en ajoute pas.
const mocks = vi.hoisted(() => ({
  getSupabase: vi.fn(),
  getSession: vi.fn(),
  getUser: vi.fn(),
  profile: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  pathname: "/",
  callback: null as null | ((event: string, session: unknown) => void),
}));
vi.mock("next/navigation", () => ({ usePathname: () => mocks.pathname }));
vi.mock("@/integrations/supabase/lazy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/integrations/supabase/lazy")>()),
  getSupabase: mocks.getSupabase,
  hasSupabaseAuthHint: () => true,
}));

const client = {
  auth: {
    getSession: mocks.getSession,
    getUser: mocks.getUser,
    onAuthStateChange: (callback: typeof mocks.callback) => {
      mocks.subscribe();
      mocks.callback = callback;
      return { data: { subscription: { unsubscribe: mocks.unsubscribe } } };
    },
  },
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: mocks.profile }) }) }),
};
const session = (id: string) => ({ user: { id }, access_token: id });

function signIn(id: string) {
  mocks.getSession.mockResolvedValue({ data: { session: session(id) } });
  mocks.getUser.mockResolvedValue({ data: { user: { id } }, error: null });
  mocks.profile.mockResolvedValue({ data: { user_id: id }, error: null });
}

type Seen = { user: string | null; loading: boolean };

// Consommateur qui note chaque rendu : ce que voit réellement l'écran, pas seulement l'état final.
function recorder() {
  const seen: Seen[] = [];
  function Consumer({ name = "consumer" }: { name?: string }) {
    const { user, loading } = useAuth();
    seen.push({ user: user?.id ?? null, loading });
    return <span data-testid={name}>{loading ? "loading" : (user?.id ?? "signed-out")}</span>;
  }
  return { seen, Consumer };
}

beforeEach(() => {
  mocks.getSupabase.mockImplementation(() => Promise.resolve(client));
});
afterEach(() => {
  cleanup();
  resetSupabaseLazyForTests();
  vi.resetAllMocks();
  mocks.callback = null;
  mocks.pathname = "/";
});

describe("useAuth sous AuthProvider (client Supabase simulé)", () => {
  it("donne l'état réel, et non loading: true, à un composant monté après la vérification", async () => {
    signIn("a");
    const early = recorder();
    const late = recorder();
    const view = render(
      <AuthProvider>
        <early.Consumer name="early" />
      </AuthProvider>,
    );
    await waitFor(() => expect(view.getByTestId("early").textContent).toBe("a"));

    view.rerender(
      <AuthProvider>
        <early.Consumer name="early" />
        <late.Consumer name="late" />
      </AuthProvider>,
    );

    expect(view.getByTestId("late").textContent).toBe("a");
    // Dès son premier rendu : jamais d'image « en vérification » ni d'anonyme.
    expect(late.seen).toEqual([{ user: "a", loading: false }]);
  });

  it("retire l'ancien utilisateur à la déconnexion", async () => {
    signIn("a");
    const { seen, Consumer } = recorder();
    const view = render(
      <AuthProvider>
        <Consumer />
      </AuthProvider>,
    );
    await waitFor(() => expect(view.getByTestId("consumer").textContent).toBe("a"));

    const mark = seen.length;
    act(() => mocks.callback?.("SIGNED_OUT", null));

    expect(view.getByTestId("consumer").textContent).toBe("signed-out");
    expect(seen.slice(mark).length).toBeGreaterThan(0);
    expect(seen.slice(mark).some((state) => state.user === "a")).toBe(false);
    expect(seen.at(-1)).toEqual({ user: null, loading: false });
  });

  it("ne montre plus A à aucun rendu une fois passé au compte B", async () => {
    signIn("a");
    const first = recorder();
    const second = recorder();
    const view = render(
      <AuthProvider>
        <first.Consumer name="first" />
        <second.Consumer name="second" />
      </AuthProvider>,
    );
    await waitFor(() => expect(view.getByTestId("first").textContent).toBe("a"));
    expect(view.getByTestId("second").textContent).toBe("a");

    let finish!: (value: unknown) => void;
    mocks.getUser.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    mocks.profile.mockResolvedValue({ data: { user_id: "b" }, error: null });
    const marks = [first.seen.length, second.seen.length];
    act(() => mocks.callback?.("SIGNED_IN", session("b")));

    // Pendant la vérification de B : ni A ni B, en cours de vérification.
    expect(view.getByTestId("first").textContent).toBe("loading");
    expect(view.getByTestId("second").textContent).toBe("loading");

    await act(async () => finish({ data: { user: { id: "b" } }, error: null }));
    await waitFor(() => expect(view.getByTestId("first").textContent).toBe("b"));
    expect(view.getByTestId("second").textContent).toBe("b");

    for (const [index, { seen }] of [first, second].entries()) {
      const after = seen.slice(marks[index]);
      expect(after.length).toBeGreaterThan(0);
      expect(after.some((state) => state.user === "a")).toBe(false);
      expect(after.at(-1)).toEqual({ user: "b", loading: false });
    }
  });

  it("ne lance pas de seconde vérification d'identité pour un useAuth() enfant (C7)", async () => {
    signIn("a");
    const { Consumer } = recorder();
    const view = render(
      <AuthProvider>
        <Consumer name="navbar" />
        <div>
          <Consumer name="page" />
        </div>
      </AuthProvider>,
    );
    await waitFor(() => expect(view.getByTestId("page").textContent).toBe("a"));
    expect(view.getByTestId("navbar").textContent).toBe("a");

    expect(mocks.getSupabase).toHaveBeenCalledTimes(1);
    expect(mocks.getSession).toHaveBeenCalledTimes(1);
    expect(mocks.getUser).toHaveBeenCalledTimes(1);
    expect(mocks.profile).toHaveBeenCalledTimes(1);
    expect(mocks.subscribe).toHaveBeenCalledTimes(1);
  });
});

describe("useAuth hors AuthProvider", () => {
  it("vérifie l'identité lui-même (chemin autonome)", async () => {
    signIn("solo");
    const { result } = renderHook(() => useAuth());
    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.user?.id).toBe("solo"));
    expect(result.current.loading).toBe(false);
    expect(result.current.profile?.user_id).toBe("solo");
    expect(mocks.getSupabase).toHaveBeenCalledTimes(1);
    expect(mocks.getUser).toHaveBeenCalledTimes(1);
    expect(mocks.subscribe).toHaveBeenCalledTimes(1);
  });
});
