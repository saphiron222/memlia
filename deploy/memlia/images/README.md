# Images Linux — migrations et cron

Recettes privées adaptées des Dockerfiles Sim admis, à construire depuis un
snapshot déjà contrôlé. Elles ne changent aucun manifeste, verrou ou script de
migration du produit. La licence de nos ajouts reste à décider ; aucune
publication d’image n’est autorisée par cette tranche.

## Périmètre et mécanismes conservés

- **Migrations** : Bun 1.4.2, le runner `packages/db/scripts/migrate.ts`, ses SQL,
  son journal Drizzle et ses migrations de données natifs. La commande lance le
  même runner que `db:migrate`, avec `--no-env-file` : les DSN sont fournis
  uniquement à l’exécution. Aucun accès DB ni DSN de remplacement au build.
  Le CLI séparé [`database-bootstrap.ts`](../database-bootstrap.ts) est aussi
  copié pour le provisioning initial des cinq rôles et de la base vide ; il ne
  remplace pas le runner. Son autorité, ses phases et le journal durable sont
  décrits dans [`DATABASE_BOOTSTRAP.md`](../DATABASE_BOOTSTRAP.md). Le build
  arm64 historique ci-dessous précède cet ajout et ne le qualifie pas.
- **Cron** : Supercronic v0.2.33 et `docker/cron-entrypoint.sh` natifs. Le crontab
  est celui de `deploy/memlia/crontab`, déjà filtré des routes EE/Cloud. Sans
  `CRON_SECRET`, l’entrypoint natif affiche que les tâches sont désactivées et
  sort avec le code 0. Les appels métier demandent ensuite le web et la même
  valeur de `CRON_SECRET` sur les deux services.
- UID/GID `1001:1001`, sources et dépendances non modifiables par cet utilisateur.
  Les deux images fonctionnent avec racine en lecture seule, `/tmp` temporaire,
  sans capabilities et avec `no-new-privileges`.
- Cette tranche ne raccorde pas le worker durable. Les gates décrites dans le
  README Compose restent bloquantes. Elle ne construit ni web ni temps réel.
  Aucun déploiement client ni publication au registre.

## Préparer des contextes propres

Depuis ce dossier, définir `SOURCE` vers le snapshot **admis** de Sim et `WORK`
vers un nouveau dossier privé hors Git. Le préparateur ne remplace pas les
contrôles d’admission ou un scanner de secrets. Python 3 et curl sont requis.

```sh
SOURCE_COMMIT=$(git -C "$SOURCE" rev-parse HEAD)
LOCK_SHA256=$(shasum -a 256 "$SOURCE/bun.lock" | cut -d ' ' -f 1)
python3 tests/prepare_context.py migrations --source "$SOURCE" --source-commit "$SOURCE_COMMIT" --output "$WORK/migrations"
python3 tests/fetch_cron_assets.py "$WORK/assets" --architecture amd64
python3 tests/prepare_context.py cron --source "$SOURCE" --source-commit "$SOURCE_COMMIT" --architecture amd64 --assets "$WORK/assets" --output "$WORK/cron"
```

Les sorties doivent être absentes : aucun écrasement. Le contexte migrations
sélectionne les quatre packages natifs db/logger/utils/tsconfig, les manifestes
racine, le verrou et les patches. Les snapshots de génération Drizzle sont
omis ; son moteur lit les SQL et `meta/_journal.json`, qui sont conservés. Les
fichiers cachés, `.git`, `.env*`, caches, dépendances déjà installées, archives et
certificats privés n’entrent pas dans ces copies. Les liens symboliques dans les
sources sélectionnées sont refusés. Chaque contexte contient un inventaire SHA256.

L’installation Linux conserve le verrou produit byte pour byte :
`bun install --filter @sim/db --production --frozen-lockfile --ignore-scripts --linker hoisted`.
Bun 1.4.2 accepte ici les workspaces absents et installe 48 paquets, y compris
les peer dependencies sélectionnées par son résolveur. Aucun verrou réduit
réécrit ni installation des dépendances web. Le fichier de verrou est aussi
vérifié par SHA256 après installation dans la recette.

Les assets cron sont téléchargés depuis GitHub, le CDN Alpine et le proxy Go
public avec TLS vérifié. Le binaire et les métadonnées Supercronic sont figés par
SHA256 ; les 19 paquets Alpine le sont par nom et SHA256 dans `tests/cron-apk.sha256`
(arm64) et `tests/cron-apk-amd64.sha256` (amd64), rafraîchis seulement par la
procédure explicite décrite plus bas. Les archives
des 16 modules détectés dans le binaire sont vérifiées contre leurs checksums
Go h1 ; leurs 30 fichiers de licence/notice et leurs métadonnées sont conservés.
Le build vérifie à nouveau le binaire et les APK. `apk` vérifie aussi les
signatures officielles des paquets, sans `--allow-untrusted`.

## Provenance obligatoire des cinq images

Les recettes app, realtime, migrations, cron et workflow-worker demandent
`MEMLIA_SOURCE_COMMIT` (40 caractères hexadécimaux minuscules) et
`MEMLIA_LOCK_SHA256` (64). Elles refusent les arguments absents, malformés ou
incohérents avec `build-provenance` et le vrai `bun.lock` du contexte, avant
installation. Leurs stages finaux portent `org.memlia.source` et `org.memlia.lock`.
Ces étiquettes sont des identités déclarées, jamais une admission, une preuve de
licence, un digest d'image ou une qualification d'exécution à elles seules.

Le préparateur exige HEAD exact et fichiers suivis propres, puis compare chaque
source copiée au blob Git du commit. Un fichier sélectionné non suivi, modifié ou
symbolique est refusé. Les recettes doivent appartenir au même snapshot. Les
modes `app`, `realtime` et `workflow-worker` réemploient cette préparation ; les
deux premiers conservent aussi `turbo.json`. Le verrou étiqueté reste le verrou
d'origine ; la réduction/normalisation historique du verrou dans les stages
web/realtime n'est pas présentée comme une installation du verrou intégral.
Le helper CI `scripts/ci/workflow-worker-image.py` conserve son archive Git
vérifiée et son superviseur, réemploie le même writer de métadonnées et contrôle
les deux labels sur l'image obtenue.

Cron sélectionne explicitement arm64 ou amd64. Les deux verrous portent les mêmes
19 noms de paquets, chacun avec ses empreintes propres à l'architecture.
Supercronic reste v0.2.33 : le binaire amd64 correspond au SHA1 officiel
`71b0d58cc53f6bd72cf2f293e09e294b79c666d8`, puis au SHA256
`feefa310da569c81b99e1027b86b27b51e6ee9ab647747b49099645120cfc671`.
Les signatures des APK sont vérifiées au rafraîchissement du verrou (ci-dessous)
et `apk` les vérifie encore au build. Les sommes Go h1 des 16 modules et leurs
licences sont vérifiées par le même fetcher.
Sources : [publication Supercronic](https://github.com/aptible/supercronic/releases/tag/v0.2.33),
clés Alpine [x86_64](https://alpinelinux.org/keys/alpine-devel@lists.alpinelinux.org-6165ee59.rsa.pub)
et [aarch64](https://alpinelinux.org/keys/alpine-devel@lists.alpinelinux.org-616ae350.rsa.pub).

### Rafraîchir le verrou APK du cron

Alpine retire de `v3.24/main` les versions remplacées d'un paquet : tout verrou de
version finit par pointer vers un fichier supprimé. Observation ponctuelle du
22/10/2026, à ne pas généraliser : depuis la VM de build OVH (GRA11),
`ca-certificates-20260909-r0.apk` a répondu 404 à 4 requêtes sur 5, et 200 à la
cinquième. Le même jour, ce fichier répondait encore 200 depuis le Mac et lors de
la revue à 8 h 20. Ces réponses divergent selon le cache du CDN interrogé. L'index
signé, lui, ne publiait plus que `20261020-r0`. Le CI télécharge les assets à
chaque exécution : il échouera dès qu'il tombera sur un nœud purgé. Les APK ne
sont ni copiés dans ce dépôt public ni servis par un miroir à nous : des binaires
GPL comme busybox imposent alors une offre de sources, hors de ce périmètre.

Le fetch du build ne résout jamais de version : il télécharge exactement ce que
nomme le verrou et refuse un SHA256 divergent. Un paquet retiré (HTTP 404/410)
le fait échouer avec le nom du fichier et la commande à lancer. Le
rafraîchissement est une étape de maintenance distincte, lancée depuis la racine
du dépôt avec curl et Python 3 :

```sh
python3 deploy/memlia/images/tests/fetch_cron_assets.py --refresh-lock --architecture amd64
python3 deploy/memlia/images/tests/fetch_cron_assets.py --refresh-lock --architecture arm64
```

Pour chaque architecture, l'outil télécharge `APKINDEX.tar.gz` et vérifie sa
signature RSA avec la seule clé Alpine embarquée dans `fetch_cron_assets.py`
(6165ee59 pour x86_64, 616ae350 pour aarch64). Ces fichiers sont identiques, à
l'octet, sur alpinelinux.org/keys, dans `main/alpine-keys` d'aports 3.24-stable et
dans `/etc/apk/keys` de la base `alpine:3.24.2` épinglée par digest. Il refuse
alors une autre clé, une signature invalide, un index tronqué ou suivi de données
non signées, une entrée dupliquée ou d'une autre architecture. Il résout ensuite
les mêmes 19 noms à leur version courante et refuse un nom absent de l'index ou
une dépendance non fournie par l'ensemble verrouillé. Il refuse aussi toute
version inférieure à celle du verrou, comparée selon l'ordre d'apk pour les
formes utilisées (`1.37.0-r31`, `20261020-r0`, `2026e-r0`, suffixes `_rc`, `_git`,
`_p`). Une autre forme est refusée plutôt que devinée. Un index périmé mais
signé, servi par un cache, ne peut donc pas faire régresser un paquet. Chaque
APK est enfin contrôlé contre l'index : taille `S:`, hash `C:` du segment de
contrôle, signature du paquet par la même clé, nom et version de `.PKGINFO`,
`datahash` du segment de données. Le verrou n'est réécrit, trié, synchronisé sur
disque puis remplacé de façon atomique, qu'après tous ces contrôles ; tout refus
le laisse intact. L'outil affiche l'empreinte de l'index et chaque changement
avec son sens (`(upgrade)`). Une même version avec de nouveaux octets est
signalée, car elle demande une revue.

Relire ensuite le diff des deux verrous et le committer. `apk add --no-network`
reste l'arbitre final au build : un verrou rafraîchi n'est qualifié qu'après un
nouveau build et ses smoke tests.

Rafraîchissement du 22/10/2026 (index `v3.24.3-4-g83133521279`, SHA256
`6d1d7b0e…22e4` pour x86_64 et `9d6e669a…4ab8` pour aarch64). Cinq versions
changent sur les deux architectures : brotli-libs 1.2.0-r1 → 1.2.1-r0, c-ares
1.34.8-r0 → 1.34.9-r0, ca-certificates et ca-certificates-bundle 20260909-r0 →
20261020-r0, musl 1.2.6-r2 → 1.2.6-r3. Les 14 autres paquets gardent leurs
empreintes. Ces verrous rafraîchis n'ont encore été qualifiés par aucun build.

Ces contrôles de préparation ne qualifient aucun nouveau build Docker. Les
résultats arm64 historiques ci-dessous restent attribués à leurs anciennes sources.

## Construire

Configurer explicitement le moteur Linux voulu. Dans le laboratoire qualifié :

```sh
export DOCKER_CONFIG=/Users/kevinkitanga/.colima/memlia/docker-client
export DOCKER_HOST=unix:///Users/kevinkitanga/.colima/memlia/docker.sock
export DOCKER_BIN=/opt/homebrew/bin/docker
"$DOCKER_BIN" --config "$DOCKER_CONFIG" --host "$DOCKER_HOST" build \
  --platform linux/amd64 --memory 512m --force-rm \
  --build-arg MEMLIA_SOURCE_COMMIT="$SOURCE_COMMIT" --build-arg MEMLIA_LOCK_SHA256="$LOCK_SHA256" \
  -t memlia/migrations:p03-local "$WORK/migrations"
"$DOCKER_BIN" --config "$DOCKER_CONFIG" --host "$DOCKER_HOST" build \
  --platform linux/amd64 --build-arg TARGETARCH=amd64 --network none \
  --build-arg MEMLIA_SOURCE_COMMIT="$SOURCE_COMMIT" --build-arg MEMLIA_LOCK_SHA256="$LOCK_SHA256" \
  --memory 256m --force-rm -t memlia/cron:p03-local "$WORK/cron"
```

Le profil local utilise le builder Engine classique : aucun plugin Buildx
n’a été ajouté. Le paramètre `TARGETARCH` explicite couvre ce builder ; le cron
refuse une autre architecture. Les bases sont les images officielles :

| Base | Digest figé |
| --- | --- |
| `oven/bun:1.4.2-alpine` | `sha256:d888c0ae6c86d7866ff10c5aafdd9077b36aee6455b33dd270fb93c0dd5cef6f` |
| `alpine:3.24.2` | `sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6` |

La base cron passe du tag amont Alpine 3.21 à la base Alpine 3.24.2 figée et
qualifiée localement. Les paquets restent natifs (curl, certificats CA, tzdata et
leur fermeture de dépendances). Les URL de paquets disparaissent quand Alpine
publie une nouvelle version : ne jamais remplacer une version ou un hash à la
main, passer par le rafraîchissement vérifié décrit plus haut. Les tags `p03-local` servent au
laboratoire ; un artefact de livraison devra être référencé par digest après
les gates de publication. L’égalité bit à bit de deux builds n’est pas qualifiée.

## Vérifications

```sh
python3 -m unittest discover -s tests -v
MEMLIA_IMAGE_SMOKE=1 python3 -m unittest discover -s tests -v
```

La première commande tourne hors réseau. `tests/test_cron_apk_lock.py` signe ses
index et paquets fictifs avec des clés RSA générées par le CLI `openssl`, requis
par cette suite : il sert d'implémentation indépendante du vérificateur testé.

La seconde commande requiert `DOCKER_CONFIG`, `DOCKER_HOST` et les deux images
locales. Elle teste des conteneurs isolés sans réseau : manque de configuration,
UID/architecture, racine en lecture seule, lecture des notices, validation du
crontab, démarrage et arrêt gracieux. Elle supprime uniquement ses propres
conteneurs et vérifie leur absence. Elle n’applique aucune migration.

L’application des migrations est une action séparée, réservée à une DB dédiée
approuvée : DSN direct non poolé, compte propriétaire de schéma sans rôle
administrateur et extension vector préparée. Passer un fichier privé `0600` par
`--env-file` au **runtime**, jamais au build, avec `MIGRATION_DATABASE_URL` et
`DATABASE_URL`. Ne pas exposer les logs de diagnostics sans les contrôler : le
runner natif peut afficher des valeurs de requête lors d’une erreur. Réutiliser
les bornes/locks natifs et une limite externe d’opération adaptée au volume réel.

Qualification réalisée le 19 octobre 2026 : Linux arm64 Colima, build migration
154,685 s ; application fraîche 1,922 s (25 migrations de données), deuxième
passage 0,174 s sans migration en attente. Ces durées concernent une base vide
du laboratoire, pas une garantie pour les données d’un cabinet.

## Provenance, licences et gates restantes

Les notices Sim Apache-2.0 sont dans `/usr/share/licenses/sim`. La notice
[Bun 1.4.2](https://github.com/oven-sh/bun/blob/bun-v1.4.2/LICENSE.md)
est conservée dans `tests/bun-LICENSE.md` et `/usr/share/licenses/bun`
(SHA256 `b9caf52728691b4057e371232c221a132883198be2f3d2ddf92c90404c984b1a`). Les paquets JS
conservent leurs fichiers de licence et `package.json` ; les métadonnées APK
restent dans la base. Supercronic est MIT, ses notices et celles de ses modules
sont dans `/usr/share/licenses/supercronic`. Le binaire amont contient du code de
client Sentry, mais aucun DSN Sentry n’est configuré dans ces recettes ou dans
le profil Compose. Ne pas activer de télémétrie cloud.

Sources officielles : [Bun install](https://bun.sh/docs/pm/cli/install),
[Supercronic v0.2.33](https://github.com/aptible/supercronic/releases/tag/v0.2.33),
[licence Supercronic figée](https://github.com/aptible/supercronic/blob/cca6b3a90abc99a024f4b437da0f1886da68ca7a/LICENSE.md),
[paquets Alpine](https://pkgs.alpinelinux.org/packages).

P15 reste bloquant avant redistribution : SBOM complet des couches finales,
analyse des vulnérabilités, notices et obligations des composants natifs
(notamment sources/offres requises par les licences GPL/LGPL des bases),
vérification de la licence de Bun et de ses bibliothèques embarquées, signature
et provenance des images publiables. L’inventaire de cette tranche ne vaut pas
validation juridique complète. amd64, Hyper-V, callbacks cron vers le web,
workflow navigateur et reprise d’un worker durable : **NON TESTÉS**.

## CI manuelle du parcours Excel durable

Le workflow existant `memlia-excel-linux.yml` propose désormais l'entrée
`exercise_durable`. Elle sélectionne un seul job public standard Ubuntu24.04,
à partir du SHA exact déjà admis ; elle ne double pas le job historique ni ses
huit cas. L'opérateur déclenche cette entrée seulement après revue/publication
du candidat. Aucune image n'est envoyée à un registre externe.

`scripts/ci/excel-durable-ci.py` réemploie le préparateur de contextes, le fetcher
cron, le collecteur `owned_client` et `qualification.py --durable-compose-config`.
Il construit séquentiellement les cinq recettes existantes dans un BuildKit
possédé (13Gio RAM +24Gio swap possédé,4CPU,512PIDs, parallélisme1), puis les pousse uniquement
au registre temporaire lié à127.0.0.1:15000. Les vrais RepoDigests, IDs, labels
source/verrou et architecture sont relus après pull par digest. Ce registre
Distribution3.0.0 est épinglé par digest ; il est réservé au runner éphémère,
sans login ni changement de configuration du daemon. Les labels seuls ne
remplacent ni les gates d'admission ni les obligations de licence.

Le job prépare Node24.22.0, Bun1.4.2 vérifié, Playwright1.61.1 depuis le verrou
produit et Chromium correspondant. Les paquets Ubuntu signés nginx/NSS sont
préparés séparément ; leur installation ne doit pas démarrer un service système
(`policy-rc.d` temporaire créé exclusivement et retiré par identité/contenu).
Un proxy nginx possédé sert seulement https://localhost:18443 ; son certificat
fictif neuf ne quitte pas le runner. La confiance navigateur utilise le NSS
privé UID1001 de la recette, jamais le magasin système ni ignoreHTTPSErrors.
La configuration de bootstrap contient cinq rôles distincts et des secrets
fictifs neufs, root-owned0400/0600 dans un parent0700. Aucun fournisseur n'est
configuré. Les exécutables et dépendances non secrets sont lisibles par UID1001.

La recette native conserve ses étapes : isolation Excel, admission du host,
bootstrap/migrations/grants, vraie session navigateur et déploiement, async202,
fermeture du navigateur, worker Compose UID1001, readbackDB/XLSX, drainage puis
CAS et nettoyage. Le raccord ne modifie pas ses oracles. Un résultat inconnu
retient les données possédées ; aucun `compose down -v` ou prune global.
Les clients, le builder, le proxy et le registre sont fermés par identité ; les
images/caches et preuves restent dans le disque éphémère, sans artefact public.
Seul un verdict à champs fermés est imprimé. Les logs et erreurs sont privés
avant analyse, avec des plafonds par client et un budget global150minutes.
Le swap disque24Gio réemploie `linux-swap-host.py`/OwnedSwap, sans modifier le
swap préexistant. Les phases typegen puis TSC **complet non incrémental** passent
avant les cinq builds, avec les métriques/cgroups natifs (13Gio RAM,24Gio swap,
4CPU,512PIDs,1800s par phase). Leurs diagnostics privés sont capturés avant
analyse ; `ignoreBuildErrors` dans Next ne constitue jamais un typage acquis.
Le contexte Docker n’inclut pas les dépendances/générés host. Les deux phases
réussies sont requises ; aucun build/qualification après leur refus.
La réserve CI12Gio est contrôlée avant et pendant les opérations ; la réserve
locale Mac40Gio reste distincte et n'est pas réduite par ce job.

**Docker/Compose/TLS/Linux réels NON TESTÉS par les tests de préparation.**
Aucun succès de build, de navigateur ou de worker durable n'est acquis avant
l'exécution de ce nouveau job sur le candidat exact. Il ne qualifie pas Office
Desktop, la rotation des clés, les scénarios crash/reprise ni un déploiement
client. Distribution : <https://distribution.github.io/distribution/about/deploying/>.
