# Validation Linux : types, bundles et contrôle build requis

Le workflow `memlia-linux-validation.yml` fournit le check **validate-linux**.
Il valide sur le runner public standard Linux x64 les étapes préparatoires du
produit. **Ce n'est pas un build Next réussi, une qualification standalone ou une
qualification de la RAM nécessaire au produit.** Il ne satisfait jamais le check
obligatoire `build`, qui reste celui du workflow de construction complet.

## Modes du script partagé

```sh
# Parcours complet existant : termine uniquement après Next et standalone.
bash scripts/ci/run-linux-build.sh

# Parcours borné : aucun Next build, aucun contrôle standalone.
bash scripts/ci/run-linux-build.sh --validation-only
```

Le job obligatoire `build` utilise désormais le parcours complet explicitement
sélectionné :

```sh
bash scripts/ci/run-linux-build.sh --swap turbopack
```

Le script sans argument conserve son parcours historique Webpack sans swap ajouté ;
il n’est plus le profil choisi par ce job. Les variantes `--swap webpack` et
`--swap turbopack-zram` restent des expériences distinctes. Tout argument hors des
modes explicitement supportés est refusé avant bootstrap. Le mode borné réutilise le même
bootstrap jetable, le superviseur, les cgroups, l'installation et le nettoyage.
Il exécute dans l'ordre les tests du superviseur, l'installation gelée sans scripts
lifecycle, les contrôles de versions/empreintes, l'inventaire CLI, `next typegen
--webpack`, `tsc --noEmit --singleThreaded`, le bundle CLI et les bundles sandbox.
Ces derniers sont aussi évalués par leur script natif avant écriture.

Ne pas remplacer ces appels par `bun run build` : cette commande de l'application
lancerait aussi Next. La génération de types ne compile pas les routes pour la
production. Le bundle CLI ne prouve pas un scénario utilisateur, et les bundles
sandbox ne constituent pas une image déployée. Les sorties générées restent sur le
runner éphémère ; elles ne sont pas publiées ni proposées comme artefacts de release.

L'installation est `--frozen-lockfile --ignore-scripts`, avec contrôle SHA256 du
verrou avant/après. Next installé doit correspondre à la **version exacte** du
manifeste applicatif et à l'override racine, sans plage ni tag flottant. Le reçu
outil indique aussi cette version attendue. Le script n'effectue aucune mise à
jour : un futur export de sources doit apporter lui-même les manifestes et le
verrou cohérents. Les versions Node24.22.0/Bun1.4.2/TypeScript7.0.2, les digests
images et le checksum Bun restent vérifiés.

## Résultats distincts

Une fin normale du mode borné produit :

```json
{
  "scope": "validation",
  "status": "validation_passed",
  "buildStatus": "not_run",
  "nextStarted": false,
  "standaloneVerified": false
}
```

Le mode complet conserve `scope=build`, et ne produit le statut global `passed`
qu'après Next et la vérification standalone. `normalCompletion` désigne uniquement
la fin normale du mode sélectionné. Une phase manquante, un signal, une erreur de
commande, un nettoyage incomplet ou un échec d'écriture/émission du reçu rend le
processus non nul ; aucun `continue-on-error` ne transforme cela en réussite.

Les reçus de chaque phase conservent les mesures : temps, mémoire cgroup (dont cache
comptabilisé par le noyau), RSS échantillonnée, descendants, swap et événements OOM.
Une réussite d'une phase n'est pas une réussite de la construction entière. Aucun
log brut, source, source map, cache, dépendance, bundle ou image n'est uploadé.

## Exécution publique contrôlée

Le workflow est limité au dépôt public `saphiron222/memlia`, avec
`permissions: contents: read`, checkout sans credentials persistés, historique
complet pour le contrôle des notices et timeout de 45 minutes. Il utilise le
runner standard `ubuntu-24.04`, jamais un runner large payant. Si le dépôt devient
privé, la condition interdit ce job ; ne pas retirer ce garde pour consommer des
minutes privées sans décision distincte.

Déclenchement manuel ou push sur **validation/linux-typecheck** seulement. Cette
branche est distincte de `build/linux-16gb-measurement`, dont le push lance le build
complet existant. Pour le premier essai, publier la branche de validation après
revue/gates ; le déclenchement push évite d'exiger la présence préalable du nouveau
workflow sur la branche par défaut. Aucun événement de contribution privilégié,
secret d'application ou permission d'écriture n'est utilisé.

Le check `build` n’est ni renommé, ni remplacé, ni satisfait par le mode
`--validation-only`. En l'absence d'une vraie construction réussie du même candidat, le
check obligatoire build reste non satisfait. Aucune protection du dépôt n'est
modifiée par ces fichiers.

Le mode `--validation-only` conserve 13 Gio de cgroup sans swap supplémentaire,
CPU4 et heap10Gio ; la DB jetable reste à 512 Mio. Le bootstrap DB est conservé pour garder
l'environnement du témoin et ne migre pas de schéma métier. Cela ne prouve pas
que toutes les phases utilisent la DB. Aucune conclusion sur un besoin de 24–32 Go
ou une solution aux OOM de Next ne résulte de ce parcours.

## Tests locaux du contrôle

```sh
python3 scripts/ci/test-linux-build-metrics.py -v
bash -n scripts/ci/run-linux-build.sh
```

Les tests de sélection de phases exécutent le code Bash de production avec la
seule frontière `phase` doublée pour enregistrer les appels. Ils ne lancent aucun
Docker, PostgreSQL, compilateur ou build. Les tests de version utilisent de vrais
fichiers de manifeste fictifs, sans installation. Les tests de nettoyage utilisent
les fonctions de production et de vrais défauts de fichiers/signaux aux frontières
indiquées. Une réussite de ces tests ne qualifie pas l'installation Linux ni le TSC
du futur snapshot : seule l'Action réelle sur ce snapshot peut le faire.

Copyright 2026 Memlia. Tous droits réservés.

## Positions TypeScript publiables

Seule la phase `typecheck` peut joindre `typeScriptDiagnostics.locations` : au plus
100 tuples uniques `{path, line, column, code}`. Aucun message, extrait de source,
valeur ou commande n’est repris. `--pretty false` stabilise uniquement le format
du diagnostic ; le code de sortie et les critères de réussite restent inchangés.

Avant les phases, une liste privée est construite depuis les blobs réguliers TS,
TSX, MTS et CTS du commit Git courant. Ni fichiers non suivis, ni liens symboliques,
ni noms ambigus ne sont admis. Le manifeste, plafonné à 2 Mio et 50 000 chemins,
est monté en lecture seule ; il n’est ni imprimé ni uploadé. Les chemins publics
émis sont relatifs à la racine du dépôt, ASCII, sans segment vide, `.` ou `..`,
et limités à 512 caractères. La correspondance `../../packages/...` depuis
`apps/sim` est une clé exacte précalculée depuis cette liste ; aucune normalisation
d’un chemin fourni par le compilateur n’autorise une nouvelle cible.

L’extraction ne lit que les derniers 64 Kio de sortie. Si cette fenêtre commence
en cours de fichier, sa première ligne est ignorée par précaution. Les lignes
incomplètes, de plus de 4 096 octets ou contenant des contrôles/ANSI sont rejetées.
Lignes et colonnes doivent être positives et au plus 1 000 000 ; le code TS compte
3 à 5 chiffres. Une liste absente/invalide ne publie aucun chemin. Le champ
`truncated` signale une fenêtre réduite ou un plafond atteint ; cette liste n’est
pas un inventaire exhaustif des erreurs. Les diagnostics sans fichier versionné
(restes générés `.next`, dépendances, diagnostics globaux) ne produisent pas de
position. Les codes TS agrégés existants restent disponibles séparément.

Les tests portables utilisent de vrais dépôts Git jetables et un processus enfant
réel ; la lecture cgroup de ce test est une doublure explicitement déclarée. Ils
ne qualifient pas un nouveau typecheck Linux complet ni un build Next. Les journaux
bruts restent éphémères et sont détruits ; seules ces positions bornées sont ajoutées
aux reçus publics.

## Contrôle obligatoire `build` : Turbopack avec swap disque

`memlia-linux-build.yml` conserve le job unique **build**, sans matrice ni
`continue-on-error`. Il se déclenche sur une PR vers `main`, un push vers `main`
ou la branche historique `build/linux-16gb-measurement`, et manuellement. Aucun
filtre de fichiers ne supprime silencieusement le contrôle requis. Il est limité
au dépôt public exact `saphiron222/memlia`, permissions `contents: read`, runner
standard gratuit `ubuntu-24.04`, checkout du SHA de l’événement sans credentials
persistés et `fetch-depth: 0`. Aucun événement `pull_request_target`, secret,
permission d’écriture ou runner privé n’est utilisé.

Sur `pull_request`, le checkout explicite de `github.sha` teste le commit de
fusion temporaire de la PR, pas seulement sa tête. Une PR issue d’un fork garde
les restrictions GitHub applicables (token en lecture, sans secrets, éventuelle
approbation préalable). Le code de la PR s’exécute seulement dans la VM GitHub
éphémère ; aucun runner persistant ou déploiement n’est attaché à ce job.

Le job réemploie **sans modifier les scripts** le protocole de la variante
`turbopack` du workflow expérimental `memlia-linux-swap-build.yml` : notices
arbre/historique, tests superviseur et inventaire swap avant allocation, puis
`bash scripts/ci/run-linux-build.sh --swap turbopack` avec `MEMLIA_PUBLIC_RUN=1`.
Le bootstrap crée seulement son swapfile de 24 Gio possédé, conserve le swap
préexistant et refuse capacité/identité/inventaire/privilège indisponibles. Prévol mémoire
hôte ≥ 14 Gio, disponible ≥ 13 Gio ; volume temporaire ≥ 36 Gio avant allocation
et volume de travail ≥ 12 Gio. Les contrôles de refus et cleanup restent ceux
du protocole qualifié, sans réallocation ou suppression globale de swap/SDK/cache.

Toutes les phases préparatoires restent obligatoires, puis Next **réel**
Turbopack : cgroup RAM 13 Gio, RAM + swap 37 Gio (swap additionnel plafonné à
24 Gio), 4 CPU, 512 PID, heap V8 11 Gio, 2 workers, source maps désactivées,
sortie standalone. Le heap V8 ne borne pas la mémoire native de Turbopack. Les autres phases gardent leurs
limites ; aucune augmentation de la RAM du cgroup ou relâchement OOM n’est ajoutée ici.
Timeout du job de 120 min repris du protocole expérimental qualifié (ancien job
45 min), superviseur hôte de 6 900 s et phase Next de 6 000 s inchangés ; garder
la marge de cleanup.

Les critères de réussite restent `scope=build`, Next exécuté, fichiers standalone
vérifiés, fin normale **et** cleanup réussi. Les reçus quantitatifs fermés sont lus
même après échec ; cette lecture `always()` ne transforme pas une commande non
nulle en succès. Ni source/log brut, dépendance/cache, image, bundle, source map,
heapdump ou artefact de release n’est uploadé.

**Preuve historique distincte :** [measure (turbopack) du SHA e1](https://github.com/saphiron222/memlia/actions/runs/39290313655/job/118188973603)
a terminé SUCCESS, Next 508,467 s, zéro OOM, avec les fichiers standalone et cleanup
vérifiés. Cela qualifie ce protocole sur **ce SHA**, pas une nouvelle révision ou
le job `build` modifié qui devra s’exécuter sur son propre candidat. Aucun ancien
statut `measure(...)` n’est renommé en `build` ni reporté sur un autre commit.
La protection de `main` n’est pas modifiée ; le vrai contrôle requis reste à passer.

Les résultats historiques ci-dessus vérifiaient seulement les fichiers et
configurations standalone, sans serveur HTTP. Ils ne qualifient pas le smoke
HTTP ajouté ci-dessous. Inventaire complet de licences/secrets d’un artefact
redistribué, Docker Compose et Hyper-V restent hors de ces preuves. Une
compilation réussie n’est pas une release commerciale.
Le workflow expérimental et sa matrice restent inchangés et ne fournissent pas le
check `build` ; aucune fusion ou publication n’est effectuée par ce patch.


## Smoke HTTP standalone — protocole ajouté, Linux réel encore à mesurer

La même phase `standalone` conserve les contrôles BUILD_ID, server.js, manifests,
static et output standalone. En mode swap, les trois source maps doivent toujours
être désactivées et cpus=2. `--validation-only` ne démarre ni Next ni ce serveur.
Le succès de la phase exige désormais aussi une réponse `/api/health` JSON avec
status=ok, `/login` en HTML200 et deux ressources distinctes `/_next/static/`
référencées par ce HTML, non vides et de type CSS ou JavaScript.

`scripts/ci/linux-standalone-smoke.py` copie la sortie standalone dans un stage
privé possédé puis y ajoute public et .next/static, selon les premières copies du
Dockerfile natif. Les liens internes relatifs peuvent être conservés ; les liens
absolus, sortant de leur source, les racines/ancêtres de copie symboliques et les
collisions de destination symboliques sont refusés. Les surcharges de packages
runtime du Dockerfile (notamment sharp/oracledb et bundles spécifiques) ne sont
pas requalifiées par ce stage.

Node24 démarre en production sur un port IPv4 loopback libre. Avant chaque GET,
le listener doit être associé à un inode socket du PID Node enfant encore
possédé dans procfs ; un listener étranger n'est jamais interrogé. Aucune
redirection n'est suivie, chaque réponse est bornée à1Mio et chaque attente HTTP
à5s au plus, dans une fenêtre HTTP de67s. Huit secondes sont réservées à l'arrêt ;
la phase entière est plafonnée à120s par le superviseur existant. TERM, puis KILL
si nécessaire, ciblent uniquement cet enfant avec wait. Une interruption ou une
lecture HTTP refusée reste un échec, même quand le nettoyage réussit.

L'environnement runtime est une sélection fermée des fixtures du build possédé,
avec télémétrie désactivée, aucun compte ni clé IA, aucun DSN de migration transmis
au serveur. La base éphémère existante n'est pas migrée pour ce smoke. Le health
natif ne consulte pas la DB ; ni health, ni la page login sans session ne prouvent
une autorisation, une authentification ou un fonctionnement métier PostgreSQL.

Les logs serveur restent dans un fichier temporaire privé puis sont supprimés,
sans impression ni upload. Le seuil8Mio est contrôlé pendant l'attente du listener
et après les lectures HTTP, pas un quota disque continu. Le reçu fermé
`standalone-http.json` ne contient aucun corps, chemin d'asset, URL, argument,
environnement, secret ou exception brute. Les reçus phase/cgroup/cleanup/OOM
existants restent bloquants ; aucun ancien succès n'est attribué à ce protocole.

La phase de tests existante exécute les tests du contrôleur puis
`python3 scripts/ci/test-linux-standalone-smoke.py -v` avant les étapes lourdes.
Les tests portables utilisent de petits serveurs Python fictifs possédés avec un
listener doublé hors Linux. Le cas Linux procfs utilise réellement les inodes du
socket enfant et est explicitement ignoré sur Mac. Ces tests ne remplacent pas
une exécution du standalone Next réel dans la future CI. Aucun build Linux avec
ce nouveau smoke, aucune recette navigateur, Windows ou release n'est revendiqué
par l'ajout du code.

## Recette navigateur du standalone, sans fournisseur

Le job de build Linux sélectionne explicitement `MEMLIA_CI_CHAT_UI=1`, uniquement
avec `--swap turbopack`. Il réemploie le standalone de cette même compilation,
après le smoke health/login/deux assets existant. Aucun second build n'est lancé.
Les modes sans sélection UI et `--validation-only` conservent leur parcours ;
la sélection UI avec un mode incompatible est refusée.

La recette installe le Chromium attendu par `@playwright/test` déjà verrouillé,
avec le Node24.22.0 du runner, puis crée une base et trois rôles synthétiques dans
le PostgreSQL possédé par le job. Le rôle de migration seul migre le journal0440 ;
les rôles web/realtime n'ont ni DDL, ni superuser, ni création de rôle/base.
Un utilisateur fictif est créé par la fixture avec le hachage Better Auth natif.
Le navigateur remplit le vrai formulaire, sans cookie ni session injectés.
Il doit observer une vraie session, le token natif et une connexion Socket.IO
encore ouverte, la création native d'un workflow, puis son graphe sauvegardé et
ses nœuds DOM visibles sans spinner. Enfin, le panneau doit afficher le refus
Chat et l'API capabilities doit répondre `unavailable` avec `no-store`.

La policy root-owned est délibérément `{}` et donc invalide. Aucune clé ni aucun
appel fournisseur n'est configuré. Cette preuve ne qualifie ni conversation IA,
ni qualité d'une proposition, ni confirmation d'une modification par modèle.
Elle ne qualifie pas non plus le déploiement Compose ou Windows.
Les seules deux origines du contexte navigateur sont `localhost:3000` et
`localhost:3002` (ainsi que leur transport WebSocket). Web/realtime/Valkey sont
sur un réseau Docker interne, ports web/realtime publiés sur127.0.0.1 seulement.
Ce contrôle du contexte Playwright ne prétend pas être une sandbox OS du navigateur.

Après le build, web est limité à5Gio, realtime256Mio et Valkey128Mio, sans swap
supplémentaire, avec CPU/PID bornés, filesystem racine RO et capabilities retirées.
Les options effectives et identités/labels possédés sont inspectés. Les mesures
cgroup des phases restent celles du contrôleur existant ; l'inspection des options
n'est pas une mesure de pic des services. Le plafond UI est1200s, readiness180s et
navigateur900s au maximum, avec150s réservées aux arrêts et au nettoyage. Ces
plafonds n'étendent jamais le superviseur global6900s ni le job120min existants.

Les services sont arrêtés avant la suppression native du compte et des seuls
résidus attribués à la fixture. Les183 inventaires doivent retrouver exactement
leur baseline avant commit et en readback. Une erreur HTTP, un service mort/OOM,
un signal, un dépassement ou un nettoyage incomplet interdit le succès global.
La base/les rôles temporaires disparaissent avec le PostgreSQL possédé du job.
Les logs, DSN, mots de passe, cookies, captures et traces réseau restent privés
sur le runner éphémère, sans upload. Seul le reçu JSON fermé `chat-ui.json`
(borne4Kio, champs exacts, pas de symlink) et les métriques fermées sont publiés.

Les tests locaux de préparation couvrent les frontières et le shell avec des
doubles explicités, sans lancer Docker, PostgreSQL, Chromium ou Next. La vraie
recette Linux navigateur reste NON TESTÉE jusqu'à une exécution Actions relue.
Le runner standard gratuit n'offre pas une garantie de disque40Gio : la réserve
existante du swap et les contrôles disque restent bloquants, sans suppression
globale de SDK. La revue et les gates de publication précèdent tout lancement.

La CLI Playwright est résolue depuis `apps/sim/package.json` par le résolveur Node
natif, avec version `1.61.1` contrôlée avant téléchargement ; aucune disposition
particulière de `node_modules` n'est supposée. Le cache reste disponible pour le
nettoyage natif de la fixture, puis son identité, son état vivant et l'absence
d'OOM sont contrôlés avant son arrêt attendu. Un échec reste bloquant même si le
nettoyage est rappelé. L'observation du canvas vérifie aussi la visibilité et
l'opacité des nœuds et de leurs ancêtres ; les tests locaux de cette logique
restent des doubles DOM, pas une qualification Chromium/Linux.
