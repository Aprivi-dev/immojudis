// @vitest-environment jsdom
import { Suspense, use } from "react";
import { act } from "@testing-library/react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "@/components/AuthProvider";
import { resetSupabaseLazyForTests } from "@/integrations/supabase/lazy";
import { createAuthStore, useAuth } from "./use-auth";

vi.mock("next/navigation", () => ({ usePathname: () => "/sales" }));

let fetches = 0;
const catalogueQuery = {
  queryKey: ["catalogue"],
  queryFn: async () => {
    fetches += 1;
    return "liste";
  },
  staleTime: 0,
};

// Page de catalogue réduite à l'essentiel : une frontière Suspense (celle de `loading.tsx`) dont
// le contenu dépend d'un module « arrivé trop tard » (promesse en attente côté client, déjà
// résolue côté serveur) et qui lit l'état d'authentification. Le contenu change de forme selon
// `loading`, comme une vraie liste : un premier rendu client qui ne verrait pas `loading: true`
// ne concorderait pas avec le HTML serveur.
function Results({ code }: { code: Promise<string> }) {
  const label = use(code);
  const { loading, user } = useAuth();
  const query = useQuery(catalogueQuery);
  return (
    <ul data-testid="results" data-auth={loading ? "loading" : user ? "user" : "anonymous"}>
      <li>{label}</li>
      <li>{query.data ?? "serveur"}</li>
      {loading ? <li>vérification</li> : <li>{user ? "connecté" : "visiteur"}</li>}
    </ul>
  );
}

// Observateur React Query monté hors de la frontière suspendue : lui seul est réellement abonné
// pendant que `Results` attend son code, et il réagit donc à une invalidation.
function CatalogueObserver() {
  useQuery(catalogueQuery);
  return null;
}

function Page({ code, queryClient }: { code: Promise<string>; queryClient: QueryClient }) {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <CatalogueObserver />
        <Suspense fallback={<div data-testid="skeleton">squelette</div>}>
          <Results code={code} />
        </Suspense>
      </AuthProvider>
    </QueryClientProvider>
  );
}

function resolvedPromise(value: string) {
  // `use` lit ce statut sans suspendre : le serveur rend la liste d'emblée.
  return Object.assign(Promise.resolve(value), { status: "fulfilled", value });
}

function newQueryClient() {
  const client = new QueryClient();
  client.setQueryData(["catalogue"], "liste");
  return client;
}

const roots: Root[] = [];

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  vi.restoreAllMocks();
  window.localStorage.clear();
  resetSupabaseLazyForTests();
  document.body.innerHTML = "";
  fetches = 0;
});

describe("hydratation du catalogue sous une frontière Suspense", () => {
  async function hydrateWithLateCode() {
    const serverHtml = renderToString(
      <Page code={resolvedPromise("annonces")} queryClient={newQueryClient()} />,
    );
    expect(serverHtml).toContain('data-auth="loading"');
    const container = document.createElement("div");
    container.innerHTML = serverHtml;
    document.body.append(container);
    const serverList = container.querySelector('[data-testid="results"]');
    expect(serverList).not.toBeNull();

    let arrive!: (value: string) => void;
    const code = new Promise<string>((resolve) => {
      arrive = resolve;
    });
    const onRecoverableError = vi.fn();
    // Un écart entre le HTML serveur et le premier rendu client s'annonce par console.error.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const queryClient = newQueryClient();
    await act(async () => {
      roots.push(
        hydrateRoot(container, <Page code={code} queryClient={queryClient} />, {
          onRecoverableError,
        }),
      );
    });
    return { container, serverList, arrive, onRecoverableError, consoleError, queryClient };
  }

  it("concorde avec le HTML serveur quand l'authentification d'un visiteur anonyme se résout avant l'arrivée du code", async () => {
    const { container, serverList, arrive, onRecoverableError, consoleError } =
      await hydrateWithLateCode();

    // L'effet d'AuthProvider a déjà rendu l'état anonyme ; la frontière n'est pas encore hydratée.
    expect(container.querySelector('[data-testid="skeleton"]')).toBeNull();
    expect(container.querySelector('[data-testid="results"]')).toBe(serverList);

    await act(async () => arrive("annonces"));

    expect(container.querySelector('[data-testid="skeleton"]')).toBeNull();
    // Même nœud : hydraté, pas recréé ; et il montre désormais l'état résolu.
    expect(container.querySelector('[data-testid="results"]')).toBe(serverList);
    expect(serverList?.getAttribute("data-auth")).toBe("anonymous");
    expect(serverList?.textContent).toContain("visiteur");
    expect(onRecoverableError).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("concorde aussi avec le HTML serveur quand React Query est invalidé avant l'arrivée du code", async () => {
    const { container, serverList, arrive, queryClient, onRecoverableError, consoleError } =
      await hydrateWithLateCode();

    // L'observateur hors frontière est bien actif : l'invalidation relance réellement la requête.
    const before = fetches;
    await act(async () => {
      await queryClient.invalidateQueries();
    });
    expect(fetches).toBeGreaterThan(before);
    expect(container.querySelector('[data-testid="skeleton"]')).toBeNull();
    expect(container.querySelector('[data-testid="results"]')).toBe(serverList);

    await act(async () => arrive("annonces"));
    expect(container.querySelector('[data-testid="skeleton"]')).toBeNull();
    expect(container.querySelector('[data-testid="results"]')).toBe(serverList);
    expect(serverList?.getAttribute("data-auth")).toBe("anonymous");
    expect(onRecoverableError).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });
});

describe("magasin d'authentification", () => {
  const signedIn = {
    session: null,
    user: { id: "u1" } as never,
    profile: null,
    loading: false,
    authError: null,
  };

  it("commence en vérification, sans identité", () => {
    expect(createAuthStore().getSnapshot()).toEqual({
      session: null,
      user: null,
      profile: null,
      loading: true,
      authError: null,
    });
  });

  it("ne réveille personne quand l'état publié est identique", () => {
    const store = createAuthStore();
    const listener = vi.fn();
    store.subscribe(listener);
    const before = store.getSnapshot();
    store.publish({ ...before });
    expect(listener).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toBe(before);
  });

  it("réveille les abonnés une fois par changement, et plus après désabonnement", () => {
    const store = createAuthStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.publish(signedIn);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toBe(signedIn);
    unsubscribe();
    store.publish({ ...signedIn, loading: true });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
