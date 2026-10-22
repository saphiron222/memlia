# Outil Excel réservé au worker natif

`memlia_excel_transform` est une opération interne du registre Sim, résolue par le chargeur serveur. Sa chaîne réelle est `GenericBlockHandler → executeTool → executeMemliaExcelTool → executeExcelFile → prepareExcelThroughHost`, puis le présentateur natif reçoit exactement le `InternalToolFileResult` protégé. Le run conserve sa finalisation et ses fichiers natifs ; aucun run, appel HTTP, ordonnanceur ou finaliseur parallèle n'est ajouté.

## Configuration opérateur et portée

Le point d'entrée `scripts/memlia-workflow-worker.ts` lit une seule fois `MEMLIA_EXCEL_HOST_SOCKET` et `MEMLIA_EXCEL_HOST_OPERATOR_UID`, avant l'attente du démarrage. Tous deux absents laissent Excel indisponible ; une présence partielle ou invalide refuse le démarrage. Le chemin doit être absolu, normalisé et borné à 100 octets ; l'UID est une chaîne décimale canonique non négative de 32 bits. Ces vérifications de forme ne qualifient ni socket ni permissions Linux : le client hôte conserve leurs contrôles natifs.

`runWithExcelToolWorkerRuntime` copie strictement ces deux valeurs dans un `AsyncLocalStorage` privé. Le handler ne lit aucun environnement. La portée est uniquement un raccordement serveur de processus, pas une autorité utilisateur ou une capacité sérialisable. Les paramètres de l'outil ne peuvent ni l'établir ni la remplacer. Sans portée, le handler refuse avant préparation ; aucun Python local n'est utilisé en repli. Next ne doit recevoir ni socket hôte ni cette enveloppe worker.

La boucle `Worker` réellement installée de pg-boss conserve la portée créée autour de son `start()`, même si son callback a été construit auparavant : le test utilise cette boucle native, avec uniquement `fetch` DB doublé. `Manager.work` démarre les instances dans cette chaîne. Un callback simplement créé dans une portée puis invoqué ailleurs ne la transporte pas ; son test refuse. Ceci ne qualifie pas une nouvelle exécution PostgreSQL ou un mapping UID Linux.

## Requête, autorité et résultat

Le seul paramètre déclaratif est `request` : procédure canonique, sélections de fichiers workspace et nom de nouvelle sortie, selon `EXECUTE_EXCEL_FILE.md`. Ce paramètre est réservé à la configuration utilisateur du workflow. Il n'apporte aucun principal, run, chemin opérateur, image ou classification. Le contexte séparé vient du moteur ; le module métier conserve toutes ses captures, permissions, versions, classifications et revalidations. Copilot et les contextes incomplets restent refusés.

Le handler renvoie le résultat protégé sans copie. La composition de test traverse réellement le handler de bloc, l'exécuteur d'outil, le registre interne et le présentateur ; elle vérifie les deux revalidations, le sixième argument provenance d'upload et le refus d'une copie perdant la liaison. La préparation de fichiers, la DB de permissions et les écritures de stockage sont doublées dans cette composition ; leurs tests métier natifs restent distincts. Les refus propres au port sont fixes, sans cause brute, et non réessayables ; aucune autorisation de rejouer un effet n'est déduite d'un échec.

## Portée livrée et prérequis restants

Le registre d'outils et ses trois projections de métadonnées connaissent l'opération. Les autres entrées sont conservées ; les fonctions du générateur amont sont réutilisées pour le fragment. Aucun bloc de toolbar n'est ajouté par cette tranche et aucune sélection UI n'est qualifiée. Le document métier du parent décrit sa tranche antérieure avant ce raccordement ; ses contrôles restent inchangés.

`QUALIFIED_IMAGES` reste vide. Une image distribuable admise, la configuration hôte, les montages et le mapping UID Linux du worker demeurent nécessaires. L'absence de ces prérequis refuse ; l'ID de l'image CI supprimée n'est pas réutilisé. Cette tranche ne qualifie ni Docker, ni stockage réseau, ni téléchargement UI, ni transformation Linux activée. Aucune route ou clé n'est ajoutée.
