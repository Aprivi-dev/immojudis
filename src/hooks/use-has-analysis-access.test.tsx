// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHasAnalysisAccess } from "./use-has-analysis-access";

const plan = vi.hoisted(() => vi.fn());
vi.mock("@/lib/client-billing", () => ({ fetchAccessPlan: plan }));

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => vi.clearAllMocks());

describe("useHasAnalysisAccess", () => {
  it("ne demande rien sans compte connecté", () => {
    const { result } = renderHook(() => useHasAnalysisAccess(null), { wrapper });
    expect(result.current).toBeUndefined();
    expect(plan).not.toHaveBeenCalled();
  });

  it("indique si l'offre du compte ouvre toutes les ventes", async () => {
    plan.mockResolvedValue({ plan: { hasAnalysisAccess: false } });
    const { result } = renderHook(() => useHasAnalysisAccess("user-1"), { wrapper });
    expect(result.current).toBeUndefined();
    await waitFor(() => expect(result.current).toBe(false));
  });

  it("reste indéterminé quand la lecture de l'offre échoue", async () => {
    plan.mockRejectedValue(new Error("hors ligne"));
    const { result } = renderHook(() => useHasAnalysisAccess("user-1"), { wrapper });
    await waitFor(() => expect(plan).toHaveBeenCalled());
    expect(result.current).toBeUndefined();
  });
});
