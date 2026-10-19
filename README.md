# Memlia

Plateforme d’automatisation pour les cabinets d’expertise comptable, en développement. Le serveur cible est une VM Linux avec Docker Compose ; les automatisations Windows utilisent un agent local supervisé.

Ce dépôt contient un socle issu de Sim, ainsi que les premiers composants Memlia. Le produit complet n’est pas encore qualifié ni prêt à être installé chez un client. Le backend Chat indépendant, les parcours Windows/Excel et plusieurs contrôles de livraison restent en développement.

## Droits

Le code Sim réutilisé conserve sa licence Apache-2.0 et les conditions propres à ses composants. Voir [la licence amont](compliance/upstream/sim/LICENSE), [la notice amont](compliance/upstream/sim/NOTICE) et [la provenance et les droits](RIGHTS.md). Les composants Enterprise exclus et les polices non admises ne sont pas distribués.

**Les nouveaux développements Memlia restent sous droits réservés.** La visibilité publique pendant le développement ne leur attribue pas de licence open source. Aucune licence de marque Sim, OpenAdapt ou d’un fournisseur tiers n’est accordée.

## Vérification de compilation Linux

Le [contrôle Linux du témoin Next16.4.2](https://github.com/saphiron222/memlia/actions/runs/39239854145) passe les types en 69,713 secondes ainsi que les bundles CLI et sandbox. Le [build complet du même témoin](https://github.com/saphiron222/memlia/actions/runs/39240286480) échoue dans Next après 782,396 secondes par manque de heap V8, avec un pic cgroup de 12 652 277 760 octets sous une limite de 13 Gio ; aucun OOM cgroup. Le heap est plafonné à 10 Gio et le cache webpack est en mémoire. La configuration `experimental.cpus:2` ne signifie pas deux compilateurs webpack simultanés : Next sérialise ici ses workers de compilation. Le standalone reste non vérifié. Les quatre mesures antérieures Next16.4.0 étaient également négatives ; elles ne constituent pas un A/B strict avec cette version.

Le runner public gratuit de 16 Go n'est pas qualifié pour ce profil de build complet. Ni une optimisation future ni un besoin précis de 24–32 Go ne sont démontrés par ces échecs. Il ne s'agit pas d'un dimensionnement du serveur d'un cabinet. Aucun runner payant n'est activé ; le garde mémoire macOS demeure inchangé dans [scripts/dev](scripts/dev/README.md).

Le [contrôle Linux des sources publiées précédentes](https://github.com/saphiron222/memlia/actions/runs/39244851841) a réussi : types en 64,856 secondes, pic cgroup de 11 608 432 640 octets, bundles CLI et sandbox. Il ne lance pas Next. Le [nouvel essai borné du build complet](https://github.com/saphiron222/memlia/actions/runs/39246257403), avec heap11, échoue également par manque de heap V8 après 764,174 secondes. L'observation native montre le début de compilation serveur, sans fin collectée ; le pic cgroup atteint 13 957 734 400 octets sous la limite de 13 Gio. Aucun OOM cgroup n'est signalé, mais la marge est quasi nulle. Les types de ce témoin passent en 70,963 secondes. Aucune hausse supplémentaire de heap ni machine payante n'est lancée.

Le [contrôle global de la révision précédente](https://github.com/saphiron222/memlia/actions/runs/39250140046) a échoué avec 71 diagnostics de types, sans manque de mémoire. La présente révision corrige l'inférence circulaire et introduit une frontière contrôlée entre la réponse serveur et les types de l'éditeur : un snapshot non représentable est refusé sans conversion ou perte silencieuse, et l'intention reste conservée. Son contrôle global Linux reste à effectuer ; les types verts d'une ancienne révision ne le remplacent pas.

Annuler/Rétablir sauvegarde désormais le graphe et les variables par contrôle de révision, puis relit le snapshot réellement persisté avant de déplacer l'historique. Les remplacements complets par l'ancien trajet socket sont refusés avant persistance ou diffusion ; leur intention reste en mémoire et le workflow concerné affiche le besoin de synchronisation. Les autres workflows peuvent progresser. Cette conservation est en mémoire, sans reprise durable qualifiée après fermeture de session. La composition corrigée passe 465 tests ciblés, relus indépendamment, avec doubles explicites du réseau/authentification ; aucune recette navigateur complète n'est revendiquée.

Un port Excel analyse la forme complète d'une procédure et les seules options reconnues par le noyau existant. Il retourne toujours `executionAvailable:false` : données, contrôles métier, autorité, intégrité, écriture et runner ne sont pas qualifiés. Sa revue comprend 83 tests TypeScript et 49 tests Python sur primitives réelles, avec données fictives et classeur en mémoire. Aucun accès Excel Desktop ou exécution d'une procédure complète n'est impliqué.

La prévisualisation d'opérations reste raccordée aux providers uniquement sous sélection serveur explicite ; aucune route Chat complète ou worker durable n'est activé. Aucune API IA ou Microsoft réelle n'a été appelée pour ces tests. Le délai d'admission passe de 15 à 25 minutes après une interruption officielle pour durée maximale, avec les mêmes contrôles et permissions. Les futures expériences de compilation restent distinctes de cette validation de types.

Un [contrôle Linux distinct](scripts/ci/README.linux-validation.md) permet de vérifier les types et bundles natifs sans lancer Next build. Sa réussite ne satisfait pas le check `build` obligatoire et ne produit pas de standalone qualifié. Aucun artefact de production, journal brut, cache ou dépendance n'est publié par ces workflows.

L’installation frozen utilise les versions figées dans le verrou. Les licences des dépendances installées et des artefacts finaux nécessitent leurs contrôles distincts avant toute livraison commerciale. Les règles de publication se trouvent dans [compliance](compliance/README.md).
