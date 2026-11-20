// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import { formatPrice } from "@/lib/format";
import { SaleMaquette, type SaleMaquettePrices } from "./SaleMaquette";

// Le moteur 3D (Three.js, WebGL) n'existe pas dans jsdom : le composant est testé sur ce qu'il lui
// demande.
const engine = vi.hoisted(() => ({
  create: vi.fn(),
  scene: {
    setColumns: vi.fn(),
    setHour: vi.fn(),
    rotate: vi.fn(),
    zoom: vi.fn(),
    dispose: vi.fn(),
  },
}));
vi.mock("./maquette/scene", () => ({ createMaquetteScene: engine.create }));

const PRICES: SaleMaquettePrices = {
  startLabel: "Mise à prix",
  startingPrice: 95_000,
  ceilingLabel: "Enchère plafond (simulation)",
  ceiling: { kind: "amount", amount: 136_000, note: "selon vos hypothèses", reliability: null },
  value: 190_000,
};

const legend = () => screen.getAllByRole("listitem").map((item) => item.textContent);
const created = () => engine.create.mock.calls.at(-1)![0];
const columns = () => engine.scene.setColumns.mock.calls.at(-1)![0];

describe("fiche : maquette 3D", () => {
  beforeEach(() => {
    engine.create.mockReset().mockReturnValue(engine.scene);
    Object.values(engine.scene).forEach((spy) => spy.mockReset());
  });
  afterEach(cleanup);

  it("donne au moteur le type de bien et une colonne par montant, à l'échelle du plus élevé", () => {
    render(<SaleMaquette kind="apartment" prices={PRICES} />);

    expect(created().kind).toBe("apartment");
    expect(created().hour).toBe(10);
    expect(columns().map((column: { kind: string }) => column.kind)).toEqual([
      "amount",
      "amount",
      "amount",
    ]);
    expect(columns().map((column: { share: number }) => column.share)).toEqual([
      95_000 / 190_000,
      136_000 / 190_000,
      1,
    ]);
  });

  it("dit en toutes lettres ce que l'or désigne et chaque montant affiché", () => {
    render(<SaleMaquette kind="apartment" prices={PRICES} />);

    expect(legend()).toEqual([
      "L’appartement vendu (étage et emplacement fictifs)",
      `Mise à prix : ${formatPrice(95_000)}`,
      `Enchère plafond (simulation) : ${formatPrice(136_000)}`,
      `Valeur estimée : ${formatPrice(190_000)}`,
    ]);
    expect(screen.getByText(/elle illustre le type de bien, pas le bien lui-même/)).toBeTruthy();
    expect(screen.getByText(/la lumière ne dit rien de l’exposition réelle du bien/)).toBeTruthy();
    expect(
      screen.getByRole("img", {
        name: "Maquette 3D schématique : un immeuble de ville, dont un lot est cerné d’or.",
      }),
    ).toBeTruthy();
  });

  it("plafond réservé : une colonne voilée, et l'invitation de la fiche à la place du montant", () => {
    render(
      <SaleMaquette
        kind="house"
        prices={{
          ...PRICES,
          ceiling: { kind: "locked", action: <a href="/offres">Découvrir l’offre Analyse</a> },
          value: null,
        }}
      />,
    );

    expect(columns()).toEqual([{ kind: "amount", color: "", share: 1 }, { kind: "locked" }]);
    const row = screen.getAllByRole("listitem")[2];
    expect(row.textContent).toBe("Enchère plafond (simulation) : Découvrir l’offre Analyse");
    expect(within(row).getByRole("link").getAttribute("href")).toBe("/offres");
    expect(screen.queryByText(/Valeur estimée/)).toBeNull();
  });

  it("n'affiche ni colonne ni ligne pour un montant absent ou une simple note", () => {
    render(
      <SaleMaquette
        kind="land"
        prices={{
          ...PRICES,
          startingPrice: null,
          ceiling: { kind: "note", note: "Calcul…" },
          value: null,
        }}
      />,
    );

    expect(columns()).toEqual([]);
    expect(legend()).toEqual(["Le terrain vendu"]);
    expect(screen.queryByText(/La hauteur des colonnes/)).toBeNull();
  });

  it("le curseur « Lumière » change l'heure de la scène et la dit en clair", () => {
    render(<SaleMaquette kind="house" prices={PRICES} />);

    const slider = screen.getByRole("slider", { name: "Lumière" });
    expect(slider.getAttribute("aria-valuetext")).toBe("10 h");
    fireEvent.change(slider, { target: { value: "19.5" } });

    expect(engine.scene.setHour).toHaveBeenCalledWith(19.5);
    expect(slider.getAttribute("aria-valuetext")).toBe("19 h 30");
    expect(screen.getByRole("status").textContent).toBe("19 h 30");
  });

  it("les boutons tournent et rapprochent la maquette, sans la souris", () => {
    render(<SaleMaquette kind="house" prices={PRICES} />);

    fireEvent.click(screen.getByRole("button", { name: "Tourner la maquette vers la gauche" }));
    fireEvent.click(screen.getByRole("button", { name: "Tourner la maquette vers la droite" }));
    fireEvent.click(screen.getByRole("button", { name: "Rapprocher la maquette" }));
    fireEvent.click(screen.getByRole("button", { name: "Éloigner la maquette" }));

    expect(engine.scene.rotate.mock.calls).toEqual([[-Math.PI / 6], [Math.PI / 6]]);
    expect(engine.scene.zoom.mock.calls).toEqual([[0.85], [1 / 0.85]]);
  });

  it("ne touche à rien quand la fiche se redessine avec les mêmes montants, et libère scène et canevas en partant", () => {
    const { container, rerender, unmount } = render(<SaleMaquette kind="house" prices={PRICES} />);
    const canvas = container.querySelector("canvas");
    expect(created().canvas).toBe(canvas);

    rerender(<SaleMaquette kind="house" prices={{ ...PRICES }} />);
    expect(engine.create).toHaveBeenCalledTimes(1);
    expect(engine.scene.setColumns).toHaveBeenCalledTimes(1);
    expect(engine.scene.dispose).not.toHaveBeenCalled();

    unmount();
    expect(engine.scene.dispose).toHaveBeenCalledTimes(1);
    expect(canvas?.isConnected).toBe(false);
  });

  it("un montant qui arrive redessine les colonnes sans reconstruire la scène ni perdre le point de vue", () => {
    const { rerender } = render(<SaleMaquette kind="house" prices={{ ...PRICES, value: null }} />);
    expect(columns()).toHaveLength(2);

    rerender(<SaleMaquette kind="house" prices={PRICES} />);

    expect(engine.create).toHaveBeenCalledTimes(1);
    expect(engine.scene.dispose).not.toHaveBeenCalled();
    expect(columns()).toHaveLength(3);
  });

  it("un autre type de bien reconstruit la scène sur un canevas neuf, à l'heure choisie", () => {
    const { container, rerender } = render(<SaleMaquette kind="house" prices={PRICES} />);
    const first = container.querySelector("canvas");
    fireEvent.change(screen.getByRole("slider", { name: "Lumière" }), { target: { value: "17" } });

    rerender(<SaleMaquette kind="land" prices={PRICES} />);

    expect(engine.scene.dispose).toHaveBeenCalledTimes(1);
    expect(engine.create).toHaveBeenCalledTimes(2);
    expect(created().kind).toBe("land");
    expect(created().hour).toBe(17);
    expect(created().canvas).not.toBe(first);
    expect(container.querySelectorAll("canvas")).toHaveLength(1);
    expect(columns()).toHaveLength(3);
  });

  it("sans WebGL, un message remplace le canevas et la légende reste lisible", () => {
    const failure = new Error("WebGL indisponible");
    engine.create.mockImplementation(() => {
      throw failure;
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = render(<SaleMaquette kind="apartment" prices={PRICES} />);
    // L'erreur n'est pas avalée : elle reste lisible si la cause n'est pas l'absence de WebGL.
    expect(logged.mock.calls.at(-1)).toContain(failure);
    logged.mockRestore();
    expect(container.querySelector("canvas")).toBeNull();

    expect(
      screen.getByText("La maquette 3D ne peut pas s’afficher sur cet appareil."),
    ).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByRole("button", { name: /Tourner la maquette/ })).toBeNull();
    expect(legend()).toContain(`Mise à prix : ${formatPrice(95_000)}`);
  });

  it("contexte WebGL perdu : la scène est libérée et le message s'affiche", () => {
    const { container } = render(<SaleMaquette kind="apartment" prices={PRICES} />);

    act(() => created().onContextLost());

    expect(engine.scene.dispose).toHaveBeenCalledTimes(1);
    expect(container.querySelector("canvas")).toBeNull();
    expect(
      screen.getByText("La maquette 3D ne peut pas s’afficher sur cet appareil."),
    ).toBeTruthy();
  });

  it("ne demande aucun mouvement de caméra animé si le visiteur a réduit les animations", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    render(<SaleMaquette kind="apartment" prices={PRICES} />);
    vi.unstubAllGlobals();

    expect(created().animated).toBe(false);
  });

  it("n'a pas de défaut d'accessibilité détectable", async () => {
    const { container } = render(<SaleMaquette kind="apartment" prices={PRICES} />);

    const result = await axe(container, { rules: { "color-contrast": { enabled: false } } });
    expect(result.violations.map(({ id, help }) => ({ id, help }))).toEqual([]);
  });
});
