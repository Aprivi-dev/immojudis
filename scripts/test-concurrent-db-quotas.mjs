import postgres from "postgres";

const databaseUrl =
  process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const userId = "75000000-0000-4000-8000-000000000001";
const admin = postgres(databaseUrl, { max: 1 });
const first = postgres(databaseUrl, { max: 1 });
const second = postgres(databaseUrl, { max: 1 });

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
      await sql.unsafe("set local session authorization authenticator");
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
    throw new Error(
      `Concurrent quota invariant failed: fulfilled=${fulfilled}, rejected=${rejected}, count=${count}`,
    );
  }

  console.log(JSON.stringify({ ok: true, fulfilled, rejected, activeAlerts: count }));
} finally {
  await admin`delete from auth.users where id = ${userId}`.catch(() => undefined);
  await Promise.all([admin.end(), first.end(), second.end()]);
}
