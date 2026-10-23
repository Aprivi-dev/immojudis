import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { normalizeOptOutEmail } from "@/lib/information-agent-opt-out";

/**
 * Accès et effacement pour un professionnel contacté par l'agent d'information, sans compte.
 *
 * Le professionnel prouve qu'il tient l'adresse par le lien signé de l'email (même jeton que
 * l'opposition). La demande est enregistrée dans `data_subject_requests` sans `user_id`, avec
 * `metadata.source = PROFESSIONAL_PRIVACY_SOURCE`, puis traitée par un administrateur : l'export
 * d'accès est remis à l'adresse elle-même, et l'effacement exige que l'administrateur retape cette
 * adresse (voir `executePrivacyErasure`).
 */

export const PROFESSIONAL_PRIVACY_SOURCE = "information_agent_professional_link";
export const PROFESSIONAL_REQUEST_TYPES = ["access", "erasure"] as const;
export type ProfessionalRequestType = (typeof PROFESSIONAL_REQUEST_TYPES)[number];

const PAGE_SIZE = 1000;
const MAX_ROWS = 20_000;
const OPEN_STATUSES = ["received", "identity_verification", "in_review"];

export function isProfessionalRequestType(value: unknown): value is ProfessionalRequestType {
  return (PROFESSIONAL_REQUEST_TYPES as readonly unknown[]).includes(value);
}

/** Échappe `\`, `%` et `_` : une adresse contient souvent `_`, qui joindrait une autre adresse. */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

type PageResult<T> = PromiseLike<{ data: T[] | null; error: { message?: string } | null }>;

/** Lit toutes les lignes d'une requête par pages (PostgREST plafonne chaque réponse). */
async function fetchAll<T>(page: (from: number, to: number) => PageResult<T>): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message || "Lecture impossible.");
    rows.push(...(data ?? []));
    if ((data?.length ?? 0) < PAGE_SIZE) break;
  }
  return rows;
}

/**
 * Enregistre la demande d'un professionnel (lien signé vérifié par l'appelant). Une demande ouverte
 * du même type pour la même adresse n'est pas dupliquée.
 */
export async function createProfessionalPrivacyRequest({
  email,
  requestType,
}: {
  email: string;
  requestType: ProfessionalRequestType;
}): Promise<{ created: boolean }> {
  const requesterEmail = normalizeOptOutEmail(email);
  const { count, error: countError } = await supabaseAdmin
    .from("data_subject_requests")
    .select("id", { count: "exact", head: true })
    .eq("requester_email", requesterEmail)
    .eq("request_type", requestType)
    .is("user_id", null)
    .in("status", OPEN_STATUSES);
  if (countError) throw countError;
  if ((count ?? 0) > 0) return { created: false };

  const { error } = await supabaseAdmin.from("data_subject_requests").insert({
    user_id: null,
    requester_email: requesterEmail,
    request_type: requestType,
    // Le lien signé prouve que le demandeur tient l'adresse : l'identité est celle de l'adresse.
    identity_status: "verified",
    message: null,
    metadata: { source: PROFESSIONAL_PRIVACY_SOURCE, verification: "signed_email_link" },
  });
  if (error) throw error;
  return { created: true };
}

type Scope = { caseIds: string[]; missionIds: string[] };

/** Dossiers et demandes dont l'adresse est le destinataire (comparaison exacte, casse ignorée). */
async function professionalScope(email: string): Promise<Scope> {
  const cases = await fetchAll((from, to) =>
    supabaseAdmin
      .from("information_agent_cases")
      .select("id")
      .eq("normalized_recipient_email", email)
      .order("id")
      .range(from, to),
  );
  const missions = await fetchAll((from, to) =>
    supabaseAdmin
      .from("information_agent_missions")
      .select("id,recipient_email")
      .ilike("recipient_email", escapeLikePattern(email))
      .order("id")
      .range(from, to),
  );
  return {
    caseIds: cases.map((row) => row.id),
    // `ilike` ne sert qu'à réduire la lecture : l'égalité exacte décide.
    missionIds: missions
      .filter((row) => normalizeOptOutEmail(row.recipient_email) === email)
      .map((row) => row.id),
  };
}

async function inChunks<R>(
  values: string[],
  read: (chunk: string[]) => Promise<R[]>,
  chunkSize = 100,
): Promise<R[]> {
  const rows: R[] = [];
  for (let index = 0; index < values.length; index += chunkSize) {
    rows.push(...(await read(values.slice(index, index + chunkSize))));
  }
  return rows;
}

export type ProfessionalDataExport = {
  generatedAt: string;
  email: string;
  cases: Array<Record<string, unknown>>;
  requests: Array<Record<string, unknown>>;
  messages: Array<Record<string, unknown>>;
  files: Array<Record<string, unknown>>;
  extractedFacts: Array<Record<string, unknown>>;
  fileAnalyses: Array<Record<string, unknown>>;
  contacts: Array<Record<string, unknown>>;
};

/**
 * Copie des données détenues pour une adresse : dossiers, demandes, messages échangés, pièces
 * déposées (métadonnées, pas le contenu), informations extraites et fiche du registre. N'inclut ni
 * l'identité ni l'adresse des personnes qui ont fait la demande à Immojudis.
 */
export async function collectProfessionalData(rawEmail: string): Promise<ProfessionalDataExport> {
  const email = normalizeOptOutEmail(rawEmail);
  const { caseIds, missionIds } = await professionalScope(email);

  const cases = await inChunks(caseIds, async (chunk) => {
    const { data, error } = await supabaseAdmin
      .from("information_agent_cases")
      .select(
        "id,sale_id,recipient_name,recipient_email,subject,body_text,status,sent_at,replied_at,created_at",
      )
      .in("id", chunk);
    if (error) throw error;
    return data ?? [];
  });
  const requests = await inChunks(missionIds, async (chunk) => {
    const { data, error } = await supabaseAdmin
      .from("information_agent_missions")
      .select(
        "id,sale_id,recipient_name,recipient_email,subject,status,sent_at,replied_at,created_at",
      )
      .in("id", chunk);
    if (error) throw error;
    return data ?? [];
  });

  const messageColumns =
    "id,case_id,mission_id,direction,message_kind,from_email,to_email,subject,body_text,attachments,sent_at,received_at,created_at";
  const byCase = await inChunks(caseIds, async (chunk) => {
    const { data, error } = await supabaseAdmin
      .from("information_agent_messages")
      .select(messageColumns)
      .in("case_id", chunk);
    if (error) throw error;
    return data ?? [];
  });
  const byMission = await inChunks(missionIds, async (chunk) => {
    const { data, error } = await supabaseAdmin
      .from("information_agent_messages")
      .select(messageColumns)
      .in("mission_id", chunk);
    if (error) throw error;
    return data ?? [];
  });
  const messages = [
    ...new Map([...byCase, ...byMission].map((row) => [row.id, row])).values(),
  ].sort((left, right) => left.created_at.localeCompare(right.created_at));

  const files = await inChunks(caseIds, async (chunk) => {
    const { data, error } = await supabaseAdmin
      .from("information_agent_evidence_assets")
      .select(
        "id,case_id,message_id,original_filename,mime_type,size_bytes,sha256,review_status,created_at",
      )
      .in("case_id", chunk);
    if (error) throw error;
    return data ?? [];
  });
  const extractedFacts = await inChunks(caseIds, async (chunk) => {
    const { data, error } = await supabaseAdmin
      .from("information_agent_fact_candidates")
      .select("id,case_id,message_id,fact_key,display_value,evidence_excerpt,status,created_at")
      .in("case_id", chunk);
    if (error) throw error;
    return data ?? [];
  });

  const fileAnalyses = await inChunks(caseIds, async (chunk) => {
    const { data, error } = await supabaseAdmin
      .from("information_agent_evidence_extractions")
      .select("id,asset_id,case_id,status,document_kind,page_count,summary,created_at")
      .in("case_id", chunk);
    if (error) throw error;
    return data ?? [];
  });

  const contacts = await fetchAll((from, to) =>
    supabaseAdmin
      .from("information_agent_contacts")
      .select(
        "id,email,display_name,role,source_name,source_url,source_kind,observed_at,opposition_status,opposed_at,bounce_status,created_at",
      )
      .eq("normalized_email", email)
      .order("id")
      .range(from, to),
  );

  return {
    generatedAt: new Date().toISOString(),
    email,
    cases,
    requests,
    messages,
    files,
    extractedFacts,
    fileAnalyses,
    contacts,
  };
}

export type ProfessionalErasureReport = {
  deletedRows: Record<string, number>;
  storageObjectsQueued: number;
  oppositionRecorded: true;
};

/**
 * Efface les données d'un professionnel : fichiers reçus mis en file de suppression Storage (les
 * documents déjà publiés après validation humaine ne sont pas retirés ici), dossiers
 * partagés et demandes dont il est le destinataire (messages, pièces, informations extraites et files
 * d'analyse en cascade), fiches du registre propres à une vente. L'adresse est ensuite inscrite à la liste d'opposition (elle seule reste,
 * normalisée) : sans cela, la prochaine collecte de l'annonce la recréerait et l'agent pourrait de
 * nouveau la solliciter. Idempotent : relancé après un échec partiel, il reprend où il s'est arrêté.
 */
export async function eraseProfessionalData(rawEmail: string): Promise<ProfessionalErasureReport> {
  const email = normalizeOptOutEmail(rawEmail);
  const { caseIds, missionIds } = await professionalScope(email);
  const deletedRows: Record<string, number> = {};

  // 1. Fichiers : mis en file avant toute suppression de ligne, pour que l'échec d'une étape
  //    ultérieure ne laisse pas d'objet sans trace. La file est vidée par /api/cron/sale-retention.
  const assets = await inChunks(caseIds, async (chunk) => {
    const { data, error } = await supabaseAdmin
      .from("information_agent_evidence_assets")
      .select("storage_bucket,storage_path")
      .in("case_id", chunk);
    if (error) throw error;
    return data ?? [];
  });
  const queue = new Map<string, { bucket: string; object_path: string }>();
  for (const asset of assets) {
    queue.set(`${asset.storage_bucket}/${asset.storage_path}`, {
      bucket: asset.storage_bucket,
      object_path: asset.storage_path,
    });
  }
  if (queue.size) {
    const { error } = await supabaseAdmin
      .from("sale_retention_storage_queue")
      .upsert([...queue.values()], { onConflict: "bucket,object_path", ignoreDuplicates: true });
    if (error) throw new Error(`Mise en file des fichiers impossible : ${error.message}`);
  }

  // 2. Opposition d'abord : si la suite échoue, l'adresse n'est de toute façon plus contactée. La
  //    ligne globale conservée ne garde que l'adresse et l'opposition : nom, rôle (ramené à sa valeur
  //    par défaut, la colonne est obligatoire), source et relevé sont vidés, même si une ligne
  //    préexistante les portait. La base le fait aussi (déclencheur d'opposition), sans qu'on s'y fie.
  const { error: oppositionError } = await supabaseAdmin.from("information_agent_contacts").upsert(
    {
      sale_id: null,
      scope_sale_id: null,
      email,
      opposition_status: "opposed",
      opposed_at: new Date().toISOString(),
      display_name: null,
      role: "source_contact",
      source_name: null,
      source_url: null,
      source_kind: null,
      source_directory_name: null,
      observed_at: null,
      observed_by: null,
      observed_by_user_id: null,
      provenance: [],
      metadata: {},
    },
    { onConflict: "scope_sale_id,normalized_email" },
  );
  if (oppositionError) throw new Error(`Opposition impossible : ${oppositionError.message}`);

  // 2 bis. Fiches du registre propres à une vente (`scope_sale_id` non nul) : elles portent le nom
  //        et la source du professionnel pour cette vente. Seule la ligne globale opposée reste.
  const { count: contactCount, error: contactsError } = await supabaseAdmin
    .from("information_agent_contacts")
    .delete({ count: "exact" })
    .eq("normalized_email", email)
    .not("scope_sale_id", "is", null)
    .neq("opposition_status", "opposed");
  if (contactsError) {
    throw new Error(
      `Effacement impossible dans information_agent_contacts : ${contactsError.message}`,
    );
  }
  deletedRows["information_agent_contacts"] = contactCount ?? 0;

  // 3. Dossiers (messages, pièces, informations extraites, tâches d'analyse en cascade), puis demandes.
  deletedRows["information_agent_cases"] = await deleteByIds("information_agent_cases", caseIds);
  deletedRows["information_agent_missions"] = await deleteByIds(
    "information_agent_missions",
    missionIds,
  );

  return { deletedRows, storageObjectsQueued: queue.size, oppositionRecorded: true };
}

async function deleteByIds(
  table: "information_agent_cases" | "information_agent_missions",
  ids: string[],
): Promise<number> {
  let deleted = 0;
  for (let index = 0; index < ids.length; index += 100) {
    const { count, error } = await supabaseAdmin
      .from(table)
      .delete({ count: "exact" })
      .in("id", ids.slice(index, index + 100));
    if (error) throw new Error(`Effacement impossible dans ${table} : ${error.message}`);
    deleted += count ?? 0;
  }
  return deleted;
}
