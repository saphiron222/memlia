# Transport Unix du processus Excel — intégration inactive

Le client `apps/sim/lib/execution/sandbox/excel-host.ts` et le processus hôte
`host.py` raccordent le protocole `memlia.excel-process/v1` au superviseur natif.
Ils ne constituent ni une file de jobs, ni une autorisation de fichier, ni une
publication. `QUALIFIED_IMAGES` reste vide : tout appel réel à `execute` refuse.
L'image éphémère de la recette CI a été supprimée et n'est pas réutilisée.

## Déploiement et identité

`host.py` reçoit exactement quatre arguments opérateur : chemin absolu du socket,
ID d'image `sha256`, UID du worker autorisé et GID du socket. Il charge le seul
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

## Réemploi et prochain appelant métier

`excel-process-protocol.ts` contient la capture JSON stricte et la revalidation
extraites du caller historique : base64 canonique, tailles, digests, rôles,
identités de feuilles, contrôles et annulation. `prepareExcelInProcess` conserve
son exécution locale historique pour ses callers explicites et tests ; ce n'est
jamais le fallback du nouveau client. Le nouveau client restitue seulement
`prepared_in_memory`, `published:false` après cette même revalidation.

Le prochain appelant est un outil Excel générique interne du moteur Sim :
`GenericBlockHandler` → `executeTool` avec `options.executionContext` → registre
interne → résultat du bloc. Il devra résoudre chaque sélection par
`readWorkspaceFileContent.execute`, recontrôler portée/version/provenance avant
publication et conserver les classifications contributrices. Le mécanisme natif
`storeInternalToolFileResult` appelle déjà `uploadExecutionFile` ; sa frontière
de provenance devra être raccordée explicitement avant usage Excel. Le vrai run
enregistrera le `UserFile` dans son output puis finalisera normalement.
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
caller sont conservés ; le superviseur et ses tests restent inchangés.

Cette tranche ne qualifie ni image distribuable, ni peer Linux réel, ni
publication/téléchargement métier, ni DB, ni exécution depuis l'UI. Ces portes
restent à raccorder et revoir avant activation.
