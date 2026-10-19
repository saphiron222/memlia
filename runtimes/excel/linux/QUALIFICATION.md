# Recette Linux AMD64 — qualification séparée de l’admission

Copyright (c) 2026 Memlia. Tous droits réservés.

Cette recette est un test explicitement exécuté sur le runner public standard
`ubuntu-24.04`, sans secret, login de registre, image publiée ou runner payant.
Elle ne change pas `QUALIFIED_IMAGES` : cette liste reste vide. La réussite du
job ne constitue ni une autorisation métier, ni une admission automatique de
l’image dans un service. Une revue du résultat réel et de son identité reste
nécessaire. À la préparation de cette tranche, **Docker/Linux réel NON TESTÉ**.

## Identités et construction

La base est Docker Official Images `library/python`, Python **3.12.15**, Debian
Bookworm slim. Résolution anonyme HTTPS vérifiée le 20 octobre 2026 :

- index observé `3.12-slim-bookworm` : `sha256:34386ef0cb081344d7ec1c103ba398e6e9f64e9ab3a1509accc92a4e24a07258` ;
- manifeste **linux/amd64**, épinglé dans `qualification.py` :
  `sha256:2ed6491b93cd49272ee6de2b5a38440c3448360322c089fc23e370722d74179d` ;
- configuration de cette base, identité attendue après pull :
  `sha256:4f228bc1cbcfc794e4878312cfc241d368eff55a21c08d1e2bb263116c4ef524`.

Ces trois empreintes désignent des objets distincts. Le tag n’est jamais résolu
pendant la recette. Le pull explicite concerne ce seul digest public, avant
construction. Les exécutions conservent `--pull never`.

`prepare_context.py` et le packager natif construisent le contexte étroit depuis
les deux packages sources et les roues du verrou. Le build se fait sans réseau
pour les instructions RUN, sous la base exacte, avec les deux COPY propriétaires
65532 déjà prévus. Aucun nouveau moteur Excel, parseur, dépendance ou protocole
n’est introduit. Le reçu relie commit, verrou, contexte et ID de l’image produite.
Les sources suivies sont contrôlées propres avant/après. Aucun chemin ou argv du
modèle n’entre dans les commandes Docker.

## Mesures exigées

| Cas | Preuve réelle exigée dans la VM Linux |
| --- | --- |
| worker | `_run_owned` inchangé : stdin jusqu’à EOF, JSON complet, références exactes, SHA-256, contrôle balance et readback XLSX par openpyxl ; aucune publication |
| boundary | UID/GID 65532, écriture rootfs refusée **EROFS**, temporaire 0700 writable, exécution d’un script temporaire refusée **EACCES**, seul loopback et connexion TEST-NET refusée sans route, NoNewPrivs et capacités effectives nulles |
| cpu | cgroup v2 `cpu.max` réellement à un CPU, deux enfants bornés 2,5 s et augmentation effective `nr_throttled` |
| pids | plafond effectif 32, création d’au plus 40 enfants possédés, refus **EAGAIN**, incrément `pids.events:max`, tous enfants attendus |
| memory | plafond effectif 512 Mio, swap zéro ; allocateur borné à 640 Mio, préféré comme victime OOM, SIGKILL et incrément `memory.events:oom_kill` ; refus volontaire du transport puis nettoyage natif |
| disk | tmpfs 128 Mio, au plus 130 écritures de 1 Mio, refus **ENOSPC**, fichier supprimé |
| timeout | véritable commande exec en attente bornée à 2 s ; refus, arrêt du worker et disparition du conteneur possédé |
| cancel | événement d’annulation pendant attente réelle, mêmes exigences de refus et nettoyage |

Les bornes CPU/PID/mémoire/swap sont vérifiées **avant** les sondes de charge.
Elles sont limitées au conteneur possédé, jamais au cgroup hôte. Les compteurs et
les limites suivent les [interfaces officielles cgroup v2](https://docs.kernel.org/admin-guide/cgroup-v2.html).
La sonde mémoire n’interprète jamais l’OOM comme un succès du worker : son résultat
est une mesure de limite séparée, suivie d’un refus du transport. La capacité à
continuer un calcul après OOM reste non qualifiée.

Les autres sondes utilisent la **même image et les mêmes options** que le worker.
L’adaptateur de recette démarre le conteneur en attente de stdin, contrôle à
nouveau son identité, lance un unique script fixe par `docker exec`, puis relie le
vrai worker par [Docker attach](https://docs.docker.com/reference/cli/docker/container/attach/).
Le cas worker initial conserve exactement le start/attach de production. Le
script de sonde n’est ni installé dans l’image, ni sélectionnable dans une
requête. Ce raccordement n’est pas un nouveau mode de production.

## Budget disque propre à la recette

Le seuil est **6 Gio libres**, mesuré sur le volume du répertoire de recette
avant le contexte, le pull, le build et chaque cas, puis avant/après cleanup.
Il ne reprend pas les 40 Gio du garde de compilation Mac, qui reste inchangé.
Le runner standard public annonce 14 GB de SSD total, pas 40 Gio disponibles :
[ressources GitHub officielles](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
La disponibilité effective au démarrage reste **NON MESURÉE** avant la CI.

Ce budget est une réserve prudente de travail, pas une prédiction de taille :
2 Gio sont provisionnés pour roues/contexte/installation, 2 Gio pour base,
couches et image de build, et 2 Gio de marge. Ces postes sont des allocations
prévisionnelles, **pas des plafonds mesurés ni garantis**. La taille compressée
du manifeste ne prouve jamais la taille décompressée. Les logs pull/build sont
bornés cumulativement à 8 Mio ; les cas utilisent le tmpfs borné de 128 Mio.
Le cache BuildKit peut consommer au-delà des estimations : une phase peut encore
échouer faute d'espace entre deux observations. Le volume du stockage Docker
n'est pas qualifié par la seule mesure du volume de travail.

Chaque observation ferme contient uniquement phase, octets disponibles, seuil
et résultat. Une disponibilité faible ou inconnue refuse la recette ; durant
le cleanup, la mesure ne doit pas empêcher l'arrêt/suppression possédés, mais
interdit ensuite le statut réussi. Aucun logiciel hôte, cache ou swap étranger
n'est supprimé pour fabriquer de la place. Le reçu réel, les mesures et la
construction complète devront être relus avant toute qualification.

## Refus, délais et nettoyage

Le superviseur natif reste inchangé : image/identités/nonce/options contrôlés,
aucun signal ou rm sur une identité différente. Les champs Docker inspect requis
restent obligatoires. Si une version Docker en omet, le reçu peut nommer seulement
les clés HostConfig autorisées manquantes ; le cas échoue. Aucun défaut supposé
n’est compensé par une valeur synthétique.

Le job passe de 15 à 30 minutes pour cumuler préparation, packaging natif limité
à 10 minutes, tests légers 2 minutes et recette limitée à 12 minutes. La recette
borne son travail à 600 s, les appels de nettoyage à leur délai natif et une
marge globale de 20 s ; les bornes internes du superviseur (120 s/10 s) ne sont
pas augmentées. SIGTERM/SIGINT déclenchent un refus, pas une réussite. Le watchdog
CI conserve TERM puis KILL avec marge. Un arrêt dur du runner n’offre pas de
preuve de nettoyage : l’absence de reçu final ne vaut jamais succès.

Chaque conteneur doit disparaître par son ID et son nonce vérifiés. L’image
locale construite est supprimée seulement après contrôle de son ID et du label
privé de construction, sans `--force`. Un build dont l’issue est inconnue reste
un échec avec nettoyage non attesté. Ni le cache BuildKit ni la base éventuellement
préexistante ne sont supprimés ; la VM éphémère les récupère. Aucun prune global.

Le répertoire de recette est neuf/0700, logs privés/0600 ; capture du build bornée
à 8 Mio et commandes sans shell. Seul le reçu fermé est écrit dans le log Actions.
Aucun workbook, contexte, image, stdout/stderr brut ou archive n’est publié.
L’activation du runtime, le service Compose, les autorisations/bindings,
l’approbation métier, les sauvegardes et la publication de classeurs restent hors
qualification. Cette recette ne qualifie ni macOS, ni Windows, ni une isolation
universelle contre toutes les attaques noyau.

## Tests préparatoires

`python -B -m unittest discover -s runtimes/excel/linux -p 'test_*.py' -v`
réutilise les tests existants et ajoute les tests de recette. L’environnement doit
contenir les dépendances verrouillées et `MEMLIA_TEST_WHEELHOUSE` pour le contexte.
Les états Docker y sont **doublés** ; les pipes Python, les attentes d’enfants et
le readback XLSX sont réels. Ces tests ne lancent jamais les sondes Linux dans
l’hôte local et ne remplacent pas la future exécution du job.
