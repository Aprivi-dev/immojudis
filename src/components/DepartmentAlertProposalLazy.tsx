"use client";

import dynamic from "next/dynamic";

/**
 * La proposition d'alerte de département, chargée à la demande : elle est en bas des pages qui la
 * montrent (simulateur, annonce exemple, fin d'article) et son JavaScript (liste des départements)
 * ne doit ni alourdir le premier chargement de ces pages, ni être recopié dans chacune. Un seul
 * import dynamique, donc un seul fichier partagé.
 */
export const DepartmentAlertProposal = dynamic(
  () =>
    import("@/components/DepartmentAlertProposal").then((module) => module.DepartmentAlertProposal),
  { loading: () => null },
);
