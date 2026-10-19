# Memlia

Plateforme d’automatisation IA pour les cabinets d’expertise comptable, en développement. Le serveur cible est une VM Linux avec Docker Compose ; un agent local supervisé est prévu pour les logiciels Windows et Excel. Le produit complet n’est pas encore qualifié pour une installation chez un client.

## Droits

Le code Sim réutilisé conserve Apache-2.0 et les conditions propres à ses composants. Voir [licence amont](compliance/upstream/sim/LICENSE), [notice amont](compliance/upstream/sim/NOTICE) et [provenance et droits](RIGHTS.md). Les composants Enterprise exclus et les polices non admises sont absents de cette publication.

**Les nouveaux développements propres à Memlia restent sous droits réservés.** La visibilité publique de développement ne leur attribue pas de licence libre. Aucune licence de marque Sim, OpenAdapt ou d’un fournisseur tiers n’est accordée.

## État vérifié

Le socle conserve l’interface et les moteurs Sim autorisés. Les sauvegardes complètes utilisent une révision attendue et un readback avant modification de l’historique Annuler/Rétablir ; les anciens remplacements complets par socket sont refusés. La représentation des snapshots refuse les pertes silencieuses. Le port de capacités Excel est une observation, sans activation d’exécution.

Cette révision sépare la régénération native des IDs de workflow des stores navigateur :63tests ciblés passent après revue distincte, avec transformations natives inchangées. Trois annotations ciblent le traçage du runtime CLI déjà explicitement inclus et des commandes hôte :59tests natifs passent et les instructions sont identiques ; **leur efficacité dans le vrai build Next reste à mesurer**. Le lecteur Linux de politique administrateur Chat passe92tests et4sondes distinctes ; son activation reste bloquée. Les tests doublent explicitement les métadonnées Linux sur Mac et ne qualifient pas un montage réel.

Le test du garde mémoire attend désormais l’observation effective de son worker détaché ;24tests passent après contre-revue. Le garde de production et ses seuils sont inchangés. Le mode strict reste le défaut ; le [profil explicite de jalon Mac](scripts/dev/README.md) mesure aussi le swap et arrête sur disque, pression critique prolongée, délai ou observation indisponible.

## Compilation Linux et mesures

La [validation Linux de la révision précédente](https://github.com/saphiron222/memlia/actions/runs/39262750914) passe les types en67,190s ainsi que les bundles CLI/sandbox, sans lancer Next. Les types et le build complets de la présente source restent à exécuter. Le précédent jalon Mac a compilé puis échoué pendant la collecte des routes sur un appel serveur d’une fonction client ; le correctif ci-dessus n’est pas présenté comme un build réussi.

Le [témoin Linux heap11](https://github.com/saphiron222/memlia/actions/runs/39246257403) a échoué V8 après764,174s avec un pic cgroup13957734400octets. Le runner public gratuit16Go n’est donc pas encore qualifié pour le build complet ; aucun besoin runtime cabinet ou minimum24–32Go n’est déduit.

Les [trois expériences gratuites avec swap](README.linux-validation.md) gardent un code/verrou commun et une VM par variante : Webpack+disque, Turbopack+disque, Turbopack+zram+disque. La [première campagne](https://github.com/saphiron222/memlia/actions/runs/39263463140) a refusé ses trois prévols avant toute allocation ou compilation, sans mesure mémoire ni cause précise dans les reçus. L’inventaire corrigé lit procfs ; un test Linux arm64 réel passe sans modifier le swap. Cela ne qualifie ni l’allocation sur GitHub x64 ni le repli zram à saturation. Une nouvelle campagne attend les contrôles de publication et la validation Linux des types. Aucun runner payant.

## Travaux ouverts

Le Chat indépendant complet, son admission et son budget durable, l’UI finale Excel/OpenAdapt, le worker actif, les parcours multi-utilisateurs HTTP, les tests Windows interactifs, les images de production et les sauvegardes/restaurations restent en développement ou à qualifier. Les tests unitaires ne remplacent pas ces vérifications. Les rapports privés, secrets, données du laboratoire et artefacts bruts ne sont pas publiés.
