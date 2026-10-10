"use client";

import { useQuery } from "@tanstack/react-query";
import {
  GEORISQUES_HOME_URL,
  type CommuneRiskItem,
  type CommuneRiskProfile,
  type CommuneRiskResult,
} from "@/lib/environment-reference";
import { queryKeys } from "@/lib/query-keys";
import styles from "./ListingEnvironment.module.css";

const SEISMIC_LABELS: Record<number, string> = {
  1: "très faible",
  2: "faible",
  3: "modérée",
  4: "moyenne",
  5: "forte",
};
const RADON_LABELS: Record<number, string> = {
  1: "faible",
  2: "faible, avec facteurs aggravants possibles",
  3: "significatif",
};
const FAMILIES = [
  { key: "1", label: "Risques naturels" },
  { key: "2", label: "Risques technologiques" },
  { key: "3", label: "Risques miniers" },
] as const;
const RECENT_EVENTS_SHOWN = 5;

export function ListingEnvironmentalRisks({
  saleId,
  enabled = true,
  demoProfile,
}: {
  saleId: string;
  enabled?: boolean;
  /** Static profile of the example listing, which is not a catalogue sale. */
  demoProfile?: CommuneRiskProfile;
}) {
  const query = useQuery({
    queryKey: queryKeys.saleRisks(saleId),
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/sales/${encodeURIComponent(saleId)}/risks`, { signal });
      if (!response.ok) throw new Error(`Erreur HTTP ${response.status}`);
      return ((await response.json()) as { risks: CommuneRiskResult }).risks;
    },
    enabled: enabled && !demoProfile,
    staleTime: 24 * 60 * 60_000,
    retry: 1,
    refetchOnWindowFocus: false,
  });
  if (!enabled) return null;
  const risks = demoProfile ?? query.data;
  return (
    <section className={styles.section} aria-labelledby="environmental-risks-title">
      <h2 id="environmental-risks-title" className={styles.heading}>
        Risques environnementaux
      </h2>
      {!demoProfile && query.isPending ? (
        <p role="status">Chargement des risques de la commune…</p>
      ) : null}
      {risks?.status === "ready" ? <CommuneRisks profile={risks} /> : null}
      {(!demoProfile && query.isError) || risks?.status === "unavailable" ? (
        <p className={styles.note} role="status">
          Le profil de risques de cette commune n’est pas encore disponible. Consultez Géorisques
          pour l’adresse exacte du bien.
        </p>
      ) : null}
      <p className={styles.note}>
        Ces informations décrivent la commune, pas la parcelle. L’état des risques annexé au cahier
        des conditions de vente fait foi pour le bien.
      </p>
      <a href={GEORISQUES_HOME_URL} target="_blank" rel="noopener noreferrer">
        Vérifier l’adresse exacte sur Géorisques
      </a>
    </section>
  );
}

export function CommuneRisks({ profile }: { profile: CommuneRiskProfile }) {
  const families = FAMILIES.map((family) => ({
    ...family,
    groups: groupRisks(profile.risks.filter((risk) => risk.code.startsWith(family.key))),
  })).filter((family) => family.groups.length > 0);
  const recent = profile.catnatRecent.slice(0, RECENT_EVENTS_SHOWN);
  return (
    <div className={styles.content}>
      <p className={styles.note}>
        Commune de <strong>{profile.commune.name}</strong> ({profile.commune.code}).
      </p>

      <dl className={styles.facts}>
        <div>
          <dt>Risques recensés</dt>
          <dd>{profile.risks.filter((risk) => risk.code.length === 2).length || "Aucun"}</dd>
        </div>
        <div>
          <dt>Catastrophes naturelles reconnues</dt>
          <dd>{profile.catnatTotal}</dd>
        </div>
        {profile.seismicZone != null ? (
          <div>
            <dt>Sismicité</dt>
            <dd>
              Zone {profile.seismicZone} · {SEISMIC_LABELS[profile.seismicZone]}
            </dd>
          </div>
        ) : null}
        {profile.radonClass != null ? (
          <div>
            <dt>Potentiel radon</dt>
            <dd>
              Catégorie {profile.radonClass} · {RADON_LABELS[profile.radonClass]}
            </dd>
          </div>
        ) : null}
      </dl>

      {families.length ? (
        families.map((family) => (
          <div key={family.key}>
            <h3 className={styles.subheading}>{family.label}</h3>
            <ul className={styles.chips}>
              {family.groups.map((group) => (
                <li key={group.parent.code}>
                  {group.parent.label}
                  {group.children.length ? (
                    <span> · {group.children.map((child) => child.label).join(", ")}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ))
      ) : (
        <p className={styles.note}>Aucun risque majeur recensé dans le dossier départemental.</p>
      )}

      {profile.preventionPlans.length ? (
        <div>
          <h3 className={styles.subheading}>Plans de prévention en vigueur ou prescrits</h3>
          <ul className={styles.list}>
            {profile.preventionPlans.map((plan) => (
              <li key={`${plan.kind}-${plan.label}`}>
                <strong>{plan.label}</strong>
                {plan.risks.length ? ` · ${plan.risks.join(", ").toLowerCase()}` : ""}
                {" · "}
                {plan.approvedOn
                  ? `approuvé le ${formatDate(plan.approvedOn)}`
                  : plan.prescribedOn
                    ? `prescrit le ${formatDate(plan.prescribedOn)}`
                    : (plan.status ?? "").toLowerCase()}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {profile.catnatTotal > 0 ? (
        <div>
          <h3 className={styles.subheading}>Arrêtés de catastrophe naturelle</h3>
          <p className={styles.note}>
            {profile.catnatByType
              .slice(0, 4)
              .map((type) => `${type.label} : ${type.count}`)
              .join(" · ")}
          </p>
          <ul className={styles.list}>
            {recent.map((event) => (
              <li key={`${event.code}-${event.start}-${event.decree}`}>
                {event.label}
                {event.start ? ` · du ${formatDate(event.start)}` : ""}
                {event.end && event.end !== event.start ? ` au ${formatDate(event.end)}` : ""}
                {event.published ? ` (JO du ${formatDate(event.published)})` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className={styles.note}>
        Source :{" "}
        <a href={profile.sourceUrl} target="_blank" rel="noopener noreferrer">
          Géorisques, base GASPAR
        </a>
        {profile.snapshot ? `, mise à jour du ${formatDate(profile.snapshot)}` : ""}.
      </p>
    </div>
  );
}

type RiskGroup = { parent: CommuneRiskItem; children: CommuneRiskItem[] };

function groupRisks(risks: CommuneRiskItem[]): RiskGroup[] {
  const groups: RiskGroup[] = [];
  for (const risk of risks) {
    const parent = groups.find(
      (group) => risk.code.length > 2 && risk.code.startsWith(group.parent.code),
    );
    if (parent) parent.children.push(risk);
    else groups.push({ parent: risk, children: [] });
  }
  return groups;
}

function formatDate(value: string): string {
  const date = new Date(`${value.slice(0, 10)}T12:00:00Z`);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("fr-FR", { timeZone: "UTC" }).format(date);
}
