# Observation des capacités Excel — P09

`inspectExcelProcedureCapabilities(input)` analyse une **recette complète** avec
le contrat canonique `ExcelProcedureSchema`, après capture JSON stricte bornée à
512 Kio par le helper Sim existant. Elle n’admet aucun job et ne calcule aucune
cellule. `executionAvailable` vaut toujours `false`, y compris si les options
primitives demandées sont compatibles.

Le résultat distingue `schemaValid`, `primitiveOptionsCompatible` et
`notVerified`. Un résultat compatible ne vérifie ni l’existence des tables ou
colonnes, ni leurs types effectifs, ni les données, ni les règles de la recette.
Un enchaînement incohérent peut donc avoir des options primitives compatibles :
c’est une observation partielle explicitement étiquetée `primitive_options_only`,
pas un plan compilé ou prêt à exécuter.

## Profil fermé et provenance

Profil `memlia.excel-kernel-primitives/p00-v1`, noyau admis présent dans la base
`f6bcb8c7815934d6680a04cfc362bfcca9c9b098`. Les deux SHA-256 du code source sont
embarqués dans le descripteur et vérifiés dans les tests contre les fichiers
réels. Changer le noyau exige une relecture et une nouvelle qualification du
profil ; l’empreinte d’un fichier source n’est pas une attestation de déploiement.

- `runtimes/excel/src/memlia_excel/tables.py` :
  `f29a26ec670af1ae313f9338af6aac022d1452bd9fdb5a81c4dd69ce2142dc2d`.
- `runtimes/excel/src/memlia_excel/xlsx.py` :
  `97d87461deb9ff8a340bc010c1bb18c2abb965ad8b809bda1292c881f249e9c8`.
- Polars 2.0.0, openpyxl 3.1.5, defusedxml 0.7.1. Aucun moteur supplémentaire.

| Primitive | Options reconnues ; contraintes restant à vérifier sur les données |
| --- | --- |
| select | Colonnes explicites ; présence/types non vérifiés ici |
| cast | Decimal et `onInvalid=reject` uniquement ; aucune perte ni aucun arrondi appliqué par le noyau |
| join | left/inner, cardinalités du contrat, `onUnmatched=reject` ; une entrée gauche non appariée ou des collisions de colonnes font refuser le noyau |
| aggregate | sum/min/max/count, tout-null null ou rejet ; sum nécessite Decimal et refuse même les petites sommes d’entiers |
| sort | Clés, sens et nulls explicites, tri stable |
| derive | Colonne, littéral sauf date, comparaison ; add/subtract exigent Decimal. Les littéraux non Decimal en arithmétique sont refusés dès cette observation ; les types des colonnes ne sont pas inférés |
| filter | Comparaison ; les prédicats null n’incluent pas la ligne |

Map/pivot/melt, full join, rapport de non-appariés, moyenne, condition,
multiplication/division et dates dans les expressions restent refusés. La
présence du nom `table.derive` n’accorde pas toutes ses variantes. Précision du
profil de calcul au plus 18, échelle au plus précision (et 18), 100 000 cellules
par table. Les plafonds déclarés au-delà sont signalés ; une déclaration située
sous la limite ne prouve pas que les données ni les intermédiaires y tiendront.
Les règles d’arrondi de la recette sont validées en forme, mais aucune n’est
exécutée par ce port ; le noyau refuse les conversions inexactes.

`file.xlsx` désigne seulement les primitives sur octets d’un XLSX simple :
lecture avec en-têtes exacts, string/decimal/boolean, contrôles d’archive et
empreinte source ; création d’un nouveau classeur en mémoire avec readback des
valeurs. Decimal est écrit comme **texte exact**, pas comme cellule monétaire
numérique. Les chaînes vides non conservées au roundtrip sont refusées. Aucune
conservation des styles, application de zones ou sauvegarde persistée n’est
impliquée. Formules, liens externes, macros et objets non qualifiés sont refusés
par le noyau. Aucun recalcul Excel. Plafonds du lecteur par défaut : 10 000 000
octets compressés/décompressés, 512 parties ZIP, 100 000 cellules en incluant les
en-têtes ; le writer inclut également les en-têtes. Les lignes, objets, cellules
et bornes effectives ne sont pas inspectés par ce port. Aucun CSV ici.

## Résultat et frontières

Les capacités nécessaires sont dérivées des formats d’entrée/sortie et des
opérations. Une omission dans `requiredCapabilities` est signalée ; une capacité
non disponible déclarée l’est aussi. Des fonctions autorisées par
`formulaPolicy.allowedFunctions` ne sont pas à elles seules une demande de
calcul. Une demande explicite `excel.formulas/recalculate/styles` reste hors
profil. Le tableau de capacités est un sous-ensemble d’options, pas un grant.

Les diagnostics utilisent uniquement des codes fixes, indices d’éléments soumis
et noms de capacités de l’union canonique. Maximum 128 diagnostics ; le drapeau
`diagnosticsTruncated` signale les suivants. Aucun nom de colonne, valeur, ID de
binding, recette ou erreur brute n’est renvoyé. L’observation ne partage pas
l’entrée ni un profil global mutable. Les accesseurs/toJSON, propriétés cachées,
valeurs non JSON, cycles et tableaux troués sont refusés par le copieur existant.
Ce helper n’est pas une sandbox contre du code JavaScript hostile ou des Proxy
injectés depuis le même processus ; sa frontière prévue est celle des données.

Les obligations `notVerified` sont toujours présentes : dataflow/types, données
et limites réelles, contrôles métier, bindings/autorité, digests, révision et
version déployée, zones/formules protégées, snapshot/sauvegarde/approbation,
application/readback, publication/idempotence et isolation/timeout. Aucun champ
`writes` ou `controls` n’est ignoré pour exécuter une sous-recette : **rien n’est
exécuté**. Leur validation de forme ne remplace pas leur contrôle métier. Le
scope, `ownerUserId`, digest et `deployedVersionId` déclarés n’authentifient personne.

Le futur rattachement au graphe passera par les use cases Sim/P04, Principal
serveur et révision attendue, sans bloc Function/code arbitraire ni mutation
locale parallèle. Avant un bloc réellement exécutable restent nécessaires le
port de procédure entière, les contrôles/bindings/artefacts, PatchSet et reçu,
puis le runner isolé P10/P03. Ce fichier n’enregistre aucun bloc, outil, route,
worker ou outil Chat. Office.js et COM Windows sont des adaptateurs distincts ;
aucun repli automatique n’est introduit.

## Vérifications et droits

Tests TS : contrat canonique réel, capture stricte réelle, variantes d’options,
limites, diagnostics et absence de partage mutable. Les tests de provenance
échouent si les sources du noyau changent. Une confrontation Python privée
exécute les primitives réelles sur données fictives et classeur en mémoire ;
elle ne prouve ni une qualification Linux ni Office/COM, ni les recettes A/B/C/D.
Aucune API, DB, donnée client, compilation globale ou nouvelle dépendance.

Ajouts Memlia sous droits réservés. Les licences des bibliothèques et de leurs
composants natifs restent distinctes ; aucune licence implicite ni qualification
binaire commerciale n’est accordée par ce port.
