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
python3 tests/prepare_context.py migrations --source "$SOURCE" --output "$WORK/migrations"
python3 tests/fetch_cron_assets.py "$WORK/assets"
python3 tests/prepare_context.py cron --source "$SOURCE" --assets "$WORK/assets" --output "$WORK/cron"
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
SHA256 ; les 19 paquets Alpine le sont dans `tests/cron-apk.sha256`. Les archives
des 16 modules détectés dans le binaire sont vérifiées contre leurs checksums
Go h1 ; leurs 30 fichiers de licence/notice et leurs métadonnées sont conservés.
Le build vérifie à nouveau le binaire et les APK. `apk` vérifie aussi les
signatures officielles des paquets, sans `--allow-untrusted`.

## Construire

Configurer explicitement le moteur Linux voulu. Dans le laboratoire qualifié :

```sh
export DOCKER_CONFIG=/Users/kevinkitanga/.colima/memlia/docker-client
export DOCKER_HOST=unix:///Users/kevinkitanga/.colima/memlia/docker.sock
export DOCKER_BIN=/opt/homebrew/bin/docker
"$DOCKER_BIN" --config "$DOCKER_CONFIG" --host "$DOCKER_HOST" build \
  --platform linux/arm64 --memory 512m --force-rm \
  -t memlia/migrations:p03-local "$WORK/migrations"
"$DOCKER_BIN" --config "$DOCKER_CONFIG" --host "$DOCKER_HOST" build \
  --platform linux/arm64 --build-arg TARGETARCH=arm64 --network none \
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
leur fermeture de dépendances). Les URL de paquets peuvent un jour disparaître :
conserver le cache d’assets vérifié pour reconstruire ; ne pas remplacer
silencieusement une version ou un hash. Les tags `p03-local` servent au
laboratoire ; un artefact de livraison devra être référencé par digest après
les gates de publication. L’égalité bit à bit de deux builds n’est pas qualifiée.

## Vérifications

```sh
python3 -m unittest discover -s tests -v
MEMLIA_IMAGE_SMOKE=1 python3 -m unittest discover -s tests -v
```

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
