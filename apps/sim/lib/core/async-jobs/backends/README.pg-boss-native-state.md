# Lecture et annulation natives pour le futur backend persistant

`createPgBossNativeState()` expose exactement quatre méthodes existantes de
`JobQueueBackend` : `getJob`, `cancelJob`, `cancelByExecution`, `cancelByWorkspace`.
Il compose `DatabaseJobQueue` ; il ne possède aucune logique SQL, aucun transport,
aucun runner, aucune admission et aucun ordonnanceur. Il n'est pas un backend
complet et n'est pas sélectionné par `getJobQueue`.

## Projection et résultats

La lecture utilise la projection native, puis retire **uniquement la propriété
racine `metadata.memliaPgBossAdmission`**. Cette propriété contient l'enveloppe
persistée et le jeton privé de tentative. La route native de statut renvoie les
métadonnées du job : un futur backend doit utiliser cette projection pour sa
lecture publique, jamais renvoyer directement la racine réservée.

Les autres métadonnées, y compris une propriété homonyme imbriquée dans les données
applicatives, sont conservées. Le payload, l'output, les dates et le statut gardent
leur sémantique native. Ce module ne constitue pas un nettoyeur générique de secrets
et ne rend pas le payload publiable ; la route de statut native ne renvoie pas ce
payload. Il ne modifie aucune donnée persistée.

Les nouveaux résultats `failed` du finaliseur pg-boss conservent leur output complet,
y compris les échecs workflow sans champ error. La projection legacy d'une ancienne
ligne `completed` portant un RecordedJobFailure reste `failed`, error renseigné et
output null, comme dans `DatabaseJobQueue`. L'absence d'un job reste null.

## Annulations

Les trois annulations appellent les méthodes natives réelles. Elles conservent leurs
scopes d'exécution, les types de jobs workflow, les bornes de balayage, le signal
et le résultat `complete`. Elles n'acceptent aucun token de tentative du client.

Une annulation persistée de pending interdit sa claim. Une annulation persistée de
processing invalide la garde du finaliseur ; une ancienne tentative ne peut alors
écraser la ligne cancelled. Les terminaux ne sont pas réécrits et une répétition
reste idempotente. Une absence de job est silencieuse selon le contrat natif.

Ce module n'authentifie ni n'autorise le caller. La porte serveur doit vérifier ses
droits et le périmètre demandé avant l'appel. Il n'assimile pas metadata, payload
ou enveloppe à une preuve d'autorité. Les erreurs et journaux des méthodes natives
restent ceux de DatabaseJobQueue ; aucune nouvelle garantie de masquage n'est
ajoutée ici.

Les AbortControllers natifs ne sont présents que dans leur processus. L'annulation
de la ligne est durable ; elle ne prouve pas l'interruption d'un effet externe déjà
démarré dans un autre processus. Cette propagation et la politique d'incertitude
restent à raccorder avant un vrai worker. Aucun ACK, retry ou reset n'est produit.

## Validation réelle et limites

Depuis `apps/sim`, avec le runtime Bun admis et le fichier privé de DB P03 :

```sh
MEMLIA_QUEUE_ADMISSION_TEST_ENV_FILE=/chemin/prive/p03-queue.env \
  bun --no-env-file test lib/core/async-jobs/backends/pg-boss-native-state.integration.test.ts
```

La suite refuse une configuration absente ou une base sans `_test_`, efface les
URLs de production/réplica/migration héritées et utilise le rôle applicatif dédié.
Elle crée des IDs uniques par campagne et nettoie seulement ses lignes async_jobs
et outbox_event, avec assertions d'absence finale. Aucun mock DB, runner métier,
clé active ou donnée réelle n'est utilisé. Les enveloppes sont des fixtures de
persistance, pas des preuves d'autorisation.

Sept scénarios : projection pending/processing ; outputs failed/completed ;
compatibilité legacy ; annulation pending/idempotence/absence ; annulation processing
contre le vrai finaliseur ; scope execution/workflow/resume avec carrier exclu ;
sweep workspace borné avec signal, autre workspace et cleanup préservés.
La suite n'exerce pas une route HTTP, un arrêt interprocessus ou une action externe.

## Raccordements restants

Les sept autres méthodes natives ne sont pas implémentées ici. Admission et lots
exigent une autorité serveur revérifiable ; startJob/completeJob/markJobFailed
legacy ne portent aucun token ; batchEnqueueAndWait doit persister ses enfants et
reprendre le parent ; cancelByKey est actuellement synchrone et local. Le changement
du contrat d'annulation durable doit adapter son caller de tableau.

La liste contractuelle des quinze runners autorisés doit être reliée à leurs
fonctions natives, avec résultats/concurrence/signaux adaptés ; run-data-drain reste
exclu. Le contrat d'organisation non nullable ne couvre pas encore les espaces
personnels sans organisation. Ces décisions ne sont pas contournées dans ce module.
Autorité, consommation, réveil durable, réconciliation et ACK restent des gates
explicites ; aucune activation de backend n'est livrée par cette tranche.
