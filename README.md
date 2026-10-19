# Memlia

Plateforme d’automatisation pour les cabinets d’expertise comptable, en développement. Le serveur cible est une VM Linux avec Docker Compose ; les automatisations Windows utilisent un agent local supervisé.

Ce dépôt contient un socle issu de Sim, ainsi que les premiers composants Memlia. Le produit complet n’est pas encore qualifié ni prêt à être installé chez un client. Le backend Chat indépendant, les parcours Windows/Excel et plusieurs contrôles de livraison restent en développement.

## Droits

Le code Sim réutilisé conserve sa licence Apache-2.0 et les conditions propres à ses composants. Voir [la licence amont](compliance/upstream/sim/LICENSE), [la notice amont](compliance/upstream/sim/NOTICE) et [la provenance et les droits](RIGHTS.md). Les composants Enterprise exclus et les polices non admises ne sont pas distribués.

**Les nouveaux développements Memlia restent sous droits réservés.** La visibilité publique pendant le développement ne leur attribue pas de licence open source. Aucune licence de marque Sim, OpenAdapt ou d’un fournisseur tiers n’est accordée.

## Vérification de compilation Linux

Quatre mesures de compilation sur le runner Linux public standard de 16 Go ont échoué : Webpack avec tas de 8 et 10 Gio, Turbopack avec tas de 10 Gio, puis Webpack avec cache mémoire. [Le dernier essai](https://github.com/saphiron222/memlia/actions/runs/39223549449) atteint la limite V8 après 579,133 secondes, avec un pic cgroup de 11,872 Gio. Ces mesures portent sur le témoin Next16.4.0 ; elles ne qualifient pas le build des sources actuelles, passées depuis à Next16.4.2.

Le runner de 16 Go n'est donc pas qualifié pour ce build complet. Une machine de 24–32 Go reste une hypothèse de prochain essai, pas un minimum mesuré ni une recommandation de dimensionnement du serveur d'un cabinet. Aucun runner payant n'est activé. Le garde mémoire macOS de développement demeure dans [scripts/dev](scripts/dev/README.md).

Le [contrôle Linux de la révision précédente](https://github.com/saphiron222/memlia/actions/runs/39237426953) a terminé TypeScript sans OOM en 43,001 secondes : les huit diagnostics antérieurs sont absents, et un diagnostic de type JSON Schema restait dans le raccordement Chat. Cette révision corrige uniquement cette sélection de schéma ; 67 tests et une compilation isolée ont été rejoués par deux intervenants. L'analyse globale Linux de ce nouveau snapshot reste à exécuter. Aucune API IA ou Microsoft réelle n'a été appelée. Les nouvelles tranches de développement locales ne sont pas incluses dans ce témoin de mesure.

Un [contrôle Linux distinct](scripts/ci/README.linux-validation.md) permet de vérifier les types et bundles natifs sans lancer Next build. Sa réussite ne satisfait pas le check `build` obligatoire et ne produit pas de standalone qualifié. Aucun artefact de production, journal brut, cache ou dépendance n'est publié par ces workflows.

L’installation frozen utilise les versions figées dans le verrou. Les licences des dépendances installées et des artefacts finaux nécessitent leurs contrôles distincts avant toute livraison commerciale. Les règles de publication se trouvent dans [compliance](compliance/README.md).
