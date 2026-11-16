import type Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { VAT_EXEMPTION_INVOICE_MENTION } from "@/lib/analysis-offer";
import { findOrCreateStripeCustomer, stripeCustomerIdempotencyKey } from "@/lib/billing-stripe";

const USER_ID = "11111111-1111-4111-8111-111111111111";

const search = vi.fn();
const create = vi.fn();
const stripe = { customers: { search, create } } as unknown as Stripe;

function auth(userId = USER_ID): SupabaseAuthContext {
  return {
    userId,
    claims: { sub: userId, email: "client@example.test" },
  } as unknown as SupabaseAuthContext;
}

describe("findOrCreateStripeCustomer", () => {
  beforeEach(() => {
    search.mockReset();
    create.mockReset();
  });

  it("réutilise le client existant du compte sans en créer", async () => {
    search.mockResolvedValue({ data: [{ id: "cus_existing", created: 1_700_000_000 }] });

    await expect(findOrCreateStripeCustomer(stripe, auth())).resolves.toMatchObject({
      id: "cus_existing",
    });
    expect(search).toHaveBeenCalledWith({
      query: `metadata['user_id']:'${USER_ID}'`,
      limit: 100,
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("choisit le plus ancien quand le compte en a plusieurs", async () => {
    search.mockResolvedValue({
      data: [
        { id: "cus_recent", created: 1_700_000_300 },
        { id: "cus_oldest", created: 1_700_000_100 },
        { id: "cus_middle", created: 1_700_000_200 },
      ],
    });

    await expect(findOrCreateStripeCustomer(stripe, auth())).resolves.toMatchObject({
      id: "cus_oldest",
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("crée le client avec la clé d'idempotence quand le compte n'en a aucun", async () => {
    search.mockResolvedValue({ data: [] });
    create.mockResolvedValue({ id: "cus_new" });

    await expect(findOrCreateStripeCustomer(stripe, auth())).resolves.toEqual({ id: "cus_new" });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      email: "client@example.test",
      invoice_settings: { footer: VAT_EXEMPTION_INVOICE_MENTION },
      metadata: { user_id: USER_ID, source: "immojudis" },
    });
    expect(create.mock.calls[0]?.[1]).toEqual({
      idempotencyKey: stripeCustomerIdempotencyKey(USER_ID),
    });
  });

  it("refuse un identifiant de compte qui n'est pas un UUID, sans appeler Stripe", async () => {
    await expect(findOrCreateStripeCustomer(stripe, auth("x' OR email:'a@b.c"))).rejects.toThrow(
      /UUID/,
    );
    expect(search).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("laisse remonter une erreur de la recherche, sans créer de client", async () => {
    search.mockRejectedValue(new Error("Stripe search unavailable"));

    await expect(findOrCreateStripeCustomer(stripe, auth())).rejects.toThrow(
      "Stripe search unavailable",
    );
    expect(create).not.toHaveBeenCalled();
  });
});
