# Politique d’admission Sim proposée

Source figée : Sim `c6cef5f87b6a1d1d01df89e7140bad9e9fd4c2e2`. Ce patch prépare une admission locale ; il n’autorise ni copie avant revue, ni publication. La licence des nouveaux fichiers Memlia reste pendante. Aucune empreinte de licence Memlia n’est ajoutée aux licences amont admises.

## Exceptions examinées

`policy.json` contient 30 entrées `reviewed_secret_fixtures`, couvrant 46 occurrences du détecteur borné. Chaque entrée porte chemin, SHA256 exact, règle, ligne et motif, sans valeur sensible. Il s’agit d’en-têtes PEM sans matériau cryptographique, de placeholders, de chaînes synthétiques de tests et d’identifiants EXAMPLE. Le contrôle existant reste lié au chemin et au contenu entier exact : toute modification du blob annule son exception.

`reviewed-gitleaks.json` décrit séparément les findings de Gitleaks 8.30.1 examinés. Chaque entrée contient :

```text
{ path, sha256, rule, line, reason }
```

`path` est relatif à la racine contrôlée ; `sha256` porte sur le blob entier ; `rule` correspond au RuleID du scanner et `line` à StartLine. Aucune valeur de Match/Secret ni exclusion globale de tests n’est stockée. Une annotation TypeScript ou un nom de variable reconnu à tort comme credential est expliqué comme faux positif de code, pas comme une clé autorisée.

## Classification complémentaire, sans remplacement du scan

```sh
python3 scripts/compliance/source_policy.py \
  --root "$SOURCE" \
  --report "$RAPPORT_GITLEAKS_REDACTED" \
  --review compliance/reviewed-gitleaks.json
```

Cette commande **ne lance pas Gitleaks**. Le wrapper appelant doit d’abord lancer un scan complet réel, avec version et configuration contrôlées, sans ignorer les chemins examinés. La commande classe ensuite ses findings ; elle ne transforme pas une absence de scan en preuve.

En mode `source`, elle exige tous les fichiers examinés. En mode `repository`, une fixture absente du checkout peut être omise, mais chaque fichier présent reste vérifié, même sans finding dans le rapport. Les disparitions exigées, symlinks, contenus non admis, nouveaux tuples et findings attendus manquants restent bloquants. Un rapport vide ou tronqué ne rend pas propres des sources dont des findings sont attendus. Les rapports malformés sont refusés sans reproduire leurs valeurs. Codes : 0 classification complète, 1 findings ou dérive, 2 entrée indisponible/invalide.

**Historique :** les modes `source`/`repository` refusent les findings portant un `Commit`. Le mode `history` résout le vrai `commit:path` avec Git et calcule son SHA256, sans utiliser le fichier courant. `GIT_NO_REPLACE_OBJECTS=1` et `GIT_NO_LAZY_FETCH=1` restent imposés à ces lectures. Le wrapper `scripts/ci/check-secrets.sh` conserve les scans réels du contenu et de toutes les refs, les diffs de fusion et le texte indépendamment des attributs Git. Aucun succès de ce scan complet n’est déduit des tests du classifier.

## Versions explicites des admissions exactes

Le format historique `schema: "memlia.reviewed-gitleaks/v1"` (ou l’absence de `schema` pour les anciennes politiques) conserve un SHA256 unique par chemin et les tuples `(path, rule, line)`. Deux empreintes pour un même chemin restent refusées en v1. Un `schema` explicite inconnu ou non textuel, y compris un booléen, est refusé.

Le format `schema: "memlia.reviewed-gitleaks/v2"` admet plusieurs versions **individuellement relues** d’un même chemin. Son identité d’admission est le quadruplet exact `(path, sha256, rule, line)`. Chaque entrée conserve aussi son motif `reason`. Les chemins doivent être relatifs et canoniques, sans alias `./`, segment `..`, séparateur répété, barre finale ou backslash ; les doublons du quadruplet sont refusés. La version du scanner reste `8.30.1`.

En mode `source`/`repository`, le classifier calcule d’abord l’empreinte du fichier présent et sélectionne uniquement les admissions de **ce blob**. Tous les findings attendus pour ce blob doivent être présents. Les attentes d’une ancienne version ne sont pas exigées du fichier courant, et ne lui accordent aucun droit : contenu différent, nouvelle règle ou nouvelle ligne restent refusés, même si le même chemin possède une autre admission historique. Une empreinte inconnue reste bloquante, y compris avec un rapport vide. Le traitement des fixtures absentes en mode `repository` reste celui décrit ci-dessus.

En mode `history`, chaque finding est comparé à l’empreinte du blob réellement lu au `commit:path` indiqué. Une ancienne ligne associée au nouveau contenu, une nouvelle ligne associée à l’ancien contenu, une règle étrangère ou un blob non relu restent refusés. Une version admise dans le checkout ne sert jamais de fallback pour l’historique.

Ce contrat ne change ni Gitleaks, ni ses règles, ni ses scans, ni les conditions de revue des faux positifs. Il n’admet aucun secret réel et ne migre automatiquement aucune entrée de `reviewed-gitleaks.json`. Un passage à v2 et chaque nouvelle empreinte doivent faire l’objet d’une revue distincte avant publication ; les tests sur des fixtures fictives ne remplacent pas un nouveau rapport de scanner sur le candidat.

## Exclusion explicite du suivi amont

Le seul fichier supplémentaire exclu est `apps/sim/lib/consent/scripts.ts`, SHA256 `ee3e80bed13dcfb1f2173c09e0cd580d82aa9a03ed5483c2fd301c12de6e5808`. Il contient les identifiants et scripts de suivi amont. Aucune exception Gitleaks ne lui est accordée. Son empreinte est aussi interdite pour empêcher une copie identique sous un autre nom.

`prepare` lit une exclusion explicite seulement pour ce chemin et ce hash ; une différence de contenu bloque la préparation avant écriture. Le motif et l’empreinte figurent dans l’inventaire. Les consommateurs Apache sont conservés et nécessitent un remplacement indépendant en P01 :

| Consommateur Apache | Contrat à traiter en P01 |
|---|---|
| `apps/sim/lib/analytics/google.ts` | `GOOGLE_ADS_ID`, `GOOGLE_ANALYTICS_ID` ; événements, conversions et pages |
| `apps/sim/app/(landing)/landing-consent-tracking.tsx` | `X_PIXEL_SCRIPT` |
| `apps/sim/app/_shell/consent/consent-store-provider.tsx` | `getGlobalConsentScripts` |
| `apps/sim/app/(landing)/demo/components/demo-scheduler/demo-scheduler.tsx` | `X_DEMO_BOOKED_EVENT_ID` ; embed Cal.com à traiter séparément selon sélection |
| `apps/sim/lib/consent/scripts.test.ts` | Recette des scripts de consentement |
| `apps/sim/app/_shell/consent/google-analytics-page-view-tracker.test.tsx` | Recette de suivi des pages et consentement |
| `apps/sim/app/(landing)/demo/components/demo-scheduler/demo-scheduler.test.tsx` | Mock de l’événement de démonstration |

Le module expose également le type `ConsentScriptCallbackInfo` et `X_PIXEL_ID`. L’objectif P01 est de préserver les composants et comportements de consentement nécessaires avec une configuration Memlia indépendante, sans les identifiants ni scripts de suivi amont. Aucun de ces remplacements n’est réalisé dans ce patch.

Le scan Gitleaks de la référence complète reste rouge avec 78 findings ; après classification, le finding du module exclu reste rouge. Seul un nouveau scan réel de l’arbre effectivement préparé pourra démontrer son absence. Aucun arbre Sim n’a été copié pour cette tranche.
