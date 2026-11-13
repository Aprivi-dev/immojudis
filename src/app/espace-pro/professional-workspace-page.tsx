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
import Link from "next/link";
import {
  Badge,
  buttonClasses,
  Card,
  Eyebrow,
  Notice,
  PageShell,
  PageTitle,
} from "@/components/ui/primitives";
import { formatShortDate } from "@/lib/format/dates";
import { formatPrice } from "@/lib/format/numbers";
import { pathWithSearch } from "@/lib/navigation";
import { PROFESSIONAL_ACCESS_REQUEST_HREF } from "@/lib/professional-access";
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
import { userMessage } from "@/lib/user-messages";
import * as queryKeys from "@/lib/query-keys";
import { formatFileSize } from "@/lib/format-file-size";
import { PublicationStatusPill as StatusPill } from "@/components/PublicationStatusPill";

/** Libellés en capitales des petits blocs : 12 px, encre douce (plus de 10 ou 11 px). */
const LABEL_CLASS = "text-xs font-semibold uppercase tracking-[0.14em] text-ink-soft";

export function ProfessionalWorkspacePage() {
  const { user, profile, loading } = useAuth();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const professionalStatus = getProfessionalStatus(profile);
  const professional = isProfessionalAccount(user, profile);
  const admin = isAdminAccount(user, profile);
  const requestsQuery = useQuery({
    queryKey: queryKeys.publicationRequestsWorkspace(user?.id),
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
    queryKey: queryKeys.publicationRequest(selectedId),
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
    // Une personne qui a déjà un compte pro se connecte (formulaire de connexion) ; les autres
    // créent leur compte professionnel. Le lien « Se connecter » ouvrait le formulaire
    // d'inscription professionnelle.
    return (
      <WorkspaceMessage
        icon={ShieldCheck}
        title="Connectez-vous pour ouvrir votre espace pro"
        description="Votre espace rassemble les demandes de publication envoyées depuis votre compte et les ventes validées."
      >
        <Link
          href={pathWithSearch("/login", { redirect: "/espace-pro" })}
          className={buttonClasses({ variant: "primary" })}
        >
          Se connecter <ArrowRight className="h-4 w-4" aria-hidden />
        </Link>
        <Link
          href={pathWithSearch("/login", { mode: "professional", redirect: "/espace-pro" })}
          className={buttonClasses({ variant: "secondary" })}
        >
          Créer un compte professionnel
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
        <Link href="/compte" className={buttonClasses({ variant: "primary" })}>
          Gérer mon compte <ArrowRight className="h-4 w-4" aria-hidden />
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
          href={PROFESSIONAL_ACCESS_REQUEST_HREF}
          className={buttonClasses({ variant: "secondary" })}
        >
          Contacter Immojudis <ArrowRight className="h-4 w-4" aria-hidden />
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
          href={PROFESSIONAL_ACCESS_REQUEST_HREF}
          className={buttonClasses({ variant: "primary" })}
        >
          Demander un accès pro <ArrowRight className="h-4 w-4" aria-hidden />
        </Link>
      </WorkspaceMessage>
    );
  }

  const selectedDetail = detailQuery.data?.request ?? null;

  return (
    <PageShell
      width="wide"
      eyebrow="Espace professionnel"
      title="Suivre vos ventes déposées et publiées."
      description={
        <p>
          Retrouvez chaque demande, son statut de validation, les informations transmises et les
          pièces privées associées. Les liens vers les documents sont temporaires et réservés à
          votre compte.
        </p>
      }
      actions={
        <Card className="w-full sm:w-[19rem]">
          <p className={LABEL_CLASS}>Compte connecté</p>
          <div className="mt-3 flex items-start gap-3">
            <Mail className="mt-0.5 h-4 w-4 shrink-0 text-gold-text" aria-hidden />
            <span className="break-all text-sm text-foreground">{user.email}</span>
          </div>
          <div className="mt-4 flex items-center gap-2 text-sm text-ink-soft">
            <ShieldCheck className="h-4 w-4 text-gold-text" aria-hidden />
            {admin
              ? "Accès administrateur"
              : pendingProfessional
                ? "Validation professionnelle en cours"
                : "Compte professionnel validé"}
          </div>
        </Card>
      }
    >
      <div className="grid gap-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <Card as="section" aria-labelledby="pro-requests-title" className="sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <Eyebrow className="flex items-center gap-2">
                <FileCheck2 className="h-4 w-4" aria-hidden />
                Mes demandes
              </Eyebrow>
              <h2
                id="pro-requests-title"
                className="mt-3 font-display text-2xl font-semibold text-brand-navy"
              >
                Historique de dépôt
              </h2>
            </div>
            {pendingProfessional ? (
              <Badge tone="warning">
                <Clock3 className="h-3.5 w-3.5" aria-hidden />
                Validation en cours
              </Badge>
            ) : (
              <Link href="/publish" className={buttonClasses({ variant: "secondary" })}>
                Nouvelle demande <ArrowRight className="h-4 w-4" aria-hidden />
              </Link>
            )}
          </div>

          {pendingProfessional ? (
            <Notice tone="warning" className="mt-6">
              Votre compte professionnel est en cours de validation. Vous pourrez déposer une vente
              dès que ce contrôle sera terminé ; vos demandes déjà transmises restent visibles dans
              cette page.
            </Notice>
          ) : null}

          {requestsQuery.isPending ? (
            <div role="status" className="mt-6 flex items-center gap-3 text-sm text-ink-soft">
              <RefreshCw className="h-4 w-4 animate-spin text-gold-text" aria-hidden />
              Chargement des demandes...
            </div>
          ) : requestsQuery.isError ? (
            <Notice tone="danger" role="alert" className="mt-6">
              <p className="flex items-center gap-2 font-semibold">
                <AlertCircle className="h-4 w-4" aria-hidden />
                Impossible de charger vos demandes.
              </p>
              <p className="mt-2">
                {userMessage(requestsQuery.error, "Réessayez dans quelques instants.")}
              </p>
            </Notice>
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
            <div className="mt-6 rounded-lg border border-line bg-surface-muted p-5">
              <FileText className="h-5 w-5 text-gold-text" aria-hidden />
              <p className="mt-3 text-sm leading-relaxed text-ink-soft">
                Aucune demande n'est encore associée à ce compte.
              </p>
              {pendingProfessional ? (
                <p className="mt-4 text-sm leading-relaxed text-warning">
                  Le dépôt sera disponible après validation du compte.
                </p>
              ) : (
                <Link
                  href="/publish"
                  className={buttonClasses({ variant: "secondary", className: "mt-4" })}
                >
                  Préparer un dépôt <ArrowRight className="h-4 w-4" aria-hidden />
                </Link>
              )}
            </div>
          )}
        </Card>

        <Card as="section" aria-label="Détail de la demande" className="sm:p-6">
          {selectedRequest ? (
            <RequestDetailPanel
              request={selectedDetail ?? selectedRequest}
              loading={detailQuery.isPending}
              error={detailQuery.error}
            />
          ) : (
            <div className="flex min-h-80 flex-col items-center justify-center text-center">
              <FileCheck2 className="h-8 w-8 text-gold-text" aria-hidden />
              <h2 className="mt-4 font-display text-2xl font-semibold text-brand-navy">
                Sélectionnez une demande
              </h2>
              <p className="mt-3 max-w-md text-sm leading-relaxed text-ink-soft">
                Les informations détaillées, notes de validation et pièces privées apparaîtront ici.
              </p>
            </div>
          )}
        </Card>
      </div>
    </PageShell>
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
        selected ? "border-gold bg-surface-tint" : "border-line bg-white hover:border-gold"
      }`}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className="w-full rounded-md text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-foreground">{request.title}</div>
            <div className="mt-1 truncate text-xs text-ink-soft">
              {request.location ?? "Localisation à préciser"}
            </div>
          </div>
          <StatusPill status={request.status} />
        </div>
        <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-soft">
          <span>{formatShortDate(request.createdAt, "À préciser")}</span>
          <span>{request.documentCount} pièce(s)</span>
          {request.publishedAt ? (
            <span>Publié le {formatShortDate(request.publishedAt, "À préciser")}</span>
          ) : null}
        </div>
      </button>
      {request.publishedUrl ? (
        <a
          href={request.publishedUrl}
          className="mt-3 inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-gold-text underline"
        >
          Voir la vente publiée <ExternalLink className="h-3.5 w-3.5" aria-hidden />
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
          <Eyebrow className="flex items-center gap-2">
            <FileText className="h-4 w-4" aria-hidden />
            Dossier de publication
          </Eyebrow>
          <h2 className="mt-3 font-display text-2xl font-semibold leading-tight text-brand-navy">
            {request.title}
          </h2>
          <p className="mt-2 text-sm text-ink-soft">
            Déposé le {formatShortDate(request.createdAt, "À préciser")} ·{" "}
            {request.location ?? "Localisation à préciser"}
          </p>
        </div>
        <StatusPill status={request.status} />
      </div>

      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        <DetailStat
          label="Mise à prix"
          value={
            request.startingPriceEur == null ? "À préciser" : formatPrice(request.startingPriceEur)
          }
        />
        <DetailStat
          label="Date de vente"
          value={formatShortDate(request.hearingDate, "À préciser")}
        />
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
          className={buttonClasses({ variant: "secondary", className: "mt-6" })}
        >
          Ouvrir la vente publiée <ExternalLink className="h-4 w-4" aria-hidden />
        </a>
      ) : null}

      {request.adminNotes ? (
        <div className="mt-6 rounded-lg border border-line bg-surface-muted p-4">
          <p className={LABEL_CLASS}>Retour de validation</p>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-foreground">
            {request.adminNotes}
          </p>
        </div>
      ) : null}

      <div className="mt-6 border-t border-line pt-5">
        <Eyebrow className="flex items-center gap-2">
          <FileCheck2 className="h-4 w-4" aria-hidden />
          Pièces privées
        </Eyebrow>
        {loading ? (
          <div role="status" className="mt-4 flex items-center gap-2 text-sm text-ink-soft">
            <RefreshCw className="h-4 w-4 animate-spin text-gold-text" aria-hidden />
            Génération des liens sécurisés...
          </div>
        ) : error ? (
          <Notice tone="danger" role="alert" className="mt-4">
            {userMessage(error, "Impossible de charger les pièces.")}
          </Notice>
        ) : detail?.documents.length ? (
          <div className="mt-4 grid gap-2">
            {detail.documents.map((document) => (
              <DocumentRow key={`${document.name}-${document.uploaded_at}`} document={document} />
            ))}
          </div>
        ) : (
          <p className="mt-4 text-sm leading-relaxed text-ink-soft">
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
    <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-white px-3 py-2">
      <div className="min-w-0">
        <div className="truncate text-sm text-foreground">{document.name}</div>
        <div className="mt-1 text-xs text-ink-soft">
          {formatFileSize(document.size)} · {document.mime_type}
        </div>
      </div>
      {document.signedUrl ? (
        <a
          href={document.signedUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-11 shrink-0 items-center gap-1 text-sm font-semibold text-gold-text underline"
        >
          Ouvrir <ExternalLink className="h-3.5 w-3.5" aria-hidden />
        </a>
      ) : (
        <span className="text-xs text-ink-soft">Indisponible</span>
      )}
    </div>
  );
}

function DetailStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface-muted p-3">
      <p className={LABEL_CLASS}>{label}</p>
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
    <div className="rounded-lg border border-line bg-surface-muted p-4">
      <Eyebrow className="flex items-center gap-2">
        <Icon className="h-4 w-4" aria-hidden />
        {label}
      </Eyebrow>
      <div className="mt-2 text-sm leading-relaxed text-foreground">{value}</div>
    </div>
  );
}

function TextBlock({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <p className={LABEL_CLASS}>{label}</p>
      <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-foreground">
        {value?.trim() || "Non renseigné"}
      </p>
    </div>
  );
}

function WorkspaceLoading() {
  return (
    <main
      id="contenu"
      className="flex min-h-[calc(100vh-4rem)] items-center justify-center px-4 py-10 text-foreground"
    >
      <Card role="status" className="flex w-full max-w-2xl items-center gap-3 p-6">
        <RefreshCw className="h-5 w-5 animate-spin text-gold-text" aria-hidden />
        <span className="text-sm text-ink-soft">Vérification de votre espace pro...</span>
      </Card>
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
    <main
      id="contenu"
      className="flex min-h-[calc(100vh-4rem)] items-center justify-center px-4 py-10 text-foreground sm:px-6"
    >
      <Card className="w-full max-w-2xl p-6 sm:p-8">
        <div className="flex h-11 w-11 items-center justify-center rounded-lg border border-line bg-surface-tint text-gold-text">
          <Icon className="h-5 w-5" aria-hidden />
        </div>
        <PageTitle className="mt-5 text-brand-navy">{title}</PageTitle>
        <p className="mt-3 max-w-xl text-base leading-relaxed text-ink-soft">{description}</p>
        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:flex-wrap">{children}</div>
      </Card>
    </main>
  );
}
