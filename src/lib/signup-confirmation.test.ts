import { beforeEach, describe, expect, it, vi } from "vitest";

const track = vi.hoisted(() => vi.fn());
vi.mock("@/lib/product-events", () => ({ trackProductEvent: track }));

import {
  isFreshlyConfirmed,
  resetSignupConfirmationForTests,
  trackSignupConfirmed,
} from "./signup-confirmation";

const NOW = Date.parse("2026-10-23T10:00:00.000Z");
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

beforeEach(() => {
  track.mockReset();
  resetSignupConfirmationForTests();
});

describe("signup confirmation", () => {
  it("recognises a confirmation that has just happened and its first sign-in", () => {
    expect(
      isFreshlyConfirmed(
        { id: "u", email_confirmed_at: iso(-5_000), last_sign_in_at: iso(-4_000) },
        NOW,
      ),
    ).toBe(true);
  });

  it("ignores an old account signing in again", () => {
    expect(
      isFreshlyConfirmed(
        { id: "u", email_confirmed_at: iso(-40 * 86_400_000), last_sign_in_at: iso(-1_000) },
        NOW,
      ),
    ).toBe(false);
  });

  it("ignores a confirmation older than a minute, even with a matching sign-in", () => {
    expect(
      isFreshlyConfirmed(
        { id: "u", email_confirmed_at: iso(-10 * 60_000), last_sign_in_at: iso(-10 * 60_000) },
        NOW,
      ),
    ).toBe(false);
  });

  it("ignores an unconfirmed account and unreadable dates", () => {
    expect(
      isFreshlyConfirmed({ id: "u", email_confirmed_at: null, last_sign_in_at: iso(0) }, NOW),
    ).toBe(false);
    expect(isFreshlyConfirmed({ id: "u", email_confirmed_at: "n'importe quoi" }, NOW)).toBe(false);
  });

  it("counts a freshly confirmed account once", async () => {
    const user = { id: "u", email_confirmed_at: iso(-2_000), last_sign_in_at: iso(-1_000) };
    trackSignupConfirmed(user, NOW);
    trackSignupConfirmed(user, NOW);
    await vi.waitFor(() => expect(track).toHaveBeenCalledTimes(1));
    expect(track).toHaveBeenCalledWith("signup_confirmed");
  });

  it("counts nothing for an ordinary sign-in", async () => {
    trackSignupConfirmed(
      { id: "u", email_confirmed_at: iso(-90 * 86_400_000), last_sign_in_at: iso(-500) },
      NOW,
    );
    await Promise.resolve();
    expect(track).not.toHaveBeenCalled();
  });
});
