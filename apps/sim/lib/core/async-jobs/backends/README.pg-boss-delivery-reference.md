# Référence d’admission depuis une livraison

`resolvePgBossDeliveryReference(nativeJobId, deliveredEnvelope)` relie une enveloppe livrée à l’admission native persistée. Cette primitive interne ne modifie aucune ligne et n’authentifie pas le caller ou la livraison. Aucun worker, runner, ACK ou backend n’est activé ici.

## Identité vérifiée

Le module copie les données caller avec le copieur JSON strict de l’admission avant toute attente, puis valide `JobEnvelopeSchema`. Dans sa propre transaction courte, il verrouille la ligne async_jobs en lecture partagée, découvre son `admissionDigest`, appelle `readPgBossPublication` sous le même verrou et compare l’enveloppe entière avec celle livrée. Les valeurs et l’ordre des listes sont liés ; l’ordre des propriétés ne l’est pas.

Aucun digest caller n’est accepté. Le digest interne du transport porte l’enveloppe ; l’admissionDigest lie aussi jobId, payload, metadata, durée et runAt. Le bridge ne recalcule pas une deuxième empreinte et ne substitue jamais la première à la seconde. Le lecteur natif demeure responsable de vérifier l’intégrité complète de l’admission. La présence d’un événement outbox n’est pas requise après sa rétention.

Le retour, disponible après fermeture de la transaction, est figé ainsi que sa référence imbriquée :

```ts
{
  kind: 'delivery_admission_matched',
  origin: 'persisted_admission',
  reference: { nativeJobId, admissionDigest }
}
```

Seuls les deux champs de référence acceptés par la revérification native sont exposés. Aucune session, enveloppe, payload ou propriété de tentative n’est retournée. Ce résultat n’est pas une capacité ; `origin` décrit la lecture réalisée, pas une authentification de l’acheminement transport. Une valeur structurellement identique ne remplace aucun contrôle d’autorité ou de propriété.

## État, autorité et erreurs

Une identité intacte peut correspondre à un job pending, processing, terminal ou prématuré. Cette observation ne décide ni exécution, ni succès métier, ni ACK, ni réveil. Le caller futur devra revérifier l’autorité actuelle, posséder une tentative valide et appliquer le protocole de résultat/réconciliation avant tout effet ou acquittement. Le verrou de cette lecture est relâché avant ces étapes ; il ne protège pas un effet futur.

Le contrat conserve ses quinze noms de runners comme vocabulaire de comparaison, sans registre exécutable ajouté ; run-data-drain reste refusé. La capture/revalidation de session distincte demeure limitée à workflow-execution. Le bridge peut réussir alors que celle-ci refuse une session absente ou révoquée.

Les exceptions n’exposent que des codes fixes, sans cause brute, SQL ou donnée caller :

- `delivery_invalid_input` : identité ou enveloppe d’entrée invalide/perdant de l’information ;
- `delivery_admission_mismatch` : enveloppe livrée différente de l’admission valide ;
- `delivery_admission_reconciliation_required` : admission absente, legacy ou incohérente ;
- `delivery_observation_unavailable` : lecture/transaction indisponible.

Une erreur d’observation n’a pas de champ acceptance et ne prouve jamais qu’un job n’a pas été admis ou exécuté. Après purge, l’absence n’est pas une preuve de non-exécution. Aucun replay, reset, terminalisation, libération de slot ou retry automatique n’est ajouté.

## Vérification ciblée

Le test d’intégration exige `MEMLIA_QUEUE_ADMISSION_TEST_ENV_FILE`, pointant vers la configuration privée d’une DB P03 dédiée. Il refuse une URL non locale ou sans segment `_test_`, retire les URL héritées et emploie le rôle applicatif pour ses seules fixtures async_jobs/outbox. Aucune session réelle, aucun GRANT ou changement de schéma.

Lancer dans **un processus neuf** depuis apps/sim avec le runtime admis :

```sh
bun --no-env-file test lib/core/async-jobs/backends/pg-boss-delivery-reference.integration.test.ts
```

La suite fixe `lock_timeout=2s` uniquement sur ses connexions de test, puis vérifie ce réglage réel. Elle ne change aucun rôle, base ou option produit. Les attentes adversariales sont des verrous PostgreSQL observés via pg_blocking_pids, sans callback de test injecté sous la transaction produit. Le cleanup ne vise que les IDs générés pendant la campagne.

Cas couverts : scopes personnel/organisation, quinze mutations d’enveloppe valides au schéma, listes ordonnées, copie caller pendant attente, données hostiles/getters, payload/projection altérés, absence/purge/legacy, rétention outbox indépendante, lectures concurrentes, annulation et autres états, runAt futur, refus natif d’une session inexistante après correspondance d’identité, erreur réelle de verrouillage bornée. Aucun appel transport.work, dispatcher ou runner métier ; les arguments de livraison sont des fixtures natives, pas une consommation pg-boss qualifiée. Build global, navigateur, ACK, réveil durable et reprise après effet restent non qualifiés par cette tranche.
