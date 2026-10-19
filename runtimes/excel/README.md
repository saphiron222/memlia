# Noyau Excel Memlia — tranche P00

Ce package fournit le premier noyau déterministe destiné au runtime final. Il
prépare P09/P10 ; il **n’admet et n’exécute aucune ExcelProcedure produit**.
Contrats canoniques, autorité, bindings, approbations, jobs Sim, isolation Linux,
publication et Office restent **NON INTÉGRÉS**. Aucun statut `succeeded_verified`
n’est émis. Le code n’ouvre aucun chemin et n’exécute aucun code fourni en données.

## Réemploi et frontière

- Polars **2.0.0** assure sélection, tri, jointure, agrégats et expressions.
- openpyxl **3.1.5** lit et écrit OOXML ; aucun parseur XLSX ou calcul Excel maison.
- defusedxml **0.7.1** permet le précontrôle XML sans DTD/entités.
- Le contrat de transport appartient à `packages/memlia-contracts`. Aucun DTO ou
  schéma concurrent n’est défini ici. `apply_operation` est une primitive interne
  appelée avec une opération déjà validée, un DataFrame et éventuellement le
  DataFrame droit résolu par l’appelant de confiance. Elle ne valide ni les IDs,
  ni les droits, ni l’admission d’une procédure entière. La validation canonique
  sera branchée seulement après gel/revue des contrats.

Le manque implémenté est l’adaptation fermée des opérations au moteur, la garde
null/Decimal, le refus des capacités absentes et les contrôles avant/après IO.
Aucun code ou gabarit des anciennes automatisations métier n’est copié.

## Profil effectivement testé

| Opération | Sous-ensemble |
| --- | --- |
| select | Colonnes explicitement nommées |
| cast | Vers Decimal seulement, `onInvalid=reject`, sans arrondi |
| join | left/inner, cardinalité 1:1/m:1/1:m ; absence gauche refusée ; collisions de colonnes refusées |
| aggregate | sum Decimal (cast explicite requis pour les entiers), min/max/count ; tout-null devient null ou refus, jamais zéro |
| sort | Clés, ordre et placement des null déclarés ; tri stable |
| derive | Colonne/littéral, comparaison, addition/soustraction Decimal |
| filter | Comparaisons ; prédicat null n’inclut pas la ligne |

map, pivot, melt, full join, rapport d’absences, division, multiplication, moyenne,
conditions et dates sont refusés dans ce profil. Les contrôles produit
`unique/not_null/balance`, capacités requises, limites de procédure, références et
politiques ne sont pas admis par une entrée produit : cette entrée n’existe pas
encore. Il ne faut pas extraire silencieusement les seules opérations d’une
ExcelProcedure pour contourner ses autres champs.

Les transformations acceptent au plus **18 chiffres de précision**, avec une
échelle explicite et au plus 100 000 cellules. Les sommes de colonnes entières signées/non signées sont refusées ; un cast
Decimal explicite est nécessaire avant somme. Les entrées/sorties Decimal sont
vérifiées exactement ; une somme/addition hors précision est refusée. La borne
18 chiffres et 100 000 cellules empêche les sommes intermédiaires de dépasser
Decimal128. La primitive de conversion seule accepte jusqu’à 38 chiffres.
Les floats métier sont refusés, y compris un nombre XLSX comme 0.1 : ce profil
exige les décimaux sous forme de texte exact ou d’entiers à la lecture. Il ne
prétend pas récupérer une précision déjà perdue dans Excel.

## IO et preuves

`read_table(bytes, expected_digest=..., sheet=..., columns=..., precision=...,
scale=...)` lit une copie fournie par l’appelant, vérifie SHA-256, archive, XML,
coordonnées réelles et en-têtes. Les dimensions déclarées dans le fichier ne font
pas autorité. Les lignes/cellules doivent avoir des indices cohérents, uniques
et strictement croissants ; les trous entre lignes deviennent des nulls et leurs
cellules matérialisées comptent dans la limite. Aucun chemin provenant de l’IR n’est accepté. Le plafond est
10 000 000 octets compressés et décompressés, 512 parties ZIP et 100 000 cellules
par défaut. Ces petites bornes sont celles du noyau, pas une capacité commerciale
qualifiée. Liens externes, macros, parties inconnues, formules, noms définis (y compris internes), objets workbook et feuille
non qualifiés sont refusés ; aucun cache de formule n’est pris comme résultat.

`write_table(frame, sheet=...)` crée un nouveau classeur en mémoire et le relit
avant retour. Les Decimal sont **des cellules texte exactes**, les chaînes `=...`
restent littérales, et les textes trop longs sont refusés. Ce choix préserve les
montants ; il ne produit pas de cellules monétaires numériques Excel. La
comparaison porte sur les valeurs et types de formule relus. Aucun style ou
objet source n’est recopié ; aucun classeur source n’est réenregistré. Les chaînes vides non conservées par le roundtrip sont refusées au readback.
Les erreurs de caractères/valeurs d’écriture deviennent un code opaque, sans
valeur de cellule ni cause/context d’exception de bibliothèque conservée. Ce retour
n’est pas une sauvegarde persistée, publication, PatchSet, diff autorisé ou reçu.

L’intégrateur devra résoudre les artefacts autorisés en amont, persister une
copie immuable, vérifier le contrat et tous les contrôles, isoler le processus,
mettre en staging, relire puis publier avec un reçu véridique. Le package n’est
pas une sandbox : absence d’API réseau dans ce code ne prouve pas confinement OS.

## Vérification locale

Python 3.12, environnement privé et cache hors checkout. Aucun lockfile n’est
créé par ce mandat : l’intégrateur possède le verrouillage commun.

```sh
uv venv /chemin/prive/venv-excel --python 3.12
UV_CACHE_DIR=/chemin/prive/cache-excel uv pip install --python /chemin/prive/venv-excel/bin/python -e '.[test]'
/chemin/prive/venv-excel/bin/python -m pytest
```

Les tests génèrent tous les XLSX à la volée, sans binaire versionné. Ils couvrent
oracle littéral indépendant, null/zero, montants exacts, dépassement, cardinalité,
injection de formule, archive/XML non admis, source modifiée, fausse dimension,
readback corrompu, source disque intacte et composition réexécutée avec deux
vocabulaires de colonnes. Une suite verte macOS n’est pas une qualification Linux,
Windows, Excel Desktop, COM, Office.js, SMB ou du générateur LLM A/B/C/D.

## Licences

openpyxl et Polars : MIT pour leur code propre ; defusedxml : PSF-2.0.
`et-xmlfile` est une dépendance openpyxl. Les composants natifs du wheel Polars ont
leurs propres licences (SBOM amont distinct, 368 composants observés dans le
corpus de recherche). Aucun wheel n’est redistribué ici ; notices/SBOM de l’image
Linux restent à produire pour la distribution. Les ajouts Memlia restent tous
droits réservés ; aucune licence libre n’est accordée implicitement.
