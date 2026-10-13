import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migrations = join(process.cwd(), "supabase", "migrations");
const read = (name: string) => readFileSync(join(migrations, name), "utf8");

const PREVIOUS = read("20261009181000_stripe_subscription_ordering_and_grace.sql");
const NEXT = read("20261021100000_stripe_superseded_subscription.sql");

const FUNCTION_START = "create or replace function public.apply_stripe_subscription_state(";

function functionBody(sql: string): string {
  const start = sql.indexOf(FUNCTION_START);
  const end = sql.indexOf("$function$;", sql.indexOf("as $function$", start));
  expect(start).toBeGreaterThan(-1);
  return sql.slice(start, end);
}

const previousBody = functionBody(PREVIOUS);
const nextBody = functionBody(NEXT);

describe("migration 20261021100000_stripe_superseded_subscription", () => {
  it("garde le corps précédent et n'y ajoute que la garde de remplacement", () => {
    const withoutAdditions = nextBody
      .replace("  other_subscription boolean;\n", "")
      .replace(/ {2}other_subscription := [\s\S]*?p_stripe_subscription_id;\n\n/, "")
      .replace(/ {2}if other_subscription\n[\s\S]*? {2}end if;\n\n/, "");
    expect(withoutAdditions).toBe(previousBody);
  });

  it("ignore un statut sans accès d'un autre identifiant quand la ligne donne l'accès", () => {
    expect(nextBody).toContain("current_row.stripe_subscription_id is not null");
    expect(nextBody).toContain("current_row.stripe_subscription_id is distinct from");
    expect(nextBody).toMatch(/p_status not in \('trialing', 'active', 'past_due'\)/);
    expect(nextBody).toContain("app_private.subscription_grants_access(");
    expect(nextBody).toContain("current_row.status,");
    expect(nextBody).toContain("current_row.current_period_end");
    expect(nextBody).toContain("'superseded_subscription'::text");
  });

  it("laisse un statut actif d'un nouvel identifiant remplacer la ligne", () => {
    const guard = nextBody.slice(
      nextBody.indexOf("if other_subscription"),
      nextBody.indexOf("insert into public.user_subscriptions"),
    );
    // The guard only fires for statuses without access; an active new id reaches the upsert.
    expect(guard).toContain("p_status not in ('trialing', 'active', 'past_due')");
    expect(nextBody).toContain("stripe_subscription_id = excluded.stripe_subscription_id");
  });

  it("garde le remboursement et le litige prioritaires sur le même abonnement", () => {
    expect(nextBody).toContain(
      "same_subscription\n    and p_status in ('trialing', 'active', 'past_due')",
    );
    expect(nextBody).toContain("lifecycle.state in ('refunded', 'dispute_lost')");
    expect(nextBody.indexOf("'payment_reversed'")).toBeLessThan(
      nextBody.indexOf("'superseded_subscription'"),
    );
    expect(nextBody.indexOf("'stale_event'")).toBeLessThan(
      nextBody.indexOf("'superseded_subscription'"),
    );
  });

  it("conserve signature, security definer, search_path et droits", () => {
    expect(nextBody).toContain("security definer");
    expect(nextBody).toContain("set search_path to ''");
    expect(nextBody).toContain("returns table(applied boolean, reason text)");
    expect(NEXT).toContain("from public, anon, authenticated;");
    expect(NEXT).toMatch(/grant execute on function public\.apply_stripe_subscription_state\(/);
    expect(NEXT).toContain("to service_role;");
    expect(NEXT.trimEnd().endsWith("commit;")).toBe(true);
  });
});
