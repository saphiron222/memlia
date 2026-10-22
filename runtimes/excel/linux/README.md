# Isolation Linux du processus Excel — recette et admission opérateur

Ce dossier ajoute une image et un superviseur **hôte**, hors application Next,
pour le seul protocole `memlia.excel-process/v1`. Il réemploie le packager natif
et `memlia_excel.process` → `prepare_procedure`, sans autre moteur Excel,
ordonnanceur, enregistrement de provider ni endpoint. Les interfaces sandbox Sim
V8/code et remote E2B/Daytona ne sont pas détournées pour recevoir une commande.

`supervisor.execute` exige une admission opérateur capturée pour l'image exacte
et le hash du superviseur. Le chemin natif est
`admission.describe/capture → host.serve(--admission-file) → supervisor.execute(admission.permits)`.
`QUALIFIED_IMAGES` reste une constante historique vide ; ce n'est pas la gate active.
Ni l'enveloppe, ni une variable publique, ni un booléen de demande ne fournissent
cette admission. La primitive privée `_run_owned` reste une frontière technique
pour la recette et les doubles, sans autorité métier.

Ce code fournit un mode explicite de promotion après qualification complète.
Ce commit ne livre aucune image admise réelle : les tests portables Mac avec
Docker et identité root doublés ne qualifient pas un moteur Linux, le noyau de
déploiement, les licences des couches ou le worker durable.

## Image à préparer hors application

`prepare_context.prepare(source, wheelhouse, destination, python_image)` reçoit
uniquement des chemins d'opérateur. La destination doit être nouvelle. La base est
obligatoirement `python@sha256:<64 caractères hex minuscules>` : aucun tag, pull
implicite ou digest fictif par défaut. Cette syntaxe n'atteste ni la version ni la
provenance de l'image choisie. La recette devra vérifier CPython3.12, Linux x86_64,
le digest exact, les licences et les composants de la base.

La préparation utilise `scripts/package.py` : `capture_sources` pour les deux
packages canoniques et `verify_wheels` pour le profil verrouillé
`linux-cp312-x86_64`. Seuls ces sources, le packager, le verrou, les roues Linux
hashées et le Dockerfile rendu sont copiés. Ni checkout entier, cache, credentials,
logs, fichier `.env`, application ni wheel Memlia étrangère ne sont repris. Les
roues et leur verrou copiés sont revérifiés. `context.json` inventorie les octets
copiés, sans qualifier une image ou son isolation.

Le Dockerfile utilise la même base par digest dans les deux stages. L'installation
se fait par le **packager natif** avec `RUN --network=none`, sans résolution de
paquets. Le stage final ne reprend que son runtime installé et son manifeste.
Le chemin du venv `/opt/excel/runtime` est identique pendant installation/exécution.
UID/GID65532, commande Python fixe, `env -i` puis sept valeurs d'environnement
fermées ; les variables héritées de la base ne sont pas transmises au Python.
Aucun secret, argument de procédure, chemin utilisateur, shell d'exécution, port
ou volume n'est ajouté. Construire et qualifier cette image reste NON TESTÉ ici.

## Superviseur et ressources

Le futur appel serveur autorisé fournit séparément le digest de l'image locale
qualifiée et des octets déjà capturés par le contrat existant (14Mio maximum).
`/usr/bin/docker --host unix:///var/run/docker.sock` est fixe ; aucun socket ne doit
être remis à Next ni au worker métier. Un contexte Docker temporaire0700 vide,
un environnement hôte fermé et `--pull never` évitent l'utilisation de credentials
ou d'une image distante implicite. Le nom/nonce vient du superviseur, jamais du
modèle. Aucune commande shell n'est exécutée.

Le profil demandé et inspecté est fixe :

| Contrôle | Valeur |
|---|---|
| Image | ID `sha256` exact ; metadata Linux/amd64 |
| Identité | ID64hex, nom possédé, labels nonce128bits et profilv1 |
| Exécution | UID/GID65532 ; Python installé/argv fixes ; cwd `/tmp` |
| Réseau | `none`, aucun port publié |
| FS | root RO ; aucun bind/volume hôte ; `/tmp` tmpfs128Mio,0700,UID/GID65532,noexec,nosuid,nodev |
| Mémoire | RAM512Mio, memory+swap512Mio (pas de swap additionnel demandé) |
| CPU/PID | 1CPU ; 32PID ; nofile256 ; core0 |
| IPC | privé ; `/dev/shm`8Mio, temporaire Docker distinct de `/tmp` |
| Privilèges | capabilities ALL retirées ; no-new-privileges ; non privilégié |
| Journaux/restart | log-driver none ; restart no ; init pour réaper les enfants |
| Temps/flux | exécution120s totale ; cleanup10s distinct ; stdout14Mio, tout stderr refuse |

Les tmpfs sont comptés dans la mémoire du conteneur. Le plafond disque concerne
ses temporaires, pas les couches d'image, le stockage global du daemon ou une
quota hôte. Les fichiers spéciaux Docker `/proc`, `/sys`, `/dev`, résolveur/hosts,
le seccomp par défaut, rootless/user namespaces et l'application effective des
cgroups nécessitent la recette Linux. Un inspect conforme n'est pas cette preuve.

Avant **start**, **stop** et **rm**, une inspection revalide ID+image+nonce+nom et
le même profil complet. Aucun signal par nom/PID client ou `rm --force` aveugle.
Une identité/propriété/options inconnues empêche l'action, même si cela laisse une
ressource nécessitant une intervention hôte. La sortie n'est rendue qu'après exit0,
état terminal nonOOM/nonmort, absence d'erreur native et retrait vérifié par nonce.
Erreur/cancel/overflow arrête d'abord le CLI enfant possédé, l'attend, puis demande
stop(1s) du seul conteneur revérifié et rm après état non-running. Les commandes
et le cleanup ont des échéances ; aucun retry de travail métier.

Un accusé de création perdu est une issue inconnue : la recherche par nonce peut
retrouver une identité puis permettre son nettoyage revérifié. Une recherche
vide ne prouve pas que le daemon ne créera pas la ressource plus tard ; le refus
conserve `cleanupComplete:false`. Aucun résultat n'est rendu après interruption
pendant cleanup. Les erreurs fixes gardent seulement un reçu hôte fermé
`containerId/nonce/createAcknowledged/cleanupComplete`, jamais wire, stderr,
arguments, chemins de fichiers ou exception brute. Ce reçu n'est pas public.

## Frontière de résultat et tests

`execute` retourne `(wire, receipt)` après admission et nettoyage vérifiés. Les octets sont un **transport**, pas un
résultat autorisé/publié : l'appelant doit réemployer la revalidation complète du
caller `excel-process.ts` avant de les remettre à une application. Cette tranche
ne raccorde pas encore ce caller au superviseur ni la permission d'exécuter un job.
Elle ne résout pas bindings, approbation, autorité, provenance de fichiers,
sauvegarde, publication atomique ou quotas commerciaux.

`test_supervisor.py` utilise un double explicite de Docker pour les inspections,
limites, changements d'identité, création ambiguë, OOM et cleanup. Il lance aussi
de vrais petits enfants Python pour stdin/EOF, stderr, overflow, délai,
annulation et wait du PID possédé. **Aucun daemon ou conteneur n'est lancé.**
`test_context.py` utilise les vraies sources, le packager et le wheelhouse verrouillé
via `MEMLIA_TEST_WHEELHOUSE`; son digest de base fictif n'est jamais tiré/construit.
Aucune absence de dépendance n'est transformée en qualification.

La recette Linux restante devra réellement construire/installer, faire passer
XLSX/digest/readback, tenter réseau et écritures interdites, mesurer les limites
mémoire/CPU/PID/tmpfs/cgroups, éprouver OOM/timeout/annulation/reaping/cleanup et
l'identité avant chaque action. Elle doit vérifier le comportement du CLI/daemon
lors de rupture de canal et les descendants observés/non observés. Docker est une
frontière à qualifier sur un hôte de confiance, pas une VM ni une preuve globale
de sandbox. Linux/Windows, ABI image, sécurité OS et intégration Sim restent NON
TESTÉS par les présents tests Mac/doubles.


## Promotion explicite d'une image exacte

Le comportement habituel de `qualification.py` reste éphémère : l'image possédée
est retirée par son ID et son nonce, après la recette. `--exercise-host` et
`--exercise-application` seuls conservent ce nettoyage. Aucun test réussi ne
promeut automatiquement une image.

Le seul opt-in `--operator-release DESTINATION` exige Linux x86_64, un opérateur
root, les deux modes host/application et une destination absolue nouvelle. Ses
parents doivent être de vrais répertoires protégés et possédés par l'opérateur
ou root ; aucun lien, parent inscriptible par un tiers ou remplacement de dossier
existant n'est permis. Préparer explicitement ce parent protégé avant la recette.

L'option ne devient effective qu'après les huit cas d'isolation avec leur
nettoyage, l'acceptation du pair UID1001 et le refus UID1002, l'arrêt propre du
host, puis business/readback et nettoyage final applicatif tous réussis. Une
ancienne preuve partielle ou un reçu avec `cleanupComplete:false` n'est jamais
rechargé comme approbation. Le commit propre, le verrou, le manifeste de contexte,
le superviseur et l'identité exacte image/nonce sont revérifiés avant export puis
avant publication. Une annulation ou mesure disque inconnue refuse la promotion.

Exemple **à réserver à un hôte Linux déjà préparé et à un candidat relu**, depuis
le checkout admis, avec des chemins d'opérateur nouveaux et protégés :

```sh
/usr/bin/python3 -B runtimes/excel/linux/qualification.py \
  --wheelhouse /var/lib/memlia/wheels \
  --output /var/lib/memlia/qualification/run-IDENTIFIANT \
  --exercise-host --exercise-application \
  --operator-release /var/lib/memlia/operator-bundles/release-IDENTIFIANT
```

Le collecteur CLI existant exporte uniquement `docker image save IMAGE_ID` :
stdout binaire vers un fichier neuf0400 en staging0700 privé, stderr borné au
journal privé et refusé, environnement fermé, timeout/annulation/enfant possédé
conservés. L'export est limité à2Gio, hashé en flux puis relu sous identité stable ;
la réserve disque est observée avant, pendant et après le flux. Le plafond de2Gio
est une limite de cette recette, pas une taille d'image qualifiée ni un quota client.

Le bundle contient exactement `image.tar`, `proof.json`, `admission.json` et
`release.json`, fichiers0400. Proof/admission réemploient les schémas et
`admission.describe` existants. Le manifeste fermé lie image ID, commit, verrou,
contexte, superviseur, hash des deux enregistrements et SHA256/taille de l'archive.
La publication finale utilise l'opération Linux atomique `renameat2` avec
`RENAME_NOREPLACE` ; si elle est indisponible ou si un autre opérateur a créé la
destination, la promotion refuse. Aucun fallback qui écrase n'est utilisé.

Après succès, **l'image exacte reste réellement présente dans le daemon**, avec
son export ; `imageHeld:true` ne désigne jamais l'archive seule. `runtimeActivated`
reste false : aucun service, socket ou worker n'est installé ou démarré. La
configuration du host utilise toujours les fichiers opérateur0400 et le même
code de superviseur. Le transport ultérieur de l'archive exige vérification de
son hash puis de l'ID exact après chargement ; l'archive seule ne prouve pas qu'une
image est chargée ailleurs.

Sur refus, aucun chemin de bundle réussi n'est retourné. Une réponse de commit
perdue ou une annulation déclenche la réconciliation seulement du dossier dont
l'inode et les fichiers correspondent encore exactement au staging possédé ;
une destination concurrente n'est pas retirée. Si cette propriété ou le nettoyage
reste inconnu, le reçu reste failed/cleanup incomplet et les ressources ambiguës
restent à réconcilier par l'opérateur, sans effacement forcé ni relance métier.

La portée du manifeste est `native_api_in_process`. Il indique explicitement
`durableWorkerQualified:false`, `deploymentKernelQualified:false` et
`imageLicensesReviewed:false`. Les licences/SBOM des couches, la correspondance
au noyau/cgroups cible, l'installation du host protégé et la qualification sous
le vrai worker durable Compose restent des gates séparées à prouver avant
utilisation cabinet. Ce mode de préparation ne constitue pas une release commerciale.
