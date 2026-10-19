// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LaunchOfferProvider } from "@/components/LaunchOfferProvider";

const mocks = vi.hoisted(() => ({ fetchLaunchOffer: vi.fn() }));
vi.mock("@/lib/client-billing", () => ({ fetchLaunchOffer: mocks.fetchLaunchOffer }));

import { createLaunchOfferStore, useLaunchOffer } from "./use-launch-offer";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function Probe() {
  const { active, pending } = useLaunchOffer();
  return <p data-testid="state">{pending ? "pending" : active ? "active" : "inactive"}</p>;
}

describe("magasin de l'état de l'offre de lancement", () => {
  it("part « en attente », puis prend la réponse de l'API", async () => {
    const read = vi.fn().mockResolvedValue(true);
    const store = createLaunchOfferStore(read);
    expect(store.getSnapshot()).toEqual({ active: false, pending: true });

    const listener = vi.fn();
    store.subscribe(listener);
    store.ensure();
    await vi.waitFor(() => expect(store.getSnapshot()).toEqual({ active: true, pending: false }));
    expect(listener).toHaveBeenCalled();
  });

  it("reste sans offre sur une erreur ou une réponse illisible", async () => {
    const failing = createLaunchOfferStore(vi.fn().mockRejectedValue(new Error("réseau")));
    failing.ensure();
    await vi.waitFor(() =>
      expect(failing.getSnapshot()).toEqual({ active: false, pending: false }),
    );

    const unreadable = createLaunchOfferStore(vi.fn().mockResolvedValue(null));
    unreadable.ensure();
    await vi.waitFor(() =>
      expect(unreadable.getSnapshot()).toEqual({ active: false, pending: false }),
    );
  });

  it("ne relit pas pendant une minute, puis relit pour suivre une coupure", async () => {
    let clock = 1_000_000;
    const read = vi.fn().mockResolvedValue(true);
    const store = createLaunchOfferStore(read, () => clock);

    store.ensure();
    store.ensure();
    await vi.waitFor(() => expect(store.getSnapshot().pending).toBe(false));
    expect(read).toHaveBeenCalledTimes(1);

    clock += 30_000;
    store.ensure();
    expect(read).toHaveBeenCalledTimes(1);

    clock += 31_000;
    read.mockResolvedValue(false);
    store.ensure();
    await vi.waitFor(() => expect(store.getSnapshot().active).toBe(false));
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe("useLaunchOffer", () => {
  it("sans fournisseur : aucune offre, aucune requête (composant testé seul)", () => {
    render(<Probe />);
    expect(screen.getByTestId("state").textContent).toBe("inactive");
    expect(mocks.fetchLaunchOffer).not.toHaveBeenCalled();
  });

  it("avec le fournisseur : une seule requête pour plusieurs composants, puis l'état de l'API", async () => {
    mocks.fetchLaunchOffer.mockResolvedValue(true);
    render(
      <LaunchOfferProvider>
        <Probe />
        <Probe />
      </LaunchOfferProvider>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect((await screen.findAllByText("active")).length).toBe(2);
    expect(mocks.fetchLaunchOffer).toHaveBeenCalledTimes(1);
  });

  it("ne lance aucune requête tant qu'aucun composant n'a besoin de l'état", () => {
    render(
      <LaunchOfferProvider>
        <p>Sans consommateur</p>
      </LaunchOfferProvider>,
    );
    expect(mocks.fetchLaunchOffer).not.toHaveBeenCalled();
  });

  it("montre « en attente » avant la réponse, jamais l'offre fermée", () => {
    mocks.fetchLaunchOffer.mockReturnValue(new Promise(() => undefined));
    render(
      <LaunchOfferProvider>
        <Probe />
      </LaunchOfferProvider>,
    );
    expect(screen.getByTestId("state").textContent).toBe("pending");
  });
});
