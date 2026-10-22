# P03 — admission native et publication pg-boss

Copyright 2026 Memlia. Tous droits réservés pour ces ajouts. Les composants Sim
et pg-boss conservent leurs licences Apache-2.0 et MIT respectives.

Cette tranche persiste une demande dans `async_jobs` et son événement dans
`outbox_event`, puis le handler natif publie sa livraison dans pg-boss.
**Aucun exécuteur métier, endpoint ou backend `getJobQueue` n’est activé.**
Ce n’est pas encore une implémentation des onze méthodes de `JobQueueBackend`.

## Configuration et rôles

Le client n’ouvre aucune connexion à l’import. `get()` exige simultanément :

- `MEMLIA_PG_BOSS_ENABLED=1` exactement ;
- `MEMLIA_PG_BOSS_DATABASE_URL`, DSN serveur dédié. Aucun repli sur `DATABASE_URL`.

Le schéma `memlia_jobs` et la queue `memlia_native` sont fixes. L’installation
précrée le schéma, appartenant au rôle transport distinct. Ce rôle n’a ni
superuser, création de base/rôle, CREATE sur la base/public ni lecture des tables
métier. Le rôle applicatif possède les droits sur `async_jobs`/`outbox_event`.
Ne jamais fournir le rôle de migration comme rôle runtime.

`createSchema:false` est l’option native `MaintenanceOptions` de pg-boss 12.38.0.
Elle évite le `CREATE SCHEMA IF NOT EXISTS`, qui exige CREATE sur la base même
pour un schéma précréé. Les migrations internes pg-boss restent autorisées dans
son seul schéma. Un schéma absent ou un DDL refusé fait échouer le démarrage ;
aucun fallback de privilèges. L’option ajoutée au transport est facultative :
les anciens appels conservent leur comportement.

`createPgBossClient()` partage la connexion en cours entre appels concurrents.
`stop()` interdit les nouveaux appels, attend une connexion en cours puis le
stop/drain existant du transport. Le futur hôte du worker doit l’appeler lors de
son arrêt et borner son délai de processus. Aucun worker factice ni signal
processus global n’est installé ici.

## Admission dans la transaction du caller

`admitPgBossJob(tx, {jobId, envelope, payload, metadata?, maxDurationSeconds?, runAt?})`
exige une transaction Drizzle native. Son savepoint garantit qu’une erreur capturée
par le caller ne laisse pas la moitié d’une admission. L’acceptation ne devient
durable qu’après le commit de la transaction englobante. Un problème de réponse
DB non classifiable reste `acceptance:'unknown'` : réconcilier avec la même identité.

Cette primitive **n’autorise pas une action**. Le caller serveur futur doit
résoudre l’identité, les délégations, les scopes, les connexions, la version et
les budgets avant cette transaction, puis le worker devra les revérifier. Ne
jamais accepter directement une enveloppe fournie par un client ni déduire une
autorité du payload, du payeur ou de `metadata`. Le schéma canonique ne contrôle
que la forme. Les quinze runners canoniques sont conservés ; `run-data-drain`
reste explicitement exclu.

L’identité d’outbox dérive de l’organisation, de l’espace, du runner et de la clé
idempotente. Le job conserve aussi son ID natif opaque. Deux appels égaux ont le
même ID/événement ; une autre identité native ou un contenu différent est refusé.
L’ordre des propriétés JSON n’a pas d’effet, celui des tableaux en a un. Payload
et metadata doivent être JSON sans perte, profondeur au plus 32, demande au plus
1 Mio. Aucun runner JavaScript, option de retry implicite ou callback n’est persisté.

La projection conserve le payload natif et l’enveloppe immuable dans une clé de
metadata réservée, avec le digest de la demande. L’événement ne contient que
`nativeJobId` et `admissionDigest` ; aucune copie de payload/credentials dans
l’outbox. Les metadata de durée sont réservées à l’option explicite ; durée par
défaut 900 secondes. `runAt` est un instant ISO absolu et stable, par défaut
`envelope.submittedAt`. La date de création du job reste l’instant de l’admission.
Le processor natif respecte `availableAt` avant publication ; le transport ne
porte pas lui-même ce délai. Le futur consommateur devra revérifier `runAt`,
garantir un réveil durable et ne jamais ACK définitivement une livraison encore
prématurée. Aucun consommateur n’est branché dans cette tranche.

`maxAttempts=1` dans la projection et `retryLimit=0` dans le transport. Le helper
n’insère pas encore le run/log métier : un caller futur peut composer ses propres
écritures dans la même transaction native. L’attente persistée des batches,
la priorité/concurrence/tags et les onze méthodes du backend restent à intégrer.

## Handler natif et reprise

L’unique groupe lazy ajouté à `OUTBOX_HANDLER_GROUPS` enregistre
`memlia.pg-boss.publish`. Les claims, baux, backoff, limites, délais et dead letters
restent ceux de `processOutboxEvents` / `processOutboxEventById`.

Le handler recharge la projection, vérifie le contenu/digest, le type et l’identité
de l’événement, puis publie exactement le même ID et la même enveloppe. Une perte
d’ACK d’outbox après acceptation pg-boss provoque une republication dédupliquée.
Les erreurs du transport conservent leur classification d’acceptation ; les erreurs
DB non classifiées sont remplacées par un code fixe avant persistance native.
Aucun détail driver, DSN, payload ni raison d’abandon arbitraire n’est propagé.

Une projection terminale ne génère pas une nouvelle livraison. Une projection
`processing` ou absente exige réconciliation. Une annulation après la lecture et
avant l’envoi peut encore laisser une livraison en queue : le futur consommateur
**doit** recontrôler le statut et l’autorité avant de prendre le travail. L’ACK du
transport n’est jamais présenté comme un succès métier.

La rétention native supprime les jobs terminaux après 24 h ; le prune d’outbox
n’inclut que deux types knowledge explicitement autorisés, pas notre événement.
L’événement conservé empêche la recréation d’un job purgé : refus
`admission_reconciliation_required`. Aucun tombstone ou durée de conservation
illimitée n’est inventé. Une suppression administrative des deux lignes enlève
cette barrière. La déduplication pg-boss dépend aussi de sa rétention (voir le
README du transport). Ni exactly-once externe ni retry métier après effet
incertain ne sont garantis. Le statut incertain/reçu métier reste un gate P03.

## Vérification ciblée

Fichier privé `MEMLIA_QUEUE_ADMISSION_TEST_ENV_FILE` requis, jamais affiché :
`TEST_DATABASE_URL` pour le rôle applicatif, `MEMLIA_PG_BOSS_DATABASE_URL` pour le
rôle transport, base explicitement nommée `_test_`. Les migrations natives sont
provisionnées séparément par l’intégrateur. Aucun skip vert si la DB est absente.

```sh
bun --no-env-file test \
  apps/sim/lib/core/async-jobs/backends/pg-boss-admission.integration.test.ts \
  apps/sim/lib/core/async-jobs/backends/pg-boss-client.integration.test.ts
```

Les tests exercent PostgreSQL réel, le helper natif d’outbox, les deux rôles,
rollback/savepoint, concurrence, clés/conflicts, purge, corruption et publication
répétée après perte d’ACK. Aucun handler métier n’est exécuté. Nettoyage limité
aux IDs de fixtures créés par chaque run ; les queues du test de transport isolé
peuvent rester pour inspection. Le build global, l’activation du backend, les
workflows réels et le scénario crash après effet externe restent NON TESTÉS.

### Publication planifiée

`readPgBossPublication` expose aussi `runAt` (ISO UTC canonique validé) et
`maxDurationSeconds` (entier natif normalisé, entre 5 et 2 147 483 647 secondes).
Ces deux valeurs proviennent de la même admission vérifiée, sans reconstruction
ou seconde lecture. Elles ne changent ni le digest ni l'autorité. Le transport
peut imposer une borne plus étroite ; voir la tranche du worker avant activation.
