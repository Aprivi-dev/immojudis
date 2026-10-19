"use client";

import { useId, useState } from "react";
import { SectorAlertCta } from "@/components/SectorAlertCta";
import { Card } from "@/components/ui/primitives";
import { DEPARTMENTS } from "@/lib/department-pages";

/**
 * « Recevoir les nouvelles ventes de ce secteur » sur `/tribunaux`. Une alerte suit un
 * département (pas un tribunal) : la personne choisit le sien, puis passe par le bouton commun.
 */
export function TribunalSectorAlert() {
  const selectId = useId();
  const [code, setCode] = useState("");
  return (
    <div className="mb-10 grid gap-4">
      <Card as="section" aria-labelledby={selectId} className="grid gap-3">
        <label htmlFor={selectId} className="font-display text-2xl font-semibold">
          Être prévenu des nouvelles ventes d’un département
        </label>
        <p className="text-sm text-ink-soft">
          Les alertes suivent un département, pas un tribunal : choisissez celui qui vous intéresse.
        </p>
        <select
          id={selectId}
          value={code}
          onChange={(event) => setCode(event.target.value)}
          className="form-input min-h-11 max-w-sm"
        >
          <option value="">Choisir un département</option>
          {DEPARTMENTS.map((department) => (
            <option key={department.code} value={department.code}>
              {department.code} · {department.name}
            </option>
          ))}
        </select>
      </Card>
      {code ? <SectorAlertCta key={code} criteria={{ department: code }} /> : null}
    </div>
  );
}
