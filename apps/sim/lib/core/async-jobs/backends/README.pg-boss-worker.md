# Worker durable Memlia — première tranche workflow

Copyright 2026 Memlia. Tous droits réservés.

## Sélection explicite et périmètre

Le serveur sélectionne ce backend uniquement avec `MEMLIA_DURABLE_WORKFLOWS_ENABLED=1`,
`MEMLIA_PG_BOSS_ENABLED=1` et une `MEMLIA_PG_BOSS_DATABASE_URL` PostgreSQL dédiée valide.
Une présence vide, invalide, incomplète ou en conflit avec Trigger.dev refuse. L'ancien
flag de transport seul ne change pas le backend. Les trois variables restent serveur.
Les valeurs brutes sont conservées par le `skipValidation` natif ; le sélecteur les
valide explicitement, sans recopier la DSN dans une erreur.

La première tranche accepte seulement `workflow-execution`, préparé par le caller
serveur déjà authentifié et admis. `enqueueWorkflowExecution` transmet un handle
opaque du port natif, sans options ni closure. Le handle n'est ni sérialisé ni
reconstruit depuis les données d'un job. L'admission native prend sa propre
transaction et capture la session admissible avant de confirmer le COMMIT.
Un COMMIT inconnu conserve le slot et la claim d'exécution ; aucun nouvel essai
métier n'est déclenché ici.

| Méthode de JobQueueBackend | Comportement de cette tranche |
| --- | --- |
| enqueue | workflow session et handle natif exclusivement, sinon refus avant admission |
| batchEnqueue | refus explicite, même pour un tableau vide |
| batchEnqueueAndWait | refus explicite ; aucun appel de closure sans ligne persistée |
| getJob | projection native, racine réservée retirée, output failed conservé |
| cancelJob | annulation native persistée |
| cancelByExecution | scope et compteur natifs conservés |
| cancelByWorkspace | borne et résultat natifs conservés |
| cancelByKey | refus synchrone ; aucun faux `false` signifiant absence de travail |
| startJob | refus sans tentative fenced |
| completeJob | refus sans tentative fenced |
| markJobFailed | refus sans tentative fenced |

`getInlineJobQueue` refuse lorsque le sélecteur durable est présent. Les chemins
historique database/Trigger restent disponibles en l'absence du sélecteur.
Les sous-jobs, reprises, dispatchers et nettoyages non raccordés peuvent donc faire
échouer explicitement un workflow qui les exige : cette tranche ne qualifie pas
l'ensemble des automatisations Sim.

## Registre des quinze kinds contractuels

| Kind | Runner natif identifié | Raccordement |
| --- | --- | --- |
| workflow-execution | background/workflow-execution.executeWorkflowJob | session seulement |
| slack-search | lib/slack-search/handlers/search-message.handleSlackSearchMessage | refus |
| schedule-execution | background/schedule-execution.executeScheduleJob | refus |
| webhook-execution | background/webhook-execution.executeWebhookJob | refus |
| quickbooks-webhook-ingress | background/quickbooks-webhook-ingress.executeQuickBooksWebhookIngress | refus |
| resume-execution | background/resume-execution.executeResumeJob | refus |
| workflow-group-cell | background/workflow-column-execution.executeWorkflowGroupCellJob | refus |
| cleanup-logs | background/cleanup-logs.runCleanupLogs | refus |
| cleanup-soft-deletes | background/cleanup-soft-deletes.runCleanupSoftDeletes | refus |
| cleanup-table-row-ttl | background/cleanup-table-row-ttl.runCleanupTableRowTtl | refus |
| cleanup-stale-executions | background/cleanup-stale-executions.runCleanupStaleExecutions | refus |
| cleanup-tasks | background/cleanup-tasks.runCleanupTasks | refus |
| cleanup-file-versions | background/cleanup-file-versions.runCleanupFileVersions | refus |
| cleanup-dispatch | lib/billing/cleanup-dispatcher.dispatchCleanupJobs | refus |
| knowledge-connector-directory-sync | background/knowledge-connector-directory-sync.executeDirectorySyncJob | refus |

Le kind EE `run-data-drain` reste exclu. `organizationId: null` signifie réellement
absence d'organisation ; ce n'est jamais un scope générique. Les payloads et
métadonnées ne confèrent aucune autorité.

## Processus et persistance

Point d'entrée explicite : `apps/sim/scripts/memlia-workflow-worker.ts`, à lancer
avec le runtime Bun admis, le tsconfig de l'application et l'environnement serveur
fourni par le déploiement. Aucun import web ne lance le worker. Le transport utilise
uniquement le schéma précréé `memlia_jobs` et la queue `memlia_native`, via son rôle
distinct ; le pool natif Sim conserve son rôle applicatif.

Le cron outbox natif `enqueueOutboxProcessor`/`runOutboxProcessor` publie les événements
avec le handler déjà enregistré. Le worker ne crée ni deuxième outbox ni ordonnanceur.
La publication reprend `runAt` et `maxDurationSeconds` normalisés et vérifiés par
`readPgBossPublication`, dans la même lecture que l'identité d'admission.

Le worker vérifie l'identité persistée, revérifie la session et les droits natifs,
puis claim une seule tentative. Il attend son COMMIT avant de charger le runner.
Il valide les champs qui interdiraient les replis legacy, revérifie l'autorité,
puis le fence, avant l'effet. Le runner natif conserve son timeout et ses résultats.
Un résultat `success:false` reste un échec métier avec son output natif ; un retour
de fonction ne devient pas automatiquement un succès.

L'annulation est observée par le signal de livraison, l'arrêt possédé du worker et
un contrôle du fence natif toutes les 250 ms, sans renouvellement de lease ni
réécriture de statut. Une annulation ne peut pas annuler rétroactivement un effet
externe. Aucun appel métier n'est effectué sous verrou SQL.

L'acquittement transport attend un résultat terminal vérifié ou le COMMIT de la
finalisation native. Un job déjà processing, une perte de réponse, un résultat
inconnu ou une exception après début du runner imposent une réconciliation ; aucun
reset, retry métier ou libération de slot n'est inventé. Un arrêt brutal laisse
la tentative processing, même si pg-boss expire sa livraison. La présente tranche
ne prétend pas fournir une réconciliation automatique de ces effets inconnus.

Un `defer` vérifié avant effet ne vaut pas ACK : le transport confirme d'abord une
livraison de réveil déterministe, avec le même nativeJobId/enveloppe et le `runAt`
accepté. Une seconde observation prématurée du même réveil refuse au lieu de
prolonger son horizon. Une acceptation inconnue ou un réveil failed/cancelled ne
permet pas d'acquitter l'ancienne livraison. La rétention native n'est pas remplacée
par des tombstones : une identité purgée exige une réconciliation.

## Qualification

Les tests unitaires de sélection utilisent le véritable trajet env serveur ; ceux
du transport doublent les IO pg-boss, ceux du worker les ports de persistance et
le runner. Ils prouvent les ordres et refus locaux, pas une durabilité PostgreSQL.
Les suites natives PostgreSQL et le processus worker réel sont une qualification
séparée sur DB de fixtures dédiée, avec rôles applicatif/migrateur/transport distincts.
Aucune preuve Windows, déploiement Compose, fournisseur payant, replay après effet,
construction globale ou disponibilité commerciale n'est déduite de ces unités.

La préparation synchrone refuse une durée native de job supérieure à 86 340 secondes, avant toute lecture d’autorité ou admission. Le transport ajoute 60 secondes de grâce sans dépasser les 24 heures maximales de pg-boss 12.38. Le calcul natif de durée inclut déjà sa marge de cinq minutes ; cette limite ne prolonge pas le délai métier.
