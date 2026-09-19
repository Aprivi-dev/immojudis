# Réduction des appels Replicate — 19 septembre 2026

## Diagnostic

La lecture des événements des 24 heures précédant le chantier a relevé
152 échecs de parsing JSON d'extraction factuelle, 18 synthèses réussies et
89 événements de budget quotidien épuisé. Ces événements de budget ne sont
pas des prédictions facturées ; les estimations historiques ne permettent donc
pas, à elles seules, de mesurer les dépenses réelles.

## Comportement livré

- Les rescans des sources et des PDF restent actifs.
- Le budget de blocs limite les nouveaux appels d'un passage, sans tronquer
  définitivement la couverture. Les checkpoints réussis, y compris les
  résultats sans information trouvée, sont réutilisés.
- La synthèse attend une couverture complète ; son cache est indépendant
  des versions d'extraction factuelle.
- Un cache Supabase privé complète les fichiers locaux. Une indisponibilité
  du cache ou du budget reporte le travail.
- Les faits complets sont liés aux sources, empreintes documentaires, modèle
  et versions d'analyse. Un champ resté inconnu ne déclenche pas une nouvelle
  extraction du même contenu.
- Un changement opérationnel isolé conserve les faits et retire l'ancien
  paragraphe. Une nouvelle description locale est possible si elle préserve
  les contraintes ; les cas documentaires plus complexes restent analysés.
- Chaque POST réserve atomiquement une place dans le budget horaire.
  Le budget quotidien existant des exécutions autonomes reste en place.
- Une issue réseau ambiguë garde une réservation et bloque la même requête
  pendant 30 minutes. Un identifiant de prédiction connu est enregistré.
- Les synthèses gardent leur plafond de 512 tokens ; l'extraction structurée
  dispose de 4096 tokens maximum pour pouvoir terminer son JSON.

## Suivi après publication

Les nouvelles lignes de `llm_usage_events` portent `source_url`, `job_id`,
`stage`, `reason`, `request_key` et `request_status`. Les réservations libérées
avant envoi ne représentent pas des appels. Les tokens restent des estimations
de taille, pas une facture fournisseur.

```sql
select request_kind, request_status, count(*) as requests,
       sum(input_tokens_estimate) as estimated_input_tokens,
       sum(output_tokens_estimate) as estimated_output_tokens
from public.llm_usage_events
where created_at >= now() - interval '24 hours'
group by request_kind, request_status;
```

Le gain réel devra être mesuré après plusieurs collectes comparables. Aucun
pourcentage d'économie n'est déduit des seuls tests.

## Retour arrière

Revenir au code précédent du pipeline conserve les tables de cache et les
colonnes ajoutées, compatibles avec les anciennes écritures. Ne pas supprimer
le cache pour revenir en arrière : cela ferait perdre les analyses réutilisables.

## Validation et publication

- Suite Python avec PostgreSQL local : 1 450 tests réussis, 14 tests optionnels ignorés.
- Réservations concurrentes, permissions et cache vérifiés dans une base jetable.
- Revue indépendante : corrections des réponses/pollings ambigus et de la
  conservation des contraintes documentaires ; aucun point bloquant restant.
- Migrations de production : `20260919094724_llm_request_budget` et
  `20260919094732_llm_analysis_cache`.
- Contrôle Supabase de production : réservation, finalisation et lecture/écriture
  du cache sous `service_role`, avec annulation de toutes les écritures.
- Les tables sont réservées au service ; l'absence de politiques publiques RLS
  est intentionnelle, avec droits `anon` et `authenticated` révoqués.
