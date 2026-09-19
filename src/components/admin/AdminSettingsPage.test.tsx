// @vitest-environment jsdom
import type { AnchorHTMLAttributes } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AdminSettingsPage } from "./AdminSettingsPage";

const mocks = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn() }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { email: "admin@example.test" } }) }));
vi.mock("@/lib/client-api", () => ({
  fetchPipelineStatus: mocks.read,
  updatePipelineControl: mocks.save,
}));
vi.mock("@/lib/router-compat", () => ({
  Link: ({ to, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("next/dynamic", () => ({ default: () => () => <div>Section chargée</div> }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const control = {
  enabled: true,
  source_details_enabled: false,
  daily_ai_budget_usd: 5,
  max_ai_predictions_per_run: 40,
  updated_at: "2026-09-19T10:00:00Z",
  observation_started_at: null,
};
beforeEach(() => {
  mocks.read.mockResolvedValue({
    control,
    sources: [],
    observations: [],
    alerts: [],
    usage: { daily_ai_budget_usd: 5 },
  });
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <AdminSettingsPage />
    </QueryClientProvider>,
  );
  return client;
}
it("saves only changed settings, including a zero AI budget", async () => {
  mocks.save.mockResolvedValue({ ...control, daily_ai_budget_usd: 0 });
  setup();
  const budget = await screen.findByLabelText("Budget IA quotidien (USD)");
  fireEvent.change(budget, { target: { value: "0" } });
  expect(
    (screen.getByRole("tab", { name: "Sources de données" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Enregistrer les réglages" }));
  await waitFor(() => expect(mocks.save).toHaveBeenCalledWith({ daily_ai_budget_usd: 0 }));
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "Enregistrer les réglages" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true),
  );
});
it("preserves edits on a save error and allows cancelling", async () => {
  mocks.save.mockRejectedValue(new Error("Serveur indisponible"));
  setup();
  const budget = await screen.findByLabelText("Budget IA quotidien (USD)");
  fireEvent.change(budget, { target: { value: "12" } });
  fireEvent.click(screen.getByRole("button", { name: "Enregistrer les réglages" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Serveur indisponible");
  expect((budget as HTMLInputElement).value).toBe("12");
  fireEvent.click(screen.getByRole("button", { name: "Annuler les modifications" }));
  expect((budget as HTMLInputElement).value).toBe("5");
});
it("keeps edits while newer server data arrives", async () => {
  const client = setup();
  const budget = await screen.findByLabelText("Budget IA quotidien (USD)");
  fireEvent.change(budget, { target: { value: "12" } });
  client.setQueryData(["admin-pipeline"], {
    control: { ...control, daily_ai_budget_usd: 8 },
    usage: {},
    sources: [],
    observations: [],
    alerts: [],
  });
  await waitFor(() => expect((budget as HTMLInputElement).value).toBe("12"));
});

it("blocks internal links while edits are unsaved", async () => {
  setup();
  const budget = await screen.findByLabelText("Budget IA quotidien (USD)");
  fireEvent.change(budget, { target: { value: "12" } });
  expect(fireEvent.click(screen.getByRole("link", { name: "Configurer les emails" }))).toBe(false);
  expect((budget as HTMLInputElement).value).toBe("12");
});
