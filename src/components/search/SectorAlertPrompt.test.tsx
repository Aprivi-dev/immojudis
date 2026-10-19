// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FEW_RESULTS_ALERT_THRESHOLD, SectorAlertPrompt } from "./SectorAlertPrompt";

afterEach(cleanup);

function setup(props: Partial<Parameters<typeof SectorAlertPrompt>[0]> = {}) {
  const onSaveSearch = vi.fn();
  render(
    <SectorAlertPrompt
      resultCount={0}
      saving={false}
      signedIn={false}
      dailyAllowed={false}
      emailRecapEnabled={false}
      onSaveSearch={onSaveSearch}
      {...props}
    />,
  );
  return { onSaveSearch };
}

describe("SectorAlertPrompt", () => {
  it("n'apparaît qu'en dessous de cinq ventes", () => {
    expect(FEW_RESULTS_ALERT_THRESHOLD).toBe(5);
  });

  it("dit qu'aucune vente ne correspond et propose le bouton de l'alerte", () => {
    const { onSaveSearch } = setup();
    expect(screen.getByText("Rien pour ces critères aujourd’hui.")).toBeTruthy();
    // Un visiteur : le bouton lance directement le détour par la connexion.
    fireEvent.click(
      screen.getByRole("button", { name: "Recevoir les nouvelles ventes de ce secteur" }),
    );
    expect(onSaveSearch).toHaveBeenCalledTimes(1);
  });

  it("accorde le message au nombre de ventes", () => {
    setup({ resultCount: 1 });
    expect(screen.getByText("Seulement 1 vente correspond à ces critères.")).toBeTruthy();
    cleanup();
    setup({ resultCount: 3 });
    expect(screen.getByText("Seulement 3 ventes correspondent à ces critères.")).toBeTruthy();
  });

  it("passe par la fenêtre de l'alerte, avec la case d'email décochée, pour une personne connectée", () => {
    setup({ signedIn: true, resultCount: 2 });
    fireEvent.click(
      screen.getByRole("button", { name: "Recevoir les nouvelles ventes de ce secteur" }),
    );
    const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
  });
});
