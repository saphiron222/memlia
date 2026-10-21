# Inbox Excel — découverte POSIX et snapshot en mémoire (P14, inactif)

`memlia_excel.ingestion` ajoute seulement les primitives manquantes de découverte
bornée et copie de contenu. Les traitements, contrats, parseur XLSX, stockage de
fichiers et jobs Sim existants sont conservés. **Aucun watcher, polling, scheduler,
trigger, route, commande LLM ou exécution n’est enregistré ou activé.** Aucun
nouveau package n’est requis : bibliothèque standard Python seulement.

## Interface interne et responsabilité du caller

1. L’adaptateur serveur autorisé résout une racine absolue depuis un binding
   d’inbox configuré par l’administrateur. Un chemin du modèle ou d’un utilisateur
   ne devient jamais une configuration par le seul fait d’être une chaîne valide.
2. `observe_inbox(root)` retourne des `FileObservation` et des rejets nommés avec
   raison. Deux appels séparés par l’intervalle choisi par le serveur fournissent
   les observations. Le module ne dort pas et n’entretient aucun état de polling.
3. `take_snapshot(root, first, second, handoff_digest=..., minimum_stable_ns=...)`
   requiert les deux observations stables et le digest exact de remise du producteur,
   au format canonique `sha256:<64hexminuscules>` déjà utilisé par `ResolvedXlsx`.
4. Le résultat est un `InboxSnapshot` gelé contenant `name`, `content: bytes` et
   `sha256`. Les octets sont possédés et immuables ; une modification ultérieure
   du fichier ne modifie pas le snapshot en mémoire.
5. Le futur adaptateur autorisé doit **persister et relire/hash-vérifier** ce contenu
   via les file IDs/storage natifs Sim avant admission d’un job existant. Il doit
   vérifier Principal, workspace, binding, version, source, droits et délégation.
   Ce module n’ajoute ni stockage concurrent ni grant, reçu durable ou autorité.

Les observations sont volatiles et utilisent l’horloge monotone locale : les renouveler
après reboot, ne pas les restaurer comme un reçu durable. Les dataclasses sont un
type interne Python, pas un nouveau contrat JSON partagé.
Une observation, un digest ou un snapshot n’autorise aucune lecture ou exécution
au nom d’un autre utilisateur. Aucune donnée n’est envoyée au modèle.

## Fin d’écriture et limites de la preuve

**Deux tailles/statuts identiques ne prouvent jamais la fin d’écriture.** Le caller
utilise un protocole de remise contrôlé : fichier écrit hors inbox/en `.partial`,
fermé puis renommé définitivement, avec digest complet remis par le producteur
identifié. Le module exige ce digest et vérifie exactement les octets copiés ; le
hash seul n’établit ni authenticité du producteur, ni autorité, ni achèvement métier.
Il ne remplace pas ce protocole par un délai heuristique ou un `fs.watch`.

Le profil initial couvre des fichiers `.xlsx` directs, sans récursion. Une extension
n’est pas une validation Excel : le parseur/profil canonique existant refuse ensuite
les archives, XML ou contenus incompatibles. CSV et autres formats doivent passer
leurs adaptateurs/profils explicites ; ils ne sont pas convertis implicitement.

Un passage compte **toutes les entrées**, même rejetées : maximum32, réglable vers
le bas par `max_entries`. Au-delà, refus entier `entry_limit`, pas de pagination
silencieuse ou de lot tronqué. Une inbox doit donc recevoir des lots bornés ou être
partitionnée par le producteur. Maximum **10 000 000 octets par snapshot**, constante
`MAX_CONTENT` du transport actuel, réglable vers le bas par `max_bytes`. Les limites
cumulées de sources/job restent aussi à vérifier par le caller et le runtime.
Ce profil ne revendique pas l’objectif expérimental futur de100Mio.

## Protections effectivement appliquées

- Traversée de chaque composant depuis `/` avec `openat` (`dir_fd`), `O_DIRECTORY`
  et `O_NOFOLLOW` ; aucun parent ou racine symlink suivi. Nom direct UTF-8 borné,
  sans séparateur/traversal/NUL/contrôle/ADS ni nom réservé Windows.
- Pas de FIFO/device/dossier accepté ; nombre de liens strictement1 pour les
  sources régulières. Rejets explicites pour liens, `.partial`/`.tmp`, lockfiles
  Office `~$`, extension hors profil, fichier vide ou trop grand.
- Ouverture source `O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC` relative au descripteur
  de l’inbox. Verrou partagé `flock` non bloquant : refus si verrou exclusif détecté.
- Comparaison avant et après lecture du descripteur **et** de l’entrée à son nom :
  device/inode/nlink/taille/mtime_ns/ctime_ns, ainsi que l’identité device/inode de
  la racine. La racine configurée et ses parents sont reparcourus sans symlink avant
  retour pour refuser une substitution pendant la lecture.
- Lecture par tranches, au plus limite+1octet, puis SHA256 comparé à la remise.
  Refus → aucun snapshot retourné, aucune source écrasée, aucune sortie ou quarantaine
  écrite par ce module. Handles fermés avant livraison du résultat au caller.

Ce n’est **pas une sandbox contre un hôte hostile**. `flock` est coopératif et ne
bloque pas un writer qui l’ignore. L’OS/FS, les permissions et le protocole producteur
font partie des prérequis. Métadonnées réseau, caches SMB, pannes et délais d’appels
OS ne sont pas des garanties POSIX universelles : la future supervision doit imposer
une échéance/annulation et qualifier le montage réellement utilisé. Aucun mécanisme
ne préempte ici un appel noyau bloqué sur un partage distant.

## Rejets et idempotence

Les exceptions `IngestionRefused` portent un code fixe sans chemin/contenu/exception
native : `inbox_unavailable`, `source_unavailable`, `source_locked`, `source_changed`,
`source_not_stable`, `handoff_mismatch`, `invalid_handoff`, `invalid_observation`,
`invalid_name`, `invalid_root`, `invalid_limits`, `unsupported_filesystem`,
`input_limit`, `entry_limit`. Les rejets de découverte restent privés au binding et
conservent leur nom/raison ; ils ne doivent pas être journalisés publiquement.
Une inbox absente/inaccessible ne devient pas un succès vide.

Le même apport observé plusieurs fois donne les mêmes octets/digest. Le même nom
avec contenu changé exige de nouvelles observations et une nouvelle remise. **Ce
n’est pas une déduplication métier ou exactement-une-exécution** : ne pas utiliser
le digest seul pour fusionner utilisateurs, sources, occurrences métier ou versions.
Idempotence durable, reboot avant commit, quarantaine/accusé et publication multi-
sorties restent à raccorder au storage/outbox/admission Sim. Aucun retry de job ou
écrasement de sortie n’est effectué ici.

## Vérifications et limites de qualification

Tests `tests/test_ingestion.py` : fichiers temporaires POSIX réels, symlink/hardlink/
FIFO, verrou exclusif réel, tailles/entrées bornées, fichier en cours d’écriture,
inbox supprimée, doublons et contenu remplacé. Les mutations en cours de copie
utilisent une barrière autour du vrai `os.read` pour imposer un entrelacement
reproductible ; les mutations et les vérifications filesystem sont réelles, les
retours stat/lecture ne sont pas inventés. Ce n’est pas une preuve de toutes les
courses possibles ou d’un adversaire privilégié.

La composition de test réemploie le fixture/profil et `prepare_procedure` existants,
avec de vrais XLSX/Polars/openpyxl et readback. Elle retourne seulement
`prepared_in_memory`, `published=False` ; aucun job n’est lancé.

Tests sur macOS POSIX ≠ qualification Linux/SMB. Watcher permanent, persistance,
reboot, file IDs/autorité Sim, déclenchement navigateur fermé, déduplication métier,
partages réseau et release commerciale restent **NON TESTÉS/non implémentés** par
cette tranche. La réserve disque40Gio et les limites de l’environnement de tests
restent celles du projet ; aucun outil global installé ou paramètre modifié.

La racine accepte une chaîne ou un `PosixPath` concret de la bibliothèque standard,
jamais un objet `PathLike` actif ni une sous-classe personnalisée. Les types,
le chemin absolu sans remontée, les caractères NUL et l'encodage UTF-8 sont vérifiés
avant toute ouverture ; un refus de configuration produit `invalid_root` sans
exception native contenant le chemin.
