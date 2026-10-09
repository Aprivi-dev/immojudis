"use client";

import { useQuery } from "@tanstack/react-query";
import AlertCircle from "lucide-react/dist/esm/icons/alert-circle.js";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.js";
import BriefcaseBusiness from "lucide-react/dist/esm/icons/briefcase-business.js";
import Clock3 from "lucide-react/dist/esm/icons/clock-3.js";
import ExternalLink from "lucide-react/dist/esm/icons/external-link.js";
import EyeOff from "lucide-react/dist/esm/icons/eye-off.js";
import FileCheck2 from "lucide-react/dist/esm/icons/file-check-2.js";
import FileText from "lucide-react/dist/esm/icons/file-text.js";
import Mail from "lucide-react/dist/esm/icons/mail.js";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import { useEffect, useMemo, useState } from "react";
import { createFileRoute, Link } from "@/lib/router-compat";
import { useAuth } from "@/hooks/use-auth";
import {
  getAccountType,
  getProfessionalStatus,
  isAdminAccount,
  isProfessionalAccount,
} from "@/lib/account";
import {
  fetchPublicationRequestClient,
  fetchAllPublicationRequestsClient,
  type PublicationDocumentView,
  type PublicationRequestDetail,
  type PublicationRequestSummary,
} from "@/lib/publication-requests-client";

export const Route = createFileRoute("/espace-pro")({
  component: ProfessionalWorkspacePage,
});

export function ProfessionalWorkspacePage() {
  const { user, profile, loading } = useAuth();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const professionalStatus = getProfessionalStatus(profile);
  const professional = isProfessionalAccount(user, profile);
  const admin = isAdminAccount(user, profile);
  const requestsQuery = useQuery({
    queryKey: ["publication-requests", "workspace", user?.id],
    queryFn: fetchAllPublicationRequestsClient,
    enabled: Boolean(user),
    staleTime: 15_000,
  });
  const requests = useMemo(
    () => requestsQuery.data?.requests ?? [],
    [requestsQuery.data?.requests],
  );
  const selectedRequest = requests.find((request) => request.id === selectedId) ?? null;
  const detailQuery = useQuery({
    queryKey: ["publication-request", selectedId],
    queryFn: () => fetchPublicationRequestClient(selectedId as string),
    enabled: Boolean(selectedId && user),
    staleTime: 15_000,
  });

  useEffect(() => {
    if (selectedId && !requests.some((request) => request.id === selectedId)) {
      setSelectedId(null);
    }
  }, [requests, selectedId]);

  if (loading) {
    return <WorkspaceLoading />;
  }

  if (!user) {
    return (
      <WorkspaceMessage
        icon={ShieldCheck}
        title="Connectez-vous pour ouvrir votre espace pro"
        description="Votre espace rassemble les demandes de publication envoyées depuis votre compte et les ventes validées."
      >
        <Link
          to="/login"
          search={{ mode: "professional", redirect: "/espace-pro" }}
          className="liquid-button inline-flex items-center justify-center gap-2 rounded-lg px-5 py-3 text-xs font-bold uppercase tracking-[0.18em] text-background"
        >
          Se connecter <ArrowRight className="h-4 w-4" />
        </Link>
      </WorkspaceMessage>
    );
  }

  if (!user.email?.trim()) {
    return (
      <WorkspaceMessage
        icon={Mail}
        title="Une adresse email est nécessaire"
        description="Ajoutez et confirmez une adresse email dans votre compte avant de déposer ou suivre une demande de publication."
      >
        <Link
          to="/login"
          className="liquid-button inline-flex items-center justify-center gap-2 rounded-lg px-5 py-3 text-xs font-bold uppercase tracking-[0.18em] text-background"
        >
          Gérer mon compte <ArrowRight className="h-4 w-4" />
        </Link>
      </WorkspaceMessage>
    );
  }

  const accountType = getAccountType(user, profile);
  const pendingProfessional =
    !professional && accountType === "b2b" && professionalStatus === "pending";

  if (!professional && accountType === "b2b" && !pendingProfessional) {
    return (
      <WorkspaceMessage
        icon={Clock3}
        title="La validation de votre compte pro a été refusée"
        description="Contactez Immojudis si votre situation professionnelle a changé ou si vous souhaitez préciser votre demande."
      >
        <Link
          to="/contact"
          className="liquid-panel-soft inline-flex items-center justify-center gap-2 rounded-lg px-5 py-3 text-xs font-bold uppercase tracking-[0.18em] text-gold hover:border-gold"
        >
          Contacter Immojudis <ArrowRight className="h-4 w-4" />
        </Link>
      </WorkspaceMessage>
    );
  }

  if (!professional && !admin && !pendingProfessional) {
    return (
      <WorkspaceMessage
        icon={BriefcaseBusiness}
        title="Cet espace est réservé aux comptes professionnels"
        description="Les avocats, notaires, commissaires de justice et tribunaux peuvent demander la publication et suivre leurs dossiers ici."
      >
        <Link
          to="/login"
          search={{ mode: "professional", redirect: "/espace-pro" }}
          className="liquid-button inline-flex items-center justify-center gap-2 rounded-lg px-5 py-3 text-xs font-bold uppercase tracking-[0.18em] text-background"
        >
          Demander un accès pro <ArrowRight className="h-4 w-4" />
        </Link>
      </WorkspaceMessage>
    );
  }

  const selectedDetail = detailQuery.data?.request ?? null;

  return (
    <main className="liquid-page min-h-screen px-4 py-8 text-foreground sm:px-6 lg:py-12">
      <div className="mx-auto max-w-7xl">
        <header className="glass-shell grid gap-6 rounded-lg p-6 sm:p-8 lg:grid-cols-[1fr_19rem] lg:items-end">
          <div>
            <div className="flex items-center gap-3 text-[11px] font-semibold uppercase tracking-[0.28em] text-gold">
              <BriefcaseBusiness className="h-4 w-4" />
              Espace professionnel
            </div>
            <h1 className="mt-4 font-display text-4xl leading-tight sm:text-5xl">
              Suivre vos ventes déposées et publiées.
            </h1>
            <p className="mt-4 max-w-3xl text-sm leading-relaxed text-muted-foreground sm:text-base">
              Retrouvez chaque demande, son statut de validation, les informations transmises et les
              pièces privées associées. Les liens vers les documents sont temporaires et réservés à
              votre compte.
            </p>
          </div>
          <div className="liquid-panel-soft rounded-lg p-5">
            <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
              Compte connecté
            </div>
            <div className="mt-3 flex items-start gap-3">
              <Mail className="mt-0.5 h-4 w-4 shrink-0 text-gold" />
              <span className="break-all text-sm text-foreground">{user.email}</span>
            </div>
            <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
              <ShieldCheck className="h-4 w-4 text-gold" />
              {admin
                ? "Accès administrateur"
                : pendingProfessional
                  ? "Validation professionnelle en cours"
                  : "Compte professionnel validé"}
            </div>
          </div>
        </header>

        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          <section className="liquid-panel rounded-lg p-5 sm:p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-gold">
                  <FileCheck2 className="h-4 w-4" />
                  Mes demandes
                </div>
                <h2 className="mt-3 font-display text-2xl">Historique de dépôt</h2>
              </div>
              {pendingProfessional ? (
                <span className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-amber-300/20 bg-amber-400/10 px-3 py-2 text-[11px] font-bold uppercase tracking-[0.14em] text-amber-100">
                  <Clock3 className="h-3.5 w-3.5" />
                  Validation en cours
                </span>
              ) : (
                <Link
                  to="/publish"
                  className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-[11px] font-bold uppercase tracking-[0.14em] text-gold hover:border-gold"
                >
                  Nouvelle demande <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              )}
            </div>

            {pendingProfessional ? (
              <div className="mt-6 rounded-lg border border-amber-300/20 bg-amber-400/10 p-4 text-sm leading-relaxed text-amber-50">
                Votre compte professionnel est en cours de validation. Vous pourrez déposer une
                vente dès que ce contrôle sera terminé ; vos demandes déjà transmises restent
                visibles dans cette page.
              </div>
            ) : null}

            {requestsQuery.isPending ? (
              <div className="mt-6 flex items-center gap-3 text-sm text-muted-foreground">
                <RefreshCw className="h-4 w-4 animate-spin text-gold" />
                Chargement des demandes...
              </div>
            ) : requestsQuery.isError ? (
              <div className="mt-6 rounded-lg border border-red-300/20 bg-red-500/10 p-4 text-sm text-red-100">
                <div className="flex items-center gap-2 font-semibold">
                  <AlertCircle className="h-4 w-4" />
                  Impossible de charger vos demandes.
                </div>
                <p className="mt-2 text-xs leading-relaxed text-red-100/80">
                  {requestsQuery.error instanceof Error
                    ? requestsQuery.error.message
                    : "Réessayez dans quelques instants."}
                </p>
              </div>
            ) : requests.length ? (
              <div className="mt-6 grid gap-3">
                {requests.map((request) => (
                  <RequestCard
                    key={request.id}
                    request={request}
                    selected={request.id === selectedId}
                    onSelect={() => setSelectedId(request.id)}
                  />
                ))}
              </div>
            ) : (
              <div className="mt-6 rounded-lg border border-white/10 bg-white/[0.03] p-5">
                <FileText className="h-5 w-5 text-gold" />
                <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                  Aucune demande n'est encore associée à ce compte.
                </p>
                {pendingProfessional ? (
                  <p className="mt-4 text-xs leading-relaxed text-amber-100/80">
                    Le dépôt sera disponible après validation du compte.
                  </p>
                ) : (
                  <Link
                    to="/publish"
                    className="mt-4 inline-flex items-center gap-2 text-xs font-bold uppercase tracking-[0.14em] text-gold underline"
                  >
                    Préparer un dépôt <ArrowRight className="h-3.5 w-3.5" />
                  </Link>
                )}
              </div>
            )}
          </section>

          <section className="liquid-panel rounded-lg p-5 sm:p-6">
            {selectedRequest ? (
              <RequestDetailPanel
                request={selectedDetail ?? selectedRequest}
                loading={detailQuery.isPending}
                error={detailQuery.error}
              />
            ) : (
              <div className="flex min-h-80 flex-col items-center justify-center text-center">
                <FileCheck2 className="h-8 w-8 text-gold" />
                <h2 className="mt-4 font-display text-2xl">Sélectionnez une demande</h2>
                <p className="mt-3 max-w-md text-sm leading-relaxed text-muted-foreground">
                  Les informations détaillées, notes de validation et pièces privées apparaîtront
                  ici.
                </p>
              </div>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}

function RequestCard({
  request,
  selected,
  onSelect,
}: {
  request: PublicationRequestSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <div
      className={`rounded-lg border p-4 transition-colors ${
        selected ? "border-gold/60 bg-gold/10" : "border-white/10 bg-white/[0.03]"
      }`}
    >
      <button type="button" onClick={onSelect} className="w-full text-left">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-foreground">{request.title}</div>
            <div className="mt-1 truncate text-xs text-muted-foreground">
              {request.location ?? "Localisation à préciser"}
            </div>
          </div>
          <StatusPill status={request.status} />
        </div>
        <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>{formatDate(request.createdAt)}</span>
          <span>{request.documentCount} pièce(s)</span>
          {request.publishedAt ? <span>Publié le {formatDate(request.publishedAt)}</span> : null}
        </div>
      </button>
      {request.publishedUrl ? (
        <a
          href={request.publishedUrl}
          className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-gold underline"
        >
          Voir la vente publiée <ExternalLink className="h-3.5 w-3.5" />
        </a>
      ) : null}
    </div>
  );
}

function RequestDetailPanel({
  request,
  loading,
  error,
}: {
  request: PublicationRequestSummary | PublicationRequestDetail;
  loading: boolean;
  error: Error | null;
}) {
  const detail = "documents" in request ? request : null;

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-gold">
            <FileText className="h-4 w-4" />
            Dossier de publication
          </div>
          <h2 className="mt-3 font-display text-2xl leading-tight">{request.title}</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Déposé le {formatDate(request.createdAt)} ·{" "}
            {request.location ?? "Localisation à préciser"}
          </p>
        </div>
        <StatusPill status={request.status} />
      </div>

      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        <DetailStat label="Mise à prix" value={formatPrice(request.startingPriceEur)} />
        <DetailStat label="Date de vente" value={formatDate(request.hearingDate)} />
        <DetailStat label="Tribunal" value={request.court ?? "À préciser"} />
        <DetailStat label="Pièces" value={`${request.documentCount} fichier(s)`} />
      </div>

      <div className="mt-6 grid gap-5">
        <TextBlock label="Description" value={request.description} />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextBlock label="Atouts" value={request.strengths} />
          <TextBlock label="Points à contextualiser" value={request.cautions} />
        </div>
      </div>

      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        <InfoCard
          icon={EyeOff}
          label="Anonymisation"
          value={request.anonymizeDocuments ? "Demandée avant diffusion" : "Non demandée"}
        />
        <InfoCard
          icon={BriefcaseBusiness}
          label="Promotion"
          value={
            request.promotionOptions.length ? request.promotionOptions.join(", ") : "Aucune option"
          }
        />
      </div>

      {request.publishedUrl ? (
        <a
          href={request.publishedUrl}
          className="mt-6 inline-flex items-center gap-2 rounded-lg border border-gold/35 bg-gold/10 px-4 py-3 text-xs font-bold uppercase tracking-[0.14em] text-gold"
        >
          Ouvrir la vente publiée <ExternalLink className="h-4 w-4" />
        </a>
      ) : null}

      {request.adminNotes ? (
        <div className="mt-6 rounded-lg border border-white/10 bg-white/[0.03] p-4">
          <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Retour de validation
          </div>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-foreground">
            {request.adminNotes}
          </p>
        </div>
      ) : null}

      <div className="mt-6 border-t border-white/10 pt-5">
        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-gold">
          <FileCheck2 className="h-4 w-4" />
          Pièces privées
        </div>
        {loading ? (
          <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
            <RefreshCw className="h-4 w-4 animate-spin text-gold" />
            Génération des liens sécurisés...
          </div>
        ) : error ? (
          <p className="mt-4 text-sm text-red-100">
            {error instanceof Error ? error.message : "Impossible de charger les pièces."}
          </p>
        ) : detail?.documents.length ? (
          <div className="mt-4 grid gap-2">
            {detail.documents.map((document) => (
              <DocumentRow key={`${document.name}-${document.uploaded_at}`} document={document} />
            ))}
          </div>
        ) : (
          <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
            Aucun fichier n'a été joint. Les types de documents déclarés :{" "}
            {request.documentTypes.length ? request.documentTypes.join(", ") : "aucun"}.
          </p>
        )}
      </div>
    </div>
  );
}

function DocumentRow({ document }: { document: PublicationDocumentView }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-3">
      <div className="min-w-0">
        <div className="truncate text-sm text-foreground">{document.name}</div>
        <div className="mt-1 text-xs text-muted-foreground">
          {formatFileSize(document.size)} · {document.mime_type}
        </div>
      </div>
      {document.signedUrl ? (
        <a
          href={document.signedUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-gold underline"
        >
          Ouvrir <ExternalLink className="h-3.5 w-3.5" />
        </a>
      ) : (
        <span className="text-xs text-muted-foreground">Indisponible</span>
      )}
    </div>
  );
}

function DetailStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
      <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 truncate text-sm text-foreground">{value}</div>
    </div>
  );
}

function InfoCard({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof EyeOff;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-lg border border-gold/20 bg-gold/10 p-4">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.15em] text-gold">
        <Icon className="h-4 w-4" />
        {label}
      </div>
      <div className="mt-2 text-sm leading-relaxed text-foreground">{value}</div>
    </div>
  );
}

function TextBlock({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </div>
      <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-foreground">
        {value?.trim() || "Non renseigné"}
      </p>
    </div>
  );
}

function StatusPill({ status }: { status: PublicationRequestSummary["status"] }) {
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

function WorkspaceLoading() {
  return (
    <main className="liquid-page flex min-h-[calc(100vh-4rem)] items-center justify-center px-4 py-10 text-foreground">
      <div className="glass-shell flex w-full max-w-2xl items-center gap-3 rounded-lg p-6">
        <RefreshCw className="h-5 w-5 animate-spin text-gold" />
        <span className="text-sm text-muted-foreground">Vérification de votre espace pro...</span>
      </div>
    </main>
  );
}

function WorkspaceMessage({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: typeof ShieldCheck;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <main className="liquid-page flex min-h-[calc(100vh-4rem)] items-center justify-center px-4 py-10 text-foreground sm:px-6">
      <div className="glass-shell w-full max-w-2xl rounded-lg p-6 sm:p-8">
        <div className="flex h-11 w-11 items-center justify-center rounded-lg border border-gold/25 bg-gold/10 text-gold">
          <Icon className="h-5 w-5" />
        </div>
        <h1 className="mt-5 font-display text-3xl leading-tight">{title}</h1>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">{description}</p>
        <div className="mt-6">{children}</div>
      </div>
    </main>
  );
}

function formatDate(value: string | null): string {
  if (!value) return "À préciser";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "À préciser";
  return new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium" }).format(date);
}

function formatPrice(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "À préciser";
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  const kilobytes = bytes / 1024;
  if (kilobytes < 1024) return `${kilobytes.toFixed(1)} Ko`;
  return `${(kilobytes / 1024).toFixed(1)} Mo`;
}
