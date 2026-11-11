// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MapPin } from "lucide-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mapboxPreviewModeLabel } from "@/lib/mapbox-preview";
import { MapboxPreviewButton } from "./MapboxPreviewButton";

type Handler = (...args: unknown[]) => void;

const mocks = vi.hoisted(() => ({
  token: "pk.test",
  maps: [] as Array<{ handlers: Record<string, Handler[]>; remove: ReturnType<typeof vi.fn> }>,
}));

vi.mock("mapbox-gl/dist/mapbox-gl.css", () => ({}));
vi.mock("@/lib/mapbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mapbox")>()),
  getMapboxAccessToken: () => mocks.token,
  disableMapboxTelemetry: vi.fn(),
}));
vi.mock("mapbox-gl", () => {
  class FakeMap {
    handlers: Record<string, Handler[]> = {};
    remove = vi.fn();
    constructor() {
      mocks.maps.push(this);
    }
    on(event: string, handler: Handler) {
      (this.handlers[event] ??= []).push(handler);
    }
    addControl() {}
    getSource() {
      return undefined;
    }
    addSource() {}
    setTerrain() {}
  }
  class FakeMarker {
    setLngLat() {
      return this;
    }
    setPopup() {
      return this;
    }
    addTo() {
      return this;
    }
    remove() {}
  }
  class FakePopup {
    setText() {
      return this;
    }
  }
  class FakeControl {}
  return {
    default: {
      Map: FakeMap,
      Marker: FakeMarker,
      Popup: FakePopup,
      NavigationControl: FakeControl,
      ScaleControl: FakeControl,
      accessToken: "",
    },
  };
});

const FAILURE = "Mapbox n'a pas pu être chargé";
const MAP_LABEL = mapboxPreviewModeLabel("streetLevel");

function renderPreview(coordinates: { lat?: number | null; lng?: number | null } = {}) {
  return render(
    <MapboxPreviewButton
      mode="streetLevel"
      lat={"lat" in coordinates ? coordinates.lat : 45.76}
      lng={"lng" in coordinates ? coordinates.lng : 4.83}
      label="Quartier 3D"
      title="Appartement à Lyon"
      description="Aperçu du quartier"
      ariaLabel="ouvrir l'aperçu du quartier"
      icon={MapPin}
    />,
  );
}

async function openPreview() {
  fireEvent.click(screen.getByRole("button", { name: /Quartier 3D/ }));
  await waitFor(() => expect(mocks.maps).toHaveLength(1));
  return mocks.maps[0];
}

function emit(map: (typeof mocks.maps)[number], event: string) {
  act(() => {
    for (const handler of map.handlers[event] ?? []) handler({});
  });
}

beforeEach(() => {
  mocks.token = "pk.test";
  mocks.maps.length = 0;
});
afterEach(cleanup);

describe("MapboxPreviewButton", () => {
  it("shows the map once Mapbox has loaded", async () => {
    renderPreview();
    const map = await openPreview();
    expect(screen.getByLabelText(MAP_LABEL).getAttribute("aria-hidden")).toBe("true");

    emit(map, "load");
    expect(screen.getByLabelText(MAP_LABEL).getAttribute("aria-hidden")).toBe("false");
    expect(screen.queryByText(FAILURE)).toBeNull();
  });

  it("reports an error that happens before the map is shown", async () => {
    renderPreview();
    const map = await openPreview();

    emit(map, "error");
    expect(screen.getByText(FAILURE)).toBeTruthy();
  });

  it("keeps the displayed map when Mapbox reports an error afterwards", async () => {
    renderPreview();
    const map = await openPreview();
    emit(map, "load");

    // Une tuile en échec après l'affichage : la carte reste, sans message d'erreur par-dessus.
    emit(map, "error");
    expect(screen.queryByText(FAILURE)).toBeNull();
    expect(screen.getByLabelText(MAP_LABEL).getAttribute("aria-hidden")).toBe("false");
  });

  it("explains that the listing has no coordinates, without loading Mapbox", () => {
    renderPreview({ lat: null, lng: null });
    fireEvent.click(screen.getByRole("button", { name: /Quartier 3D/ }));

    expect(screen.getByText("Aperçu indisponible")).toBeTruthy();
    expect(mocks.maps).toHaveLength(0);
  });

  it("explains that Mapbox is not configured", () => {
    mocks.token = "";
    renderPreview();
    fireEvent.click(screen.getByRole("button", { name: /Quartier 3D/ }));

    expect(screen.getByText("Mapbox n'est pas configuré")).toBeTruthy();
    expect(mocks.maps).toHaveLength(0);
  });
});
