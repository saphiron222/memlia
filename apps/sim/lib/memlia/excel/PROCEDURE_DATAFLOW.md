# Observation déclarative des flux Excel

État de qualification ciblée : RED fonctionnel observé contre le stub (38 échecs sur 44 tests), puis 44 tests du validateur et 47 du port de capacités verts en composition. Le corpus natif des contrats compte également 428 cas verts. Six cas fictifs en mémoire ont été confrontés avec succès aux primitives Python réelles ; cela ne qualifie pas une procédure complète. Revue indépendante et typage global restent distincts.

`validateExcelProcedureDataflow` est un validateur pur de la structure déclarée. Il ne lit aucun classeur, ne calcule aucune cellule, ne résout aucun binding et n’autorise jamais une exécution : `executionAvailable` vaut toujours `false`.

Le contrat partagé `ExcelProcedureSchema` demeure la source des formes acceptées. L’entrée est capturée par `stringifyBoundedJson` en mode strict, avec une limite de 512 Kio. Les objets à accesseurs, prototypes non JSON et structures dépassant cette limite sont refusés. Le port existant `inspectExcelProcedureCapabilities` est ensuite consulté. Un profil d’options non pris en charge est refusé **avant toute propagation** : notamment `join.onUnmatched=report`, les dates, les calculs conditionnels, les opérations map/pivot/melt et les profils décimaux non reconnus.

## Sens des résultats

- `schemaValid` indique uniquement la conformité au contrat canonique.
- `declaredDataflowValid` indique la résolution des dépendances et types déclarés dans ce sous-ensemble. Ce résultat n’atteste pas les types ou valeurs d’un fichier réel.
- Les diagnostics contiennent des codes fixes et des indices, jamais de noms de colonnes, identifiants, valeurs ou messages issus de l’entrée. Ils sont limités à 128, avec un indicateur distinct de troncature.
- `columnTypes` contient au maximum 512 descriptions indexées, entrées puis sorties d’opérations (`inputIndex` ou `operationIndex`, et `columnIndex`). Sa troncature ne suspend pas la validation. La nullabilité vient des déclarations et de la sémantique des primitives, jamais de données inspectées.
- Le budget global est de 25 000 unités de propagation : colonnes des entrées, une unité par opération, colonnes de chaque table source copiée (droite comprise pour join), références de writes/controls. Son épuisement constitue un refus, même si le résumé avait déjà été tronqué. Le contrat borne en outre chaque liste et les 200 opérations. Une table rejetée n’est jamais publiée dans l’environnement de résolution.

## Sous-ensemble et provenance

Les noms de tables et colonnes sont résolus dans des `Map`. Les rôles sont uniques, une sortie d’opération ne peut réutiliser un identifiant de table déjà déclaré, et toute entrée doit être disponible avant son utilisation. Les références des sélections, tris, clés, agrégats, expressions, écritures et contrôles sont vérifiées. Les tables d’opérations sont des résultats successifs ; une modification explicite de colonne par `cast` ou `derive` conserve la sémantique native et ne redéfinit pas une table existante.

La référence est le noyau `runtimes/excel/src/memlia_excel/tables.py`, SHA-256 `f29a26ec670af1ae313f9338af6aac022d1452bd9fdb5a81c4dd69ce2142dc2d`, déjà décrit par le port de capacités. La validation conserve ses limites :

- `select` et `sort` conservent les types déclarés ; les colonnes doivent exister.
- Le seul cast reconnu est la conversion explicite vers decimal avec rejet des valeurs invalides. Aucune conversion numérique implicite n’est admise.
- `count` produit le type intermédiaire interne `integer`, distinct des quatre types d’entrée du contrat. Il peut être explicitement converti en decimal ; une écriture directe integer reste hors profil, tout comme une somme integer.
- Le `count` natif entoure aussi sa réduction du contrôle de présence : un groupe entièrement nul produit null avec `allNull=null`, et une erreur avec `allNull=reject`. Le cast explicite conserve ce null ; il ne le transforme pas en zéro. Cet exemple a été confronté au noyau réel sur une table fictive à une ligne.
- `sum` nécessite decimal ; `min` et `max` conservent le type. `allNull=null` rend le résultat potentiellement nul ; `reject` exclut ce résultat pour une exécution qui réussirait. Cela ne prouve pas la présence de valeurs dans les données.
- Une jointure reconnue vérifie types et références des clés, collisions de colonnes et suppression des clés droites. La primitive rejette toutes les lignes gauches sans correspondance avant `left` ou `inner`. Elle n’introduit donc pas de nouvelle nullabilité à droite dans ce profil précis ; les nulls déjà déclarés restent possibles. Ce raisonnement ne vaut pas pour une jointure générale ni pour `onUnmatched=report`.
- Les expressions reconnues propagent les références, littéraux typés, comparaisons et additions/soustractions décimales. Des types différents ne deviennent pas comparables par conversion implicite. Un résultat null sans type déclaré déterminable est refusé.

## Obligations qui restent ouvertes

Les références de writes et controls ne prouvent ni les droits, ni les contrôles métier, ni la sûreté d’une écriture. Les données réelles, cardinalités, limites runtime, contenus décimaux, valeurs nulles, bindings et autorité, digests, révisions et déploiements, périmètres protégés, sauvegardes, approbation, patchs/readback, publication, idempotence et runner isolé restent non vérifiés.

`idempotence.businessKeyColumns` ne précise pas de table dans le contrat actuel. Le validateur ne choisit pas une table arbitraire : cette ambiguïté reste explicitement `idempotence_business_key_scope`. Le présent module ne constitue ni un compilateur de procédure complet ni la qualification de P09.
