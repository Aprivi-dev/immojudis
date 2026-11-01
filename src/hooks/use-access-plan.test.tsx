// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAccessPlan } from "./use-access-plan";

const plan = vi.hoisted(() => vi.fn());
vi.mock("@/lib/client-billing", () => ({ fetchAccessPlan: plan }));

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => vi.clearAllMocks());

describe("useAccessPlan", () => {
  it("ne demande rien sans compte connecté", () => {
    const { result } = renderHook(() => useAccessPlan(null), { wrapper });
    expect(result.current).toBeUndefined();
    expect(plan).not.toHaveBeenCalled();
  });

  it("rend les droits du compte, avec la fin de son essai", async () => {
    plan.mockResolvedValue({
      plan: { hasAnalysisAccess: true, launchOffer: true, trialEndsAt: "2026-11-07T10:00:00Z" },
    });
    const { result } = renderHook(() => useAccessPlan("user-1"), { wrapper });
    expect(result.current).toBeUndefined();
    await waitFor(() => expect(result.current?.trialEndsAt).toBe("2026-11-07T10:00:00Z"));
  });

  it("reste indéterminé quand la lecture échoue", async () => {
    plan.mockRejectedValue(new Error("hors ligne"));
    const { result } = renderHook(() => useAccessPlan("user-1"), { wrapper });
    await waitFor(() => expect(plan).toHaveBeenCalled());
    expect(result.current).toBeUndefined();
  });
});
