import postgres from "postgres";

const databaseUrl =
  process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const authenticatorDatabaseUrl = new URL(databaseUrl);
authenticatorDatabaseUrl.username = "authenticator";

const refreshUserId = "77000000-0000-4000-8000-000000000001";
const paymentUserId = "77000000-0000-4000-8000-000000000002";
const ownerUserId = "77000000-0000-4000-8000-000000000003";
const collaboratorUserId = "77000000-0000-4000-8000-000000000004";
const saleIds = [
  "77000000-1000-4000-8000-000000000001",
  "77000000-1000-4000-8000-000000000002",
  "77000000-1000-4000-8000-000000000003",
  "77000000-1000-4000-8000-000000000004",
];
const workspaceId = "77000000-2000-4000-8000-000000000001";
const collaboratorId = "77000000-3000-4000-8000-000000000001";
const paymentIntentId = "pi_phase2_concurrent";

const admin = postgres(databaseUrl, { max: 1 });
const first = postgres(authenticatorDatabaseUrl.toString(), { max: 1 });
const second = postgres(authenticatorDatabaseUrl.toString(), { max: 1 });

try {
  await seedFixtures();

  const refreshOutcomes = await Promise.allSettled([
    enqueueRefresh(first, saleIds[2], "cadastre"),
    enqueueRefresh(second, saleIds[3], "cadastre"),
  ]);
  const refreshFulfilled = refreshOutcomes.filter(
    (outcome) => outcome.status === "fulfilled",
  ).length;
  const refreshRejected = refreshOutcomes.filter((outcome) => outcome.status === "rejected").length;
  const [{ count: activeRefreshes }] = await admin`
    select count(*)::integer as count
    from public.data_refresh_requests
    where user_id = ${refreshUserId}
      and status in ('queued', 'running')
  `;
  if (refreshFulfilled !== 1 || refreshRejected !== 1 || activeRefreshes !== 3) {
    throw new Error(
      `Refresh concurrency invariant failed: fulfilled=${refreshFulfilled}, rejected=${refreshRejected}, active=${activeRefreshes}`,
    );
  }

  const paymentOutcomes = await Promise.allSettled([grantCheckout(first), recordRefund(second)]);
  if (paymentOutcomes.some((outcome) => outcome.status === "rejected")) {
    throw new Error(
      `Stripe concurrency call failed: ${JSON.stringify(
        paymentOutcomes.map((outcome) =>
          outcome.status === "rejected" ? outcome.reason?.message : "fulfilled",
        ),
      )}`,
    );
  }
  const [paymentState] = await admin`
    select
      payment.state,
      subscription.plan_code,
      subscription.status,
      subscription.current_period_end
    from public.stripe_payment_lifecycle payment
    left join public.user_subscriptions subscription on subscription.user_id = payment.user_id
    where payment.payment_intent_id = ${paymentIntentId}
  `;
  const paymentIsActive =
    paymentState?.plan_code === "analyse" &&
    ["trialing", "active"].includes(paymentState?.status) &&
    paymentState?.current_period_end &&
    new Date(paymentState.current_period_end).getTime() > Date.now();
  if (paymentState?.state !== "refunded" || paymentIsActive) {
    throw new Error(
      `Stripe ordering invariant failed: ${JSON.stringify({ paymentState, paymentIsActive })}`,
    );
  }

  const collaborationOutcomes = await Promise.allSettled([
    acceptCollaboration(first),
    revokeCollaboration(second),
  ]);
  if (collaborationOutcomes.some((outcome) => outcome.status === "rejected")) {
    throw new Error(
      `Collaboration concurrency call failed: ${JSON.stringify(
        collaborationOutcomes.map((outcome) =>
          outcome.status === "rejected" ? outcome.reason?.message : "fulfilled",
        ),
      )}`,
    );
  }
  const [collaboration] = await admin`
    select status, collaborator_user_id, revoked_at
    from public.sale_workspace_collaborators
    where id = ${collaboratorId}
  `;
  if (collaboration?.status !== "revoked" || !collaboration?.revoked_at) {
    throw new Error(
      `Collaboration terminal-state invariant failed: ${JSON.stringify(collaboration)}`,
    );
  }

  console.log(
    JSON.stringify({
      ok: true,
      refresh: { fulfilled: refreshFulfilled, rejected: refreshRejected, activeRefreshes },
      stripe: { state: paymentState.state, entitlementActive: Boolean(paymentIsActive) },
      collaboration: { status: collaboration.status },
    }),
  );
} finally {
  await cleanupFixtures();
  await Promise.all([admin.end(), first.end(), second.end()]);
}

async function seedFixtures() {
  await admin.begin(async (sql) => {
    await sql`
      delete from auth.users
      where id in (${refreshUserId}, ${paymentUserId}, ${ownerUserId}, ${collaboratorUserId})
    `;
    // Test-fixture teardown must not manufacture permanent Outcome bridges.
    // This local/admin-only transaction bypasses the production deletion guard
    // for the four deterministic fixture IDs, then restores normal triggers
    // before any invariant under test is exercised.
    await sql.unsafe("set local session_replication_role = replica");
    await sql`delete from public.auction_sales where id in ${sql(saleIds)}`;
    await sql.unsafe("set local session_replication_role = origin");
    await sql`
      insert into auth.users (
        id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
        created_at, updated_at, raw_app_meta_data, raw_user_meta_data
      ) values
        (
          ${refreshUserId}, '00000000-0000-0000-0000-000000000000',
          'authenticated', 'authenticated', 'phase2-refresh-concurrent@example.test', '',
          now(), now(), now(), '{}'::jsonb, '{}'::jsonb
        ),
        (
          ${paymentUserId}, '00000000-0000-0000-0000-000000000000',
          'authenticated', 'authenticated', 'phase2-payment-concurrent@example.test', '',
          now(), now(), now(), '{}'::jsonb, '{}'::jsonb
        ),
        (
          ${ownerUserId}, '00000000-0000-0000-0000-000000000000',
          'authenticated', 'authenticated', 'phase2-owner-concurrent@example.test', '',
          now(), now(), now(), '{}'::jsonb, '{}'::jsonb
        ),
        (
          ${collaboratorUserId}, '00000000-0000-0000-0000-000000000000',
          'authenticated', 'authenticated', 'phase2-collaborator-concurrent@example.test', '',
          now(), now(), now(), '{}'::jsonb, '{}'::jsonb
        )
    `;
    await sql`
      insert into public.user_subscriptions (user_id, plan_code, status)
      values
        (${refreshUserId}, 'analyse', 'active'),
        (${paymentUserId}, 'decouverte', 'active'),
        (${ownerUserId}, 'analyse', 'active')
    `;
    await sql`
      insert into public.auction_sales (id, source_name, source_url, title)
      values
        (${saleIds[0]}, 'phase-2-concurrency', 'https://example.test/concurrency/sale-1', 'Sale one'),
        (${saleIds[1]}, 'phase-2-concurrency', 'https://example.test/concurrency/sale-2', 'Sale two'),
        (${saleIds[2]}, 'phase-2-concurrency', 'https://example.test/concurrency/sale-3', 'Sale three'),
        (${saleIds[3]}, 'phase-2-concurrency', 'https://example.test/concurrency/sale-4', 'Sale four')
    `;
    await sql`
      insert into public.data_refresh_requests (
        user_id, sale_id, source_url, request_kind, requested_payload
      ) values
        (
          ${refreshUserId}, ${saleIds[0]}, 'https://example.test/concurrency/sale-1',
          'cadastre', '{}'::jsonb
        ),
        (
          ${refreshUserId}, ${saleIds[1]}, 'https://example.test/concurrency/sale-2',
          'cadastre', '{}'::jsonb
        )
    `;
    await sql`
      insert into public.sale_workspaces (id, user_id, sale_id)
      values (${workspaceId}, ${ownerUserId}, ${saleIds[0]})
    `;
    await sql`
      insert into public.sale_workspace_collaborators (
        id, workspace_id, owner_id, invited_by, invited_email, role, status
      ) values (
        ${collaboratorId}, ${workspaceId}, ${ownerUserId}, ${ownerUserId},
        'phase2-collaborator-concurrent@example.test', 'commenter', 'invited'
      )
    `;
  });
}

function enqueueRefresh(client, saleId, kind) {
  return asServiceRole(
    client,
    (sql) => sql`
    select * from public.enqueue_data_refresh_bounded(
      ${refreshUserId}, ${saleId}, ${kind}, false
    )
  `,
  );
}

function grantCheckout(client) {
  return asServiceRole(
    client,
    (sql) => sql`
    select * from public.grant_analysis_access_from_payment(
      'cs_phase2_concurrent',
      ${paymentIntentId},
      ${paymentUserId},
      'cus_phase2_concurrent',
      2900,
      'eur',
      '2026-07-27T17:00:00Z'::timestamptz,
      'evt_phase2_checkout_concurrent',
      1785171600,
      30
    )
  `,
  );
}

function recordRefund(client) {
  return asServiceRole(
    client,
    (sql) => sql`
    select * from public.record_stripe_payment_state(
      ${paymentIntentId},
      ${paymentUserId},
      'refunded',
      'evt_phase2_refund_concurrent',
      'charge.refunded',
      1785175200,
      'cancelled',
      true
    )
  `,
  );
}

function acceptCollaboration(client) {
  return asServiceRole(
    client,
    (sql) => sql`
    update public.sale_workspace_collaborators
    set
      collaborator_user_id = ${collaboratorUserId},
      status = 'accepted',
      accepted_at = now(),
      revoked_at = null
    where id = ${collaboratorId}
      and status = 'invited'
      and collaborator_user_id is null
    returning id
  `,
  );
}

function revokeCollaboration(client) {
  return asServiceRole(
    client,
    (sql) => sql`
    update public.sale_workspace_collaborators
    set status = 'revoked', revoked_at = now()
    where id = ${collaboratorId}
    returning id
  `,
  );
}

function asServiceRole(client, operation) {
  return client.begin(async (sql) => {
    await sql.unsafe("set local role service_role");
    return operation(sql);
  });
}

async function cleanupFixtures() {
  await admin`delete from auth.users where id in (${refreshUserId}, ${paymentUserId}, ${ownerUserId}, ${collaboratorUserId})`.catch(
    () => undefined,
  );
  await admin
    .begin(async (sql) => {
      await sql.unsafe("set local session_replication_role = replica");
      await sql`delete from public.auction_sales where id in ${sql(saleIds)}`;
    })
    .catch(() => undefined);
}
