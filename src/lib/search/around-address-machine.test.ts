import { describe, expect, it } from "vitest";
import {
  aroundAddressCenter,
  aroundAddressMachine,
  isLocatingAroundAddress,
  type AroundAddressEvent,
  type AroundAddressState,
} from "./around-address-machine";

const lyon = { lat: 45.76, lng: 4.83 };
const lille = { lat: 50.63, lng: 3.06 };

function run(events: AroundAddressEvent[]): AroundAddressState {
  return events.reduce(aroundAddressMachine.transition, aroundAddressMachine.initial);
}

describe("aroundAddressMachine", () => {
  it("has no centre and is not locating without an address", () => {
    expect(aroundAddressCenter(aroundAddressMachine.initial)).toBeNull();
    expect(isLocatingAroundAddress(aroundAddressMachine.initial)).toBe(false);
  });

  it("locates an address, then exposes its centre", () => {
    const locating = run([{ type: "ADDRESS_CHANGED", address: "Lyon" }]);
    expect(locating).toEqual({ status: "locating", address: "Lyon" });
    expect(isLocatingAroundAddress(locating)).toBe(true);

    const located = aroundAddressMachine.transition(locating, {
      type: "RESOLVED",
      address: "Lyon",
      point: lyon,
    });
    expect(aroundAddressCenter(located)).toEqual(lyon);
    expect(isLocatingAroundAddress(located)).toBe(false);
  });

  it("stops locating when the address is cleared while the geocoder is still answering", () => {
    const state = run([
      { type: "ADDRESS_CHANGED", address: "Lyon" },
      { type: "ADDRESS_CHANGED", address: null },
    ]);
    expect(state).toEqual({ status: "idle" });
    expect(isLocatingAroundAddress(state)).toBe(false);
  });

  it("ignores the late answer of an address that was cleared", () => {
    const state = run([
      { type: "ADDRESS_CHANGED", address: "Lyon" },
      { type: "ADDRESS_CHANGED", address: null },
      { type: "RESOLVED", address: "Lyon", point: lyon },
    ]);
    expect(state).toEqual({ status: "idle" });
    expect(aroundAddressCenter(state)).toBeNull();
  });

  it("drops the previous centre as soon as the address changes", () => {
    const state = run([
      { type: "ADDRESS_CHANGED", address: "Lyon" },
      { type: "RESOLVED", address: "Lyon", point: lyon },
      { type: "ADDRESS_CHANGED", address: "Lille" },
    ]);
    // Le centre de Lyon ne sert jamais à trier ou à surveiller une recherche autour de Lille.
    expect(aroundAddressCenter(state)).toBeNull();
    expect(isLocatingAroundAddress(state)).toBe(true);
  });

  it("ignores the late answer of the previous address", () => {
    const state = run([
      { type: "ADDRESS_CHANGED", address: "Lyon" },
      { type: "ADDRESS_CHANGED", address: "Lille" },
      { type: "RESOLVED", address: "Lyon", point: lyon },
    ]);
    expect(state).toEqual({ status: "locating", address: "Lille" });

    const located = aroundAddressMachine.transition(state, {
      type: "RESOLVED",
      address: "Lille",
      point: lille,
    });
    expect(aroundAddressCenter(located)).toEqual(lille);
  });

  it("ends the search without a centre when the address is not found", () => {
    const state = run([
      { type: "ADDRESS_CHANGED", address: "nulle part" },
      { type: "RESOLVED", address: "nulle part", point: null },
    ]);
    expect(state).toEqual({ status: "unlocated", address: "nulle part" });
    expect(aroundAddressCenter(state)).toBeNull();
    expect(isLocatingAroundAddress(state)).toBe(false);
  });

  it("does not let a second answer replace a located centre", () => {
    const located = run([
      { type: "ADDRESS_CHANGED", address: "Lyon" },
      { type: "RESOLVED", address: "Lyon", point: lyon },
    ]);
    expect(
      aroundAddressMachine.transition(located, { type: "RESOLVED", address: "Lyon", point: lille }),
    ).toBe(located);
  });

  it("locates again after an address that was not found", () => {
    const state = run([
      { type: "ADDRESS_CHANGED", address: "nulle part" },
      { type: "RESOLVED", address: "nulle part", point: null },
      { type: "ADDRESS_CHANGED", address: "Lyon" },
    ]);
    expect(state).toEqual({ status: "locating", address: "Lyon" });
  });

  it("keeps the same idle state when there is still no address", () => {
    const idle = aroundAddressMachine.initial;
    expect(aroundAddressMachine.transition(idle, { type: "ADDRESS_CHANGED", address: null })).toBe(
      idle,
    );
  });
});
