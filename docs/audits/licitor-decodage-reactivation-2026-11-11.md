# Licitor : réactivation du décodage des adresses masquées (11 novembre 2026)

## Décision

Décision du propriétaire du 11/11/2026 : réactiver le décodage des adresses email masquées des fiches Licitor.
Fondement : accord de Licitor **déclaré par le propriétaire le 11/11/2026 ; pièce à verser au dossier**. La pièce
n'est pas dans le dépôt et n'a pas été vérifiée lors de cette modification.

Rappel : le décodage avait été désactivé par défaut le 23/10/2026 (PR #293, point 41 de
`docs/equipe/2026-10-23-session-complete.md`).

## Ce qui est réactivé

- `.github/workflows/data-pipeline.yml` transmet `LICITOR_DECODE_PROTECTED_EMAILS` avec la valeur `true` quand la
  variable de dépôt GitHub du même nom est absente. La variable de dépôt garde la main : posée à `false`, elle
  coupe le décodage sans commit. **Si elle vaut déjà `false` (consigne des 18, 20 et 23/10/2026), rien ne change
  tant qu'elle n'est pas supprimée ou passée à `true`.**
- Le code reste explicite (`decode_protected_emails_enabled`, `src/sources/licitor.py`) : sans valeur vraie,
  aucun décodage. En local, `.env.example` garde `false`.

## Ce qui ne change pas

- L'adresse décodée ne va que dans le registre privé `information_agent_contacts` (`service_role`) : aucune
  colonne publique, aucun `raw_payload`, aucun point de reprise, aucun journal.
- Filtres : juridictions, Ordres, barreaux, CARPA, RPVA, `noreply`, `dpo`, `rgpd` écartés ; seuls les blocs des
  professionnels sont lus.
- Purge : seuil de 21 jours, purge hebdomadaire, soit 28 jours au plus après la dernière consultation de
  l'annonce ; aucune écriture pour une vente passée, retirée, annulée ou sans date.
- Opposition : une adresse opposée n'est jamais écrite ni rafraîchie.
- Aucune requête ajoutée vers Licitor : le décodage se fait sur le HTML déjà récupéré, dans le budget existant,
  et ce lot n'ajoute ni rattrapage ni relecture forcée.
- Point de reprise de collecte : il ne contient aucune adresse. Une fiche reprise d'un run interrompu est donc
  publiée sans adresse à ce passage et la reçoit à la relecture suivante de son détail, au plus 24 heures après
  sa lecture d'origine.
- Le pilote automatique écarte toujours les adresses Licitor décodées tant que le réglage `allow_licitor_decoded`
  n'est pas activé (`docs/runbooks/information-agent.md`) : la réactivation remplit le registre, elle n'ouvre
  aucun envoi.

## Effet attendu

Mesure du diagnostic du 11/11/2026 : 71 ventes Licitor à venir sur 410 ont une adresse au registre, soit environ
340 ventes à couvrir (moins celles dont la fiche ne présente aucune adresse retenue).

Le détail d'une fiche n'est tenu pour frais que 24 heures (6 heures quand l'audience est à moins de 7 jours) ;
passé ce délai il est relu, carte inchangée ou non, et l'adresse est écrite à cette lecture. Un passage Licitor
a lieu toutes les 12 heures environ, avec un budget de 42 minutes décompté dès le début du passage, donc lecture
des listes comprise ; les fiches non lues sont reportées au passage suivant. Les ventes concernées sont
couvertes en deux à trois passages, 36 heures environ après la fusion. Aucun rattrapage forcé n'a été ajouté : il
aurait relu une seconde fois des fiches encore fraîches pour un gain d'un passage au plus.

Contrôle après trois passages (lecture seule, `service_role`) :

```sql
select count(distinct scope_sale_id)
from public.information_agent_contacts
where source_kind = 'sale_listing'
  and metadata->>'observation_channel' = 'licitor_cloudflare_decoded'
  and observed_at > now() - interval '36 hours';
```

## Notaires (même lot)

La carte de liste des notaires ne porte que le téléphone ; le détail porte « téléphone | adresse ». Pour une
carte inchangée, le téléphone de la carte remplaçait le contact du détail à chaque collecte (26 ventes sur 202
avec l'adresse dans la colonne le 11/11/2026). Désormais (`src/main.py`), pour une carte notaires
inchangée dont le contact ne contient pas d'adresse alors que le détail connu en contient une, le contact devient
« téléphone de la carte | adresse du détail connu » : le téléphone reste celui de la carte, seule l'adresse vient
du détail. Les autres sources et les fiches dont la lecture du détail a échoué ne sont pas concernées. Le stock se rétablit
sans écriture manuelle : le détail d'une vente notaires est relu au plus tard 72 heures après sa dernière lecture
(6 heures à moins de 7 jours de la vente), ce qui réécrit « téléphone | adresse », et la valeur n'est plus perdue
ensuite. Cette adresse est celle que la source publie ; elle reste dans la colonne `lawyer_contact`, lisible par
les comptes connectés, pas par les visiteurs, comme avant.

## Textes à revoir (non modifiés ici)

Les textes juridiques publiés et `docs/rgpd-processing-register.md` ne sont pas modifiés par ce lot ; les passages
devenus inexacts sont signalés au propriétaire dans le compte-rendu de la modification.
