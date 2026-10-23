// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: { user: null as { id: string } | null, loading: false },
  create: vi.fn(),
  ready: true,
}));

vi.mock("@/hooks/use-auth", () => ({ useAuth: () => mocks.auth }));
vi.mock("@/hooks/use-create-alert", () => ({
  useCreateAlert: () => ({ createAlertFromSearch: mocks.create, ready: mocks.ready }),
}));

import { PendingAlertRunner } from "./PendingAlertRunner";
import { peekPendingAlert, savePendingAlert } from "@/lib/pending-alert";

beforeEach(() => {
  window.localStorage.clear();
  mocks.auth = { user: null, loading: false };
  mocks.ready = true;
  mocks.create.mockResolvedValue({ status: "created", emailConsent: false });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("PendingAlertRunner", () => {
  it("ne fait rien tant que la personne n'est pas connectée, et garde la demande", async () => {
    savePendingAlert({ department: "33" }, { emailRecap: true });
    render(<PendingAlertRunner />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.create).not.toHaveBeenCalled();
    expect(peekPendingAlert()).not.toBeNull();
  });

  it("crée l'alerte demandée avant l'inscription dès la connexion, une seule fois", async () => {
    savePendingAlert({ department: "33", maxPrice: 150000 }, { emailRecap: true });
    mocks.auth = { user: { id: "user-1" }, loading: false };
    const { rerender } = render(<PendingAlertRunner />);
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ department: "33", maxPrice: 150000 }),
      { emailRecap: true },
    );
    expect(peekPendingAlert()).toBeNull();
    rerender(<PendingAlertRunner />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it("attend que les droits du compte soient lus avant de créer", async () => {
    savePendingAlert({ department: "33" });
    mocks.auth = { user: { id: "user-1" }, loading: false };
    mocks.ready = false;
    const { rerender } = render(<PendingAlertRunner />);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(mocks.create).not.toHaveBeenCalled();
    expect(peekPendingAlert()).not.toBeNull();
    mocks.ready = true;
    rerender(<PendingAlertRunner />);
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
  });

  it("ne charge rien pour une personne connectée sans demande en attente", async () => {
    mocks.auth = { user: { id: "user-1" }, loading: false };
    render(<PendingAlertRunner />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
