// @vitest-environment jsdom

import { lazy, Suspense } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WhenNear } from "./SaleDetailLayout";

afterEach(cleanup);

describe("WhenNear", () => {
  // Sans `IntersectionObserver` (jsdom), le bloc est monté tout de suite.
  it("garde l'emplacement réservé pendant le téléchargement du bloc, sans masquer la fiche", async () => {
    let arrive: (module: { default: () => React.ReactNode }) => void = () => {};
    const Block = lazy(
      () => new Promise<{ default: () => React.ReactNode }>((resolve) => (arrive = resolve)),
    );

    render(
      <Suspense fallback={<p>Squelette de la fiche</p>}>
        <h1>La fiche</h1>
        <WhenNear placeholder="Scénarios d’enchères…">
          <Block />
        </WhenNear>
      </Suspense>,
    );

    // L'attente s'arrête à l'emplacement réservé : elle ne remonte pas à la frontière de la fiche.
    expect(screen.getByText("Scénarios d’enchères…")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "La fiche" })).toBeTruthy();
    expect(screen.queryByText("Squelette de la fiche")).toBeNull();

    await act(async () => arrive({ default: () => <p>Bloc chargé</p> }));

    expect(screen.getByText("Bloc chargé")).toBeTruthy();
    expect(screen.queryByText("Scénarios d’enchères…")).toBeNull();
  });
});
