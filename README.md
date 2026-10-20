# Memlia

Plateforme d’automatisation IA pour les cabinets d’expertise comptable, en développement. Le serveur cible est une VM Linux avec Docker Compose ; les capacités Excel et Windows se raccordent à l’application Sim conservée. Cette publication de développement n’est pas une release qualifiée pour un cabinet.

## Droits

Le code Sim réutilisé conserve Apache-2.0 et les conditions propres à ses composants. Voir la [licence amont](compliance/upstream/sim/LICENSE), la [notice amont](compliance/upstream/sim/NOTICE) et la [provenance](RIGHTS.md). Les composants Enterprise exclus et les polices non admises ne sont pas distribués.

**Les nouveaux développements propres à Memlia restent sous droits réservés.** Leur visibilité publique ne leur attribue pas de licence libre. Les licences des composants tiers restent distinctes ; aucune licence de marque Sim, OpenAdapt ou fournisseur n’est accordée.

## Parcours en développement

Le socle conserve l’interface et les moteurs Sim autorisés. Les sauvegardes complètes utilisent une révision attendue ; les anciens remplacements complets par socket sont refusés. Les intentions Annuler/Rétablir, les snapshots et les changements de portée conservent leurs contrôles de concurrence.

Le Chat local est sélectionné explicitement par une politique administrateur côté serveur. Le parcours natif compose session, permissions, transcript texte autorisé, modèle administrateur et fenêtre tarifaire ; il réserve un budget avant chaque tentative physique. Les propositions affichent leur corps exact, révision et échéance, puis exigent une décision unitaire liée au digest et aux droits courants avant application. Ce budget est une **estimation USD au tarif liste**, pas une facture fournisseur ni un plafond global de tous les workflows. Aucun secret, clé ou profil tarifaire ne vient du modèle.

L’interface native expose les capacités disponibles et l’adoption explicite des réglages du cabinet. Les intentions locales restent refusées si leur portée ou leur profil dérive ; les fonctions non prises en charge sont signalées. Depuis Home, une création explicite de brouillon de workflow prépare le contexte requis avant le Chat. Le déploiement possède un profil local et les confirmations natives ; leur configuration effective reste nécessaire. L’absence de politique conserve le chemin historique, qui ne qualifie pas une installation indépendante. Une reprise de calcul locale après redémarrage n’est pas annoncée.

Une recette composée antérieure a exécuté sept cas avec PostgreSQL réel et le graphe natif, mais avec **texte, session/authentification et modèle doublés**. Elle ne qualifie ni un fournisseur réel, ni une session navigateur complète. Les tests ciblés de Home et du Chat ne valent pas recette visuelle d’un collaborateur. Un contrôle global TypeScript de la composition applicative a réussi en 27,129 s ; ce délai n’est pas un benchmark à froid et aucun résultat Next antérieur n’est réattribué à cet export.

Le runtime Excel réutilise Polars et openpyxl, les contrats canoniques et le [packaging hors index](runtimes/excel/PACKAGING.md). Son [protocole de processus](runtimes/excel/PROCESS_PROTOCOL.md) accepte uniquement des entrées déclaratives bornées et remet un résultat intégral revalidé. Un processus seul ne constitue pas une sandbox réseau ou système de fichiers. L’image non-root, le superviseur Linux et la [recette de qualification](runtimes/excel/linux/QUALIFICATION.md) sont préparés ; **la recette Docker/Linux réelle reste NON TESTÉE sur cette source**. La liste d’images admises demeure vide. Aucun classeur n’est publié automatiquement, aucun worker n’est activé par ce seul export.

L’agent Windows et l’adaptateur OpenAdapt sont préparés. Une recette native Windows x64 a réussi la compilation d’une fixture fictive, le chargement du workflow avec validation et vérification d’intégrité, ainsi qu’un refus natif sur entrée incomplète. Le moteur OCR natif a été initialisé et observé ; l’exactitude de transcription OCR n’est pas qualifiée. Le résultat reste un bundle **à tester**, et le Python généré n’a pas été exécuté. La supervision s’est terminée en 90,698 s avec nettoyage des seules ressources possédées de cette campagne. **Capture, replay, confinement réseau, installation et parcours Windows interactif restent NON QUALIFIÉS.** Ce succès borné ne requalifie pas les échecs antérieurs et n’en établit pas rétrospectivement la cause. Les preuves TLS et les tests de CredMan doublé ne qualifient pas les ACL Windows, Office ou l’autorité mTLS serveur.

## Composition applicative courante

Cette révision ajoute les préparations de tests Excel depuis l’interface native, le bloc Excel serveur, le raccordement du worker persistant pg-boss et les instantanés de procédure. La découverte d’une entrée Excel Linux produit une lecture bornée ; elle ne constitue ni un watcher durable, ni une autorisation d’exécuter. Les nouveaux ports Windows (contrôles locaux, JobObject et filtre Capture) restent inactifs tant que leurs qualifications composées et les autorisations serveur/locales ne sont pas satisfaites. Le patch Capture garde sa licence MIT et ses notices propres.

Le raccordement Anthropic utilise le SDK natif, le workspace administrateur et les réservations de coût avant chaque transport, sans worker propriétaire Sim. Un essai réel ciblé a renvoyé une proposition exacte de renommage, confirmée avant une seule mutation du graphe ; les trois tentatives représentent une estimation catalogue de 0,085211 USD. Cet essai conserve des doubles de session, de source de politique et de notification realtime ; il ne qualifie pas l’authentification du navigateur, le fichier de politique Linux, la qualité générale de génération ou une facture fournisseur. La clôture relue a confirmé les trois réservations et lignes de coût réglées, les 183 inventaires restaurés et l’arrêt des ressources possédées, sans échec de nettoyage. Le modèle demandé reste l’alias `claude-haiku-4-5` ; le modèle exact renvoyé n’est pas exposé par ce port. Un contrôle distinct de création d’un workflow a échoué sur son oracle de référence de sortie ; ce résultat et son rapprochement sont conservés séparément, sans rejeu automatique. La génération complète d’un nouveau workflow et son calcul ne sont donc pas qualifiés.

La CI préparée ajoute un parcours navigateur avec vraie connexion et Socket.IO, création d’un workflow et vérification du canvas, puis refus du Chat sans fournisseur. **Ce parcours navigateur/Linux sur cette révision reste NON TESTÉ** ; les tests locaux doublés ne le remplacent pas. Aucun nouveau build Linux ou déploiement Compose n’est revendiqué par cette composition.

## Compilation et contrôles Linux

Le parent public exact `a049b11fa9777a7a9c875759c88d3e20fc269174` a réussi le [build Linux](https://github.com/saphiron222/memlia/actions/runs/39327619309) et l’[admission arbre, historique, notices et secrets](https://github.com/saphiron222/memlia/actions/runs/39327619295). Next y a terminé en 525,591 s, OOM zéro, avec drainage passif puis absence de descendants et vérification des fichiers standalone. Ce témoin ne démarrait pas de serveur HTTP.

**Le nouveau build Linux, le smoke HTTP standalone et la recette Excel de cet export restent à exécuter.** Le smoke préparé conserve les contrôles BUILD_ID, manifests et configuration ; il doit ensuite démarrer un Node possédé et vérifier health, login et deux assets sur loopback. Health ne démontre pas une connexion DB ni une authentification réelle. Aucun résultat du parent ou d’un candidat historique en HOLD ne qualifie ces nouveaux contrôles.

Les jobs GitHub requis restent inchangés dans leur rôle. La recette Excel utilise un runner public standard gratuit, sans publication d’image ni activation automatique. La [matrice swap expérimentale](README.linux-validation.md) reste distincte ; son repli zram sous saturation n’est pas supposé qualifié. Aucun runner payant.

Un test natif du garde macOS a échoué pendant le nettoyage avec `PermissionError`. Le diagnostic ciblé suivant n’a pas reproduit cette erreur ; sa cause précise reste inconnue. Les sources et assertions de ce garde sont identiques à celles du parent public. Le garde mémoire local reste en pause opérationnelle autorisée, avec délais, réserve disque et nettoyage des processus possédés conservés. **Cet échec reste ouvert ; la suite Mac n’est pas annoncée verte et la fusion de cette composition est retenue.** Les essais GitHub Linux ne qualifient pas ce parcours macOS. Aucune release commerciale n’est déclarée.

## Limites

Les parcours multi-utilisateurs complets, les fournisseurs réels sous politique de cabinet, les autorisations et sauvegardes d’écriture Excel, Windows interactif, les images de production et la restauration restent à qualifier. Les anciens échecs restent conservés dans les preuves internes. Les secrets, rapports privés, données du laboratoire, artefacts bruts et historiques de travail privés ne sont pas publiés.
