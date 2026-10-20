# Transport Unix du processus Excel — intégration inactive

Le client `apps/sim/lib/execution/sandbox/excel-host.ts` et le processus hôte
`host.py` raccordent le protocole `memlia.excel-process/v1` au superviseur natif.
Ils ne constituent ni une file de jobs, ni une autorisation de fichier, ni une
publication. `QUALIFIED_IMAGES` reste vide : sans admission opérateur locale
explicitement capturée, tout appel réel à `execute` refuse. L'ancienne image
éphémère supprimée n'est pas réutilisée ; aucune preuve historique n'est réattribuée.

## Admission opérateur hors requête

L'option CLI `--admission-file` est réservée à l'opérateur. `serve` capture sa
configuration avant de créer le listener ; ni le frame, ni un champ de procédure,
ni le modèle ne choisit ce chemin, le digest ou la preuve. Sans option, le défaut
reste fermé. Aucun fallback ni allowlist modifiée en mémoire.

`admission.json` et son seul voisin fixe `proof.json` sont des fichiers réguliers
0400, avec un lien unique, appartenant à l'UID du host. Leurs ancêtres réels sont
possédés par root ou le host, sans écriture groupe/autres. Les métadonnées sont
comparées entre lstat, fstat et après lecture, ainsi que l'identité des ancêtres.
Deux JSON de 16 Kio maximum, sans clé dupliquée/extra ni valeur non finie, sont
capturés : aucune lecture différée de configuration mutable pendant le travail.

Le schéma opérateur `memlia.excel-local-admission/v1`, `purpose:local-host`, lie
`imageId`, `sourceCommit`, `lockSha256`, `contextSha256`, `supervisorSha256` et
`proofSha256`. La preuve `memlia.excel-isolation-proof/v1` porte les cinq mêmes
identités, `imageHeld:true` et exactement les huit cas de qualification, chacun
avec `passed:true` et `cleanupComplete:true`. Le hash du superviseur doit être
celui réellement chargé ; `execute` exige l'objet immuable capturé pour cette
image et ce code. Une chaîne `sha256`, un dict transmis par le demandeur ou le
statut d'une ancienne campagne ne suffisent pas.

Ce fichier est une décision locale de l'opérateur, pas une signature prouvant à
lui seul l'exécution de tests. L'opérateur doit examiner la provenance et les vrais
résultats avant de l'installer. La recette CI manuelle installe cette configuration
uniquement après ses huit oracles réels, puis la retire avec son namespace. Aucun
registre public ni admission métier/permission de fichier n'en découle. Un process
host ou un administrateur compromis reste hors de cette frontière de confiance.

## Déploiement et identité

`host.py` reçoit quatre arguments opérateur : chemin absolu du socket,
ID d'image `sha256`, UID du worker autorisé et GID du socket, ainsi que l'option
explicite `--admission-file` décrite ci-dessus. Il charge le seul
`supervisor.py` adjacent, sans module choisi par le demandeur. Le processus hôte
est distinct de Next et du worker métier ; lui seul dispose du socket Docker.
Son répertoire, son code et sa configuration sont installés par l'opérateur.
Le service manager doit appliquer les bornes de processus et protéger ce code.

Le socket Unix est monté **seulement dans le worker de confiance**. Aucun montage
dans Next, le navigateur ou un outil générique non autorisé. Le UID réel observé
par Linux `SO_PEERCRED` doit correspondre exactement à l'UID opérateur autorisé,
non nul et différent du propriétaire du service. Il ne représente pas un
utilisateur Sim : l'autorisation métier demeure celle du run.

Les ancêtres doivent être des répertoires réels, possédés par root ou le service,
sans écriture groupe/autres. Le socket est créé en mode privé, puis configuré
`0660` avec le GID opérateur. Aucun socket préexistant, même apparemment ancien,
n'est supprimé. Avant chaque acceptation et à la fermeture, identité
dev/inode/UID/GID/mode et nature du socket sont contrôlées. Un remplacement ou
une disparition refuse le nettoyage ; aucune ressource étrangère n'est retirée.

Le client exige Linux, vérifie les ancêtres et le propriétaire du socket, puis
recontrôle la même identité après connexion avant d'envoyer le corps. Sa
configuration est capturée avant le premier await ; le payload ne peut choisir
ni socket, ni UID, ni image. Une installation inline sans socket refuse, sans
retour vers Python local. Le mapping UID réel conteneur/hôte, les ACL effectives
et les montages devront être qualifiés sous Linux avant activation.

## Cadres et fermeture

Une connexion transporte un seul travail. La requête est une longueur uint32
big-endian suivie des octets JSON capturés par le protocole natif, au maximum
14 Mio. La lecture complète dispose de cinq secondes. Le pair garde son côté
écriture ouvert : EOF, octet supplémentaire, SIGTERM/SIGINT du service ou
déconnexion déclenchent l'annulation transmise à `execute`.

La réponse comprend un statut d'un octet et une longueur uint32 big-endian.
Statut `0` : réponse native complète, non vide, au maximum 14 Mio ; statut `1` :
refus fermé, longueur zéro. Une fermeture sans réponse complète est aussi un
refus. Aucun message d'exception, chemin, argument, reçu Docker ou contenu de
procédure n'est envoyé dans le refus. Les erreurs CLI sont fixes.

Le service accepte au plus un travail actif. Les connexions supplémentaires
sont refusées sans admission ni attente métier. Il appelle exclusivement
`supervisor.execute(image_opérateur, wire, cancel=...)`, sans détourner
`_run_owned` ni modifier l'allowlist. La réponse n'est envoyée qu'après son retour
et `cleanupComplete:true`. Un cleanup inconnu ferme l'admission du service ;
aucun retry automatique ou acquittement métier n'est produit.

Le superviseur conserve ses bornes natives d'exécution et de nettoyage. Le
client borne l'attente socket par le timeout de la procédure, plafonné à 120 s,
et attend la fermeture de son socket possédé avant de répondre. Une annulation
côté client ne prouve pas à elle seule que le nettoyage distant est terminé :
elle refuse la sortie, tandis que le service conserve le travail actif jusqu'au
retour du superviseur. L'écriture de réponse hôte est bornée à cinq secondes.

## Réemploi et parcours métier restant à qualifier

`excel-process-protocol.ts` contient la capture JSON stricte et la revalidation
extraites du caller historique : base64 canonique, tailles, digests, rôles,
identités de feuilles, contrôles et annulation. `prepareExcelInProcess` conserve
son exécution locale historique pour ses callers explicites et tests ; ce n'est
jamais le fallback du nouveau client. Le nouveau client restitue seulement
`prepared_in_memory`, `published:false` après cette même revalidation.

L'outil générique `executeExcelFile` existe déjà dans le moteur Sim : il résout
les sélections avec `readWorkspaceFileContent.execute`, vérifie l'autorité native,
appelle `prepareExcelThroughHost` et lie la publication à une nouvelle lecture
de portée/version/provenance avec `bindInternalToolFilePublication`. Le mécanisme
natif `storeInternalToolFileResult` appelle `uploadExecutionFile`. Le futur run
composé devra attester ces ports réels, enregistrer le `UserFile` dans son output
et finaliser normalement.
`downloadWorkflowRunFileStream` revalidera ensuite le run terminal et l'accès au
contenu. Aucun faux run, appel manuel à `LoggingSession.complete`, registre
d'outil ou stockage n'est ajouté par cette tranche.

## Preuves et limites

Les tests TypeScript utilisent de vrais sockets Unix locaux. Les métadonnées
Linux/propriétaire sont explicitement doublées sur Mac ; un cas transmet aussi
de vrais octets XLSX au package Python installé puis relit le résultat avec
openpyxl et un oracle littéral. Son endpoint hôte est un double de protocole,
pas une exécution isolée Linux.

Les tests Python utilisent de vrais sockets Unix et fichiers POSIX. Ils doublent
le peer Linux et le lancement de conteneur pour les cas de réussite/annulation,
mais le refus de l'image inconnue utilise la vraie gate vide. Le cas natif
`SO_PEERCRED` est explicitement sauté sur Mac, sans en faire une réussite.
Ils couvrent aussi le refus busy, le cleanup inconnu, les cadres incomplets et
le refus de supprimer un socket remplacé. Les trente tests historiques du
caller, les cinq fonctions de transport/cleanup du superviseur et ses tests
sont conservés ; seule sa gate publique reçoit l'admission opérateur.

Cette tranche ne qualifie ni image distribuable, ni peer Linux réel, ni
publication/téléchargement métier, ni DB, ni exécution depuis l'UI. Ces portes
restent à raccorder et revoir avant activation.
