// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pepiteCriteriaPayload, pepiteCriteriaViews } from "@/lib/sale-pepite-view";

const mocks = vi.hoisted(() => ({ state: vi.fn() }));
vi.mock("@/hooks/use-sale-pepite", () => ({
  useSalePepiteState: (args: unknown) => mocks.state(args),
}));
vi.mock("next/dynamic", () => ({
  default: () =>
    function Block({ payload }: { payload: { count: number } }) {
      return <section id="pepite">bloc chargé : {payload.count}</section>;
    },
}));

import { PepiteBlockLazy } from "./PepiteBlockLazy";

afterEach(cleanup);

const PAYLOAD = pepiteCriteriaPayload(
  pepiteCriteriaViews(["pass:regime_open", "pass:test_c_cost"], [], "notary_auction"),
);

describe("PepiteBlockLazy", () => {
  it("rend le bloc et dit à la fiche qu'il existe", () => {
    mocks.state.mockReturnValue({ payload: PAYLOAD, status: "ready" });
    const onLoadedChange = vi.fn();
    render(
      <PepiteBlockLazy saleId="s" known lockedAction={null} onLoadedChange={onLoadedChange} />,
    );
    expect(document.querySelector("#pepite")).not.toBeNull();
    expect(onLoadedChange).toHaveBeenLastCalledWith(true);
  });

  it("pendant la lecture, tient la place du bloc avec un squelette de hauteur fixe", () => {
    mocks.state.mockReturnValue({ payload: null, status: "loading" });
    const onLoadedChange = vi.fn();
    render(
      <PepiteBlockLazy saleId="s" known lockedAction={null} onLoadedChange={onLoadedChange} />,
    );
    const skeleton = screen.getByTestId("pepite-block-loading");
    expect(skeleton.getAttribute("aria-busy")).toBe("true");
    expect(skeleton.hasAttribute("aria-label")).toBe(false);
    expect(skeleton.className).toMatch(/min-h-44/);
    expect(document.querySelector("#pepite")).toBeNull();
    expect(onLoadedChange).toHaveBeenLastCalledWith(false);
  });

  it("en erreur, dit que le détail n'a pas pu être chargé et renvoie à la méthode", () => {
    mocks.state.mockReturnValue({ payload: null, status: "error" });
    render(<PepiteBlockLazy saleId="s" known lockedAction={null} />);
    const line = screen.getByTestId("pepite-block-error");
    expect(line.textContent).toContain("n’a pas pu être chargé");
    expect(within(line).getByRole("alert")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Comment repérons-nous/ }).getAttribute("href")).toBe(
      "/methode-pepites",
    );
  });

  it("n'affiche rien quand la vente n'est plus une pépite publiable (404)", () => {
    mocks.state.mockReturnValue({ payload: null, status: "absent" });
    const { container } = render(<PepiteBlockLazy saleId="s" known lockedAction={null} />);
    expect(container.innerHTML).toBe("");
  });
});
