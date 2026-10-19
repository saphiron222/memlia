# Admission des sources et contrôles de publication

Les nouveaux fichiers Memlia sous `scripts/compliance` et dans ce dossier sont provisoirement sous droits réservés. La politique contient des empreintes, aucun code Enterprise. Les fichiers Sim admis conservent leurs conditions et notices Apache-2.0 amont ; aucun droit n’est accordé sur les éléments exclus.

## Commandes

Python 3 et Node 22 sont nécessaires. Le scanner réutilise le parseur `@typescript/typescript6` déjà déclaré par Sim, sous Apache-2.0 ; il n’ajoute aucune dépendance. Une installation locale du paquet est résolue normalement. Pour le runtime isolé du précédent audit, définir `MEMLIA_TYPESCRIPT_PATH` avec le chemin absolu de son fichier `lib/typescript.js`. Les métadonnées de ce paquet indiquent 6.0.2, mais `ts.version` indique 6.0.3. Le SHA256 du parseur observé est `d3f3cd2b04b7f466f4484df921b744223f7bd1f3e353ec9110bdf52695b983d5`. Ces deux versions sont acceptées ; la CI doit figer séparément la dépendance et le lockfile.

```sh
python3 -m unittest discover -s scripts/compliance -p 'test_*.py'
python3 scripts/compliance/gate.py source --root "$REFERENCE" --manifest compliance/sim-source.json
python3 scripts/compliance/gate.py tree --root .
python3 scripts/compliance/gate.py history --root .
```

Code de sortie 0 : contrôle choisi réussi ; 1 : éléments signalés ; 2 : contrôle incomplet ou configuration invalide. Les rapports affichent chemins, règles et numéros de ligne, jamais les valeurs des secrets. Un parseur ou une configuration indisponible bloque le contrôle. La racine de l’arbre doit être un répertoire existant ; les erreurs de parcours et de lecture remontent. Les tests de permissions utilisent de véritables refus du système de fichiers et doivent s’exécuter sans privilèges root.

Le package de configurations `@sim/tsconfig` est résolu depuis ses exports JSON versionnés sous `packages/tsconfig`, sans installation préalable. Le nom du package et sa cible interne sont vérifiés ; un export absent, un package incorrect ou une cible sortant du package bloque le contrôle. Cette résolution s'applique aussi aux snapshots historiques, avec leurs propres JSON. Les autres erreurs de configuration ne sont pas ignorées.

`prepare --root "$REFERENCE" --manifest compliance/sim-source.json --destination "$PRODUCT" --inventory "$PRIVATE_INVENTORY"` vérifie origine, HEAD, propreté du checkout et empreintes des licences, puis copie les blobs Git exacts sans importer l’historique Git. Toutes les collisions sur les destinations et leurs parents existants sont vérifiées avant la première écriture. Cela ne garantit pas une transaction face à une panne disque ou une modification concurrente après ce contrôle.

La préparation préserve le README et le `.gitignore` du produit. Elle exclut Enterprise, les polices non admises, les workflows/instructions amont, les scripts de développement racine et les archives/exécutables opaques. Ces exclusions figurent dans l’inventaire ; elles ne constituent pas une application fonctionnelle. Chaque script de développement amont nécessaire doit être examiné avant sa réintroduction. Les fichiers LICENSE/NOTICE racine sont déplacés sous `compliance/upstream/sim/` pour ne pas suggérer une licence applicable aux nouveaux fichiers Memlia.

La préparation est une quarantaine, **pas une autorisation de publication**. Les consommateurs Apache d’EE nécessitent encore les remplacements indépendants consignés dans le plan privé de 330 arêtes. Ne pas committer des imports intermédiaires interdits : un import committé puis supprimé reste bloquant dans le contrôle d’historique.

## Contrôles effectivement réalisés

- Chemins EE interdits et empreintes exactes des 316 fichiers EE exclus ; une copie identique renommée est également refusée.
- Chemins, signatures de polices et empreintes interdites Season Sans/Söhne. Aucune police n’est actuellement admise.
- Licences/notices imbriquées soumises à une empreinte admise. Les licences Sim figées et la NOTICE ont été lues. Les licences des dépendances et des artefacts distribués nécessitent leur propre examen.
- Ensemble borné de signatures de secrets, fichiers d’environnement, conteneurs inconnus et signatures d’exécutables natifs.
- Analyse AST TypeScript des imports, réexports, types importés, import-equals, require, require.resolve et imports dynamiques. Les concaténations/templates littéraux et alias `paths` des tsconfig sont évalués ; les expressions de modules non littérales bloquent la publication sauf admission du chargeur source exact décrite ci-dessous.
- Erreurs de parsing bloquantes. Les source maps plates doivent déclarer leur version 3, leurs sources, leurs contenus embarqués et leurs mappings ; les sources sont inspectées. Les maps indexées et les sections externes sont refusées avec `uninspected-sourcemap` jusqu’à l’existence d’une inspection dédiée.
- Archives et images non présumées propres : les formats d’archive et d’exécutable reconnus bloquent la publication jusqu’à une admission d’artefact distincte.
- Historique de chaque commit accessible depuis toutes les refs locales, avec la configuration JSON propre à chaque commit. Un fichier supprimé, ou un alias supprimé, ne masque pas son signalement. Les objets de remplacement Git sont désactivés. Les historiques greffés, clones shallow et dépôts déclarés partiels sont refusés ; `git fsck --full --no-reflogs` vérifie les objets. Aucun téléchargement implicite d’objets n’est autorisé. Récupérer un historique complet constitue une étape explicite séparée.

## Contrôles complémentaires obligatoires et limites

Les signatures intégrées ne sont pas un détecteur exhaustif de secrets. **Gitleaks 8.30.1 doit être exécuté indépendamment sur le contenu et l’historique avant toute publication**, avec ses règles intégrées, valeurs masquées, commentaires d’exception amont désactivés et aucune baseline inexpliquée. `scripts/ci/check-secrets.sh` classe ensuite chaque détection par `reviewed-gitleaks.json` : chemin, SHA256 intégral, règle et ligne exacts, avec justification revue. Toute détection inconnue ou fichier présent modifié bloque ; il n’existe aucune exemption générale de fixtures.

Le mode `source` de `source_policy.py` exige tous les fichiers et toutes les détections de la référence. Le mode `repository` permet l’absence d’une fixture exclue du produit, mais exige encore l’empreinte et les détections d’une fixture présente. Le mode `history` vérifie les octets de **commit:path**, sans objets de remplacement, et ne se fie jamais au fichier courant. Il ne remplace pas le scan complet : le wrapper produit un rapport frais pour chaque exécution, refuse les erreurs du scanner/rapports illisibles et garde les scans contenu/historique. La policy et les contrôles eux-mêmes restent soumis à revue ; une entrée auto-ajoutée n’établit aucun droit ni absence de secret.

`sim-source-gitleaks.json` conserve la baseline des 77 détections de la référence amont figée, pour reproduire le mode `source` avec `--review compliance/sim-source-gitleaks.json`. `reviewed-gitleaks.json` est la policy du produit : deux fixtures ont seulement changé d'import EE vers l'adaptateur libre, sept empreintes de détection ont été actualisées après revue indépendante ; textes détectés, lignes, règles et raisons sont inchangés. Le wrapper utilise uniquement cette dernière policy. Aucune de ces deux listes n'est une exemption par nom de fichier. Le classificateur courant n'admet qu'un blob par chemin : toute évolution future d'une fixture déjà publiée devra préserver aussi l'admission exacte de ses anciennes versions historiques avant publication, sans réécriture de l'historique.

Le parcours de l’arbre de travail ignore seulement `.git`, `node_modules` et les caches Python. Le contrôle d’historique n’ignore pas les dépendances ou caches versionnés. Les sorties de build, couches conteneur, ressources compressées, binaires, SBOM des dépendances runtime, attributions de licences, remplacement de marque et isolation réseau restent des contrôles P01/release séparés. L’historique contrôlé est celui des refs présentes localement : ce contrôle ne découvre pas des branches distantes absentes.

L’analyse statique ne prouve pas l’absence de code généré, d’eval ou de loaders indirects, ni d’implémentations EE transformées ou copiées partiellement. Le refus par empreinte exacte complète la revue de provenance sans la remplacer.

## Chargeurs dynamiques examinés

`reviewed_dynamic_imports` admet exclusivement une détection `unresolved-module-expression` aux **chemin, SHA256 intégral et lignes exacts** d'un chargeur dont le source et la provenance ont été examinés. Toute modification du fichier, déplacement, nouvelle expression ou autre règle reste signalée. Les imports EE, erreurs de syntaxe, secrets et sources embarquées dans une map ne reçoivent aucune dérogation. Le mode historique compare les octets du commit examiné, jamais ceux du checkout courant.

Les neuf sources initiales sont identiques aux blobs Apache-2.0 du commit Sim figé : deux ponts natifs Desktop, un test Next, le bootstrap standalone, deux tests de génération locale, deux parcours de contrats et un test d'exhaustivité outbox. Les métadonnées consignent les cibles connues et les contrôles restants. Les parcours de tests conservent leur découverte exhaustive ; ils ne sont pas remplacés par une liste de fixtures qui pourrait masquer un oubli. Tous les fichiers découverts présents dans les sources restent soumis au scan complet habituel.

Cette admission établit seulement que **ce chargeur source précis est réutilisable**. Elle n'autorise aucun binaire natif, paquet installé, code généré ou module fourni ultérieurement, ne garantit pas la sécurité de tous ses usages et ne vaut pas qualification de son exécution. Le `server.js`, les chunks et la couche standalone doivent être inspectés après construction. Les ponts Desktop ne font pas partie de l'image serveur Linux V1 ; une distribution Desktop nécessiterait son propre contrôle. Les dépendances, cibles générées et artefacts restent bloqués tant que leurs contrôles distincts ne sont pas achevés. Le banc de mesure acceptant un module externe arbitraire n'est pas admis par cette liste.

Ces tests ne prouvent aucun build applicatif, fonctionnement UI/login/canvas, installation de dépendances, push ou acceptation P01.

## Présence obligatoire des textes amont avant publication

`python3 scripts/ci/check-upstream-notices.py --root .` exige les deux textes Sim aux chemins et SHA256 figés ; leur suppression, modification ou remplacement par symlink bloque la publication. `--history` examine aussi toutes les refs accessibles. Seuls les commits strictement neutres ne contenant que `README.md` et `.gitignore` peuvent ne pas porter ces textes. Ce contrôle complète le contrôle AST/contenu, qui inspecte les fichiers présents sans en déduire que les notices nécessaires existent.

La publication de développement est autorisée par le propriétaire. Les deux fichiers LICENSE propres aux ajouts Memlia sont admis par l'empreinte exacte du texte de droits réservés relu ; cette admission ne leur attribue aucune licence libre. Les préfixes de modification Apache dans 219 fichiers adaptés entraînent uniquement des changements d'empreintes et de lignes explicitement revus pour les sept tuples de fixtures concernés. Les textes des détections et la baseline amont restent inchangés.

Le générateur de développement `scripts/generate-v2-cli-api.ts`, réadmis depuis le même commit Sim Apache, conserve cinq expressions d'import calculées. Une admission distincte fixe son chemin, son SHA256 intégral et les cinq lignes exactes ; retirer ses deux notices Memlia restitue le fichier amont. ROOT dépend uniquement de l'emplacement du script : quatre cibles sont fixes et les 46 autres sont les fichiers de contrats `.ts` immédiats, réguliers, hors tests/index, sous un répertoire fixe. Les cinquante cibles sont inventoriées dans cette entrée de policy et restent soumises au scan complet ; ni leur exécution, ni un binaire, ni un futur module n'est implicitement admis. Toute modification du chargeur annule l'admission. Les valeurs de fixtures, les licences, le code Enterprise et les règles globales du scanner ne sont pas exemptés.
