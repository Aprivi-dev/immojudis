import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Pencil from "lucide-react/dist/esm/icons/pencil.js";
import Plus from "lucide-react/dist/esm/icons/plus.js";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.js";
import Save from "lucide-react/dist/esm/icons/save.js";
import Scale from "lucide-react/dist/esm/icons/scale.js";
import XCircle from "lucide-react/dist/esm/icons/x-circle.js";
import { useState } from "react";
import { toast } from "sonner";
import { fetchAdminReferencedLawyers, saveAdminReferencedLawyer } from "@/lib/client-api";
import type { AdminReferencedLawyerInput, AdminReferencedLawyerSummary } from "@/lib/admin-lawyers";

type CoverageDraft = {
  tribunalCode: string;
  tribunalName: string;
  city: string;
  department: string;
  postalCodePrefix: string;
};

type LawyerFormState = {
  id?: string;
  status: AdminReferencedLawyerInput["status"];
  paidPlacementStatus: AdminReferencedLawyerInput["paidPlacementStatus"];
  displayName: string;
  firmName: string;
  email: string;
  phone: string;
  websiteUrl: string;
  barAssociation: string;
  barNumber: string;
  city: string;
  department: string;
  address: string;
  profileSummary: string;
  practiceTags: string;
  priorityWeight: string;
  paidPlacementStartsAt: string;
  paidPlacementEndsAt: string;
  acceptsJudicialAuctions: boolean;
  acceptsRemoteContact: boolean;
  coverage: CoverageDraft[];
};

const LAWYER_QUERY_KEY = ["admin-referenced-lawyers"] as const;

export function AdminReferencedLawyersPanel() {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<LawyerFormState>(() => emptyLawyerForm());
  const lawyersQuery = useQuery({
    queryKey: LAWYER_QUERY_KEY,
    queryFn: fetchAdminReferencedLawyers,
    staleTime: 30_000,
  });
  const lawyers = lawyersQuery.data?.lawyers ?? [];

  const saveMutation = useMutation({
    mutationFn: () => saveAdminReferencedLawyer({ data: formToInput(form) }),
    onSuccess: async (response) => {
      toast.success("Avocat référencé sauvegardé.");
      setForm(formFromLawyer(response.lawyer));
      await queryClient.invalidateQueries({ queryKey: LAWYER_QUERY_KEY });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Sauvegarde impossible");
    },
  });

  return (
    <section className="liquid-panel mt-6 rounded-lg p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-gold">
            <Scale className="h-4 w-4" />
            Avocats référencés
          </div>
          <h2 className="mt-3 font-display text-2xl">Mise en relation avocat</h2>
        </div>
        <button
          type="button"
          onClick={() => void lawyersQuery.refetch()}
          className="liquid-panel-soft inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-gold transition hover:border-gold"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${lawyersQuery.isFetching ? "animate-spin" : ""}`} />
          Actualiser
        </button>
      </div>

      {lawyersQuery.error ? (
        <div className="mt-4 rounded-lg border border-red-300/20 bg-red-500/10 p-3 text-sm text-red-100">
          {lawyersQuery.error instanceof Error
            ? lawyersQuery.error.message
            : "Chargement impossible"}
        </div>
      ) : null}

      <div className="mt-5 grid gap-4 xl:grid-cols-[0.95fr_1.05fr]">
        <form
          className="rounded-lg border border-white/10 bg-white/[0.03] p-4"
          onSubmit={(event) => {
            event.preventDefault();
            saveMutation.mutate();
          }}
        >
          <div className="grid gap-3 md:grid-cols-2">
            <TextField
              label="Nom affiché"
              value={form.displayName}
              required
              onChange={(displayName) => setForm((current) => ({ ...current, displayName }))}
            />
            <TextField
              label="Cabinet"
              value={form.firmName}
              onChange={(firmName) => setForm((current) => ({ ...current, firmName }))}
            />
            <TextField
              label="Email"
              value={form.email}
              type="email"
              onChange={(email) => setForm((current) => ({ ...current, email }))}
            />
            <TextField
              label="Téléphone"
              value={form.phone}
              onChange={(phone) => setForm((current) => ({ ...current, phone }))}
            />
            <TextField
              label="Barreau"
              value={form.barAssociation}
              onChange={(barAssociation) => setForm((current) => ({ ...current, barAssociation }))}
            />
            <TextField
              label="N° barreau"
              value={form.barNumber}
              onChange={(barNumber) => setForm((current) => ({ ...current, barNumber }))}
            />
            <TextField
              label="Site"
              value={form.websiteUrl}
              type="url"
              onChange={(websiteUrl) => setForm((current) => ({ ...current, websiteUrl }))}
            />
            <TextField
              label="Ville"
              value={form.city}
              onChange={(city) => setForm((current) => ({ ...current, city }))}
            />
            <TextField
              label="Département"
              value={form.department}
              onChange={(department) => setForm((current) => ({ ...current, department }))}
            />
            <TextField
              label="Adresse cabinet"
              value={form.address}
              onChange={(address) => setForm((current) => ({ ...current, address }))}
            />
            <SelectField
              label="Statut fiche"
              value={form.status ?? "draft"}
              options={[
                ["draft", "Brouillon"],
                ["active", "Actif"],
                ["paused", "Pause"],
                ["archived", "Archivé"],
              ]}
              onChange={(status) =>
                setForm((current) => ({
                  ...current,
                  status: status as LawyerFormState["status"],
                }))
              }
            />
            <SelectField
              label="Placement payant"
              value={form.paidPlacementStatus ?? "not_started"}
              options={[
                ["not_started", "Non démarré"],
                ["trial", "Essai"],
                ["active", "Actif"],
                ["past_due", "Paiement en retard"],
                ["paused", "Pause"],
                ["cancelled", "Résilié"],
              ]}
              onChange={(paidPlacementStatus) =>
                setForm((current) => ({
                  ...current,
                  paidPlacementStatus:
                    paidPlacementStatus as LawyerFormState["paidPlacementStatus"],
                }))
              }
            />
            <TextField
              label="Priorité"
              value={form.priorityWeight}
              type="number"
              onChange={(priorityWeight) => setForm((current) => ({ ...current, priorityWeight }))}
            />
            <TextField
              label="Début placement"
              value={form.paidPlacementStartsAt}
              type="datetime-local"
              onChange={(paidPlacementStartsAt) =>
                setForm((current) => ({ ...current, paidPlacementStartsAt }))
              }
            />
            <TextField
              label="Fin placement"
              value={form.paidPlacementEndsAt}
              type="datetime-local"
              onChange={(paidPlacementEndsAt) =>
                setForm((current) => ({ ...current, paidPlacementEndsAt }))
              }
            />
            <TextField
              label="Tags"
              value={form.practiceTags}
              onChange={(practiceTags) => setForm((current) => ({ ...current, practiceTags }))}
            />
          </div>

          <div className="mt-4 rounded-lg border border-white/10 bg-white/[0.03] p-3 text-xs leading-relaxed text-muted-foreground">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-semibold uppercase tracking-[0.14em]">
                Éligibilité bloc fiche
              </span>
              <StatusPill
                label={isFormPlacementEligible(form) ? "Visible" : "Non visible"}
                active={isFormPlacementEligible(form)}
              />
            </div>
            <p className="mt-2">
              Pour apparaître dans le bloc sticky, la fiche doit être active, le placement en essai
              ou actif, l'adjudication acceptée, au moins une zone renseignée et la fenêtre de
              placement ouverte.
            </p>
          </div>

          <label className="mt-3 grid gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Résumé
            <textarea
              value={form.profileSummary}
              onChange={(event) =>
                setForm((current) => ({ ...current, profileSummary: event.target.value }))
              }
              rows={3}
              className="rounded-lg border border-white/10 bg-background/45 px-3 py-2.5 text-sm normal-case tracking-normal text-foreground outline-none transition focus:border-gold"
            />
          </label>

          <div className="mt-4 rounded-lg border border-white/10 p-3">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                Couverture
              </div>
              <button
                type="button"
                onClick={() =>
                  setForm((current) => ({
                    ...current,
                    coverage: [...current.coverage, emptyCoverageDraft()],
                  }))
                }
                className="inline-flex items-center gap-1 rounded-md border border-white/10 px-2.5 py-1 text-xs text-gold transition hover:border-gold"
              >
                <Plus className="h-3.5 w-3.5" />
                Zone
              </button>
            </div>
            <div className="grid gap-3">
              {form.coverage.map((coverage, index) => (
                <CoverageRow
                  key={index}
                  coverage={coverage}
                  onChange={(nextCoverage) =>
                    setForm((current) => ({
                      ...current,
                      coverage: current.coverage.map((item, itemIndex) =>
                        itemIndex === index ? nextCoverage : item,
                      ),
                    }))
                  }
                  onRemove={() =>
                    setForm((current) => ({
                      ...current,
                      coverage: current.coverage.filter((_, itemIndex) => itemIndex !== index),
                    }))
                  }
                />
              ))}
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={saveMutation.isPending}
              className="liquid-button inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-background disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Save className="h-3.5 w-3.5" />
              {saveMutation.isPending ? "Sauvegarde" : form.id ? "Mettre à jour" : "Créer"}
            </button>
            <button
              type="button"
              onClick={() => setForm(emptyLawyerForm())}
              className="liquid-panel-soft inline-flex items-center justify-center rounded-lg px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-gold transition hover:border-gold"
            >
              Nouveau
            </button>
          </div>
        </form>

        <div className="overflow-hidden rounded-lg border border-white/10">
          <div className="grid grid-cols-[1fr_0.7fr_0.75fr_0.45fr_auto] gap-3 bg-white/[0.04] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            <span>Avocat</span>
            <span>Statut</span>
            <span>30 jours</span>
            <span>Zones</span>
            <span />
          </div>
          <div className="divide-y divide-white/10">
            {lawyersQuery.isLoading ? (
              <div className="p-4 text-sm text-muted-foreground">Chargement</div>
            ) : lawyers.length ? (
              lawyers.map((lawyer) => (
                <LawyerLine
                  key={lawyer.id}
                  lawyer={lawyer}
                  onEdit={() => setForm(formFromLawyer(lawyer))}
                />
              ))
            ) : (
              <div className="p-4 text-sm text-muted-foreground">Aucun avocat référencé</div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function LawyerLine({
  lawyer,
  onEdit,
}: {
  lawyer: AdminReferencedLawyerSummary;
  onEdit: () => void;
}) {
  const metrics = lawyer.placementMetrics;
  return (
    <div className="grid grid-cols-[1fr_0.7fr_0.75fr_0.45fr_auto] items-center gap-3 px-3 py-3 text-sm">
      <div className="min-w-0">
        <div className="truncate font-semibold text-foreground">{lawyer.displayName}</div>
        <div className="mt-1 truncate text-xs text-muted-foreground">
          {[lawyer.firmName, lawyer.city, lawyer.department].filter(Boolean).join(" · ") || "—"}
        </div>
      </div>
      <div className="min-w-0">
        <StatusPill label={lawyer.status} active={lawyer.status === "active"} />
        <div className="mt-1 text-xs text-muted-foreground">{lawyer.paidPlacementStatus}</div>
        <div className="mt-1">
          <StatusPill
            label={isLawyerPlacementVisible(lawyer) ? "Visible bloc" : "Hors bloc"}
            active={isLawyerPlacementVisible(lawyer)}
          />
        </div>
      </div>
      <div className="min-w-0 text-xs text-muted-foreground">
        <div>{metrics.impressions} vue(s)</div>
        <div className="mt-1">
          {metrics.ctaClicks} clic(s) · {metrics.referralRequests} demande(s)
        </div>
      </div>
      <span className="text-xs text-muted-foreground">{lawyer.coverage.length}</span>
      <button
        type="button"
        onClick={onEdit}
        className="inline-grid h-8 w-8 place-items-center rounded-md border border-white/10 text-gold transition hover:border-gold"
        aria-label="Modifier"
      >
        <Pencil className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function CoverageRow({
  coverage,
  onChange,
  onRemove,
}: {
  coverage: CoverageDraft;
  onChange: (coverage: CoverageDraft) => void;
  onRemove: () => void;
}) {
  return (
    <div className="grid gap-2 md:grid-cols-[repeat(5,minmax(0,1fr))_auto]">
      <CompactField
        label="Tribunal"
        value={coverage.tribunalCode}
        onChange={(tribunalCode) => onChange({ ...coverage, tribunalCode })}
      />
      <CompactField
        label="Nom tribunal"
        value={coverage.tribunalName}
        onChange={(tribunalName) => onChange({ ...coverage, tribunalName })}
      />
      <CompactField
        label="Ville"
        value={coverage.city}
        onChange={(city) => onChange({ ...coverage, city })}
      />
      <CompactField
        label="Dépt."
        value={coverage.department}
        onChange={(department) => onChange({ ...coverage, department })}
      />
      <CompactField
        label="CP"
        value={coverage.postalCodePrefix}
        onChange={(postalCodePrefix) => onChange({ ...coverage, postalCodePrefix })}
      />
      <button
        type="button"
        onClick={onRemove}
        className="inline-grid h-9 w-9 place-items-center rounded-md border border-white/10 text-muted-foreground transition hover:border-red-300/40 hover:text-red-100 md:self-end"
        aria-label="Retirer la zone"
      >
        <XCircle className="h-4 w-4" />
      </button>
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
  type = "text",
  required = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  required?: boolean;
}) {
  return (
    <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
      {label}
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        type={type}
        required={required}
        className="rounded-lg border border-white/10 bg-background/45 px-3 py-2.5 text-sm normal-case tracking-normal text-foreground outline-none transition focus:border-gold"
      />
    </label>
  );
}

function CompactField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="grid gap-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
      {label}
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="rounded-md border border-white/10 bg-background/45 px-2 py-2 text-sm normal-case tracking-normal text-foreground outline-none transition focus:border-gold"
      />
    </label>
  );
}

function SelectField({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<[string, string]>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
      {label}
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="rounded-lg border border-white/10 bg-background/45 px-3 py-2.5 text-sm normal-case tracking-normal text-foreground outline-none transition focus:border-gold"
      >
        {options.map(([optionValue, label]) => (
          <option key={optionValue} value={optionValue}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );
}

function StatusPill({ label, active }: { label: string; active: boolean }) {
  return (
    <span
      className={`inline-flex w-fit rounded-full border px-2 py-0.5 text-[11px] ${
        active
          ? "border-emerald-300/20 bg-emerald-400/10 text-emerald-100"
          : "border-amber-300/20 bg-amber-400/10 text-amber-100"
      }`}
    >
      {label}
    </span>
  );
}

function emptyCoverageDraft(): CoverageDraft {
  return {
    tribunalCode: "",
    tribunalName: "",
    city: "",
    department: "",
    postalCodePrefix: "",
  };
}

function emptyLawyerForm(): LawyerFormState {
  return {
    status: "draft",
    paidPlacementStatus: "not_started",
    displayName: "",
    firmName: "",
    email: "",
    phone: "",
    websiteUrl: "",
    barAssociation: "",
    barNumber: "",
    city: "",
    department: "",
    address: "",
    profileSummary: "",
    practiceTags: "adjudication",
    priorityWeight: "0",
    paidPlacementStartsAt: "",
    paidPlacementEndsAt: "",
    acceptsJudicialAuctions: true,
    acceptsRemoteContact: true,
    coverage: [emptyCoverageDraft()],
  };
}

function formFromLawyer(lawyer: AdminReferencedLawyerSummary): LawyerFormState {
  return {
    id: lawyer.id,
    status: lawyer.status,
    paidPlacementStatus: lawyer.paidPlacementStatus,
    displayName: lawyer.displayName,
    firmName: lawyer.firmName ?? "",
    email: lawyer.email ?? "",
    phone: lawyer.phone ?? "",
    websiteUrl: lawyer.websiteUrl ?? "",
    barAssociation: lawyer.barAssociation ?? "",
    barNumber: lawyer.barNumber ?? "",
    city: lawyer.city ?? "",
    department: lawyer.department ?? "",
    address: lawyer.address ?? "",
    profileSummary: lawyer.profileSummary ?? "",
    practiceTags: lawyer.practiceTags.join(", "),
    priorityWeight: String(lawyer.priorityWeight),
    paidPlacementStartsAt: isoToDateTimeLocal(lawyer.paidPlacementStartsAt),
    paidPlacementEndsAt: isoToDateTimeLocal(lawyer.paidPlacementEndsAt),
    acceptsJudicialAuctions: lawyer.acceptsJudicialAuctions,
    acceptsRemoteContact: lawyer.acceptsRemoteContact,
    coverage: lawyer.coverage.length
      ? lawyer.coverage.map((coverage) => ({
          tribunalCode: coverage.tribunalCode ?? "",
          tribunalName: coverage.tribunalName ?? "",
          city: coverage.city ?? "",
          department: coverage.department ?? "",
          postalCodePrefix: coverage.postalCodePrefix ?? "",
        }))
      : [emptyCoverageDraft()],
  };
}

function formToInput(form: LawyerFormState): AdminReferencedLawyerInput {
  return {
    id: form.id,
    status: form.status,
    paidPlacementStatus: form.paidPlacementStatus,
    displayName: form.displayName,
    firmName: form.firmName,
    email: form.email,
    phone: form.phone,
    websiteUrl: form.websiteUrl,
    barAssociation: form.barAssociation,
    barNumber: form.barNumber,
    city: form.city,
    department: form.department,
    address: form.address,
    profileSummary: form.profileSummary,
    practiceTags: form.practiceTags
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean),
    priorityWeight: Number(form.priorityWeight || 0),
    paidPlacementStartsAt: dateTimeLocalToIso(form.paidPlacementStartsAt) ?? undefined,
    paidPlacementEndsAt: dateTimeLocalToIso(form.paidPlacementEndsAt) ?? undefined,
    acceptsJudicialAuctions: form.acceptsJudicialAuctions,
    acceptsRemoteContact: form.acceptsRemoteContact,
    coverage: form.coverage.filter((coverage) =>
      Boolean(
        coverage.tribunalCode ||
        coverage.tribunalName ||
        coverage.city ||
        coverage.department ||
        coverage.postalCodePrefix,
      ),
    ),
  };
}

function isFormPlacementEligible(form: LawyerFormState): boolean {
  return (
    form.status === "active" &&
    (form.paidPlacementStatus === "trial" || form.paidPlacementStatus === "active") &&
    form.acceptsJudicialAuctions &&
    form.coverage.some((coverage) =>
      Boolean(
        coverage.tribunalCode || coverage.department || coverage.city || coverage.postalCodePrefix,
      ),
    ) &&
    isPlacementWindowOpen(
      dateTimeLocalToIso(form.paidPlacementStartsAt),
      dateTimeLocalToIso(form.paidPlacementEndsAt),
    )
  );
}

function isLawyerPlacementVisible(lawyer: AdminReferencedLawyerSummary): boolean {
  return (
    lawyer.status === "active" &&
    (lawyer.paidPlacementStatus === "trial" || lawyer.paidPlacementStatus === "active") &&
    lawyer.acceptsJudicialAuctions &&
    lawyer.coverage.length > 0 &&
    isPlacementWindowOpen(lawyer.paidPlacementStartsAt, lawyer.paidPlacementEndsAt)
  );
}

function isPlacementWindowOpen(startsAt: string | null, endsAt: string | null): boolean {
  const now = Date.now();
  const starts = dateToTimestamp(startsAt);
  const ends = dateToTimestamp(endsAt);
  return (starts == null || starts <= now) && (ends == null || ends >= now);
}

function isoToDateTimeLocal(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function dateTimeLocalToIso(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function dateToTimestamp(value: string | null): number | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}
