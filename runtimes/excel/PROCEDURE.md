# Préparation interne d’une procédure Excel

`memlia_excel.procedure.prepare_procedure` compose le contrat canonique `memlia_contracts.validate('ExcelProcedure', ...)`, les primitives Polars de `tables.py` et l’IO/readback de `xlsx.py`. Il ne crée aucun moteur, parser, bloc Sim, route, autorité ou ordonnanceur. L’entrée et les sorties sont des objets/octet internes ; aucun chemin de fichier utilisateur n’est accepté.

**Portée précise :** « en mémoire » décrit l’API sur octets, pas une garantie sans IO disque. `xlsx.write_table` retourne des octets mais openpyxl3.1.5 crée un XML temporaire de feuille, l’ajoute au ZIP puis le supprime. Le writer natif est conservé sans remplacement ou monkeypatch. Le processus de job devra démarrer avec un `TMPDIR` privé possédé, fourni par le serveur **avant import/runtime**, et un système de fichiers en lecture seule ailleurs. Aucun chemin n’est choisi par la procédure ou le modèle. Cet isolement P10/P16 reste obligatoire avant activation et n’est pas livré par ces trois fichiers.

## Contrat d’appel interne

L’argument obligatoire `profile='memlia.excel-memory/a1-header-v1'` sélectionne une interprétation limitée et explicite ; ces conventions ne sont pas imputées au schéma IR général. Le caller serveur doit préalablement authentifier/autoriser le sujet, résoudre les bindings, vérifier la version/digest canonique de la procédure et fournir les seuls artefacts autorisés. Les champs scope, ownerUserId, digest, workflowId, deployedVersionId, parentVersion et policyVersion sont validés en forme par le schéma ; ils ne prouvent aucun de ces prérequis.

- Sources : dictionnaire exact par rôle, valeurs `ResolvedXlsx(binding_id, sheet_id, sheet_name, content, sha256)`. Un rôle fournit un seul artefact XLSX ; `cardinality='one'` ne signifie pas une seule ligne. IDs et noms sont reliés aux déclarations. SHA-256 des octets est réellement vérifié par le lecteur natif. Les noms de feuilles sont des identifiants XLSX, jamais des chemins.
- Destinations : dictionnaire exact par rôle, valeurs `OutputTarget(binding_id, sheet_id, sheet_name)`. Chaque sortie désigne un binding distinct des entrées et des autres sorties. Aucun fichier existant n’est ouvert ou modifié.
- La procédure est copiée strictement avant validation canonique. Sous-classes, callbacks, cycles, nombres non finis, clés autres que chaînes et entrée supérieure à512Kio sont refusés. Les sources et destinations sont copiées en primitives avant tout appel aux bibliothèques. Aucun `schema_directory` externe n’est accepté.

Le résultat contient les sorties XLSX relues et hashées et des observations de contrôles par indice/kind/severity/satisfied. Son statut est exclusivement `prepared_in_memory`, avec `published=False` : il décrit la présence d’octets préparés, pas une absence de temporaires de bibliothèque. Aucun CommitReceipt, PatchSet, sauvegarde persistée ou autorisation de publication n’est émis. Une erreur ne retourne pas d’ensemble partiel.

## Profil d’options admis

Seul XLSX simple est admis, sans mapping, dates, formule, recalcul, style conservé ou protectedScopes. Les fonctionnalités inconnues du schéma sont refusées par le validateur canonique. Les capacités déclarées doivent inclure celles réellement nécessaires et rester dans le sous-ensemble kernel ; leur liste ne confère aucun droit.

Les entrées ont des colonnes string/decimal/boolean exactes. La locale admise est `en-US` : aucun parseur localisé n’est ajouté, les montants restent des décimaux exacts au format canonique. Les autres locales sont refusées. `nullable=False` et `nullPolicy='reject'` sont réellement contrôlés. Dans ce profil conservateur, les keyColumns déclarées doivent être présentes, distinctes, non nulles et uniques ensemble ; aucune identité n’est devinée depuis les valeurs.

Précision1..18, échelle0..min(18,precision), rounding='half_even' seulement. Aucun arrondi n’est appliqué : les valeurs inexactes sont refusées par le kernel. Chaque agrégat doit déclarer le même allNull que la politique générale ; aucun override silencieux. Les limites déclarées sont vérifiées sur chaque table avec son en-tête ; maxRows/maxCells supérieurs à100000 sont refusés. Le cache local cumulé de tables intermédiaires est également limité à100000 cellules avec en-têtes. Les sources compressées cumulées sont bornées à10millions d’octets et le précontrôle natif d’archive garde ses propres limites.

Opérations : select, cast Decimal/reject, left/inner join avec cardinalité déclarée et onUnmatched=reject, sum Decimal/min/max/count, sort stable, derive col/literal/comparaison/add/subtract Decimal, filter comparaison. Les dépendances doivent exister dans l’ordre et ne peuvent être redéfinies. Les colonnes et types effectifs sont contrôlés, sans recopier le validateur déclaratif TS. Les types integer résultant de count exigent un cast Decimal explicite avant sortie. map/pivot/melt/full join/moyenne/multiplication/division/condition/date et options non couvertes sont refusés. Le traitement numérique et tabulaire reste celui de Polars et des gardes du kernel.

## Contrôles et nouvelles sorties

Tous les contrôles sont exécutés avant la préparation des fichiers : unique utilise les clés Polars (une valeur nulle unique reste une valeur distincte, le contrôle not_null est séparé), not_null vérifie réellement les colonnes, balance agrège en Decimal natif et compare l’écart exact à une tolérance non négative et représentable. Toute donnée absente dans une colonne de balance rend le contrôle non résolu, jamais implicitement zéro. Un échec blocking refuse la procédure ; un échec informative est conservé dans le résultat. Une erreur d’évaluation n’est pas transformée en réussite informative.

Seul `regenerate_owned_zone` est admis, pour une **nouvelle sortie** seulement. Il faut une écriture par sortie, des colonnes contiguës de1 àN, une plage exacte A1:N(hauteur+1) incluant les en-têtes émis par le kernel et des writeScopes exactement correspondants, sans surplus. Les businessKeyColumns doivent être présentes, distinctes, non nulles et uniques dans chaque table écrite. Cette vérification ne prouve aucune idempotence persistante ou propriété effective d’un classeur ; aucune suppression/réécriture d’une zone existante n’est effectuée.

Les Decimal sortent comme texte exact, les chaînes restent littérales. La sauvegarde native vérifie déjà valeurs/types de formules ; l’adaptateur relit aussi chaque sortie avec `read_table` et compare la table typée. Une erreur ou un timeout ne retourne aucune sortie partielle. La réexécution doit produire les mêmes valeurs, pas nécessairement des ZIP byte-identiques (métadonnées temporelles natives).

Le timeout est **coopératif**, vérifié avant/après les appels natifs et avant le retour. Il n’interrompt pas une fonction native en cours. Le futur job isolé doit imposer délai, mémoire, CPU et annulation externes. Les interruptions Python remontent ; elles ne deviennent pas un résultat préparé. Les erreurs retournées sont des codes fixes sans données, chemin ni cause/context de bibliothèque.

## Assemblage et limites de preuve

Cette tranche importe le package Python canonique déjà existant, mais ne modifie aucun pyproject/lock. L’assemblage final devra inclure memlia-contracts/jsonschema en plus des dépendances Excel. Le harnais réutilise les deux environnements Python3.12 préexistants via chemins privés explicites, sans installation ; ceci ne qualifie pas l’installation autonome du runtime.

Les tests utilisent des XLSX fictifs réels, Polars et JSONSchema, avec des oracles littéraux indépendants. Les doubles servent seulement à observer l’absence de sortie après refus, l’interruption, l’échéance et la mutation pendant un appel de bibliothèque ; ils sont distincts de la chaîne numérique réelle. Aucun fournisseur, DB, classeur utilisateur, Excel Desktop, Office.js, Windows, image Linux, sandbox, publication, workflow exécuté ou parcours UI n’est qualifié.
