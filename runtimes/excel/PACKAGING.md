# Assemblage offline du runtime Excel

Cette tranche construit **deux roues locales**, memlia-contracts0.1.0 et memlia-excel0.1.0, puis les installe avec leurs dépendances vérifiées dans un venv neuf. Elle ne crée pas d'image, service, job, route ou autorité. Le package canonique conserve son backend `CheckedBuildPy`, son registre généré, ses schémas et son validateur ; aucune copie concurrente du contrat n'est créée.

Le manifeste Excel déclare `memlia-contracts==0.1.0`. **Installer directement ce nom depuis un index n'est pas le parcours autorisé.** `scripts/package.py` construit obligatoirement `packages/memlia-contracts` puis `runtimes/excel` depuis les chemins locaux du même snapshot admis. Il ne télécharge rien. La fermeture tierce est figée dans `requirements.lock` : lignes pip avec hashes, plus annotations fermées `# wheel profil nom hash` pour choisir les roues exactes. Les annotations et les exigences doivent correspondre ; les roues Memlia présentes dans le cache tiers sont refusées.

## Préparer les entrées

Profils distincts : `linux-cp312-x86_64` (roues manylinux2.17, cible Linux CPython3.12 amd64) et `macos-cp312-arm64` (roues macOS11+, laboratoire CPython3.12.11 arm64). Ils partagent les roues Python pures mais pas Polars natif/rpds. Les versions proviennent des environnements préexistants : openpyxl3.1.5, Polars/runtime32 2.0.0, defusedxml0.7.1, et-xmlfile2.0.0, jsonschema4.26.0, attrs26.1.0, specifications2025.9.1, referencing0.37.0, rpds2026.9.1, typing-extensions4.16.0 ; construction setuptools80.9.0/wheel0.45.1/packaging26.3 et pip25.0. Aucun extra ou sdist.

Un opérateur prépare un cache de roues **tierces seulement**, depuis les métadonnées de version `https://pypi.org/pypi/<nom>/<version>/json` et leurs URL officielles `files.pythonhosted.org`, avec TLS vérifié. Le nom, la version et le SHA256 doivent correspondre au verrou avant usage ; conserver les attestations d'origine hors données utilisateur. Ne jamais interroger PyPI pour les deux noms Memlia. Le préparateur du cache n'est pas un downloader produit ajouté par ce lot. La disponibilité de ces fichiers n'est pas garantie dans le futur : conserver les roues vérifiées sans substituer une version/hash. Les deux profils peuvent coexister dans le cache ; aucun fichier `.whl` hors inventaire n'est admis.

Le snapshot source doit avoir passé les contrôles de provenance/licences/secrets existants. Le constructeur sélectionne exclusivement les manifests, le backend/notice du contrat et les arbres Python/schémas ; il refuse liens, fichiers cachés, `__pycache__`, extensions non admises et fichiers de source supérieurs à2Mio. Cela exclut notamment `.env`, certificats et archives ; **une allowlist de fichiers n'est pas un scanner de secrets dans le code**. Aucun environnement de développement n'est transmis aux subprocessus.

## Construire et installer

Depuis un interpréteur CPython3.12 correspondant au profil, sous un superviseur de propriété/timeout/nettoyage :

```sh
python3.12 -I -B runtimes/excel/scripts/package.py \
  --source /snapshot/admis \
  --wheelhouse /cache/roues-verifiees \
  --output /travail/assemblage-neuf \
  --profile linux-cp312-x86_64
```

Le dossier de sortie doit être absent ; aucun dossier existant n'est supprimé. Il est créé0700 et contient contextes propres, builder, runtime, roues, notices natives, log privé et manifeste. `TMPDIR` est privé0700 et fixé avant chaque lancement. Le builder réemploie pip wheel/setuptools, `--no-deps --no-build-isolation --no-index`. Les installations utilisent `--no-index --no-deps --require-hashes` avec chemins locaux de roues, configuration pip neutralisée, cache désactivé. Les outils setuptools/wheel/packaging restent dans le builder et ne sont pas installés dans le runtime. `venv` utilise le bootstrap ensurepip de l'interpréteur choisi, remplacé ensuite par pip25.0 verrouillé ; l'interpréteur lui-même doit être figé par le futur contexte Linux et sa version est enregistrée.

Avant l'installation locale, noms exacts, Python/schémas et métadonnées des deux roues sont confrontés au contexte source. Le contrôle exige les métadonnées natives `.egg-info/PKG-INFO` et `top_level.txt` produites par le backend dans ce contexte propre : comparaison octet à octet avec `METADATA` et `top_level.txt`, sans reconstruire les exigences de dépendances. La licence canonique est comparée exactement au `LICENSE` capturé. Un seul répertoire dist-info, au nom/version attendu, et sa liste fermée de fichiers sont admis : ajout de `entry_points.txt`, autre hook ou second dist-info refusé. Le fichier `WHEEL` doit correspondre au profil pur py3-none-any du backend setuptools80.9.0 déjà verrouillé. `RECORD` doit décrire exactement ces mêmes fichiers et leurs SHA256/tailles ; un RECORD cohérent ne prouve pas la provenance et ne permet jamais de substituer une licence ou des métadonnées. Ce contrôle est limité aux deux distributions locales définies ici ; un changement de backend ou de profil exige de revoir cette correspondance, pas de tolérance générique. `pip check`, import de la procédure et chargement du schéma canonique installé sont obligatoires. Le manifeste `status=installed` est écrit seulement après ces étapes ; il conserve inventaire SHA256 des sources, hash du verrou et roues utilisées. Le numéro0.1.0 ne remplace pas cette identité de contenu ; le coordinateur doit relier l'inventaire au SHA admis. Aucun `PYTHONPATH`, editable ou téléchargement de secours. Les appels aux outils partagent une échéance120s ; le superviseur externe reste nécessaire pour les descendants et l'annulation. En cas d'échec, le dossier privé peut rester pour diagnostic : son absence de manifeste positif n'est pas un succès. Ne retirer que ce dossier possédé après fin des processus.

Les notices/licences tierces et fichiers dist-info sont conservés par l'installation native, y compris celles des roues natives et des bibliothèques vendorizées. La roue canonique conserve son LICENSE ; Excel déclare les droits réservés Memlia. Le constructeur conserve également DEPENDENCIES du contrat dans le contexte. L'inventaire de roues ne clôt ni SBOM, vulnérabilités, obligations de distribution native/base Linux, signature ni revue juridique P15. Les nouvelles sources Memlia ne reçoivent aucune licence permissive implicite.

## Vérifications et limites

Avec le cache tiers vérifié disponible et un Python3.12 muni du backend de construction déjà revu :

```sh
MEMLIA_TEST_WHEELHOUSE=/cache/roues-verifiees \
  python3.12 -B runtimes/excel/tests/test_packaging.py -v
```

`MEMLIA_TEST_BUILD_PYTHON` peut désigner explicitement ce Python de test lorsque la suite pytest existante est lancée par un autre venv sans backend. Ce réglage est seulement celui du test ; le constructeur crée ses propres builder/runtime. Cache manquant = échec, pas skip. Le test d'installation réemploie le constructeur de fixture canonique de `test_procedure.py`, puis lance un Python installé `-I -B` dans un cwd extérieur : vrai XLSX fictif, validation, préparation et readback avec oracle littéral, aucune autorité/publication. Il vérifie aussi les références distantes refusées et les temporaires nettoyés.

Qualification de ce lot : **installation et tests natifs Mac arm64 seulement**. Les roues Linux peuvent être téléchargées/hashées/inspectées sur Mac ; cela ne qualifie pas leur chargement, libc/ABI/CPU, installation ou exécution Linux. Aucune image, Hyper-V, Windows, Office.js, classeur utilisateur ou réseau isolé au niveau OS n'est qualifié. `--no-index` et chemins locaux ferment la résolution pip ; ils ne constituent pas une sandbox réseau pour un backend Python arbitraire. Seuls les backends/sources revus sont admis.

La reproductibilité porte sur entrées verrouillées, sources et installation. L'égalité byte à byte de deux roues/ZIP n'est pas promise : les timestamps natifs restent possibles.

## Gate P10/P16 avant activation

L'API bytes n'élimine pas l'IO temporaire d'openpyxl. Le futur processus doit démarrer avec TMPDIR neuf possédé0700 **avant import** et refuser un répertoire absent/lien/non possédé/non inscriptible plutôt que laisser tempfile chercher un repli. Il faut encore fournir et qualifier Linux non-root, filesystemRO ailleurs, réseau absent, limites RAM/CPU/PID/disque, timeout/annulation et suppression des seuls temporaires/descendants possédés même après arrêt forcé. Aucun chemin n'est fourni par le modèle/IR. Ces restrictions OS ne sont pas livrées par ce packager et restent obligatoires avant activation du job. Autorité, admission durable, publication, liaison Sim et idempotence restent des ports distincts.

Les régressions d’intégrité construisent les deux vraies roues natives depuis un contexte temporaire, puis ne modifient que des copies ZIP. Licence remplacée, console entrypoint ajouté, dépendance modifiée, second dist-info et profil WHEEL falsifié sont refusés même avec RECORD recalculé. Un RECORD incomplet est également refusé. Aucune archive forgée n’est installée/importée ; seule la paire native légitime est installée pour la composition XLSX existante.
