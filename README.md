# Memlia

Plateforme d’automatisation pour les cabinets d’expertise comptable, en développement. Le serveur cible est une VM Linux avec Docker Compose ; les automatisations Windows utilisent un agent local supervisé.

Ce dépôt contient un socle issu de Sim, ainsi que les premiers composants Memlia. Le produit complet n’est pas encore qualifié ni prêt à être installé chez un client. Le backend Chat indépendant, les parcours Windows/Excel et plusieurs contrôles de livraison restent en développement.

## Droits

Le code Sim réutilisé conserve sa licence Apache-2.0 et les conditions propres à ses composants. Voir [la licence amont](compliance/upstream/sim/LICENSE), [la notice amont](compliance/upstream/sim/NOTICE) et [la provenance et les droits](RIGHTS.md). Les composants Enterprise exclus et les polices non admises ne sont pas distribués.

**Les nouveaux développements Memlia restent sous droits réservés.** La visibilité publique pendant le développement ne leur attribue pas de licence open source. Aucune licence de marque Sim, OpenAdapt ou d’un fournisseur tiers n’est accordée.

## Vérification de compilation Linux

Une mesure GitHub Actions est prévue sur un runner Linux standard public. Elle doit relever la RAM effectivement disponible, le pic du groupe de compilation, la durée et le résultat complet. Aucun artefact de production n’est publié par cette mesure. Le garde mémoire macOS de développement demeure dans [scripts/dev](scripts/dev/README.md).

L’installation frozen utilise les versions figées dans le verrou. Les licences des dépendances installées et des artefacts finaux nécessitent leurs contrôles distincts avant toute livraison commerciale. Les règles de publication se trouvent dans [compliance](compliance/README.md).
