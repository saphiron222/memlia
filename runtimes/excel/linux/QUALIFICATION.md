# Recette Linux AMD64 — qualification séparée de l’admission

Copyright (c) 2026 Memlia. Tous droits réservés.

Cette recette est un test explicitement exécuté sur le runner public standard
`ubuntu-24.04`, sans secret, login de registre, image publiée ou runner payant.
Elle ne change pas `QUALIFIED_IMAGES` : cette liste reste vide. Par défaut,
l'image est supprimée après les huit cas et aucun host ne la consomme. La réussite
du job ne constitue ni une autorisation métier, ni une admission automatique dans
un service. L'option opérateur distincte ci-dessous prépare une preuve composée ;
son nouveau parcours reste **Docker/Linux réel NON TESTÉ**.

## Composition applicative manuelle, sans serveur Next

Une seconde entrée manuelle, `exercise_application`, fausse par défaut, implique
`exercise_host`. Les PR/push et le mode host seul conservent leurs parcours.
Elle prépare les outils Node **24.22.0** et Bun **1.4.2** déjà épinglés dans la CI,
avec le verrou gelé et les scripts de cycle de vie désactivés. Les contrôles
Oracle, le rebuild Node natif `isolated-vm` avec les en-têtes de la même image,
`build:cli-runtime` et `build:sandbox-bundles` réemploient la recette worker
existante. Aucun Next build, stub natif, dépendance supplémentaire ou image
applicative publiée n'est ajouté. Cette préparation reste **Linux/GHA NON TESTÉE**.

Après les huit oracles et les pairs UID réels, le **même host**, consommant
l'**image exacte encore détenue**, est utilisé par une fixture applicative.
`application_qualification.py` réemploie le transport Docker borné et les phases
publiques de `scripts/ci/linux-chat-fixture.ts` sans modifier ce helper : base
neuve, rôles migration/web distincts, migrateur produit, métadonnées et baseline
des 183 tables, compte synthétique avec `user_stats` et compte credential.
PostgreSQL et Valkey sont des conteneurs possédés sur un réseau interne, sans
port publié. Le rôle web est vérifié sans superuser/DDL et ne reçoit jamais le
DSN propriétaire. Ses limites cgroup réelles sont relues avant les opérations.

`scripts/ci/excel-file-workflow.ts` provisionne une clé synthétique avec
l'émetteur natif, puis l'authentifie réellement ; aucun principal n'est forgé
depuis un ID. La préparation de deux workspaces réemploie la politique et la
création natives après cette authentification. Les opérations fichier, création
de workflow, édition révisée du graphe et exécution passent ensuite par
`dispatchInProcessV2Request`, le transport déjà employé par le CLI embarqué.
Il appelle les **vrais handlers v2**, avec leurs contrats, authentification,
permissions et présentateurs. Le petit graphe contient Start → memlia_excel ;
aucun nouvel outil, moteur de graphe ou transformation n'est implémenté ici.

Le run manuel synchrone passe par `executeManualWorkflowOperation`,
`executeWorkflowService`, `LoggingSession`, preprocessing et executionCore natifs.
Seule la configuration opérateur du host est portée par le scope de processus
déjà fourni au worker. Aucun contexte exécuteur fourni par le client, insertion
SQL de run terminal ou contournement des permissions de `executeExcelFile`.
Le GET natif du run doit être terminal et décrire un fichier enregistré, avec
ses octets inlinés. La vraie route binaire du fichier de **ce même run** doit
rendre exactement ces octets, longueur et MIME ; le readback openpyxl vérifie
les cellules attendues et le SHA-256. La source est relue nativement inchangée.
Une deuxième transformation ne sert jamais d'oracle de téléchargement.

Les refus sans clé, avec une clé erronée, avec une clé scoped sur l'autre
workspace et le téléchargement sans autorité sont obligatoires. Aucun secret,
classement comptable réel, contenu de classeur ou erreur brute ne sort du
namespace privé. Le reçu ne contient que les booléens, phases fermées, digest,
taille et identité des ressources possédées. Les notifications temps réel sont
best effort vers un loopback sans service ; aucune collaboration Socket.IO
n'est qualifiée par ce test.
Un seul acteur synthétique est utilisé : la seconde clé doit d'abord réussir
la lecture de son propre workspace **réellement créé**, puis être refusée sur
le fichier/run existants du premier. Cela vérifie le scope de cette clé, pas
l'isolation entre deux collaborateurs ; aucun ID absent ne sert d'oracle
d'autorisation. Les essais multi-utilisateurs restent distincts.

Cette preuve est une **composition API native in-process + IPC host + stockage
et téléchargement natifs**. Elle ne prouve **ni HTTP entrant, ni Next démarré,
ni navigateur, ni worker pg-boss durable**, ni activation serveur autonome d'un
cabinet. Le premier de ces parcours exige encore un serveur Next/standalone
qualifié ; ne pas attribuer une réussite HTTP à cette fixture. À cette version,
la composition Linux elle-même est **NON TESTÉE** : les tests Mac exercent
l'oracle XLSX réel et les contrôles préparatoires, avec Docker et les API absents.
Le scope opérateur est composé explicitement dans cette fixture de processus ;
cela ne configure pas le processus web de production. La disponibilité d'un run
Excel depuis ce web, ainsi que le worker pg-boss configuré et son packaging,
restent des critères distincts avant de déclarer le parcours cabinet utilisable.

Le nettoyage produit du compte est suivi du readback des 183 tables avant
de déclarer la composition passée. Les conteneurs ne sont arrêtés/retirés
qu'après contrôle d'ID, nonce, état et limites ; un état inconnu refuse la
réussite. Les fichiers du namespace neuf ne sont retirés qu'après fermeture des
processus, inventaire sans liens et relecture d'identité. Il s'agit d'un modèle
coopératif de CI, pas d'une atomicité contre un administrateur hostile. Une
préparation ou un cleanup incomplet reste échoué et conserve son namespace
dans le reçu. Le host et l'image gardent leur nettoyage natif original.
Après toutes les assertions API/download, la fixture retire uniquement le log
terminé de ce run synthétique, son snapshot et son unique tombstone d'ID par transaction : IDs, workflow,
workspace, propriétaire, version `xmin` et digest frais, cardinalités 1 et absence
d'autre référence obligatoires. Aucun run n'est inséré ou rendu terminal par SQL.
Cette purge de fixture est nécessaire car le snapshot a une FK `ON DELETE SET NULL`
et reste normalement conservé après effacement du compte. Le tombstone est aussi
conservé en production pour empêcher de réutiliser un ID ; seul celui du run
synthétique identifié est retiré avec version/digest exacts. Aucune purge globale
d'orphelins ni modification de ce comportement produit n'est effectuée. Le cleanup
de compte natif et la comparaison des 183 tables restent ensuite inchangés.

La préparation applicative dispose de 900 s sous 2 CPU/4 Gio/swap zéro/256 PID ;
la recette conserve **600 s + marge de nettoyage 20 s**, ses huit oracles et les
bornes natives. Le job passe à 40 minutes pour la préparation optionnelle ;
aucune campagne n'est déclenchée automatiquement pour ce mode. La réserve
runner reste 6 Gio, contrôlée avant/après préparation et par la recette.

## Consommation locale explicite avant suppression

L'entrée manuelle du workflow expose `exercise_host`, booléen faux par défaut.
Seul `workflow_dispatch` peut le sélectionner ; PR et push conservent la recette
historique. Ce mode appelle le même programme avec `--exercise-host`, sous root
dans la VM gratuite éphémère, pour disposer de deux vrais UID de pairs. Il ne crée
aucun compte, service permanent, registre, image publiée ou archive. Les délais
600 s internes / 12 minutes externes et le cleanup natif ne changent pas.

Après les huit cas réussis et leurs huit nettoyages de conteneurs, les contrôles
de source/verrou sont refaits et le label de possession de l'image est relu.
`qualification_proof` ferme la projection : ID exact de l'image, commit source,
SHA256 du verrou, du contexte et du superviseur, huit couples booléens
`passed/cleanupComplete`, et `imageHeld:true`. Ce dernier champ indique une image
encore possédée, **pas** son nettoyage déjà terminé. Le contrôle mémoire ne devient
jamais une réussite de calcul après OOM.

L'opérateur installe explicitement cette preuve et son admission locale, toutes
deux en mode 0400, sous son propre UID, dans un namespace neuf `/run` non modifiable
par le pair. Le lecteur décrit dans HOST_PROTOCOL vérifie les deux captures.
Le host démarre depuis trois copies exactes et protégées de ses modules. Il ne
reçoit aucun code ou chemin provenant d'une procédure.

Le consommateur réemploie `host.py` et son vrai `supervisor.execute`, sans modifier
`QUALIFIED_IMAGES`, remplacer `execute` ou appeler une couture privée à sa place.
Deux petits processus Python stdlib abandonnent groupes/GID/UID avant de lire le
frame avec `os.setgroups/setgid/setuid` : UID1001/GID1001 accepté,
UID1002/GID1001 refusé par `SO_PEERCRED` malgré le groupe socket commun. Le premier
transmet la fixture XLSX native déjà utilisée et son résultat repasse par
`verify_answer`/openpyxl. Ce sont des pairs natifs fictifs ; pas le worker pg-boss,
une session Sim ou une autorisation métier fabriquée.

Le host reçoit TERM, draine son travail et doit sortir proprement, socket retiré.
Seuls les fichiers exacts de ce namespace sont alors supprimés, puis le `finally`
historique retire l'image par son ID et label vérifiés. Un host non terminal ou un
cleanup inconnu conserve les ressources et son nonce dans le reçu fermé ; aucun
SIGKILL du host non réglé, prune ou suppression forcée ne fabrique une réussite.

La préparation est développée et testée isolément ; ni cette option Linux, ni
l'admission d'une installation, ni le parcours fichier → résultat téléchargeable
ne sont qualifiés. Licences/couches/P15 et revue indépendante restent nécessaires
avant redistribution. Aucune publication binaire n'est ajoutée.

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
