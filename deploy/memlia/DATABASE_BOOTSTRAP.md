# Installation PostgreSQL initiale

Le CLI `database-bootstrap.ts` complète l’image migrations existante. Il crée
uniquement une **installation vide** : cinq rôles distincts, sa base, les
extensions natives et le schéma privé du transport pg-boss. Le runner
`packages/db/scripts/migrate.ts` reste responsable des tables et migrations
Sim/Memlia. Aucun workflow, utilisateur, job ou résultat n’est fabriqué par ce
CLI. Une installation existante n’est jamais adoptée ou écrasée.

## Configuration et autorité

Exécuter avec Bun de l’image migrations, en opération d’administration isolée,
avant le démarrage des applications. L’administrateur PostgreSQL est utilisé
seulement par cette opération, jamais par web/realtime/worker/transport. Les
services applicatifs gardent UID/GID1001. L’administrateur prépare un fichier
JSON hors dépôt, propriétaire de l’identité qui exécute le CLI, mode0400 ou0600,
sans lien ni lien dur, dans un parent immédiat0700. Tous ses ancêtres et ceux
du journal doivent appartenir à root ou à cette identité et être non modifiables
par groupe/autres. Un répertoire temporaire root sticky est accepté uniquement
au-dessus d’un enfant privé possédé ; le journal durable ne doit pas être placé
dans un tmpfs éphémère.

Schéma strict, aucun champ supplémentaire :

```json
{
  "version": "memlia.database-bootstrap/v1",
  "deploymentId": "<identifiant aléatoire de 32 caractères hexadécimaux minuscules>",
  "database": "<nom de la nouvelle base>",
  "stateDirectory": "/run/memlia-bootstrap/state",
  "adminUrl": "<DSN administrateur vers la base postgres>",
  "urls": {
    "migrate": "<DSN propriétaire de la nouvelle base>",
    "web": "<DSN application web>",
    "realtime": "<DSN serveur collaboratif>",
    "worker": "<DSN métier du worker>",
    "transport": "<DSN dédié au transport pg-boss>"
  }
}
```

Ces valeurs sont des emplacements à remplir, pas une configuration exécutable.
Tous les DSN doivent viser le même hôte/port, sans query ni fragment. Les cinq
DSN applicatifs visent la nouvelle base ; les noms de rôles et les six mots de
passe sont distincts. Chaque mot de passe contient20 à128 caractères ASCII
base64url (`A-Z a-z 0-9 _ -`). Les noms SQL suivent
`[a-z][a-z0-9_]{0,62}` ; `postgres`, les noms réservés `pg_*` et les bases
templates sont refusés. Ne jamais imprimer le JSON, le donner en argument de
ligne de commande ou conserver sa résolution Compose dans un journal public.

Le profil initial garde le transport dans la même base, dans `memlia_jobs`,
avec son propre rôle. Un autre hôte/base de transport nécessite un provisioning
séparé ; ce CLI ne prétend pas le qualifier. Les connexions sont privées au
réseau du cabinet ; aucune option TLS n’est inventée dans les DSN. La
qualification du réseau/TLS entre services reste une gate de livraison.

## Ordre obligatoire

1. Monter le fichier protégé en lecture seule et le répertoire parent du
   journal en écriture durable. Avec l’image migrations admise et sans autre
   service applicatif, exécuter :

   ```sh
   bun --no-env-file /app/deploy/memlia/database-bootstrap.ts \
     --config /run/memlia-bootstrap-config/config.json --phase prepare
   ```

2. Fermer l’opération d’administration. Exécuter le runner migrations natif
   de la même image/révision avec `MIGRATION_DATABASE_URL` et `DATABASE_URL`
   égaux au seul DSN `migrate`, sans lui transmettre le JSON administrateur.
3. Reprendre l’opération d’administration protégée avec le même fichier et
   journal ; exécuter `--phase grants`, puis `--phase verify`.
4. Autoriser le démarrage applicatif uniquement après leurs reçus `PASS`, les
   migrations réussies et les autres gates du profil Compose. Ces reçus ne
   sont ni une admission métier ni une qualification de l’installation complète.

En conteneur, l’identité de provisioning peut être root, avec racine en lecture
seule, capabilities retirées et `no-new-privileges`, le seul journal durable
inscriptible et le réseau DB nécessaire. Le montage parent du journal peut
être0755 ; le CLI crée et vérifie son enfant `state` en0700. Le parent immédiat
du fichier JSON doit rester0700 **dans le conteneur** également. Ne pas monter
les secrets administrateur dans web, realtime, worker ou cron.

## Droits et contrôles effectifs

Le propriétaire de migration reste sans droits superuser/createDB/createRole ;
il possède la base et les objets métier. Les extensions `vector`, `pg_trgm` et
`btree_gin` sont préparées par l’administrateur. Les rôles runtime sont sans
héritage ni appartenance à un autre rôle. Aucun runtime ne reçoit CREATE sur
la base, TEMP ou CREATE sur un schéma métier. Le transport possède uniquement
son schéma de queue ; les données métier et journaux de migration lui sont
refusés. pg-boss conserve son moteur natif et crée ses propres objets de queue.

`grants` attribue les quatre droits DML aux rôles web/worker sur les tables
métier, sans TRUNCATE, REFERENCES, TRIGGER ou MAINTAIN. Realtime reçoit les
droits des graphes et les lectures requises par son auth/collaboration ; il ne
reçoit pas la table des connexions `account`. Les séquences métier sont
USAGE/SELECT pour web/worker, sans UPDATE. Les fonctions SECURITY DEFINER ne
sont pas exécutables par runtime. Les journaux réels `drizzle.__drizzle_migrations` et
`public.script_migrations` restent exclus de tous les droits runtime, y compris
SELECT. Parmi les cinq profils applicatifs, seul `migrate` conserve les droits
sur ces journaux ; le runner natif reste leur seul gestionnaire.

`verify` authentifie chacun des cinq DSN, vérifie les droits **effectifs**,
incluant ceux hérités de PUBLIC, ainsi que les propriétaires tables/séquences
et l’absence de propriété runtime sur schemas/fonctions/types métier. Ce
contrôle est en lecture seule dans PostgreSQL : il refuse un droit manquant ou
excessif sans le réparer. Les restrictions DB complètent les contrôles
utilisateur/espace du produit ; elles ne les remplacent pas. Elles ne protègent
pas d’un administrateur PostgreSQL malveillant.

## Résultats inconnus et reprise

Le journal privé est lié aux octets exacts du JSON, à l’identifiant de déploiement
et à l’identifiant système PostgreSQL. Une intention est synchronisée sur disque
**avant** les créations ou changements de droits. Un lock local exclusif et un
verrou advisory sur session PostgreSQL possédée sérialisent l’opération.

Une phase pending, un lock abandonné, une connexion perdue ou une provenance
divergente signifie **HOLD / réconciliation requise**. Ne jamais effacer un lock
et relancer aveuglément ; inspecter l’effet dans le namespace possédé et
conserver le diagnostic privé. Aucune suppression automatique de base/rôle,
aucun retry des créations et aucune adoption d’une installation préexistante.
Un prepare déjà acquitté ne rejoue aucun DDL. La rotation des secrets, les
mises à jour de schéma et la restauration d’une installation existante sont
des opérations distinctes à qualifier ; ce CLI ne les déclare pas validées.

La sortie standard contient uniquement un petit reçu aux champs fixes. Les
erreurs natives bornées sont écrites en mode0600 dans le journal avant
projection vers un motif fermé. Garder ces diagnostics privés : une erreur du
runner migrations natif peut également contenir du SQL ou des paramètres.

## Portée de validation

Les tests portables vérifient les configurations et fichiers protégés ; les
tests d’intégration exigent explicitement
`MEMLIA_DB_BOOTSTRAP_TEST_CONFIG` vers une installation de laboratoire vide et
possédée. Ils modifient temporairement ses seuls droits pour vérifier le refus
en lecture seule, puis les restaurent. Ne jamais les exécuter sur une base de
cabinet. Le provisioning, migrations, grants, sessions réelles et contre-tests
ACL ont été exercés sur PostgreSQL17 natif du laboratoire. L’image Docker
contenant ce CLI, la recette Compose complète et le worker ne sont pas qualifiés
par ces seuls tests. Voir le suivi privé de qualification pour les révisions,
mesures et preuves exactes.
