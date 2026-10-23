// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SalesSearchParams } from "@/lib/search/search-url-state";

const mocks = vi.hoisted(() => ({
  auth: { user: { id: "user-1" } as { id: string } | null, loading: false },
  push: vi.fn(),
  plan: vi.fn(),
  preferences: vi.fn(),
  updatePreferences: vi.fn(),
  createZone: vi.fn(),
  createAlert: vi.fn(),
  track: vi.fn(),
  offerOpen: vi.fn(),
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), message: vi.fn() }),
}));

vi.mock("@/hooks/use-auth", () => ({ useAuth: () => mocks.auth }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));
vi.mock("@/lib/client-api", () => ({
  fetchAccessPlan: mocks.plan,
  fetchNotificationPreferences: mocks.preferences,
  updateNotificationPreferences: mocks.updatePreferences,
  createWatchedZone: mocks.createZone,
}));
vi.mock("@/lib/queries", () => ({ createAlert: mocks.createAlert }));
vi.mock("@/lib/product-events", () => ({ trackProductEvent: mocks.track }));
vi.mock("@/lib/search/analysis-offer-open", () => ({ isAnalysisOfferOpen: mocks.offerOpen }));
vi.mock("@/lib/toast", () => ({ toast: mocks.toast }));

import { useCreateAlert } from "./use-create-alert";

function freePlan() {
  return {
    plan: {
      hasAnalysisAccess: false,
      features: { smartAlerts: "limited", watchedZones: "limited" },
    },
  };
}

function setup(returnTo = "/sales?department=33") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useCreateAlert({ returnTo }), { wrapper });
}

/** Attend que le droit d'alerte soit lu, puis lance la création. */
async function create(
  hook: ReturnType<typeof setup>,
  search: SalesSearchParams,
  options?: Parameters<ReturnType<typeof setup>["result"]["current"]["createAlertFromSearch"]>[1],
) {
  await waitFor(() => expect(mocks.plan).toHaveBeenCalled());
  await waitFor(() => expect(mocks.preferences).toHaveBeenCalled());
  let outcome: Awaited<
    ReturnType<ReturnType<typeof setup>["result"]["current"]["createAlertFromSearch"]>
  >;
  // Laisse les droits arriver dans le hook avant l'appel.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    outcome = await hook.result.current.createAlertFromSearch(search, options);
  });
  return outcome!;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth = { user: { id: "user-1" }, loading: false };
  mocks.plan.mockResolvedValue(freePlan());
  mocks.preferences.mockResolvedValue({ preferences: { alertEmailEnabled: false } });
  mocks.updatePreferences.mockResolvedValue({ preferences: { alertEmailEnabled: true } });
  mocks.createZone.mockResolvedValue({ zone: { id: "zone-1" } });
  mocks.createAlert.mockResolvedValue(undefined);
  mocks.offerOpen.mockResolvedValue(true);
});

describe("useCreateAlert", () => {
  it("envoie un visiteur vers la connexion avec le motif « alerte » et son choix à retrouver", async () => {
    mocks.auth = { user: null, loading: false };
    const hook = setup("/sales?department=33&maxPrice=150000");
    let outcome;
    await act(async () => {
      outcome = await hook.result.current.createAlertFromSearch({ department: "33" });
    });
    expect(outcome).toEqual({ status: "login" });
    expect(mocks.push).toHaveBeenCalledWith(
      "/login?redirect=%2Fsales%3Fdepartment%3D33%26maxPrice%3D150000&mode=investor&reason=alerte",
    );
    expect(mocks.createAlert).not.toHaveBeenCalled();
  });

  it("n'envoie pas vers la connexion pendant que le compte se vérifie", async () => {
    mocks.auth = { user: null, loading: true };
    const hook = setup();
    let outcome;
    await act(async () => {
      outcome = await hook.result.current.createAlertFromSearch({ department: "33" });
    });
    expect(outcome).toEqual({ status: "blocked" });
    expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.toast.message).toHaveBeenCalledWith(
      "Vérification de votre compte en cours. Réessayez dans un instant.",
    );
  });

  it("crée l'alerte hebdomadaire d'un compte gratuit, sans email récapitulatif", async () => {
    const hook = setup();
    const outcome = await create(hook, {
      department: "33",
      homeTypes: ["house"],
      maxPrice: 150_000,
      minSqft: 40,
    });
    expect(outcome).toEqual({ status: "created", emailConsent: false });
    expect(mocks.createZone).toHaveBeenCalledTimes(1);
    expect(mocks.createAlert).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({
        name: "Recherche Dép. 33 · Maison · ≤ 150 k€",
        department: "33",
        property_type: "house",
        max_price_eur: 150_000,
        min_surface_m2: 40,
        alert_frequency: "weekly",
        watched_zone_id: "zone-1",
      }),
    );
    // Le consentement à l'email n'est jamais donné sans demande explicite.
    expect(mocks.updatePreferences).not.toHaveBeenCalled();
    expect(mocks.toast.success).toHaveBeenCalledWith("Zone surveillée et alerte créées");
    expect(mocks.track).toHaveBeenCalledWith("alert_created", { email_consent: false });
  });

  it("n'active l'email récapitulatif que si la case a été cochée", async () => {
    const hook = setup();
    const outcome = await create(hook, { department: "33" }, { emailRecap: true });
    expect(outcome).toEqual({ status: "created", emailConsent: true });
    expect(mocks.updatePreferences).toHaveBeenCalledWith({
      alertEmailEnabled: true,
      consentSource: "alert_creation",
    });
    expect(mocks.toast.success).toHaveBeenCalledWith(
      "Zone surveillée et alerte créées. Email récapitulatif activé.",
    );
    expect(mocks.track).toHaveBeenCalledWith("alert_created", { email_consent: true });
  });

  it("garde l'alerte et le dit quand l'email récapitulatif n'a pas pu être activé", async () => {
    mocks.updatePreferences.mockRejectedValue(new Error("hors ligne"));
    const hook = setup();
    const outcome = await create(hook, { department: "33" }, { emailRecap: true });
    expect(outcome).toEqual({ status: "created", emailConsent: false });
    expect(mocks.toast.error).toHaveBeenCalledWith(
      expect.stringContaining("l'email récapitulatif n'a pas pu être activé"),
    );
  });

  it("demande un filtre avant d'enregistrer une recherche vide", async () => {
    const hook = setup();
    const outcome = await create(hook, {});
    expect(outcome).toEqual({ status: "blocked" });
    expect(mocks.toast.error).toHaveBeenCalledWith(
      "Ajoutez au moins un filtre avant d'enregistrer",
    );
    expect(mocks.createAlert).not.toHaveBeenCalled();
  });

  it("ne crée pas d'alerte sans critère quand la recherche n'a que « sous la fourchette » ou « sans point à vérifier »", async () => {
    for (const search of [
      { belowRange: true },
      { noPointsToVerify: true },
      { belowRange: true, noPointsToVerify: true },
    ]) {
      mocks.toast.error.mockClear();
      const hook = setup();
      const outcome = await create(hook, search);
      expect(outcome).toEqual({ status: "blocked" });
      expect(mocks.toast.error).toHaveBeenCalledWith(
        expect.stringContaining("ne sont pas encore proposés dans les alertes"),
      );
    }
    expect(mocks.createAlert).not.toHaveBeenCalled();
  });

  it("enregistre les autres critères et dit que ces deux filtres n'y sont pas", async () => {
    const hook = setup();
    const outcome = await create(hook, { department: "33", belowRange: true });
    expect(outcome.status).toBe("created");
    expect(mocks.createAlert).toHaveBeenCalledTimes(1);
    expect(mocks.toast.message).toHaveBeenCalledWith(
      expect.stringContaining("ne sont pas enregistrés dans l'alerte"),
    );
  });

  it("refuse à un compte gratuit les critères réservés à Analyse", async () => {
    const hook = setup();
    const outcome = await create(hook, { query: "Bordeaux" });
    expect(outcome).toEqual({ status: "blocked" });
    expect(mocks.toast.error).toHaveBeenCalledWith(
      "L'alerte gratuite accepte les critères publics : zone, type de vente, type de bien, budget et surface.",
    );
    expect(mocks.createAlert).not.toHaveBeenCalled();
  });

  it("accepte ces critères pour un compte Analyse, en alerte quotidienne", async () => {
    mocks.plan.mockResolvedValue({
      plan: {
        hasAnalysisAccess: true,
        features: { smartAlerts: "included", watchedZones: "included" },
      },
    });
    const hook = setup();
    const outcome = await create(hook, { query: "Bordeaux" }, { name: "Recherche Bordeaux" });
    expect(outcome.status).toBe("created");
    expect(mocks.createAlert).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({
        name: "Recherche Bordeaux",
        alert_frequency: "daily",
        advanced_criteria: expect.objectContaining({ query: "Bordeaux" }),
      }),
    );
  });

  it("enregistre un code de département tapé dans la recherche comme filtre département", async () => {
    mocks.plan.mockResolvedValue({
      plan: {
        hasAnalysisAccess: true,
        features: { smartAlerts: "included", watchedZones: "included" },
      },
    });
    const hook = setup();
    for (const [query, department] of [
      ["26", "26"],
      ["07", "07"],
      ["2A", "2A"],
    ]) {
      mocks.createAlert.mockClear();
      const outcome = await create(hook, { query });
      expect(outcome.status).toBe("created");
      expect(mocks.createAlert).toHaveBeenCalledWith(
        "user-1",
        expect.objectContaining({
          department,
          advanced_criteria: expect.objectContaining({ query: null }),
        }),
      );
    }
  });

  it("garde le texte libre et le département explicite tels quels", async () => {
    mocks.plan.mockResolvedValue({
      plan: {
        hasAnalysisAccess: true,
        features: { smartAlerts: "included", watchedZones: "included" },
      },
    });
    const hook = setup();
    await create(hook, { query: "26", department: "33" });
    expect(mocks.createAlert).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({
        department: "33",
        advanced_criteria: expect.objectContaining({ query: "26" }),
      }),
    );
  });

  it("explique que les alertes sont réservées quand l'offre ne les ouvre pas", async () => {
    mocks.plan.mockResolvedValue({
      plan: {
        hasAnalysisAccess: false,
        features: { smartAlerts: "locked", watchedZones: "locked" },
      },
    });
    mocks.offerOpen.mockResolvedValue(false);
    const hook = setup();
    const outcome = await create(hook, { department: "33" });
    expect(outcome).toEqual({ status: "blocked" });
    expect(mocks.toast.message).toHaveBeenCalledWith(
      "Les alertes de cette recherche sont réservées à l'offre Analyse. L'abonnement Analyse n'est pas encore ouvert.",
    );
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("annonce l'échec de la création sans masquer l'erreur", async () => {
    mocks.createAlert.mockRejectedValue(new Error("Limite d'alertes atteinte pour votre offre."));
    const hook = setup();
    const outcome = await create(hook, { department: "33" });
    expect(outcome).toEqual({ status: "failed" });
    expect(mocks.toast.error).toHaveBeenCalled();
    expect(hook.result.current.saving).toBe(false);
    expect(mocks.track).not.toHaveBeenCalled();
  });
});
