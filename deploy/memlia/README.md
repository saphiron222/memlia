# Profil Linux Docker Compose Memlia — fondation P03

Ce profil réemploie le Compose de production, les Dockerfiles, les routes et le
cron de Sim `c6cef5f87b6a1d1d01df89e7140bad9e9fd4c2e2` (Apache-2.0 hors EE).
Il prépare la cible finale : une VM Linux dédiée par cabinet, avec le même
fichier sur hôte Linux ou Windows Server Hyper-V. **Ce n'est pas encore un
profil commercial opérationnel.** Les images propres, les migrations produit,
le stockage applicatif et le worker doivent franchir les gates ci-dessous.
Hyper-V et Ubuntu 24.04 amd64 ne sont pas qualifiés par les essais Linux arm64
du laboratoire. Aucun déploiement client n'a été effectué.

## Conditions bloquantes avant démarrage applicatif

1. Construire les quatre images Memlia de **la même révision admise P01**, à
   partir des Dockerfiles Sim `docker/{app,realtime,db,cron}.Dockerfile` adaptés
   et revus. Scanner sources, dépendances, couches et artefacts ; conserver
   licences/notices/SBOM. Ne pas construire à partir du clone de référence brut,
   ni remplacer les champs vides par des images `simstudioai`. Les sources
   filtrées et les images ne sont pas livrées par ce dossier. Fixer aussi les
   images de build et dépendances système avant qualification reproductible.
2. Raccorder `JobQueueBackend`, admission/outbox, registre exhaustif et point
   d'entrée durable du worker. Le transport pg-boss seul ne suffit pas. **Aucun
   service worker ni commande inventée n'est déclaré ici.** Ajouter ensuite un
   service utilisant le code/image admis, les mêmes connexions et le volume
   `uploads`, avec un répertoire de travail aligné sur le serveur web
   (`/app/apps/sim`), puis qualifier arrêt/reprise/annulation et effets incertains.
   Un workflow long ne peut pas être annoncé persistant avec cette seule tranche.
3. Provisionner des rôles PostgreSQL distincts web, realtime, propriétaire de
   schéma et futur worker. Appliquer les droits requis, pgvector et les migrations
   admises par le parcours de provisioning/migration revu. Les trois URL sont
   obligatoires et indépendantes ; Compose ne crée pas ces rôles et ne vérifie
   pas leurs droits. Ne pas utiliser le compte administrateur pour les apps.
   `POSTGRES_PASSWORD` initialise seulement le volume neuf ; le changer dans
   `.env` ne change pas le mot de passe d'une base existante.
4. Préparer `/app/apps/sim/uploads` dans l'image avec propriétaire `1001:1001`,
   avant `USER nextjs`, puis tester création/lecture/restauration en UID 1001.
   Le provider local utilise `process.cwd()/uploads` ; Next standalone change
   le répertoire courant vers celui de `server.js`. Un volume neuf hérite du
   répertoire de l'image ; l'upstream ne le prépare pas. Ne pas masquer cette
   erreur par un lancement du web en root. Les volumes existants nécessitent
   une vérification des droits et une migration contrôlée.
5. Construire avec la véritable origine HTTPS du cabinet et les réglages
   publics PostHog désactivés. `NEXT_PUBLIC_*` peut être incorporé au build :
   changer uniquement les variables du conteneur n'est pas une preuve. Vérifier
   le navigateur et l'absence d'appels PostHog/Sentry/telemetry cloud sur l'image
   finale. `NEXT_TELEMETRY_DISABLED=1` désactive aussi l'export OTel amont ;
   `DO_NOT_TRACK=1` et `SIM_TELEMETRY_DISABLED=1` couvrent le CLI réemployé.
6. Configurer et tester TLS, WebSocket, cookies, fichiers, cron, fournisseurs,
   sauvegarde/restauration et budgets via le produit réel. Les defaults
   `MAX_TOOL_ITERATIONS=20` et timeouts 900 s sont explicites ; les budgets Chat
   et l'admission sont des contrôles applicatifs séparés, pas des garanties Compose.

## Configuration et réemploi

Docker Engine Linux et le plugin Compose sont requis ; les versions exactes
sont à figer à la qualification. Les essais locaux ont utilisé Compose 5.5.1. Ne pas forcer `platform: linux/amd64` sur le labo arm64 :
la qualification amd64 reste séparée. Aucune architecture Windows native n'est
ajoutée.

Copier `.env.example` vers `.env`, mode `0600`, remplir les secrets aléatoires et
les quatre digests vérifiés. `.env`, `.env.*`, certificats et clés privées sont
ignorés par la racine du produit ; seul `.env.example` est publié. Conserver les
certificats du cabinet et sauvegardes hors dépôt. La configuration résolue
contient les secrets : ne jamais la journaliser ni la publier. Le profil passe
chaque variable explicitement, sans injecter tout `.env` dans chaque service.

```sh
chmod 600 deploy/memlia/.env
docker compose --env-file deploy/memlia/.env -p memlia-cabinet \
  -f deploy/memlia/compose.yaml config --quiet
```

Chaque référence applicative est `${MEMLIA_IMAGE_PREFIX}/web@sha256:…` (idem
`realtime`, `migrations`, `cron`). Renseigner les digests ensemble depuis le
manifeste d'une seule release. Le préfixe est le registre/espace Memlia choisi
par l'exploitation. Aucun `latest`, serveur propriétaire Copilot, Trigger.dev,
MinIO obligatoire ou nouveau scheduler n'est ajouté.

Le service nommé `redis` conserve les URL natives `redis://redis:6379` mais
exécute Valkey 8.1.10-alpine. Son manifeste est
`sha256:081c2f5cb575efc901aa80ff9cdbd1ec6a301682fd35e1ebb4b0990a4a4a8507`.
[Source et licence BSD-3-Clause](https://github.com/valkey-io/valkey/blob/55a542671762eaddff979f78dc6a3d1414ce1d75/COPYING),
[distribution officielle](https://hub.docker.com/r/valkey/valkey).
PostgreSQL 17/pgvector utilise le manifeste déjà retenu
`sha256:ac08538c6f8b9904c33c8224c5e5706dbe760aca29db1d096972b4052c22a75d`
(PostgreSQL 17.11, pgvector 0.8.7 observés arm64).
[Licence pgvector](https://github.com/pgvector/pgvector/blob/v0.8.7/LICENSE),
[licence PostgreSQL](https://www.postgresql.org/about/licence/).
La licence du serveur ne remplace pas l'inventaire des composants de l'image.

DB et cache n'ont aucun port hôte et ne rejoignent que le réseau interne.
L'absence d'authentification cache reprend la confiance du réseau privé Sim :
aucun conteneur non fiable ne doit rejoindre ce réseau. AOF `everysec` conserve
le cache au redémarrage mais peut perdre la dernière seconde ; aucun état
métier durable ne doit dépendre seulement de Valkey. `noeviction` rend visible
la saturation ; surveiller les erreurs et qualifier les clients Sim, scripts Lua,
pub/sub, budgets et reconnexions. Un simple PING ne suffit pas.

Les services applicatifs restent UID/GID 1001 ; les images DB/cache utilisent
leurs entrypoints natifs pour initialiser les permissions puis abandonner root.
Les limites mémoire sont des bornes initiales, **pas un dimensionnement mesuré**
(8 Gio web, 1 Gio realtime/migrations, 2 Gio DB, 512 Mio cache, 256 Mio cron).
Le test infrastructure seul ne valide pas une installation complète sur 4 Gio.
Les journaux des services continus sont bornés (3 × 10 Mio par service).

`migrations` conserve `bun run db:migrate` et le verrou advisory natif Sim,
avec `restart: no`. Web et realtime attendent sa réussite. Les readiness probes
HTTP reprennent les routes amont ; elles ne prouvent pas un parcours métier.
Le cron reprend supercronic et `cron-entrypoint.sh` existants. Le fichier `crontab`, monté via `configs.file` pour conserver la racine du
cron en lecture seule, réutilise les horaires et appels bornés amont, en retirant SCIM, data drains EE,
facturation et réconciliation d'entitlements Cloud. `CRON_SECRET` est obligatoire
avant résolution Compose. Son healthcheck prouve seulement la vie du processus,
pas la réussite des appels : surveiller leurs erreurs. Pas de nouveau scheduler.

## Configuration du Chat indépendant

`MEMLIA_CHAT_POLICY_SOURCE` désigne un fichier JSON non secret, par chemin
absolu dans la VM Linux. Préparer sa politique selon
[`CHAT_POLICY.md`](../../apps/sim/lib/memlia/ai/CHAT_POLICY.md) et ses règles de
modèle/tarif/fenêtre ; ce déploiement n'invente aucun prix ni budget actif.
Les secrets fournisseurs restent injectés seulement dans leurs variables
serveur existantes, jamais dans ce JSON ni une variable publique. Le profil
local actuel accepte OpenAI ; les autres clés restent utiles aux blocs de
workflows existants mais ne sélectionnent pas un autre moteur Chat local.

Le web reçoit toujours `MEMLIA_CHAT_POLICY_FILE=/etc/memlia/chat-policy.json`
et `COPILOT_TOOL_PERMISSIONS_ENABLED=true`. Le fichier est monté en lecture
seule au premier emplacement, avec `bind.create_host_path=false`. Une source
hôte manquante ne doit pas devenir un répertoire créé automatiquement. La
variable source est obligatoire avant résolution Compose ; ni son contenu ni
ses permissions ne sont vérifiés par `compose config`. Le chemin interne fixe
sélectionne le backend local : absence, corruption ou refus de policy ne
retombe pas sur le worker Sim. Aucune clé `COPILOT_API_KEY` n'est transmise.

Préparer le fichier sous UID 0, sans écriture groupe/autres et sans lien,
par exemple mode0444, lisible par UID/GID1001. Dans l'image finale, `/etc/memlia`
et tous les parents du chemin interne doivent également appartenir à root,
être traversables et ne pas être modifiables par l'identité web. Vérifier les
permissions réelles après montage, y compris les ACL : `read_only` seul ne
prouve pas ces propriétés. Le lecteur natif recontrôle la propriété, les
modes, l'accès effectif, les métadonnées et la taille bornée à chaque lecture.
Les services DB/cache/realtime/cron/migrations ne reçoivent ni fichier ni
variable de policy. Aucun UID de config supposé changer l'ownership hôte
n'est utilisé.

Le flag de confirmations rend les routes natives disponibles ; il n'accorde
aucune permission de workspace ou de workflow. Le driver local conserve son
gate unitaire sans approbation automatique ni préférence permanente, lié aux
opérations exactes et au CAS. Permissions, modèle courant, transcript,
fenêtre monétaire, réservations et quotas restent vérifiés dans le backend.
Une simple clé fournisseur ne suffit pas à rendre ce Chat opérationnel.

Le crontab existant appelle toutes les30minutes la route authentifiée
`/api/cron/cleanup-stale-executions`. Celle-ci enfile le job natif qui appelle
`runCleanupStaleExecutions`, puis `sweepOrphanedRuns` pour les tours abandonnés.
Aucun timer ou daemon supplémentaire n'est ajouté. Le dispatch, l'exécution
réelle du job et son résultat doivent être vérifiés et supervisés dans la
recette Compose ; le seul HTTP200 ne prouve pas la clôture. Le raccordement
persistant général des jobs reste une condition bloquante décrite plus haut.

Les tests de cette tranche résolvent réellement le modèle Compose sans daemon
et exercent les absences de variables, la portée du montage, les valeurs fixes
serveur et l'absence de credentials worker. Ils ne qualifient pas un montage
Linux, un démarrage applicatif, un modèle, le cron en exécution ou Hyper-V.

## TLS du cabinet

Le reverse proxy existant s'exécute sur la même VM et termine HTTPS ; il rejoint
le web via `127.0.0.1:3000` et realtime via `127.0.0.1:3002`. Les ports sont
volontairement locaux. Si le proxy est distant/conteneurisé, préparer et revoir
sa liaison réseau privée avant déploiement ; ne pas publier ces ports sur tout
le LAN. Garder `NEXT_PUBLIC_SOCKET_URL` vide pour le fallback d'origine Sim.

Exemple à intégrer au **proxy Nginx existant** (aucun service proxy installé ici),
avec les certificats privés du cabinet hors Git :

```nginx
# Contexte http
map $http_upgrade $memlia_connection { default upgrade; '' close; }
server {
    listen 443 ssl;
    server_name memlia.cabinet.example;
    ssl_certificate /etc/cabinet/tls/memlia-fullchain.pem;
    ssl_certificate_key /etc/cabinet/tls/memlia-key.pem;
    location /socket.io/ {
        proxy_pass http://127.0.0.1:3002;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $memlia_connection;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_read_timeout 950s;
    }
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_buffering off;
        proxy_read_timeout 950s;
    }
}
```

Définir l'origine HTTPS exacte et la liste native `AUTH_TRUSTED_PROXIES` selon
l'adresse effectivement vue par l'app. Ne pas faire confiance à un en-tête fourni
par Internet. Adapter limites d'upload et délais à la politique cabinet et
qualifier le streaming. Le réseau `egress` permet les appels sortants nécessaires ;
ce fichier n'est pas un pare-feu de destinations. L'allowlist native
`EGRESS_ALLOWED_HOSTS` reste vide ; un endpoint IA privé requiert une autorisation
explicite, sans autoriser tout le réseau privé. Les clés IA restent vides jusqu'à
configuration des fournisseurs.

## Exploitation après fermeture des gates

Démarrer uniquement DB/cache pour le provisioning, puis appliquer le parcours
approuvé des rôles/migrations. Ensuite, utiliser le même projet Compose :

```sh
docker compose --env-file deploy/memlia/.env -p memlia-cabinet \
  -f deploy/memlia/compose.yaml up -d --wait --wait-timeout 180
```

Cette commande n'est pas une preuve que les gates sont fermées. Sur une base
volumineuse, les migrations peuvent dépasser 180 s : examiner leur état avant
un nouvel essai, sans lancer de migration concurrente. `docker compose stop`
préserve les volumes ; **ne jamais utiliser `down --volumes` en exploitation**.
Avant mise à jour, sauvegarder ensemble DB, uploads, clés de chiffrement, confiance
agents et configuration hors VM, et vérifier une restauration isolée. Les
checkpoints Hyper-V ne remplacent pas cette sauvegarde. Revenir aux anciens
digests seulement si les migrations sont compatibles ; sinon restaurer l'ensemble
cohérent. Le rollback et la restauration produit restent NON TESTÉS.

## Vérification ciblée

```sh
python3 -m unittest discover -s deploy/memlia/tests -v
python3 deploy/memlia/tests/smoke_infrastructure.py --evidence /chemin/prive/p03.json
```

`MEMLIA_TEST_DOCKER` peut sélectionner un client/contexte explicite sans changer
le contexte global. Le premier test résout le vrai modèle Compose, vérifie les
refus sur valeurs requises absentes, la distribution des secrets, les ports,
volumes, digests et conditions de dépendance. Le second démarre **uniquement**
DB/cache dans un projet aléatoire, vérifie vecteur/Lua/TTL/accès réseau privé et
persistance après recréation. Il remplace temporairement l’image cron par l’image
Valkey admise pour tester le vrai montage en lecture seule et l’expansion shell
des variables, sans lancer supercronic ni appeler les endpoints HTTP. Il supprime
ensuite seulement ses conteneurs/volumes/réseaux et vérifie leur absence. Toute
erreur, y compris au nettoyage, produit un reçu `failed`, en conservant l’éventuelle
erreur initiale. Les tests négatifs de ce classement utilisent des réponses de
sous-processus simulées ; ils ne constituent pas des preuves Docker.
Il utilise des fixtures fictives sans clé IA et ne touche pas la DB de développement.
Il ne qualifie ni les consommateurs Sim ni les parcours navigateur/Excel/worker.
