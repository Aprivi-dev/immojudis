import { describe, expect, it } from "vitest";
import { defineMachine } from "./state-machine";

type DoorState =
  | { status: "closed" }
  | { status: "open"; by: string }
  | { status: "locked"; attempts: number };

type DoorEvent =
  | { type: "OPEN"; by: string }
  | { type: "CLOSE" }
  | { type: "LOCK" }
  | { type: "KNOCK" };

const door = defineMachine<DoorState, DoorEvent>(
  { status: "closed" },
  {
    closed: {
      OPEN: (_state, event) => ({ status: "open", by: event.by }),
      LOCK: () => ({ status: "locked", attempts: 0 }),
    },
    open: {
      CLOSE: () => ({ status: "closed" }),
    },
    locked: {
      KNOCK: (state) => ({ status: "locked", attempts: state.attempts + 1 }),
    },
  },
);

describe("defineMachine", () => {
  it("starts in the initial state", () => {
    expect(door.initial).toEqual({ status: "closed" });
  });

  it("applies a declared transition and hands the event payload to it", () => {
    expect(door.transition({ status: "closed" }, { type: "OPEN", by: "Ada" })).toEqual({
      status: "open",
      by: "Ada",
    });
  });

  it("hands the narrowed current state to the transition", () => {
    expect(door.transition({ status: "locked", attempts: 2 }, { type: "KNOCK" })).toEqual({
      status: "locked",
      attempts: 3,
    });
  });

  it("ignores an event the current state does not accept and keeps the same reference", () => {
    const state: DoorState = { status: "open", by: "Ada" };
    // Une porte ouverte ne se verrouille pas : rien ne change, React ne re-rend pas.
    expect(door.transition(state, { type: "LOCK" })).toBe(state);
    expect(door.transition(state, { type: "OPEN", by: "Bob" })).toBe(state);
  });

  it("never resolves an event named like an inherited object property", () => {
    const state: DoorState = { status: "closed" };
    // Un type d'événement venu de l'extérieur (réponse réseau mal formée), hors du typage.
    const inherited = { type: "toString" } as unknown as DoorEvent;
    expect(door.transition(state, inherited)).toBe(state);
    expect(door.accepts(state, inherited.type)).toBe(false);
  });

  it("says which events a state accepts", () => {
    expect(door.accepts({ status: "closed" }, "OPEN")).toBe(true);
    expect(door.accepts({ status: "closed" }, "CLOSE")).toBe(false);
    expect(door.acceptedEvents("closed")).toEqual(["OPEN", "LOCK"]);
    expect(door.acceptedEvents("locked")).toEqual(["KNOCK"]);
  });

  it("lists every state of the table", () => {
    expect(door.statuses).toEqual(["closed", "open", "locked"]);
  });

  it("works as a reducer over a sequence of events", () => {
    const events: DoorEvent[] = [
      { type: "CLOSE" },
      { type: "OPEN", by: "Ada" },
      { type: "LOCK" },
      { type: "CLOSE" },
      { type: "LOCK" },
      { type: "KNOCK" },
    ];
    expect(events.reduce(door.transition, door.initial)).toEqual({ status: "locked", attempts: 1 });
  });
});
