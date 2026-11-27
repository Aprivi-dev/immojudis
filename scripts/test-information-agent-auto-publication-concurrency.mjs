import { randomUUID } from "node:crypto";
import postgres from "postgres";

// Publication automatique (étape 6, migration 20261211100000) : trois publications simultanées de faits du même
// dossier, par trois connexions du serveur (service_role), n'en publient jamais plus de deux (plafond par dossier
// tenu en base, sous verrou). Base locale jetable de la CI seulement (jamais la production) : le mode « auto » est
// posé ici directement, puis rétabli.
//
// Les lignes écrites restent : le registre des pièces est en ajout seul même hors déclencheurs ordinaires
// (déclencheurs ALWAYS), et une publication y écrit une observation et une décision. Le test tourne donc APRÈS les
// tests pgTAP (étape à part de la CI, pas dans test-phase-2-db-concurrency.mjs qui les précède), avec des
// identifiants neufs à chaque exécution.

const databaseUrl =
  process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const authenticatorDatabaseUrl = new URL(databaseUrl);
authenticatorDatabaseUrl.username = "authenticator";

const userId = randomUUID();
const saleId = randomUUID();
const missionId = randomUUID();
const caseId = randomUUID();
const messageId = randomUUID();
const recipient = `avocat-${caseId}@example.test`;
const facts = [
  [randomUUID(), "surface_m2", 120],
  [randomUUID(), "rooms_count", 5],
  [randomUUID(), "land_surface_m2", 800],
];
const POLICY_VERSION = "auto_publication_v2";
const ARBITER_VERSION = "auto_publication_arbiter_v1";

const admin = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
const workers = [0, 1, 2].map(() =>
  postgres(authenticatorDatabaseUrl.toString(), { max: 1, onnotice: () => undefined }),
);
let previousMode = null;

try {
  [{ mode: previousMode }] = await admin`
    select mode from public.information_agent_auto_publication_settings where singleton
  `;
  await seed();

  const outcomes = await Promise.allSettled(
    facts.map(([factId, factKey], index) =>
      workers[index].begin(async (sql) => {
        await sql.unsafe("set local role service_role");
        const [{ result }] = await sql`
          select public.publish_information_agent_fact_auto(
            ${factId}, ${factKey}, ${POLICY_VERSION}, ${ARBITER_VERSION}
          ) as result
        `;
        return result;
      }),
    ),
  );
  const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
  if (rejected.length) {
    throw new Error(
      `Concurrent automatic publication failed: ${rejected.map((outcome) => outcome.reason?.message).join("; ")}`,
    );
  }
  const statuses = outcomes.map((outcome) => outcome.value?.status).sort();
  const [{ published, accepted }] = await admin`
    select
      (select count(distinct decision.fact_id)::integer
       from public.information_agent_auto_publication_decisions decision
       where decision.case_id = ${caseId} and decision.outcome = 'published') as published,
      (select count(*)::integer
       from public.information_agent_fact_candidates fact
       where fact.case_id = ${caseId} and fact.status = 'accepted') as accepted
  `;
  if (
    JSON.stringify(statuses) !== JSON.stringify(["published", "published", "review"]) ||
    published !== 2 ||
    accepted !== 2
  ) {
    throw new Error(
      `Automatic publication case cap failed under concurrency: statuses=${JSON.stringify(statuses)}, published=${published}, accepted=${accepted}`,
    );
  }
  console.log(JSON.stringify({ ok: true, statuses, published }));
} finally {
  if (previousMode !== null) {
    await admin`
      update public.information_agent_auto_publication_settings set mode = ${previousMode} where singleton
    `;
  }
  await Promise.all([admin.end(), ...workers.map((worker) => worker.end())]);
}

async function seed() {
  await admin.begin(async (sql) => {
    await sql`
      insert into auth.users (
        id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
        created_at, updated_at, raw_app_meta_data, raw_user_meta_data
      ) values (
        ${userId}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        ${`${userId}@example.test`}, '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb
      )
    `;
    await sql`
      insert into public.auction_sales (
        id, source_name, source_url, status, sale_date, city, property_type, starting_price_eur,
        raw_payload, sale_procedure, sale_venue_type, quality_flags
      ) values (
        ${saleId}, 'licitor', ${`https://example.test/auto-publication-concurrency/${saleId}`}, 'upcoming',
        now() + interval '20 days', 'Alphaville', 'house', 90000,
        '{}'::jsonb, '{}'::jsonb, 'tribunal', '[]'::jsonb
      )
    `;
    await sql`
      insert into public.information_agent_cases (
        id, sale_id, created_by, status, recipient_kind, recipient_email, normalized_recipient_email,
        subject, body_text, question_keys, missing_information, sent_at, replied_at
      ) values (
        ${caseId}, ${saleId}, ${userId}, 'review', 'source_lawyer', ${recipient},
        ${recipient}, 'Demande d''informations', 'Merci de nous transmettre la surface.',
        array['surface'], array['surface'], now() - interval '3 days', now() - interval '2 days'
      )
    `;
    await sql`
      insert into public.information_agent_missions (
        id, user_id, sale_id, case_id, status, recipient_email, subject, body_text, question_keys,
        missing_information, privacy_version
      ) values (
        ${missionId}, ${userId}, ${saleId}, ${caseId}, 'sent', ${recipient},
        'Demande d''informations', 'Merci de nous transmettre la surface.', array['surface'],
        array['surface'], 'concurrency-test'
      )
    `;
    await sql`
      insert into public.information_agent_messages (
        id, mission_id, case_id, user_id, direction, message_kind, delivery_status, subject, body_text,
        received_at, provider_message_id, metadata
      ) values (
        ${messageId}, ${missionId}, ${caseId}, ${userId}, 'inbound', 'reply', 'received',
        'Re: Demande d''informations', 'La maison fait 120 m², 5 pièces, terrain de 800 m².',
        now() - interval '2 days', ${`auto-publication-concurrency-${messageId}`},
        ${sql.json({
          imported_manually: false,
          sender_matches_recipient: true,
          sender_authentication: { status: "pass", dkim: "pass", dmarc: "pass" },
          inbound_processing: { status: "completed" },
        })}
      )
    `;
    for (const [factId, factKey, value] of facts) {
      await sql`
        insert into public.information_agent_fact_candidates (
          id, case_id, message_id, sale_id, fact_key, proposed_value, display_value, evidence_excerpt,
          confidence, status
        ) values (
          ${factId}, ${caseId}, ${messageId}, ${saleId}, ${factKey}, ${sql.json({ value })},
          ${String(value)}, ${String(value)}, 0.9, 'pending'
        )
      `;
      await sql`
        insert into public.information_agent_auto_publication_arbitrations (
          fact_id, case_id, message_id, sale_id, fact_key, value, status, publish, reason_code, model,
          prompt_version
        ) values (
          ${factId}, ${caseId}, ${messageId}, ${saleId}, ${factKey}, ${value}, 'completed', true,
          'clear_statement', 'claude-haiku-5-5', ${ARBITER_VERSION}
        )
      `;
    }
    await sql`
      update public.information_agent_auto_publication_settings set mode = 'auto' where singleton
    `;
  });
}
