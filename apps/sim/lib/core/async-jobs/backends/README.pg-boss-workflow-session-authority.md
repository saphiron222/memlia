<!-- Copyright 2026 Memlia. All rights reserved. -->
# Référence d’autorité pour les workflows issus d’une session

Cette primitive interne prépare la capture et la revérification d’une référence de
session Sim. Elle ne branche aucun endpoint, enqueue, backend global, consumer,
runner, ACK ou mécanisme de réveil. Son résultat n’est jamais « prêt à exécuter ».

## Capture après authentification serveur

`capturePgBossWorkflowSessionAuthority` reçoit le principal session fourni par une
frontière serveur qui a **déjà authentifié** la requête, puis les identifiants du
workflow et du workspace admis. Le futur raccordement se situe avant l’admission
dans `lib/workflows/executor/enqueue-execution.ts`, avec l’identité issue de
`checkHybridAuth` ou d’une frontière native équivalente.

Une valeur typée `SessionPrincipal`, un identifiant de session connu ou un JSON
client ne prouvent pas cette authentification initiale. Aucun caller n’est ajouté
ici. Il est interdit d’exposer cette fonction comme une route acceptant une
identité du client. Ni payload, metadata, payer, propriétaire du workflow ni
propriétaire du workspace ne créent un principal.

La capture produit une référence `Principal` Memlia **interne à la persistance** :
actor sérialisé nativement, même sujet utilisateur, autorité interactive, workspace
canonique et organisation strictement nullable. `null` signifie absence effective
d’organisation, sans wildcard. `scopes` et `allowedTools` sont vides ; aucun grant
ni droit d’outil n’est créé. Cette référence contient le `sessionId` nécessaire à
la revérification, jamais le token de session ni un email. Elle doit rester dans
la racine réservée de l’admission, retirée des projections publiques par la brique
`pg-boss-native-state`.

## Origine persistée et cible

`revalidatePgBossWorkflowSessionAuthority` accepte seulement la référence minimale
`{nativeJobId, admissionDigest}`. Elle charge elle-même la publication par le vrai
`readPgBossPublication`. Une enveloppe ou un objet ayant le type d’une publication
n’est pas accepté comme preuve d’origine.

Dans une courte transaction, elle verrouille la ligne native en lecture partagée,
vérifie le digest d’admission puis lit le payload du même snapshot. Le runner doit
être `workflow-execution`, le statut pending ou processing, l’acteur une session,
le sujet identique, l’autorité interactive et les deux listes de droits vides.
Le principal sérialisé du payload doit correspondre exactement à la session et au
sujet de l’admission ; workspace et executionId doivent correspondre au scope et
au runId. Le workflowId est un localisateur à résoudre canoniquement, jamais une
source d’identité. L’absence de principal ou les replis legacy sont refusés.

La transaction est terminée avant les lectures de politique et tout accès possible
à la configuration externe. Aucun callback fourni par l’appelant ni effet métier
n’est exécuté sous le verrou. Les primitives de l’entrée sont copiées avant le
premier `await` ; aucune mutation ultérieure du caller ne peut changer de job ou
de session.

Le résultat `authority_checked`, avec `origin: persisted_admission`, contient
uniquement userId/workflowId/workspaceId/organizationId. Il ne contient pas de
sessionId, token, email, payload ni cause brute. L’origine décrit **la lecture
effectuée**, pas une signature attestant que l’admission initiale provenait d’un
caller correctement authentifié : le raccordement futur de capture/admission doit
encore garantir cette frontière. L’admission générique reste une primitive de
forme, pas une autorisation.

## Contrôles natifs et limites de révocation

Les deux opérations relisent une session existante, liée au sujet et à un compte
existant, non expirée selon l’horloge PostgreSQL et sans impersonation. La requête
ne sélectionne jamais `session.token`. Les restrictions de compte passent par
`getActivelyBannedUserIds` (ban actif, suspension, politique native d’emails/domaines).
Un ban expiré garde la sémantique native. Puis le résolveur actif de workflow et
workspace et `authorizeWorkspaceOperation(..., workflowOperations.execute, ...)`
contrôlent la cible et les permissions actuelles. Le seuil natif est read ; être
owner sans permission n’y supplée pas. Une organisation d’admission différente de
l’organisation canonique, même null contre une valeur, est refusée.

Toute erreur de forme, refus natif, panne de configuration ou erreur PostgreSQL
devient l’erreur fixe `workflow_session_authority_rejected`, sans cause attachée,
valeur d’entrée ni log ajouté. Cette erreur ne déclare ni un échec métier certain
ni une autorisation de retry ou d’ACK ; le futur protocole doit traiter le refus
avant tout effet. Les erreurs d’origine/digest sont également fermées et bornées.

Les résolveurs natifs utilisent plusieurs lectures du pool, et la politique externe
peut être mise en cache. Il n’y a **pas d’atomicité** entre toutes ces lectures, une
révocation concurrente, le claim et un effet externe ultérieur. Une révocation déjà
commise avant la revérification est observée ; la concurrence après sa dernière
lecture reste une fenêtre à traiter au raccordement. Le consumer devra revérifier
immédiatement avant dispatch et respecter l’ownership de tentative. Aucun verrou
n’est tenu pendant l’exécution d’un workflow.

Fermer l’onglet ne révoque pas la session persistée. Logout, suppression, expiration
ou révocation la rendent inutilisable lors du contrôle suivant. Cette brique ne
renouvelle pas de session ; survivre à son expiration exige une vraie délégation
durable distincte. Clés API, OAuth, services, délégations et impersonation restent
refusés, sans conversion en session ou en system/internal.

## Preuves et raccordements encore ouverts

La suite PostgreSQL utilise le rôle applicatif restreint pour toutes les lectures
de runtime et le rôle propriétaire distinct uniquement pour les fixtures et leurs
révocations. Elle exige une base dédiée, sans skip. Les seules doublures concernent
la configuration externe d’accès et une attente contrôlée ; tables, permissions,
résolveurs, admission et horloge DB restent réels. Un autre scénario utilise un
vrai blocage PostgreSQL pour muter une référence pendant la lecture. La suite
vérifie aussi le refus effectif de lecture des tokens et de mutation des tables
d’autorité par le runtime. Nettoyage limité aux identifiants propres à chaque run.

Exécution locale : fournir le chemin privé `MEMLIA_QUEUE_ADMISSION_TEST_ENV_FILE`
puis, depuis `apps/sim`, lancer Bun `--no-env-file test` sur le fichier
`lib/core/async-jobs/backends/pg-boss-workflow-session-authority.integration.test.ts`.
Le fichier privé doit contenir `TEST_DATABASE_URL` et `MIGRATION_DATABASE_URL` de
la même base de test, sous deux rôles différents. Aucune valeur ne doit être publiée.
Le schéma natif doit inclure 0436 pour la lecture complète de workflow.

Restent à raccorder : caller authentifié et capture obligatoire, admission
transactionnelle, choix explicite des flags credentials/API (sans defaults legacy),
facturation/réservation et version de workflow, claim, dispatch natif hors verrou,
résultat métier/finalizer, annulation et arrêt, ACK durable, réveil après defer et
réconciliation des effets inconnus. Aucun retry automatique n’est ajouté.
Les onze méthodes de `JobQueueBackend`, les quinze runners admis et l’arbitrage
`cancelByKey` asynchrone restent hors de cette tranche ; `getJobQueue` reste intact.
Les tests de référence de session ne constituent pas une observation navigateur
ni la preuve d’un workflow exécuté après fermeture de l’onglet.
