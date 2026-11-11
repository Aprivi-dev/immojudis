import { describe, expect, it } from "vitest";
import { acceptedEvents } from "./state-machine";
import {
  mapboxPreviewMachine,
  type MapboxPreviewEvent,
  type MapboxPreviewStatus,
} from "./mapbox-preview-machine";

function run(...types: MapboxPreviewEvent["type"][]): MapboxPreviewStatus {
  return types
    .map((type) => ({ type }) as MapboxPreviewEvent)
    .reduce(mapboxPreviewMachine.transition, mapboxPreviewMachine.initial).status;
}

describe("mapboxPreviewMachine", () => {
  it("is closed at first", () => {
    expect(mapboxPreviewMachine.initial).toEqual({ status: "idle" });
  });

  it("loads then shows the map", () => {
    expect(run("LOAD_STARTED")).toBe("loading");
    expect(run("LOAD_STARTED", "LOADED")).toBe("ready");
  });

  it("reports a failure that happens before the map is shown", () => {
    expect(run("LOAD_STARTED", "LOAD_FAILED")).toBe("error");
  });

  it("keeps a displayed map when Mapbox reports an error afterwards", () => {
    // Une tuile en échec après l'affichage ne recouvre pas la carte d'un message d'erreur.
    expect(run("LOAD_STARTED", "LOADED", "LOAD_FAILED")).toBe("ready");
  });

  it("does not show a map that finished loading after a failure", () => {
    expect(run("LOAD_STARTED", "LOAD_FAILED", "LOADED")).toBe("error");
  });

  it("ignores load results once the preview is closed", () => {
    expect(run("LOAD_STARTED", "CLOSED", "LOADED")).toBe("idle");
    expect(run("LOAD_STARTED", "CLOSED", "LOAD_FAILED")).toBe("idle");
  });

  it("explains a missing token or missing coordinates", () => {
    expect(run("UNCONFIGURED")).toBe("unconfigured");
    expect(run("COORDINATES_MISSING")).toBe("missing");
  });

  it("can load again after an error, a missing token or missing coordinates", () => {
    expect(run("LOAD_STARTED", "LOAD_FAILED", "LOAD_STARTED", "LOADED")).toBe("ready");
    expect(run("UNCONFIGURED", "LOAD_STARTED")).toBe("loading");
    expect(run("COORDINATES_MISSING", "LOAD_STARTED")).toBe("loading");
  });

  it("accepts a failure only while loading", () => {
    const statuses = Object.keys(mapboxPreviewMachine.table) as MapboxPreviewStatus[];
    const accepting = statuses.filter((status) =>
      acceptedEvents(mapboxPreviewMachine, status).includes("LOAD_FAILED"),
    );
    expect(accepting).toEqual(["loading"]);
  });
});
