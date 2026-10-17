// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useCallback, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopMapZone } from "./DesktopMapZone";
import { useFirstGestureStart } from "./use-first-gesture-start";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Le montage de `SearchPage` : l'état « carte démarrée », le hook de premier geste, le cadre. */
function Harness({ onStarted }: { onStarted?: () => void }) {
  const [started, setStarted] = useState(false);
  const start = useCallback(() => {
    setStarted(true);
    onStarted?.();
  }, [onStarted]);
  useFirstGestureStart({ enabled: !started, onStart: start });
  return (
    <>
      <button type="button">Avant la carte</button>
      <DesktopMapZone started={started} onStart={start}>
        <div data-testid="map-panel">Carte</div>
      </DesktopMapZone>
    </>
  );
}

const showMapButton = () => screen.getByRole("button", { name: "Afficher la carte" });
const mapZone = () => screen.getByRole("region", { name: "Carte des ventes" });

describe("DesktopMapZone au clavier", () => {
  it("après Tab, la carte n'a pas démarré et le focus est sur le bouton", () => {
    vi.useFakeTimers();
    render(<Harness />);
    const before = screen.getByRole("button", { name: "Avant la carte" });
    act(() => before.focus());
    // Tab : la touche part de l'élément qui a le focus, puis le focus passe au suivant. jsdom ne
    // déplace pas le focus lui-même : on le fait comme le navigateur.
    fireEvent.keyDown(before, { key: "Tab" });
    act(() => showMapButton().focus());
    fireEvent.keyUp(showMapButton(), { key: "Tab" });
    act(() => {
      vi.advanceTimersByTime(5_000);
    });

    expect(document.activeElement).toBe(showMapButton());
    expect(screen.queryByTestId("map-panel")).toBeNull();
    expect(screen.getByTestId("map-preview")).toBeTruthy();
  });

  it("Entrée sur le bouton démarre la carte et met le focus sur le cadre de la carte", () => {
    render(<Harness />);
    const button = showMapButton();
    act(() => button.focus());
    // Un navigateur répond à Entrée sur un <button> par un `click` ; jsdom ne le fait pas.
    fireEvent.keyDown(button, { key: "Enter" });
    fireEvent.click(button);

    expect(screen.getByTestId("map-panel")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Afficher la carte" })).toBeNull();
    expect(document.activeElement).toBe(mapZone());
    expect(mapZone().getAttribute("tabindex")).toBe("-1");
    expect(screen.getByRole("status").textContent).toBe("Carte affichée");
  });

  it("le clic démarre la carte, avec le même focus et la même annonce", () => {
    render(<Harness />);
    fireEvent.click(showMapButton());
    expect(screen.getByTestId("map-panel")).toBeTruthy();
    expect(document.activeElement).toBe(mapZone());
    expect(screen.getByRole("status").textContent).toBe("Carte affichée");
  });

  it("démarre tout de suite : le bouton n'attend ni la peinture ni un moment d'inactivité", () => {
    vi.useFakeTimers();
    render(<Harness />);
    fireEvent.click(showMapButton());
    expect(screen.getByTestId("map-panel")).toBeTruthy();
  });

  it("un appui de souris sur le bouton ne lance pas le démarrage différé du hook : un seul démarrage", () => {
    vi.useFakeTimers();
    const onStarted = vi.fn();
    render(<Harness onStarted={onStarted} />);
    const button = showMapButton();
    // Un clic de souris : `pointerdown`, puis (un peu plus tard) `click`.
    fireEvent.pointerDown(button);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByTestId("map-panel")).toBeNull();
    fireEvent.click(button);

    expect(onStarted).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(mapZone());
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(onStarted).toHaveBeenCalledTimes(1);
  });

  it("un autre geste démarre la carte sans lui prendre le focus ni l'annoncer", () => {
    vi.useFakeTimers();
    render(<Harness />);
    const before = screen.getByRole("button", { name: "Avant la carte" });
    act(() => before.focus());
    fireEvent.wheel(window);
    act(() => {
      vi.advanceTimersByTime(1_000);
    });

    expect(screen.getByTestId("map-panel")).toBeTruthy();
    expect(document.activeElement).toBe(before);
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("la région d'annonce existe avant le démarrage, vide, pour que l'annonce soit lue", () => {
    render(<Harness />);
    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toBe("");
  });
});
