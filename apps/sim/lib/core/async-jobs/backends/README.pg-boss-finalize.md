# Finalisation native d’une tentative possédée — P03

Copyright 2026 Memlia. All rights reserved.

`finalizePgBossAttempt(tx, attempt, outcome)` écrit uniquement le résultat, le
statut et les horodatages terminaux dans `async_jobs`, après validation par
`guardPgBossAttempt` dans la même transaction appelante. Cette primitive de
persistance n’est raccordée à aucun consommateur, endpoint ou runner métier.
Le backend natif existant reste inchangé.

Le finaliseur et la garde copient l’identifiant et le jeton primitifs avant toute
attente. La même identité privée sert à la garde et aux requêtes suivantes ; une
modification ultérieure de l’objet fourni par l’appelant ne change ni la ligne
verrouillée ni le résultat du contrôle de possession.

## Contrat interne

Le futur appelant de confiance doit résoudre et revérifier l’autorité, exécuter
le runner natif hors transaction, qualifier honnêtement son résultat et préparer
ses données avant la courte transaction de finalisation. Une enveloppe ou un
jeton de tentative ne constitue pas une authentification. Aucun effet externe,
appel IA ou callback métier ne doit s’exécuter sous le verrou.

L’union `PgBossFinalization` constitue le contrat :

| Entrée | Persistance |
| --- | --- |
| `returned`, avec `outputJson` | Conserve le résultat JSON complet. Pour `workflow-execution`, un objet `success: false` produit `failed`, même sans message `error`. Sinon la tentative devient `completed` ; cela ne prouve pas le succès métier d’un autre type de runner. |
| `failed`, avec `error` | Conserve un échec certain, avec erreur préparée côté serveur et output null, comme la forme native d’échec. |
| `unknown` | Renvoie `reconciliation_required` sans verrouiller, écrire, terminaliser ou réinitialiser. Ce résultat n’atteste ni permission ni possession. |

`outputJson` est du texte sérialisé par l’appelant hors verrou. Aucun getter ni
`toJSON` de l’objet de résultat ne peut donc s’exécuter dans la persistance.
Le parsing, la taille UTF-8 maximale de 1 Mio, la profondeur maximale de 32, les
nombres finis et la forme exacte de l’entrée sont vérifiés avant le verrou de
ligne. Les règles numériques ordinaires de JSON/JavaScript s’appliquent : ce
n’est pas un transport de décimales exactes ni un sérialiseur d’objets arbitraires.
Le validateur canonique privé de l’admission sert une autre frontière ; il n’est
ni recopié ni réexporté. Les entrées malformées, surnuméraires, avec accesseurs ou
trop grandes produisent uniquement `finalize_invalid_outcome`, avant écriture.

L’erreur directe doit être non vide et occuper au plus 16 Kio UTF-8. Cette borne
**ne masque pas les secrets** : l’appelant serveur doit déjà avoir préparé un
message sûr. Le résultat persistant peut contenir des données métier sensibles,
comme le résultat natif. Ce module ne journalise ni ne renvoie ce contenu, le
message métier ou le jeton de tentative. Les futurs lecteurs devront appliquer
les droits natifs.

## Résultats métier natifs

`getRecordedJobFailureError` est réutilisé pour reconnaître le résultat natif
d’échec workflow enregistré. Son erreur est conservée jusqu’à 16 Kio plus les
trois octets du suffixe de troncature natif. Si elle manque ou dépasse cette borne,
la colonne error reçoit `workflow_execution_failed`, sans tronquer le résultat
JSON complet. Aucune sémantique générique `success: false` n’est inventée pour les
autres types : leur classification reste à raccorder.

Le backend DB historique écrit les échecs workflow enregistrés en `completed`,
puis les projette en `failed` avec output null à la lecture. Cette primitive écrit
`failed` et **conserve intégralement le résultat natif d’échec**. Le futur lecteur
pg-boss devra gérer explicitement cette différence ; aucun `getJob` historique
n’est changé ici. Une exception après un effet externe incertain ne constitue
pas, à elle seule, un échec certain : l’appelant doit choisir la réconciliation
non terminale. Aucun runner, journal métier ou contrôle de quota n’est exécuté.

## Transaction et concurrence

La garde existante verrouille et vérifie l’admission, une tentative `processing`,
son jeton serveur, ses dates et l’absence de résultat/erreur antérieurs. Une
annulation, un changement d’identité ou de jeton, une ligne absente/purgée ou un
état terminal ne peut être écrasé. L’UPDATE reste sous le même verrou et exige
aussi `processing`. Metadata d’admission et de tentative, payload, attempts,
runAt et startedAt restent inchangés. completedAt/updatedAt utilisent la même
horloge PostgreSQL UTC de l’instruction, indépendamment du fuseau de session.

`{ kind: 'finalized', status }` est **provisoire jusqu’au commit externe**. Un
rollback appelant annule résultat et champs terminaux ensemble. Un finaliseur
perdant reçoit `reconciliation_required` : aucun doublon ne réécrit résultat ou
dates, et aucun de ces retours ne décide d’un ACK. Une annulation commitée avant
la finalisation gagne. Inversement, une annulation limitée aux états en cours ne
peut défaire une finalisation déjà commitée. Les réécritures administratives
arbitraires restent hors protocole.

Le pool autocommit est refusé. Les erreurs bornées de garde/admission sont
conservées ; les nouvelles erreurs driver exposent seulement
`finalize_persistence_unknown`, acceptance `unknown`, sans cause brute, SQL ni
payload. PostgreSQL peut refuser du JSON valide, par exemple U+0000 : l’appelant
doit laisser l’erreur annuler sa transaction puis réconcilier sans rejouer un
effet. La primitive ne voit pas une panne ultérieure du commit externe ; une
réponse de commit incertaine reste une incertitude pour le futur appelant.

## Vérification et raccordements restants

Le test utilise l’environnement privé P03 désigné par
`MEMLIA_QUEUE_ADMISSION_TEST_ENV_FILE`, exige une DB `_test_`, retire les URL DB
héritées et exécute réellement admission, claim et finalisation PostgreSQL.
Seuls ses jobs/outbox uniques sont supprimés. Aucune DB ni aucun runner n’est
simulé. Les résultats fictifs représentent un runner déjà terminé : ils ne
qualifient pas l’exécution métier.

```sh
bun --no-env-file test apps/sim/lib/core/async-jobs/backends/pg-boss-finalize.integration.test.ts
```

La suite observe les attentes PostgreSQL pour deux finaliseurs et une annulation,
rollback, possession périmée, admission corrompue, échecs workflow avec/sans erreur,
horloge de session non UTC, refus d’entrée avant un verrou détenu, timeout réel
et rejet JSONB réel. Worker, autorité, annulation propagée, autres méthodes du
backend, réveil durable différé, réconciliation, lecture terminale et ACK restent
à raccorder. Aucun TTL, reset, retry, tombstone, scheduler ou exactly-once externe
n’est ajouté. Typage/build global, déploiement et parcours navigateur ne sont pas
qualifiés par ces tests de persistance.
