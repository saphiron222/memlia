# Memlia

Plateforme d’automatisation IA pour les cabinets d’expertise comptable, en développement. Le serveur cible est une VM Linux avec Docker Compose ; un agent local supervisé est prévu pour les logiciels Windows et Excel. Le produit complet n’est pas encore qualifié pour une installation chez un client.

## Droits

Le code Sim réutilisé conserve Apache-2.0 et les conditions propres à ses composants. Voir [licence amont](compliance/upstream/sim/LICENSE), [notice amont](compliance/upstream/sim/NOTICE) et [provenance et droits](RIGHTS.md). Les composants Enterprise exclus et les polices non admises sont absents de cette publication.

**Les nouveaux développements propres à Memlia restent sous droits réservés.** La visibilité publique de développement ne leur attribue pas de licence libre. Aucune licence de marque Sim, OpenAdapt ou d’un fournisseur tiers n’est accordée.

## État du développement

Le socle conserve l’interface et les moteurs Sim autorisés. Les sauvegardes complètes utilisent une révision attendue et un readback avant modification de l’historique Annuler/Rétablir ; les anciens remplacements complets par socket sont refusés. La représentation des snapshots refuse les pertes silencieuses.

Le Chat dispose de ports internes de lecture, prévisualisation, proposition et consentement lié au corps exact, à sa révision et à son échéance. La branche locale compose le lifecycle, les handlers et les boucles providers natifs ; elle reste absente par défaut et aucune route ne l’active. Le budget durable réserve un plafond avant chaque tentative physique, puis conserve un règlement et sa provenance tarifaire versionnée. Il s’agit d’un **budget estimatif USD au tarif liste**, pas d’une facture fournisseur ni d’un plafond global de tous les workflows. L’admission administrateur/session, la sélection explicite de fenêtre et la résolution de clé restent à raccorder avant activation.

Le runtime Excel réutilise Polars et openpyxl pour préparer des résultats à partir de procédures canoniques et d’entrées déjà résolues. Le [packaging local](runtimes/excel/PACKAGING.md) construit les deux roues Memlia depuis leurs sources et installe explicitement hors index ; aucune résolution PyPI de memlia-contracts n’est admise. Ces résultats ne constituent pas une publication de classeur ni une autorisation d’écriture. Le processus isolé avec TMPDIR privé et système de fichiers restreint reste un prérequis de déploiement.

L’agent Windows contient le transport HTTPS à origine fixée et une préparation d’identité cliente avec validation cryptographique avant fichier temporaire. Les preuves TLS et les doubles de CredMan sont distingués dans sa documentation ; elles ne qualifient pas à elles seules les ACL Windows, l’autorité mTLS serveur, Office ou une automatisation interactive.

Les tests ciblés des modules et leurs revues restent distincts d’une validation globale. Le premier contrôle global a refusé un accès non typé au contexte de reprise. Après une correction ciblée utilisant le lecteur natif, **le rejeu global TypeScript est vert en14,323s sur Mac**, avec cache possible : ce délai n’est pas un benchmark à froid et ne qualifie pas un build Next. Aucun succès Linux d’une source antérieure n’est réattribué à cette révision.

## Compilation Linux et mesures

Le parent public [d845 a réussi le build requis](https://github.com/saphiron222/memlia/actions/runs/39307709081) avec Turbopack, RAM cgroup13Gio et swap disque24Gio sur runner standard gratuit. Next a terminé en585,707s, sans descendant résiduel, et les fichiers/configurations standalone ont été vérifiés. Ce job ne démarrait pas de serveur HTTP. Les [types](https://github.com/saphiron222/memlia/actions/runs/39307696808) et l’[admission arbre/histoire/notices/secrets](https://github.com/saphiron222/memlia/actions/runs/39307709278) sont également verts pour ce parent.

La présente source contient des ajouts applicatifs depuis ce témoin : **son build Linux reste à exécuter après admission de l’export**. Le succès du parent ne détermine pas les besoins runtime d’un cabinet ni un minimum matériel universel. Les expériences antérieures échouées restent des échecs ; le cas5a a notamment terminé Next mais échoué sur un descendant résiduel, avant vérification standalone.

La matrice [expérimentale swap](README.linux-validation.md) reste disponible par déclenchement manuel ou sur la seule branche `build/linux-swap-measurement`. Elle ne se lance plus automatiquement à chaque push sur main. Le job obligatoire `build` reste distinct et conserve son protocole complet. Le repli zram sous saturation n’est pas supposé qualifié. Aucun runner payant.

## Travaux ouverts

L’activation complète du Chat, sa reprise durable, l’UI finale Excel/OpenAdapt, le worker actif, les parcours multi-utilisateurs HTTP sur cette composition, les tests Windows interactifs, les images de production et les sauvegardes/restaurations restent en développement ou à qualifier. Les tests unitaires ne remplacent pas ces vérifications. Les rapports privés, secrets, données du laboratoire et artefacts bruts ne sont pas publiés. Cet export est une étape de développement, pas une release commerciale.
