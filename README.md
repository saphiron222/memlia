# Memlia

Plateforme d’automatisation pour les cabinets d’expertise comptable, en développement. Le serveur cible est une VM Linux avec Docker Compose ; les automatisations Windows utilisent un agent local supervisé.

Ce dépôt contient un socle issu de Sim, ainsi que les premiers composants Memlia. Le produit complet n’est pas encore qualifié ni prêt à être installé chez un client. Le backend Chat indépendant, les parcours Windows/Excel et plusieurs contrôles de livraison restent en développement.

## Droits

Le code Sim réutilisé conserve sa licence Apache-2.0 et les conditions propres à ses composants. Voir [la licence amont](compliance/upstream/sim/LICENSE), [la notice amont](compliance/upstream/sim/NOTICE) et [la provenance et les droits](RIGHTS.md). Les composants Enterprise exclus et les polices non admises ne sont pas distribués.

**Les nouveaux développements Memlia restent sous droits réservés.** La visibilité publique pendant le développement ne leur attribue pas de licence open source. Aucune licence de marque Sim, OpenAdapt ou d’un fournisseur tiers n’est accordée.

## Vérification de compilation Linux

Le [contrôle Linux du témoin Next16.4.2](https://github.com/saphiron222/memlia/actions/runs/39239854145) passe les types en 69,713 secondes ainsi que les bundles CLI et sandbox. Le [build complet du même témoin](https://github.com/saphiron222/memlia/actions/runs/39240286480) échoue dans Next après 782,396 secondes par manque de heap V8, avec un pic cgroup de 12 652 277 760 octets sous une limite de 13 Gio ; aucun OOM cgroup. Le heap est plafonné à 10 Gio, deux workers et cache mémoire. Le standalone reste non vérifié. Les quatre mesures antérieures Next16.4.0 étaient également négatives ; elles ne constituent pas un A/B strict avec cette version.

Le runner public gratuit de 16 Go n'est pas qualifié pour ce profil de build complet. Ni une optimisation future ni un besoin précis de 24–32 Go ne sont démontrés par ces échecs. Il ne s'agit pas d'un dimensionnement du serveur d'un cabinet. Aucun runner payant n'est activé ; le garde mémoire macOS demeure inchangé dans [scripts/dev](scripts/dev/README.md).

Cette révision ajoute les sauvegardes versionnées d'import et d'auto-layout, la politique Chat d'installation encore bloquée, l'isolation des transports IA contrôlés et des primitives d'admission de jobs liées aux sessions. Ces composants ont été testés et relus sur leurs périmètres ciblés. Ils n'activent ni le backend conversationnel complet ni un worker durable et ne ferment pas les travaux diff/undo/collaboration. La validation Linux de cette nouvelle révision reste à effectuer ; les résultats du témoin ne lui sont pas attribués. Aucune API IA ou Microsoft réelle n'a été appelée pour ces tests.

Un [contrôle Linux distinct](scripts/ci/README.linux-validation.md) permet de vérifier les types et bundles natifs sans lancer Next build. Sa réussite ne satisfait pas le check `build` obligatoire et ne produit pas de standalone qualifié. Aucun artefact de production, journal brut, cache ou dépendance n'est publié par ces workflows.

L’installation frozen utilise les versions figées dans le verrou. Les licences des dépendances installées et des artefacts finaux nécessitent leurs contrôles distincts avant toute livraison commerciale. Les règles de publication se trouvent dans [compliance](compliance/README.md).
