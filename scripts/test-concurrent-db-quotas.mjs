import postgres from "postgres";

const databaseUrl =
  process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const authenticatorDatabaseUrl = new URL(databaseUrl);
authenticatorDatabaseUrl.username = "authenticator";
const userId = "75000000-0000-4000-8000-000000000001";
const unlockUserId = "75000000-0000-4000-8000-000000000002";
const unlockSaleIds = Array.from(
  { length: 6 },
  (_, index) => `75000000-1000-4000-8000-00000000000${index + 1}`,
);
const admin = postgres(databaseUrl, { max: 1 });
const first = postgres(authenticatorDatabaseUrl.toString(), { max: 1 });
const second = postgres(authenticatorDatabaseUrl.toString(), { max: 1 });

try {
  await admin.begin(async (sql) => {
    await sql`delete from auth.users where id = ${userId}`;
    await sql`
      insert into auth.users (
        id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
        created_at, updated_at, raw_app_meta_data, raw_user_meta_data
      ) values (
        ${userId}, '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated', 'concurrent-quota@example.test', '',
        now(), now(), now(), '{}'::jsonb, '{}'::jsonb
      )
    `;
    await sql`
      insert into public.user_subscriptions (user_id, plan_code, status)
      values (${userId}, 'analyse', 'active')
    `;
    await sql`
      insert into public.user_alerts (user_id, name, is_active)
      select ${userId}, 'Existing alert ' || n, true
      from generate_series(1, 24) n
    `;
  });

  const insertAsServiceRole = (client, name) =>
    client.begin(async (sql) => {
      await sql.unsafe("set local role service_role");
      await sql`
        insert into public.user_alerts (user_id, name, is_active)
        values (${userId}, ${name}, true)
      `;
    });

  const outcomes = await Promise.allSettled([
    insertAsServiceRole(first, "Concurrent alert A"),
    insertAsServiceRole(second, "Concurrent alert B"),
  ]);
  const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled").length;
  const rejected = outcomes.filter((outcome) => outcome.status === "rejected").length;
  const [{ count }] = await admin`
    select count(*)::integer as count
    from public.user_alerts
    where user_id = ${userId} and is_active
  `;

  if (fulfilled !== 1 || rejected !== 1 || count !== 25) {
    const rejectionReasons = outcomes
      .filter((outcome) => outcome.status === "rejected")
      .map((outcome) => outcome.reason?.message ?? String(outcome.reason));
    throw new Error(
      `Concurrent quota invariant failed: fulfilled=${fulfilled}, rejected=${rejected}, count=${count}, reasons=${JSON.stringify(rejectionReasons)}`,
    );
  }

  const unlocks = await verifyConcurrentSaleUnlocks();

  console.log(JSON.stringify({ ok: true, fulfilled, rejected, activeAlerts: count, unlocks }));
} finally {
  await admin`delete from auth.users where id = ${userId}`.catch(() => undefined);
  await admin`delete from auth.users where id = ${unlockUserId}`.catch(() => undefined);
  await deleteUnlockFixtureSales(admin).catch(() => undefined);
  await Promise.all([admin.end(), first.end(), second.end()]);
}

/**
 * "3 déblocages par mois": six simultaneous unlocks of six different sales by one Découverte
 * account must leave exactly three rows (the account is serialized by an advisory lock), and a
 * simultaneous repeat of one already unlocked sale must consume nothing.
 */
async function verifyConcurrentSaleUnlocks() {
  await admin.begin(async (sql) => {
    await sql`delete from auth.users where id = ${unlockUserId}`;
    await deleteUnlockFixtureSales(sql);
    await sql`
      insert into auth.users (
        id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
        created_at, updated_at, raw_app_meta_data, raw_user_meta_data
      ) values (
        ${unlockUserId}, '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated', 'concurrent-unlock@example.test', '',
        now(), now(), now(), '{}'::jsonb, '{}'::jsonb
      )
    `;
    for (const [index, saleId] of unlockSaleIds.entries()) {
      await sql`
        insert into public.auction_sales (id, source_name, source_url, title, status, sale_date)
        values (
          ${saleId}, 'concurrent-unlock-test', ${`https://example.test/concurrent-unlock/${index}`},
          ${`Concurrent unlock ${index}`}, 'upcoming', '2099-01-01 12:00:00Z'
        )
      `;
    }
  });

  const clients = unlockSaleIds.map(() =>
    postgres(authenticatorDatabaseUrl.toString(), { max: 1 }),
  );
  try {
    const unlockAsAccount = (client, saleId) =>
      client.begin(async (sql) => {
        await sql.unsafe("set local role authenticated");
        await sql`select set_config('request.jwt.claim.sub', ${unlockUserId}, true)`;
        const [row] = await sql`select public.unlock_sale(${saleId}::uuid) as result`;
        return row.result;
      });

    const outcomes = await Promise.allSettled(
      clients.map((client, index) => unlockAsAccount(client, unlockSaleIds[index])),
    );
    const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled").length;
    const quotaRefusals = outcomes.filter(
      (outcome) => outcome.status === "rejected" && outcome.reason?.code === "P0001",
    ).length;
    const [{ count }] = await admin`
      select count(*)::integer as count from public.user_sale_unlocks where user_id = ${unlockUserId}
    `;
    if (fulfilled !== 3 || quotaRefusals !== 3 || count !== 3) {
      throw new Error(
        `Concurrent unlock invariant failed: fulfilled=${fulfilled}, refused=${quotaRefusals}, rows=${count}`,
      );
    }

    const [{ saleId: unlockedSaleId }] = await admin`
      select sale_id as "saleId" from public.user_sale_unlocks
      where user_id = ${unlockUserId} order by unlocked_at limit 1
    `;
    const repeats = await Promise.allSettled(
      clients.slice(0, 4).map((client) => unlockAsAccount(client, unlockedSaleId)),
    );
    const [{ count: afterRepeat }] = await admin`
      select count(*)::integer as count from public.user_sale_unlocks where user_id = ${unlockUserId}
    `;
    if (repeats.some((outcome) => outcome.status !== "fulfilled") || afterRepeat !== 3) {
      throw new Error("Repeating an unlocked sale must consume nothing and never be refused.");
    }
    return { fulfilled, quotaRefusals, rows: count };
  } finally {
    await Promise.all(clients.map((client) => client.end()));
  }
}

/**
 * Test-fixture teardown must not manufacture permanent Outcome bridges (pgTAP 120 and 160 count
 * every catalogue row). Same local/admin-only bypass as scripts/test-phase-2-db-concurrency.mjs:
 * the account is deleted first so its unlocks cascade, then the production deletion guard is
 * skipped for the six deterministic fixture IDs only.
 */
async function deleteUnlockFixtureSales(client) {
  const run = async (sql) => {
    await sql`delete from public.user_sale_unlocks where sale_id = any(${unlockSaleIds})`;
    await sql`delete from app_private.auction_sale_source_checks where sale_id = any(${unlockSaleIds})`;
    await sql.unsafe("set local session_replication_role = replica");
    await sql`delete from public.auction_sales where id = any(${unlockSaleIds})`;
    await sql.unsafe("set local session_replication_role = origin");
  };
  // Inside admin.begin() the client is already a transaction; otherwise open one so that
  // "set local" stays scoped to the teardown.
  return typeof client.savepoint === "function" ? run(client) : client.begin(run);
}
