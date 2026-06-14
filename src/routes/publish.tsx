import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type * as React from "react";
import { useMemo, useState } from "react";
import BadgeCheck from "lucide-react/dist/esm/icons/badge-check.js";
import Clock from "lucide-react/dist/esm/icons/clock.js";
import EyeOff from "lucide-react/dist/esm/icons/eye-off.js";
import FileText from "lucide-react/dist/esm/icons/file-text.js";
import ImagePlus from "lucide-react/dist/esm/icons/image-plus.js";
import LockKeyhole from "lucide-react/dist/esm/icons/lock-keyhole.js";
import Megaphone from "lucide-react/dist/esm/icons/megaphone.js";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import UploadCloud from "lucide-react/dist/esm/icons/upload-cloud.js";
import { toast } from "sonner";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/integrations/supabase/client";
import type { Json, Tables } from "@/integrations/supabase/types";
import { getProfessionalStatus, isProfessionalAccount } from "@/lib/account";

export const Route = createFileRoute("/publish")({
  head: () => ({
    meta: [
      { title: "Publier une vente — Immojudis" },
      {
        name: "description",
        content:
          "Préparez une demande de publication de vente aux enchères immobilière avec documents, anonymisation et validation admin.",
      },
    ],
    links: [{ rel: "canonical", href: "/publish" }],
  }),
  component: PublishPage,
});

type PublishDraft = {
  title: string;
  location: string;
  startingPrice: string;
  hearingDate: string;
  court: string;
  description: string;
  strengths: string;
  cautions: string;
  anonymizeDocuments: boolean;
  selectedDocuments: string[];
  selectedPromotions: string[];
  fileCount: number;
};

type PublicationRequest = Tables<"listing_publication_requests">;

type UploadedPublicationDocument = {
  bucket: string;
  path: string;
  name: string;
  size: number;
  mime_type: string;
  uploaded_at: string;
};

const PUBLICATION_DOCUMENT_BUCKET = "listing-request-documents";

const INITIAL_DRAFT: PublishDraft = {
  title: "",
  location: "",
  startingPrice: "",
  hearingDate: "",
  court: "",
  description: "",
  strengths: "",
  cautions: "",
  anonymizeDocuments: true,
  selectedDocuments: [],
  selectedPromotions: ["featured"],
  fileCount: 0,
};

const DOCUMENT_TYPES = [
  "Cahier des conditions de vente",
  "Procès-verbal descriptif",
  "Diagnostics techniques",
  "Photos du bien",
  "Plans ou annexes",
] as const;

const PROMOTION_OPTIONS = [
  {
    id: "featured",
    label: "Mise en avant Immojudis",
    desc: "Annonce priorisée dans les sélections éditoriales et les pages de recherche.",
  },
  {
    id: "seo",
    label: "Référencement renforcé",
    desc: "Titre, description et données structurées préparés pour une meilleure visibilité.",
  },
  {
    id: "partners",
    label: "Diffusion partenaires",
    desc: "Préparation d'un dossier compatible avec des relais médias ou sites spécialisés.",
  },
] as const;

function PublishPage() {
  const { user, profile, loading } = useAuth();
  const [draft, setDraft] = useState<PublishDraft>(INITIAL_DRAFT);
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const isProfessional = isProfessionalAccount(user, profile);
  const professionalStatus = getProfessionalStatus(profile);

  const { data: recentRequests = [], isFetching: requestsLoading } = useQuery({
    queryKey: ["publication-requests", user?.id],
    enabled: Boolean(user?.id && isProfessional),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("listing_publication_requests")
        .select(
          "id,title,location,status,created_at,submitted_documents,starting_price_eur,hearing_date",
        )
        .eq("requester_id", user?.id ?? "")
        .order("created_at", { ascending: false })
        .limit(5);

      if (error) throw error;
      return (data ?? []) as PublicationRequest[];
    },
  });

  const completion = useMemo(() => {
    const checks = [
      draft.title.trim(),
      draft.location.trim(),
      draft.startingPrice.trim(),
      draft.hearingDate.trim(),
      draft.court.trim(),
      draft.description.trim(),
      draft.selectedDocuments.length > 0 ? "documents" : "",
      draft.fileCount > 0 ? "files" : "",
    ];

    return Math.round((checks.filter(Boolean).length / checks.length) * 100);
  }, [draft]);

  const updateDraft = <K extends keyof PublishDraft>(key: K, value: PublishDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const toggleDocument = (name: string) => {
    setDraft((current) => ({
      ...current,
      selectedDocuments: current.selectedDocuments.includes(name)
        ? current.selectedDocuments.filter((item) => item !== name)
        : [...current.selectedDocuments, name],
    }));
  };

  const togglePromotion = (id: string) => {
    setDraft((current) => ({
      ...current,
      selectedPromotions: current.selectedPromotions.includes(id)
        ? current.selectedPromotions.filter((item) => item !== id)
        : [...current.selectedPromotions, id],
    }));
  };

  const handleFilesChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const nextFiles = Array.from(event.currentTarget.files ?? []);
    setFiles(nextFiles);
    updateDraft("fileCount", nextFiles.length);
  };

  const submitRequest = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!user || !isProfessional) {
      toast.error("Seuls les comptes professionnels peuvent demander une publication.");
      return;
    }

    if (!draft.title.trim() || !draft.location.trim() || !draft.description.trim()) {
      toast.error("Ajoutez au minimum un titre, une localisation et une description.");
      return;
    }

    if (!draft.selectedDocuments.length && !files.length) {
      toast.error("Ajoutez au moins un type de document ou une pièce transmise.");
      return;
    }

    const requestId = createRequestId();
    setSubmitting(true);

    try {
      const uploadedDocuments: UploadedPublicationDocument[] = [];

      for (const file of files) {
        const path = `${user.id}/${requestId}/${safeStorageFileName(file.name)}`;
        const { error } = await supabase.storage
          .from(PUBLICATION_DOCUMENT_BUCKET)
          .upload(path, file, {
            cacheControl: "3600",
            contentType: file.type || undefined,
            upsert: false,
          });

        if (error) throw error;

        uploadedDocuments.push({
          bucket: PUBLICATION_DOCUMENT_BUCKET,
          path,
          name: file.name,
          size: file.size,
          mime_type: file.type || "application/octet-stream",
          uploaded_at: new Date().toISOString(),
        });
      }

      const { error } = await supabase.from("listing_publication_requests").insert({
        id: requestId,
        requester_id: user.id,
        requester_email: user.email ?? null,
        title: draft.title.trim(),
        location: draft.location.trim(),
        starting_price_eur: parseEuroAmount(draft.startingPrice),
        hearing_date: draft.hearingDate || null,
        court: draft.court.trim() || null,
        description: draft.description.trim(),
        strengths: draft.strengths.trim() || null,
        cautions: draft.cautions.trim() || null,
        anonymize_documents: draft.anonymizeDocuments,
        document_types: draft.selectedDocuments,
        promotion_options: draft.selectedPromotions,
        submitted_documents: uploadedDocuments as unknown as Json,
        status: "pending",
      });

      if (error) throw error;

      toast.success("Demande envoyée. Elle apparaît maintenant dans la file de validation admin.");
      setDraft(INITIAL_DRAFT);
      setFiles([]);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Impossible d'enregistrer la demande de publication.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <main className="liquid-page min-h-screen px-4 py-8 text-foreground sm:px-6 lg:py-12">
        <div className="glass-shell mx-auto max-w-3xl rounded-lg p-6">
          <RefreshCw className="h-5 w-5 animate-spin text-gold" />
          <p className="mt-4 text-sm text-muted-foreground">Vérification de l'accès pro...</p>
        </div>
      </main>
    );
  }

  if (!isProfessional) {
    return (
      <main className="liquid-page min-h-screen px-4 py-8 text-foreground sm:px-6 lg:py-12">
        <div className="glass-shell mx-auto max-w-3xl rounded-lg p-6 sm:p-8">
          <div className="flex items-center gap-3 text-[11px] font-semibold uppercase tracking-[0.28em] text-gold">
            <LockKeyhole className="h-4 w-4" />
            Accès professionnel
          </div>
          <h1 className="mt-4 font-display text-4xl leading-tight">
            La publication d'annonce est réservée aux comptes pro.
          </h1>
          <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
            Les investisseurs particuliers conservent l'accès aux fiches, favoris, alertes et à la
            carte. Pour référencer une vente, créez un compte professionnel avocat, notaire,
            commissaire de justice ou tribunal.
          </p>
          <Link
            to="/login"
            className="liquid-button mt-6 inline-flex items-center justify-center rounded-lg px-5 py-3 text-xs font-bold uppercase tracking-[0.18em] text-background"
          >
            Créer un compte pro
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="liquid-page min-h-screen px-4 py-8 text-foreground sm:px-6 lg:py-12">
      <div className="mx-auto max-w-7xl">
        <header className="glass-shell mb-8 grid gap-6 rounded-lg p-6 sm:p-8 lg:grid-cols-[1fr_24rem] lg:items-end">
          <div>
            <div className="flex items-center gap-3 text-[11px] font-semibold uppercase tracking-[0.28em] text-gold">
              <Megaphone className="h-4 w-4" />
              Demande de publication pro
            </div>
            <h1 className="mt-4 max-w-4xl font-display text-4xl leading-tight text-foreground sm:text-5xl">
              Transmettre une annonce complète pour validation Immojudis.
            </h1>
            <p className="mt-5 max-w-3xl text-sm leading-relaxed text-muted-foreground sm:text-base">
              Les informations et pièces déposées sont enregistrées dans Supabase en statut
              "en attente". L'équipe peut ensuite contrôler, compléter et valider la mise en ligne
              depuis le panel admin.
            </p>
          </div>

          <div className="liquid-panel-soft rounded-lg p-5">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                  Préparation
                </div>
                <div className="mt-2 font-display text-3xl text-gold-soft">{completion}%</div>
              </div>
              <BadgeCheck className="h-8 w-8 text-gold" />
            </div>
            <div className="mt-4 h-2 overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full rounded-full bg-gold transition-all"
                style={{ width: `${completion}%` }}
              />
            </div>
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              Statut pro : {professionalStatusLabel(professionalStatus)}. La publication reste
              soumise à validation interne avant diffusion.
            </p>
          </div>
        </header>

        <form onSubmit={submitRequest} className="grid gap-6 lg:grid-cols-[1fr_22rem]">
          <div className="grid gap-6">
            <section className="liquid-panel rounded-lg p-5 sm:p-6">
              <SectionTitle
                icon={FileText}
                title="Informations de l'annonce"
                subtitle="Les éléments qui structurent la lecture investisseur."
              />

              <div className="mt-6 grid gap-4 md:grid-cols-2">
                <Field label="Titre de l'annonce">
                  <input
                    value={draft.title}
                    onChange={(event) => updateDraft("title", event.target.value)}
                    className="form-input"
                    placeholder="Appartement T3 avec terrasse..."
                  />
                </Field>
                <Field label="Adresse ou secteur">
                  <input
                    value={draft.location}
                    onChange={(event) => updateDraft("location", event.target.value)}
                    className="form-input"
                    placeholder="Bordeaux, département 33"
                  />
                </Field>
                <Field label="Mise à prix">
                  <input
                    value={draft.startingPrice}
                    onChange={(event) => updateDraft("startingPrice", event.target.value)}
                    className="form-input"
                    inputMode="numeric"
                    placeholder="340000"
                  />
                </Field>
                <Field label="Date de vente">
                  <input
                    value={draft.hearingDate}
                    onChange={(event) => updateDraft("hearingDate", event.target.value)}
                    className="form-input"
                    type="date"
                  />
                </Field>
                <Field label="Tribunal">
                  <input
                    value={draft.court}
                    onChange={(event) => updateDraft("court", event.target.value)}
                    className="form-input"
                    placeholder="TJ Bordeaux"
                  />
                </Field>
                <Field label="Pièces transmises">
                  <label className="form-dropzone">
                    <ImagePlus className="h-5 w-5 text-gold" />
                    <span>{files.length > 0 ? `${files.length} fichier(s)` : "Ajouter"}</span>
                    <input
                      type="file"
                      accept="image/*,application/pdf"
                      multiple
                      className="sr-only"
                      onChange={handleFilesChange}
                    />
                  </label>
                </Field>
              </div>

              {files.length ? (
                <div className="mt-4 rounded-lg border border-white/10 bg-white/[0.03] p-3">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                    Fichiers prêts à envoyer
                  </div>
                  <div className="mt-3 grid gap-2">
                    {files.map((file) => (
                      <div
                        key={`${file.name}-${file.size}`}
                        className="flex items-center justify-between gap-3 rounded-md bg-background/35 px-3 py-2 text-xs"
                      >
                        <span className="truncate text-foreground">{file.name}</span>
                        <span className="shrink-0 text-muted-foreground">
                          {formatFileSize(file.size)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="mt-4 grid gap-4">
                <Field label="Description détaillée">
                  <textarea
                    value={draft.description}
                    onChange={(event) => updateDraft("description", event.target.value)}
                    className="form-textarea min-h-32"
                    placeholder="Décrire le bien, son contexte, les surfaces, annexes et conditions de visite."
                  />
                </Field>
                <div className="grid gap-4 md:grid-cols-2">
                  <Field label="Atouts à mettre en avant">
                    <textarea
                      value={draft.strengths}
                      onChange={(event) => updateDraft("strengths", event.target.value)}
                      className="form-textarea"
                      placeholder="Terrasse, cave, stationnement, emplacement..."
                    />
                  </Field>
                  <Field label="Points à contextualiser">
                    <textarea
                      value={draft.cautions}
                      onChange={(event) => updateDraft("cautions", event.target.value)}
                      className="form-textarea"
                      placeholder="Occupation, travaux, servitude, diagnostics..."
                    />
                  </Field>
                </div>
              </div>
            </section>

            <section className="liquid-panel rounded-lg p-5 sm:p-6">
              <SectionTitle
                icon={ShieldCheck}
                title="Documents et confidentialité"
                subtitle="Les pièces sont conservées dans un espace privé avant validation."
              />

              <div className="mt-6 grid gap-3 md:grid-cols-2">
                {DOCUMENT_TYPES.map((name) => (
                  <label key={name} className="choice-card">
                    <input
                      type="checkbox"
                      checked={draft.selectedDocuments.includes(name)}
                      onChange={() => toggleDocument(name)}
                      className="sr-only"
                    />
                    <FileText className="h-4 w-4 text-gold" />
                    <span>{name}</span>
                  </label>
                ))}
              </div>

              <label className="mt-5 flex items-start gap-3 rounded-lg border border-gold/20 bg-gold/10 p-4">
                <input
                  type="checkbox"
                  checked={draft.anonymizeDocuments}
                  onChange={(event) => updateDraft("anonymizeDocuments", event.target.checked)}
                  className="mt-1"
                />
                <span>
                  <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <EyeOff className="h-4 w-4 text-gold" />
                    Anonymiser les documents avant diffusion
                  </span>
                  <span className="mt-1 block text-sm leading-relaxed text-muted-foreground">
                    Les pièces restent privées. La diffusion publique ne doit conserver que les
                    éléments utiles à l'investisseur et masquer les données personnelles.
                  </span>
                </span>
              </label>
            </section>
          </div>

          <aside className="grid gap-6 lg:sticky lg:top-24 lg:self-start">
            <section className="liquid-panel rounded-lg p-5">
              <SectionTitle
                icon={Megaphone}
                title="Promotion"
                subtitle="Choisir comment donner de la visibilité au dossier."
              />

              <div className="mt-5 grid gap-3">
                {PROMOTION_OPTIONS.map((option) => (
                  <label key={option.id} className="choice-card items-start">
                    <input
                      type="checkbox"
                      checked={draft.selectedPromotions.includes(option.id)}
                      onChange={() => togglePromotion(option.id)}
                      className="mt-1"
                    />
                    <span>
                      <span className="block text-sm font-semibold text-foreground">
                        {option.label}
                      </span>
                      <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                        {option.desc}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </section>

            <section className="liquid-panel-soft rounded-lg p-5">
              <div className="flex items-center gap-3 text-[11px] font-semibold uppercase tracking-[0.2em] text-gold">
                <UploadCloud className="h-4 w-4" />
                Prochaine étape
              </div>
              <h2 className="mt-4 font-display text-2xl text-foreground">
                Envoyer à la validation
              </h2>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                La demande sera visible côté admin avec les fichiers associés, en attente de
                contrôle avant publication.
              </p>
              <button
                type="submit"
                disabled={submitting}
                className="liquid-button mt-5 inline-flex w-full items-center justify-center gap-2 rounded-lg px-5 py-3 text-xs font-bold uppercase tracking-[0.18em] text-background disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting ? (
                  <>
                    <RefreshCw className="h-4 w-4 animate-spin" />
                    Envoi en cours
                  </>
                ) : (
                  "Envoyer pour validation"
                )}
              </button>
            </section>

            <section className="liquid-panel rounded-lg p-5">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-gold">
                  <Clock className="h-4 w-4" />
                  Mes demandes
                </div>
                {requestsLoading ? (
                  <RefreshCw className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                ) : null}
              </div>
              <div className="mt-4 grid gap-3">
                {recentRequests.length ? (
                  recentRequests.map((request) => (
                    <PublicationRequestLine key={request.id} request={request} />
                  ))
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Aucune demande encore transmise depuis ce compte.
                  </p>
                )}
              </div>
            </section>
          </aside>
        </form>
      </div>
    </main>
  );
}

function PublicationRequestLine({ request }: { request: PublicationRequest }) {
  const documents = asUploadedDocuments(request.submitted_documents);

  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-foreground">{request.title}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {request.location ?? "Localisation à préciser"}
          </div>
        </div>
        <StatusPill status={request.status} />
      </div>
      <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
        <span>{documents.length} fichier(s)</span>
        <span>•</span>
        <span>{formatDate(request.created_at)}</span>
      </div>
    </div>
  );
}

function SectionTitle({
  icon: Icon,
  title,
  subtitle,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-gold/20 bg-gold/10 text-gold">
        <Icon className="h-5 w-5" />
      </span>
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-foreground">
          {title}
        </h2>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{subtitle}</p>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-2">
      <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}

function StatusPill({ status }: { status: PublicationRequest["status"] }) {
  const label =
    status === "approved" ? "Validée" : status === "rejected" ? "Refusée" : "En attente";
  const tone =
    status === "approved"
      ? "border-emerald-300/20 bg-emerald-400/10 text-emerald-100"
      : status === "rejected"
        ? "border-red-300/20 bg-red-500/10 text-red-100"
        : "border-amber-300/20 bg-amber-400/10 text-amber-100";

  return (
    <span className={`inline-flex shrink-0 rounded-full border px-2.5 py-1 text-[11px] ${tone}`}>
      {label}
    </span>
  );
}

function createRequestId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function safeStorageFileName(fileName: string): string {
  const cleanName =
    fileName
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(-140) || "document";

  return `${Date.now()}-${cleanName}`;
}

function parseEuroAmount(value: string): number | null {
  const normalized = value.replace(/\s/g, "").replace(/[^\d.,-]/g, "").replace(",", ".");
  const amount = Number.parseFloat(normalized);
  return Number.isFinite(amount) ? amount : null;
}

function professionalStatusLabel(status: ReturnType<typeof getProfessionalStatus>) {
  if (status === "approved") return "validé";
  if (status === "rejected") return "refusé";
  if (status === "pending") return "en cours de revue";
  return "professionnel";
}

function asUploadedDocuments(value: Json | null): UploadedPublicationDocument[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is UploadedPublicationDocument =>
      item !== null && typeof item === "object" && !Array.isArray(item) && "path" in item,
  );
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  const kilobytes = bytes / 1024;
  if (kilobytes < 1024) return `${kilobytes.toFixed(1)} Ko`;
  return `${(kilobytes / 1024).toFixed(1)} Mo`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("fr-FR", {
    dateStyle: "medium",
  }).format(new Date(value));
}
