// @vitest-environment jsdom
import { act, cleanup, render, renderHook, waitFor } from "@testing-library/react";
import { AuthProvider } from "@/components/AuthProvider";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "./use-auth";

const mocks = vi.hoisted(() => ({
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
  supabase: {
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
  },
}));
const session = (id: string) => ({ user: { id }, access_token: id });
afterEach(() => {
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
});
