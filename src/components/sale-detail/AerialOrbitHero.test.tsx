// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AerialOrbitHero, ORBIT_LOAD_TIMEOUT_MS } from "./AerialOrbitHero";

type Handler = (...args: unknown[]) => void;

const mocks = vi.hoisted(() => ({
  maps: [] as Array<{
    options: Record<string, unknown>;
    handlers: Record<string, Handler[]>;
    canvas: HTMLCanvasElement;
    remove: ReturnType<typeof vi.fn>;
    rotateTo: ReturnType<typeof vi.fn>;
    bearing: number;
  }>,
}));

vi.mock("mapbox-gl/dist/mapbox-gl.css", () => ({}));
vi.mock("@/lib/mapbox-preview", () => ({ addMapboxBuildingVolumes: vi.fn() }));
vi.mock("mapbox-gl", () => {
  class FakeMap {
    handlers: Record<string, Handler[]> = {};
    canvas = document.createElement("canvas");
    remove = vi.fn();
    bearing = 0;
    rotateTo = vi.fn((bearing: number) => {
      this.bearing = bearing;
    });
    options: Record<string, unknown>;
    constructor(options: Record<string, unknown>) {
      this.options = options;
      mocks.maps.push(this as unknown as (typeof mocks.maps)[number]);
    }
    on(event: string, handler: Handler) {
      (this.handlers[event] ??= []).push(handler);
    }
    getCanvas() {
      return this.canvas;
    }
    getBearing() {
      return this.bearing;
    }
    getSource() {
      return undefined;
    }
    addSource() {}
    setTerrain() {}
    resize() {}
  }
  class FakeMarker {
    setLngLat() {
      return this;
    }
    addTo() {
      return this;
    }
    remove() {}
  }
  return { default: { Map: FakeMap, Marker: FakeMarker, config: {} } };
});

const target = { lat: 44.8378, lng: -0.5792, address: "12 rue Sainte-Catherine, 33000, Bordeaux" };

let intersection: ((entries: Array<{ isIntersecting: boolean }>) => void) | null = null;
let frames: Array<{ id: number; callback: FrameRequestCallback }> = [];
let nextFrame = 1;
let reduced = false;
let mediaListeners: Array<(event: { matches: boolean }) => void> = [];

function runFrame(time: number) {
  const pending = frames;
  frames = [];
  act(() => {
    for (const frame of pending) frame.callback(time);
  });
}

function emit(map: (typeof mocks.maps)[number], event: string) {
  act(() => {
    for (const handler of map.handlers[event] ?? []) handler();
  });
}

async function showMap() {
  await act(async () => {
    intersection?.([{ isIntersecting: true }]);
  });
  await waitFor(() => expect(mocks.maps).toHaveLength(1));
  const map = mocks.maps[0];
  await waitFor(() => expect(map.handlers.load).toBeDefined());
  return map;
}

beforeEach(() => {
  mocks.maps.length = 0;
  frames = [];
  nextFrame = 1;
  reduced = false;
  mediaListeners = [];
  vi.stubEnv("NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN", "pk.test");
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
        intersection = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = nextFrame++;
    frames.push({ id, callback });
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames = frames.filter((frame) => frame.id !== id);
  });
  window.matchMedia = ((query: string) => ({
    media: query,
    get matches() {
      return reduced;
    },
    addEventListener: (_: string, listener: (event: { matches: boolean }) => void) =>
      mediaListeners.push(listener),
    removeEventListener: (_: string, listener: (event: { matches: boolean }) => void) => {
      mediaListeners = mediaListeners.filter((item) => item !== listener);
    },
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  document.body.removeAttribute("data-scroll-locked");
});

describe("AerialOrbitHero", () => {
  it("affiche d'abord l'image d'attente, légère et décrite, avec ses crédits hors de l'image", () => {
    render(<AerialOrbitHero target={target} title="Appartement" />);

    const poster = screen.getByRole("img", {
      name: /Vue aérienne autour de l’adresse 12 rue Sainte-Catherine.*« Appartement »/,
    });
    // @1x et WebP : pas de suffixe @2x, extension .webp.
    expect(poster.getAttribute("src")).toMatch(/\/1280x720\.webp\?access_token=/);
    expect(poster.getAttribute("src")).not.toContain("@2x");
    const credit = screen.getByTestId("aerial-orbit-attribution");
    expect(credit.textContent).toContain("© Maxar");
    expect(credit.textContent).toContain("Date d’imagerie inconnue");
    expect(credit.contains(poster)).toBe(false);
    expect(screen.getByRole("button", { name: "Lancer la vue 360°" })).toBeTruthy();
    expect(mocks.maps).toHaveLength(0);
  });

  it("n'enveloppe plus la carte et ses liens dans un role=img, et place le bouton avant la carte", () => {
    const { container } = render(<AerialOrbitHero target={target} title="Appartement" />);

    expect(container.querySelector('[role="img"]')).toBeNull();
    const button = screen.getByRole("button", { name: "Lancer la vue 360°" });
    const map = screen.getByTestId("aerial-orbit-map");
    expect(button.compareDocumentPosition(map) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // La carte est inerte tant qu'elle n'est pas prête.
    expect(map.parentElement?.hasAttribute("inert")).toBe(true);
  });

  it("charge la carte au premier passage à l'écran, puis reflète l'état réel sur le bouton", async () => {
    render(<AerialOrbitHero target={target} title="Appartement" />);
    const map = await showMap();

    const loading = screen.getByRole("button", { name: /Chargement de la vue/ });
    expect((loading as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Mettre en pause" })).toBeNull();
    expect(map.canvas.getAttribute("aria-hidden")).toBe("true");
    const locale = map.options.locale as Record<string, string>;
    expect(locale["Map.Title"]).toMatch(/^Vue aérienne autour de/);
    expect(locale["NavigationControl.ZoomIn"]).toBe("Zoomer");
    expect(locale["AttributionControl.ToggleAttribution"]).toMatch(/crédits/);

    emit(map, "load");

    expect(screen.getByRole("button", { name: "Mettre en pause" })).toBeTruthy();
    expect(screen.getByTestId("aerial-orbit-map").parentElement?.hasAttribute("inert")).toBe(false);
    expect(screen.getByText(/3D schématique/)).toBeTruthy();
    expect(screen.queryByTestId("aerial-orbit-attribution")).toBeNull();
  });

  it("plafonne la rotation à 30 images par seconde", async () => {
    render(<AerialOrbitHero target={target} title="Appartement" />);
    const map = await showMap();
    emit(map, "load");

    // Quatre images à 60 Hz : la première et une sur deux ensuite.
    for (const time of [1000, 1016.7, 1033.4, 1050.1]) runFrame(time);

    expect(map.rotateTo).toHaveBeenCalledTimes(2);
  });

  it("met en pause et reprend sans recharger la carte", async () => {
    render(<AerialOrbitHero target={target} title="Appartement" />);
    const map = await showMap();
    emit(map, "load");

    fireEvent.click(screen.getByRole("button", { name: "Mettre en pause" }));
    expect(frames).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Reprendre la rotation" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Reprendre la rotation" }));
    expect(frames).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Mettre en pause" })).toBeTruthy();
    expect(mocks.maps).toHaveLength(1);
  });

  it("ne planifie plus d'image hors de l'écran", async () => {
    render(<AerialOrbitHero target={target} title="Appartement" />);
    const map = await showMap();
    emit(map, "load");
    expect(frames).toHaveLength(1);

    act(() => intersection?.([{ isIntersecting: false }]));
    expect(frames).toHaveLength(0);

    act(() => intersection?.([{ isIntersecting: true }]));
    expect(frames).toHaveLength(1);
  });

  it("s'arrête après deux tours et propose de reprendre", async () => {
    render(<AerialOrbitHero target={target} title="Appartement" />);
    const map = await showMap();
    emit(map, "load");

    // 0,1 s d'écart par image, 0,6 degré par image : 720 degrés en 1 200 images.
    let time = 1000;
    for (let index = 0; index < 1300 && frames.length > 0; index += 1) {
      time += 100;
      runFrame(time);
    }

    expect(frames).toHaveLength(0);
    expect(map.bearing).toBeGreaterThan(0);
    const resume = screen.getByRole("button", { name: "Reprendre la rotation" });
    fireEvent.click(resume);
    expect(frames).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Mettre en pause" })).toBeTruthy();
  });

  it("fait une pause tant qu'une fenêtre modale est ouverte", async () => {
    render(<AerialOrbitHero target={target} title="Appartement" />);
    const map = await showMap();
    emit(map, "load");
    expect(frames).toHaveLength(1);

    act(() => document.body.setAttribute("data-scroll-locked", "1"));
    await waitFor(() => expect(frames).toHaveLength(0));

    act(() => document.body.removeAttribute("data-scroll-locked"));
    await waitFor(() => expect(frames).toHaveLength(1));
  });

  it("revient à l'image d'attente quand le contexte WebGL est perdu", async () => {
    render(<AerialOrbitHero target={target} title="Appartement" />);
    const map = await showMap();
    emit(map, "load");

    act(() => {
      map.canvas.dispatchEvent(new Event("webglcontextlost"));
    });

    expect(map.remove).toHaveBeenCalledTimes(1);
    expect(frames).toHaveLength(0);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByTestId("aerial-orbit-attribution")).toBeTruthy();
  });

  it("abandonne la carte après le délai de chargement et retire le bouton", async () => {
    const timers = vi.spyOn(window, "setTimeout");
    render(<AerialOrbitHero target={target} title="Appartement" />);
    const map = await showMap();
    expect(screen.getByRole("button", { name: /Chargement de la vue/ })).toBeTruthy();

    const timeout = timers.mock.calls.find(([, delay]) => delay === ORBIT_LOAD_TIMEOUT_MS);
    expect(timeout).toBeDefined();
    act(() => (timeout?.[0] as () => void)());

    expect(map.remove).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("img", { name: /Vue aérienne autour/ })).toBeTruthy();
  });

  it("une carte qui n'arrive pas à se charger retire le bouton", async () => {
    render(<AerialOrbitHero target={target} title="Appartement" />);
    const map = await showMap();

    emit(map, "error");

    expect(screen.queryByRole("button")).toBeNull();
    expect(map.remove).toHaveBeenCalledTimes(1);
  });

  it("ne démonte pas deux fois la carte à la fermeture de la page", async () => {
    const { unmount } = render(<AerialOrbitHero target={target} title="Appartement" />);
    const map = await showMap();
    emit(map, "error");

    unmount();

    expect(map.remove).toHaveBeenCalledTimes(1);
  });

  it("avec le mouvement réduit, ne charge la carte qu'au clic", async () => {
    reduced = true;
    render(<AerialOrbitHero target={target} title="Appartement" />);

    await act(async () => {
      intersection?.([{ isIntersecting: true }]);
    });
    expect(mocks.maps).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Lancer la vue 360°" }));
    await waitFor(() => expect(mocks.maps).toHaveLength(1));
  });

  it("suit en direct la préférence de mouvement réduit", async () => {
    render(<AerialOrbitHero target={target} title="Appartement" />);
    const map = await showMap();
    emit(map, "load");
    expect(frames).toHaveLength(1);

    reduced = true;
    act(() => mediaListeners.forEach((listener) => listener({ matches: true })));

    expect(frames).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Reprendre la rotation" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reprendre la rotation" }));
    expect(frames).toHaveLength(1);
  });

  it("en démonstration publique, ne charge jamais la carte et n'a pas de bouton", async () => {
    render(<AerialOrbitHero target={target} title="Appartement" publicDemo />);

    await act(async () => {
      intersection?.([{ isIntersecting: true }]);
    });

    expect(mocks.maps).toHaveLength(0);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("img", { name: /Vue aérienne autour/ })).toBeTruthy();
    expect(screen.getByTestId("aerial-orbit-attribution").textContent).toContain("© Maxar");
  });

  it("sans jeton Mapbox, n'affiche ni image ni bouton", () => {
    vi.stubEnv("NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN", "");
    render(<AerialOrbitHero target={target} title="Appartement" />);

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
  });
});
