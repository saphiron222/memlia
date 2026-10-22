# Image du worker durable Memlia — recette non qualifiée

Cette recette lance **le worker existant**, sans nouveau moteur de queue ou
d’exécution. Elle n’ajoute aucun service à Compose, n’inscrit aucune image dans
`QUALIFIED_IMAGES` et n’active pas les jobs par défaut. Construire et qualifier
l’image Linux avant de l’utiliser ; aucun déploiement cabinet n’est validé ici.

## Code et runtime conservés

Le point d’entrée est `apps/sim/scripts/memlia-workflow-worker.ts`. Il appelle
`startPgBossWorkflowWorker`, qui conserve les admissions, l’outbox, pg-boss,
l’autorité de session, les claims, l’annulation et la finalisation natives. Le
registre `pg-boss-registry.ts` ne sélectionne que `workflow-execution`, puis
`executeWorkflowJob`. Les autres types de jobs, le cron et l’envoi d’événements
ne deviennent pas persistants du fait de cette image. Le producteur/outbox et
les migrations/provisioning restent les mécanismes existants, à qualifier
ensemble. Aucun appel SQL ou runner de remplacement n’est introduit.

La commande directe Bun conserve SIGTERM/SIGINT et le drainage du worker ; pas
de shell intermédiaire, serveur Next ou bootstrap de secrets cloud. Le processus
worker porte la durée de vie du conteneur. Aucun healthcheck HTTP fictif n’est
ajouté : la vie du processus ne prouve pas le traitement correct d’un job.

| Élément | Source retenue |
| --- | --- |
| Bun TS | 1.4.2, archive Linux x64 et SHA256 déjà retenus par `scripts/ci/run-linux-build.sh` |
| Node | 24.22.0-bookworm, digest `14078204b6bb268c107ceff6d3c43f45a888105e5c2b18b14c32b3409d93a1b0` déjà retenu dans cette CI |
| Sandbox | `isolated-vm` 6.2.0 et `node-gyp` 12.4.0 du verrou produit ; compilation Node avec les headers de la même image |
| Graphe | Sources Sim/workspaces natifs ; tsconfig de l’app, exports des packages, runtime CLI et bundles sandbox natifs |
| Installation | Bun `--frozen-lockfile --ignore-scripts --linker hoisted`, avec contrôle du hash du verrou avant/après |

Les deux installations séparent les outils de compilation des dépendances JS
de production. Seul le module isolated-vm compilé est repris, avec le workspace
tsconfig nécessaire à Bun. Les scripts de vérification Oracle restent ceux de
Sim. Aucun `npx`, NodeSource flottant, normalisation de lock ou build Next. Les
compilations CLI/bundles sont celles du package app, sans nouvelle dépendance.

Le profil initial de cette recette **refuse toute architecture sauf amd64**.
Ce choix borne l’archive Bun retenue ; il ne qualifie pas encore Linux amd64 et
ne remplace pas l’architecture VM Linux validée. L’hébergement Hyper-V reste à
tester séparément. La base bookworm complète contient aussi une chaîne de
compilation : empreinte, surface de vulnérabilités et réduction éventuelle du
runtime devront être mesurées avant qualification. Aucun support de média
nécessitant FFmpeg, de module natif additionnel ou de connecteur particulier
n’est déduit du seul packaging.

## Contexte avant construction

Le contexte doit provenir d’un **commit explicitement admis** : droits,
licences, sources, historique, ressources et secrets contrôlés. Ni cette recette
ni son fichier ignore ne transforment un clone amont brut contenant EE en source
autorisée. Le SHA, les rapports d’admission et le hash du verrou font partie de
la provenance privée de la campagne, sans les incorporer avec des secrets dans
l’image. Ne pas construire depuis un dossier de travail sale ou un export dont
les droits ne sont pas établis.

Après revue du candidat, préparer un dossier neuf par une archive Git du commit
figé. L’archive exclut par construction `.git` et les fichiers non suivis. La
sélection suivante ne copie ni `references`, ni `engineering`, ni le laboratoire,
ni `.scratch`. Les exclusions d’extraction retirent aussi les fichiers `.env*`,
dépendances/caches et EE avant construction. Elles constituent une défense
supplémentaire, **pas une admission de droits**.

```bash
set -euo pipefail
# ADMITTED et REV désignent le dépôt et le commit déjà contrôlés.
REV="$(git -C "$ADMITTED" rev-parse --verify "${REV}^{commit}")"
CONTEXT="$(mktemp -d "${TMPDIR:-/tmp}/memlia-worker.XXXXXXXX")"
git -C "$ADMITTED" archive "$REV" -- \
  package.json bun.lock bunfig.toml patches packages apps/sim compliance/upstream \
  deploy/memlia/images/workflow-worker.Dockerfile \
  deploy/memlia/images/workflow-worker.Dockerfile.dockerignore \
  deploy/memlia/images/tests/bun-LICENSE.md |
  tar -xf - -C "$CONTEXT" \
    --exclude='.env*' --exclude='*/.env*' --exclude='*/node_modules/*' \
    --exclude='*/.next/*' --exclude='*/.turbo/*' --exclude='*/.cache/*' \
    --exclude='*/ee' --exclude='*/ee/*' --exclude='*.pem' --exclude='*.key' \
    --exclude='*.p12' --exclude='*.pfx'
git -C "$ADMITTED" show "${REV}:bun.lock" | cmp - "$CONTEXT/bun.lock"
# Refuser tout lien ; ne pas suivre une cible hors du snapshot.
if find "$CONTEXT" -type l -print -quit | grep -q .; then
  echo 'Build context contains a symlink' >&2
  exit 1
fi
```

Conserver l’inventaire et les hashes du contexte, puis appliquer les contrôles
de contenu/secrets prévus avant tout build. Le fichier ignore dédié exclut
également environnements, clés/certificats privés, uploads, caches et tests de
la transmission Docker. Le contexte ne doit contenir aucune donnée cabinet.
Les fichiers amont de licence/notice restent copiés dans l’image, ainsi que la
notice Bun existante ; les dépendances JS gardent leurs notices installées.

**Commande à exécuter uniquement après revue de la recette et de ses bornes**,
sur un moteur Linux amd64 explicitement choisi :

```bash
docker build --platform linux/amd64 --build-arg TARGETARCH=amd64 \
  -f "$CONTEXT/deploy/memlia/images/workflow-worker.Dockerfile" \
  -t memlia/workflow-worker:p03-unqualified "$CONTEXT"
```

Le moteur, l’identité du build, les limites CPU/mémoire/PIDs/disque, les délais,
les réseaux et le nettoyage doivent être définis dans la campagne revue. Ce
bloc ne lance pas une campagne ni ne donne un budget de ressources implicite.
L’installation peut échouer si le sous-graphe workspace ne respecte pas le
verrou figé : conserver l’échec, ne pas enlever `--frozen-lockfile` pour passer.

## Configuration d’exécution après qualification

Le répertoire courant est `/app/apps/sim`, comme le web. Code et dépendances
restent root-owned ; UID/GID1001 possède seulement le répertoire `uploads`
initial. Raccorder le même volume uploads et vérifier ses droits avec le web,
sans écrire dans la couche de l’image. Prévoir racine en lecture seule, `/tmp`
temporaire borné, capabilities supprimées, `no-new-privileges`, PID/CPU/mémoire
bornés, arrêt externe borné et collecte de logs contrôlée. Le délai de drainage
et le comportement des enfants Node doivent être mesurés avec de vrais jobs.
Une expiration ou un kill n’atteste pas l’absence d’un effet : conserver l’état
incertain et la réconciliation native, sans relancer automatiquement le métier.

Configuration serveur **au runtime seulement**, par un fichier privé protégé ou
le mécanisme d’injection validé ; ne pas passer de DSN en build-arg ni afficher
`docker inspect .Config.Env` dans les preuves publiques :

- `DATABASE_URL` pour les tables métier et contrôles d’autorité ;
- `MEMLIA_DURABLE_WORKFLOWS_ENABLED=1` et `MEMLIA_PG_BOSS_ENABLED=1` ;
- `MEMLIA_PG_BOSS_DATABASE_URL` avec rôle transport distinct, sans fallback vers
  le rôle web ; schéma `memlia_jobs`/queue `memlia_native` précréés par le
  provisioning natif autorisé ;
- `TRIGGER_DEV_ENABLED` absent ou désactivé ; aucun credential Trigger/Copilot
  propriétaire requis pour sélectionner ce worker ;
- mêmes clés de chiffrement applicatives, fournisseurs/connexions et réglages
  réseau/Redis nécessaires aux workflows autorisés, après contrôle des droits.

Les variables `MEMLIA_EXCEL_HOST_SOCKET` et `MEMLIA_EXCEL_HOST_OPERATOR_UID`
restent toutes deux absentes tant que l’hôte Excel Linux n’est pas qualifié et
raccordé. Le worker existe sans cette capacité ; l’outil Excel répond alors
indisponible. Les ajouter ne confère aucune autorité utilisateur et ne dispense
pas du protocole/admission existants. Aucun socket Docker ne doit être monté
dans le worker pour contourner ce contrat.

La sélection durable ne traite actuellement que les workflows déjà admis par
le parcours natif de session. Elle n’étend pas automatiquement l’autorité aux
déclencheurs cron, API ou service accounts. Ne pas activer un mode durable
global en annonçant une compatibilité non mesurée avec ces producteurs.

## Tests accessibles et gates restantes

```bash
MEMLIA_TEST_BUN=/chemin/vers/bun-1.4.2 \
  python3 deploy/memlia/images/tests/test_workflow_worker.py -v
```

Ces tests extraient la commande et le répertoire de la recette, puis exécutent
le vrai Bun local sur des petites fixtures : alias app et exports workspace TS,
absence de chargement `.env`, échec visible par le code de sortie et réception
SIGTERM avec fin normale. Les fixtures n’importent pas le worker produit,
isolated-vm ou pg-boss et n’appellent aucun réseau. **Ce n’est pas un build ni
une qualification Linux, DB, sandbox ou drainage du moteur produit.**

Avant activation ou inscription d’un digest qualifié :

1. Construire la recette exacte Linux amd64 ; vérifier verrou intact, contenus,
   liens workspace, tsconfig, chemins natifs Node/Oracle/CLI/sandbox, UID1001,
   droits fichiers/uploads et absence de secrets dans toutes les couches.
2. Démarrer le vrai worker avec PostgreSQL/Valkey de test et rôles distincts ;
   reprendre les oracles natifs P03, puis exécuter un workflow déterministe avec
   un vrai FunctionBlock/isolated-vm dans le conteneur. Vérifier les résultats,
   les enfants et le drainage SIGTERM/SIGINT, sans simulation de ces mécanismes.
3. Mesurer arrêt forcé, livraison redondante, annulation, session révoquée et
   état incertain/reprise ; aucun second effet implicite après crash.
4. Préparer le service Compose et son contrôle de santé métier dans une tranche
   distincte, seulement après qualification ; tester stockage partagé,
   admission/outbox, producteurs réellement pris en charge et sauvegarde/reprise.
5. Réaliser SBOM, notices des couches, vulnérabilités, obligations natives des
   bases/Bun/Node/isolated-vm, provenance et signature avant toute distribution.
   Les notices présentes seules ne constituent pas une validation P15 complète.

La recette, son contexte Docker, le build, le processus produit conteneurisé et
ses opérations natives restent **NON QUALIFIÉS** tant que ces gates ne passent
pas avec leurs sources/digests exacts.

## Recette Compose durable Excel, option explicite et non qualifiée

`runtimes/excel/linux/qualification.py --durable-compose-config /run/qualification/config.json`
réemploie la recette d’isolation Excel et son hôte Unix admis. Cette option exige
`--exercise-host --exercise-application`, Linux x64 et l’opérateur root ; elle
est incompatible avec `--operator-release`. Le mode historique reste inchangé.
Le mode durable remplace son essai métier en processus : il ne l’exécute pas
une seconde fois et n’en assimile pas le résultat à celui d’un worker.

La préparation attend un commit produit propre, déjà admis pour ses droits,
notices, secrets et contenu, et les sept images exactes déjà disponibles. Le
contrôle de provenance et l’admission existants restent requis ; des labels ne
confèrent aucun droit de redistribution. La recette ne construit, ne tire et
ne publie pas ces images. Les cinq images application doivent porter les labels
`org.memlia.source` (SHA40 du candidat) et `org.memlia.lock` (SHA256 du verrou),
ajoutés par leur campagne de construction revue. Les images actuellement
dépourvues de ces labels sont refusées. Les références sont immuables avec
digest, le `RepoDigest` et l’ID d’image sont relus ; le worker doit conserver sa
commande et son utilisateur natifs. Aucun de ces prérequis n’est réputé acquis
par les tests à doubles.

La configuration JSON administrateur suit `memlia.excel-durable-qualification/v1` :

| Champ | Valeur exigée |
| --- | --- |
| `sourceCommit`, `lockSha256` | SHA40 du candidat propre et SHA256 de son `bun.lock` |
| `nonce` | 32 caractères hexadécimaux nouveaux ; namespace dédié `memlia-excel-durable-<nonce>` |
| `envFile` | Chemin absolu du fichier Compose privé, sans clés IA pour cet essai déterministe |
| `bootstrapFile` | Chemin absolu de la configuration du bootstrap produit, jamais des commandes SQL arbitraires |
| `images` | `web`, `realtime`, `migrations`, `cron`, `workflow-worker`, `db`, `redis` ; chaque entrée contient `reference` et `imageId` ; les cinq premières comportent aussi `sourceCommit` et `lockSha256` |
| `browser` | `node`, `chromium`, `certutil`, `ca` ; chaque entrée contient un chemin absolu et son SHA256 |
| `journey` (facultatif) | Uniquement `inactive-test` pour la variante décrite ci-dessous ; absent pour le parcours historique |

Le champ de version s’appelle `schemaVersion`. Les autres champs ou services
sont refusés. Les fichiers de configuration et la CA sont root-owned, 0400/0600,
sans lien ni ancêtre accessible en écriture ; les exécutables sont root-owned
et non modifiables par groupe/autres. Le contrôle ne transporte aucune clé
privée TLS. Utiliser un environnement de qualification dédié, avec UID/GID1001
disponible et moteur Docker rootful ; ne pas utiliser de données cabinet.

Le fichier bootstrap suit `memlia.database-bootstrap/v1`, avec le même nonce,
la base `memlia_ui_<nonce>`, cinq rôles distincts `ui_<purpose>_<nonce>` pour
`migrate`, `web`, `realtime`, `worker`, `transport`, les mots de passe distincts
exigés par le bootstrap et l’hôte privé `database:5432`. Sa configuration est
recopiée dans un répertoire neuf 0700 et montée en lecture seule sous
`/run/memlia` ; son état durable 0700 est conservé sous
`/run/memlia-bootstrap/state` dans un volume propre au namespace. Les étapes
produit `prepare`, migrations natives, `grants`, `verify` restent distinctes.
Le bootstrap doit être inclus dans l’image migrations du candidat. La recette
refuse une base, un volume ou un namespace existants ; elle ne répare pas leurs
droits et ne reprend pas aveuglément une préparation inconnue.

Un reverse proxy HTTPS de laboratoire doit déjà desservir l’origine
`https://localhost[:port]` configurée, avec routage web/realtime tel que décrit
dans le README du déploiement. Cette recette n’installe ni ne reconfigure de
proxy. La CA de test est vérifiée puis ajoutée uniquement à la base NSS d’un
HOME/profil Chromium temporaire appartenant à UID1001. Le système hôte n’est
pas modifié ; aucune option `ignoreHTTPSErrors`, confiance globale ou connexion
HTTP de substitution n’est utilisée. Le proxy, les certificats et les outils
doivent être disponibles et admis avant un véritable essai.
Chromium résout `localhost` vers127.0.0.1 pour cet essai ; le proxy doit transmettre
son adresse cliente avec `X-Forwarded-For $remote_addr`, comme l’exemple existant.
`AUTH_TRUSTED_PROXIES` reste vide dans ce namespace de qualification pour ne pas
traiter l’unique adresse cliente comme un relais. Le cleanup ne peut retirer
que les deux représentations attendues du bucket socket loopback, avec les
gardes de fraîcheur et de version natives. Un autre chemin réseau est refusé
ou laisse la baseline en échec ; il n’élargit pas la suppression.

Le parcours exécute ensuite :

1. Oracle de schéma contre les exports Drizzle et le ledger natif
   `script_migrations`, puis comparaison de **chaque** hash et timestamp du
   journal des migrations, sans nombre de tables codé pour le nouveau candidat.
   Le ledger scripts est comparé au registre natif (supersessions comprises).
   Les deux ledgers sont relus avec le rôle migration avant/après le parcours,
   avec comparaison de leurs digests. La baseline et les contrôles CAS métier
   sont conservés sans donner au web des droits sur les ledgers.
2. Compte fictif, upload et graphe via les mécanismes natifs existants. Seuls
   deux scripts de recette sont montés sous `/app/scripts/ci` ; sources,
   dépendances et alias sont ceux de l’image exacte, sans `node_modules` hôte.
3. Connexion de session depuis Chromium, déploiement explicite par la route
   native, puis `POST /api/workflows/<id>/execute` avec mode async et réponse202.
   Aucun contrôle draft, clé API ou principal fabriqué ne sert à cette admission.
4. Fermeture vérifiée du navigateur **et de son groupe de processus** avant le
   démarrage du worker. L’outbox native publie la livraison ; aucun job, claim,
   snapshot ou résultat métier n’est inséré par SQL de recette.
5. Worker Compose UID1001, racine en lecture seule, limites4Gio/2CPU/256PIDs,
   socket Excel protégé et uploads partagés ; rôle métier et rôle transport
   distincts. Le transport ne lit pas les tables métier. Résultat et livraison
   acquittée sont relus, avec une tentative native et un seul journal d’exécution.
6. Téléchargement du fichier enregistré et comparaison du même contenu XLSX,
   contrôles d’accès négatifs et source inchangée ; drainage SIGTERM observé,
   puis retrait CAS des seules lignes de recette terminales, suppression native
   du compte, comparaison de la baseline et nettoyage des ressources possédées.

Préparation, métier, drainage et nettoyage sont observés séparément. Les
réponses et erreurs bornées sont gardées dans des fichiers privés avant
projection, y compris sur refus HTTP ou erreur native. Les identifiants,
credentials, captures et classeurs ne doivent pas être publiés. Une admission
perdue ou un nettoyage inconnu garde les volumes/base/queue et le diagnostic
pour réconciliation ; aucun `compose down -v`, balayage de namespace ou rejeu
métier automatique. Un nettoyage échoué empêche le verdict global même si le
fichier métier a été vérifié.

Les tests portables associés vérifient les contrats, les refus, le montage du
bootstrap, l’ordre navigateur/worker et le nettoyage avec les frontières IO
doublées. **Compose, TLS/Chromium, le worker réel, les images, la base nouvelle
et le parcours Excel durable restent NON TESTÉS nativement dans cette tranche.**
Ces tests ne remplacent pas la qualification Windows/Excel Desktop, Hyper-V,
les scénarios crash/reprise/concurrence ni la checklist commerciale.


### Variante de test préparé inactif — non qualifiée

La même configuration peut porter uniquement le champ optionnel
`"journey": "inactive-test"`. Son absence conserve le parcours durable historique
avec déploiement. Cette variante utilise le même lanceur, les mêmes images
admises, rôles, CA/NSS isolé, hôte Excel et contrôles de ressources ; elle n’ajoute
aucun runner, bypass TLS ou couche d’exécution. Les scripts publics de lancement
CI ne sélectionnent pas encore ce champ : le raccord de leur option CLI attend
la coordination de leur propriétaire.

Le navigateur utilise le profil existant `--inactive-test` : session réelle,
observation de la révision et du digest, opération de préparation stable,
version `excel_test_v1` inactive, puis POST de test et reçu202 avec ID
stable. Aucun déploiement ni activation n’est demandé. La recette relit les
captures privées bornées `test-observe`, `test-identities`, `test-prepare` et
`test-enqueue` avant de démarrer le worker. Un reçu final seul ne suffit pas ;
une capture ambiguë ou une fermeture de groupe non confirmée bloque le démarrage.
L’identifiant `workflow-execution:<executionId>` est d’abord **dérivé attendu**
(`jobIdSource=derived_expected`), puis comparé aux véritables lignes de queue.
Il n’est jamais présenté comme un ID déjà observé avant cette lecture.

Après fermeture du navigateur et publication native, le worker existant traite
le test. Les observations privées précèdent leur projection : payload humain
et `excelTestExecution` identiques au binding admis, exécution asynchrone avec
contrôles de credentials, version inactive/propriétaire/digest du graphe,
`workflow_execution_logs.deployment_version_id` exact, fichier d’exécution
propriétaire sous le préfixe de ce même run. Le téléchargement natif doit rendre
les mêmes octets que le fichier enregistré et l’oracle XLSX indépendant reste
inchangé. Le résultat porte le scope distinct
`native_inactive_test_compose` et les gardes `payloadBound`,
`journalVersionBound`, `resultFileBound` et `versionInactive`. Il ne prouve ni
lecture humaine ni justesse d’une règle métier arbitraire. Aucun résultat
n’active la version.

Après drainage confirmé, le nettoyage vérifie de nouveau la préparation native,
puis verrouille ses lignes exactes avec celles du run. Il ne retire la clé
`excel-test-preparation:<digest(scope,acteur)>:<operationId>` qu’après vérification
du fingerprint, du résultat `completed`, du reçu exact, du propriétaire, de la
version inactive et du digest de son état. Sa suppression utilise `xmin` et
`md5(row_to_json(...))` dans la même transaction que le nettoyage ciblé du run.
Aucune suppression par préfixe, reprise de test ou activation implicite. Une
ambiguïté conserve les ressources et les preuves pour diagnostic.

Les tests portables avec doubles vérifient ces gardes et l’oracle Python/XLSX ;
ils ne qualifient pas PostgreSQL, les images, le navigateur, le vrai worker ou
une installation cabinet. **La variante reste NON TESTÉE sur Linux réel**
jusqu’à un essai unique sur les sources/images exactes admises. Les reçus
historiques durables, en processus et Office09 conservent leur périmètre propre.
La reprise d’une préparation après rechargement de la page reste un chantier
produit distinct.
