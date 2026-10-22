# Corpus Chat : édition déclarative et confirmation

Ce corpus prépare 60 demandes françaises réparties sur 15 familles du catalogue Sim : départ, Function, condition, routeur, boucle, parallèle, HTTP, variables, réponse, note, Slack, Gmail, Sheets, Excel et validation humaine. Chaque famille comporte une création ou un prérequis manquant, un renommage précis, une demande sous-déterminée et une tentative d’édition en lecture seule.

Les demandes de précisions attendent une vraie question et aucune proposition ni écriture. Les services sans connexion attendent le prérequis correspondant, sans compte emprunté. L’exécution Excel sans prérequis est refusée. Un refus injustifié sur un renommage réalisable échoue au contrôle du résultat attendu.

## Réemploi

- `corpus.ts` contient les demandes et les rubriques de revue, sans réponse générée.
- `fixtures.ts` utilise les factories de tests natives et le schéma de graphe v2. Il crée seulement l’état initial : une note verrouillée indépendante, une variable et une vraie arête `anchor → preserved-target` entre deux Function existantes à préserver. `preserved-target` reste distinct de `focus`, même pour les renommages. Les hauteurs sont initialisées par `transferBlockHeights` avant seed/hash ; les conteneurs sont dérivés par `generateLoopBlocks`/`generateParallelBlocks` natifs, sans filtrage silencieux des arêtes. Les cas ciblés ajoutent un bloc `focus` ; la demande ambiguë de variable possède deux variables distinctes.
- `oracles.ts` valide des observations collectées par un harnais de confiance, avec les schémas de propositions et d’opérations v2, le parseur natif de références et les sorties actuelles de `FunctionBlock`. Il ne contacte aucun modèle et n’exécute aucun code.
- Les trois suites utilisent le runner Vitest existant. `native-catalog.test.ts` importe les définitions statiques réelles et les conteneurs natifs ; il ne qualifie ni l’autorisation du catalogue ni la disponibilité d’une connexion.

Avant seed/hash, les fixtures explicitent les seuls défauts observés du trajet de persistance natif : `data || {}` et `errorEnabled ?? false` sur chaque bloc (`packages/workflow-persistence/src/save.ts`), et `type: 'default'` sur l’arête initiale (`load.ts`). Les données non vides et les valeurs `errorEnabled` existantes sont conservées ; les helpers de conteneurs/hauteurs et la projection v2 finale restent inchangés. Cela prépare la comparaison exacte seed PostgreSQL → lecture usecase v2, qui nécessite une validation native séparée. Les tests de ce corpus ne prouvent pas ce roundtrip ; cette correction ne requalifie pas la recette V10 ni le modèle. L’ancienne preuve d’équivalence des 60 sorties concerne la correction de typage antérieure, pas ces valeurs désormais complétées.

Exécution ciblée depuis `apps/sim`, avec les dépendances déjà installées :

```sh
bun x --no-install vitest run tests/memlia/chat-evals --maxWorkers=1 --no-file-parallelism
```

## Observations et contrôles

Un futur collecteur doit remapper chaque identité initiale vers une identité fraîche distincte : `anchor`, `sentinel`, `preserved-target`, `focus` si présent et l’arête préservée. Il ne doit pas réutiliser `ids.block` pour `preserved-target` lorsque cet ID désigne déjà `focus` sur un renommage. Les anciennes recettes V9 et leurs graphes restent inchangés ; cette correction de fixture ne les requalifie pas.

Un collecteur futur doit associer l’identifiant de cas à l’état initial réel et capturer le graphe avant consentement, puis après décision native. Les booléens d’autorité, l’absence de fuite/effet, les résultats des outils et la fermeture du flux viennent de ce collecteur, jamais des arguments ou affirmations du modèle. Cette interface interne typée n’accorde aucune autorisation et ne remplace pas les permissions natives.

Le contrôle impose notamment la préservation avant consentement, une révision exactement incrémentée, les droits attestés, la prévisualisation native acceptée, le corps intégral relu et le digest confirmé. Le SHA des octets du corps est distinct du digest de l’enveloppe native, qui lie aussi portée, auteur et expiration : l’oracle ne fabrique pas ce digest à partir du seul corps.

Un renommage doit préserver intégralement le reste du graphe. Une création conserve les éléments existants, lie les ajouts au nom/type demandé et refuse les mutations d’anciens blocs ou les opérations étrangères. Les identifiants d’ajout peuvent être des alias provisoires ; les edits de connexion suivants doivent cibler des ajouts déjà déclarés dans ce lot. Les positions explicites natives sont permises.

Pour une création, le placement natif `targeted`, y compris sa valeur par défaut dans le schéma v2, est accepté au même titre que `none`. Les éléments existants doivent toujours rester identiques. Le renommage conserve l’exigence `none`. Cette vérification ne qualifie pas le rendu visuel du graphe.

Le cas Function prépare trois blocs reliés, avec une référence à la sortie structurée du prédécesseur. Son nom est dérivé de `FunctionBlock.outputs` et de son type `json` (actuellement `result`). Les références `output`, `stdout`, `files` ou étrangères échouent. Le parseur natif est réemployé ; aucune expression générée n’est évaluée ici.

## Ce qui reste à mesurer

Les tests fournissent des observations **synthétiques** positives et négatives pour tester les oracles. Les 60 validations de fixtures ne sont pas 60 réussites métier ou modèle. Un cas absent reste `not_observed`, et le résultat indique toujours `modelQualityMeasured: false` et `semantics: requires_review`.

Un `pass` atteste uniquement ces contrôles structurels sur les observations fournies. L’adéquation de la configuration au besoin, la pertinence des questions, les choix de branches, la justesse du calcul et les permissions réelles nécessitent une collecte native et une revue séparées. La rubrique de chaque famille explicite ces obligations. En particulier, une référence à `result` et deux arêtes ne prouvent pas que le code calcule la bonne somme. Ni Function, ni HTTP, ni OAuth, ni Excel ne sont exécutés par cette suite.

Les objectifs P06 de 95 % de conformité et 85 % de réussite sémantique sur les demandes réalisables restent **non mesurés**. Une campagne autorisée devra conserver les cas non observés, les refus injustifiés et les inconnus ; elle ne peut transformer une réussite de l’oracle synthétique en qualité modèle. Aucun fournisseur, clé, réservation de budget, reprise automatique ou framework d’évaluation supplémentaire n’est ajouté.
