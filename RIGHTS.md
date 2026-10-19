# Provenance, modifications et droits

## Sources tierces

Le socle Sim provient du dépôt officiel https://github.com/simstudioai/sim au commit `c6cef5f87b6a1d1d01df89e7140bad9e9fd4c2e2`. Les fichiers réutilisés conservent leurs droits et leurs notices Apache-2.0, disponibles sous `compliance/upstream/sim/`. Les licences imbriquées restent à leur emplacement. Les textes de licence des bibliothèques ne sont pas remplacés par les présentes indications.

Le répertoire Enterprise `apps/sim/ee`, les empreintes Enterprise interdites, les polices Season Sans et Söhne et les archives/exécutables opaques non admis sont exclus de cet export. Le dépôt ne distribue pas actuellement les moteurs OpenAdapt ; leur intégration est en cours de développement.

Les fichiers Sim adaptés portent une mention de modification Memlia. Cette mention conserve la licence et les droits sur le code tiers ; elle n’affirme pas que Memlia est propriétaire du code amont. Les noms et signes d’autres éditeurs restent leurs marques. Leur présence comme référence technique, attribution ou élément d’amont ne constitue aucun droit de marque pour un produit commercial.

## Ajouts Memlia

Copyright 2026 Memlia. Tous droits réservés sur les nouveaux développements propres à Memlia. Le propriétaire a autorisé leur visibilité publique pendant le développement ; leur licence logicielle future n’est pas encore choisie. Aucune licence Apache, MIT ou autre licence libre ne leur est implicitement attribuée. Cette réserve ne restreint aucun droit fourni indépendamment par une licence tierce, la loi ou les conditions de la plateforme d’hébergement.

Les composants nouveaux sont notamment `agents/windows/`, `packages/memlia-contracts/`, `scripts/compliance/`, `scripts/ci/`, `scripts/dev/build_guard.py`, `scripts/dev/test_build_guard.py`, `deploy/memlia/`, `apps/sim/lib/memlia/` et les remplacements explicitement identifiés dans les sources. Les fichiers de licences tierces, textes de notices et recettes directement reprises gardent leurs conditions originales. La politique de conformité contient des empreintes de composants exclus, jamais leur code.

## Limites de cette publication de développement

Cet export source n’est pas une release commerciale. Les dépendances téléchargées, binaires générés, images conteneur, source maps, ressources graphiques et archives de livraison ont leurs propres obligations et gates. Aucun résultat de compilation n’autorise à distribuer un artefact dont les licences n’ont pas été contrôlées. Les preuves internes, secrets, données du laboratoire et l’historique de travail privé ne sont pas publiés.
