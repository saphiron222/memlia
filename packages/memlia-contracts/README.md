# Contrats Memlia

Contrats privés et versionnés entre l’application/worker Sim, l’agent Windows et
le runtime Excel Python. Les ajouts Memlia restent provisoirement tous droits
réservés. Ce package n’autorise aucune publication.

## Source canonique unique

`src/*.ts` définit les schémas Zod 4.3.6 ; les types TypeScript en sont inférés.
`bun run generate` exporte JSON Schema draft 2020-12 dans
`python/memlia_contracts/schemas/`. Python valide exactement ces fichiers générés
avec jsonschema 4.26.0. Ne pas modifier ces JSON manuellement ni créer une copie
de schéma Pydantic/TS. `bun run check:generated` échoue sur tout export absent ou
modifié ou surnuméraire. Le registre `_index.json` est généré depuis les mêmes
noms canoniques ; Python ne découvre pas ses contrats par les noms de fichiers.
Le chargeur et la construction du wheel refusent un ensemble de fichiers
différent, y compris un ancien export conservé dans le répertoire de build.
Une conversion Zod non représentable lève une erreur ; aucun mode
permissif de remplacement. Les `$ref` doivent rester locaux au document : le
chargeur Python refuse les références réseau.

Les six familles partagent identité, références, approbations et reçus : un seul
package réel suffit. Aucun package relais `excel-contracts` n’est nécessaire.

```ts
import { JobEnvelopeSchema, type JobEnvelope } from '@memlia/contracts'
const envelope: JobEnvelope = JobEnvelopeSchema.parse(untrustedInput)
```

```python
from memlia_contracts import validate
payload = validate("ExcelProcedure", untrusted_input)
```

Les deux validateurs refusent propriétés inconnues et versions non reconnues,
sans coercition, suppression silencieuse ni valeur par défaut. Le point d’entrée
Python est `validate`, sans seconde hiérarchie de modèles.

## Formats d’échange

- `schemaVersion` est un discriminant exact, distinct de la version immuable de
  procédure et de la révision de l’état. Une version inconnue est refusée.
- Les identifiants ASCII sont opaques : jamais des chemins, URL ou secrets.
  Le service autorisé résout un binding sans concaténer son identifiant à un chemin.
- Le scope exige toujours `organizationId` et `workspaceId`. `organizationId`
  accepte un identifiant ou explicitement `null`, qui signifie l’absence effective
  d’organisation du workspace, jamais un joker ni une portée globale. `workspaceId`
  reste un identifiant obligatoire non nul ; absence, chaîne vide et identifiant
  invalide sont refusés pour les deux champs. Aucune organisation n’est déduite
  ni remplacée par défaut. Le serveur doit résoudre le workspace canonique,
  comparer son organisation (y compris `null`) et vérifier les droits du principal
  authentifié ; ce contrôle de forme ne crée aucune autorité.
- Les horodatages suivent ISO 8601 en UTC, avec trois décimales et suffixe `Z`.
  Les dates de cellules sont `AAAA-MM-JJ`. Le calendrier grégorien commun va de
  l’année 0001 à 9999 ; année zéro, dates impossibles et suffixes sont refusés.
- La longueur des libellés (1–256) et du texte de cellule (0–32767) compte les
  valeurs scalaires Unicode : un caractère hors BMP compte pour un, un accent
  combinant compte séparément. Aucune normalisation ni coercition ; les
  substituts UTF-16 isolés sont refusés. Les motifs JS utilisent le mode Unicode ;
  tout futur validateur JSON Schema JavaScript doit conserver cette sémantique.
  Ces bornes de transport ne qualifient pas les limites natives d’un hôte Excel.
- Révisions et clôtures de bail sont des entiers JSON positifs ou nuls, ≤ 2^53−1.
- SHA-256 utilise `sha256:` puis 64 caractères hexadécimaux minuscules. Hacher
  les octets immuables exacts, sans resérialisation par le consommateur. Le digest
  d’une enveloppe désigne les octets persistés de son contenu non signé, sans son
  champ digest ; conserver ces octets avant approbation/envoi. Ce package contrôle
  la syntaxe de l’empreinte ; il ne la calcule ni ne l’authentifie.
- Decimal est une chaîne décimale, jamais un nombre JSON binaire. Null, zéro,
  texte et formule sont des valeurs distinctes. Précision, arrondi et agrégats
  tout-null ont des politiques explicites.
- Aucun champ ne permet jeton bearer, secret de connexion, fallback propriétaire,
  shell, programme arbitraire, chemin hôte ou URL de téléchargement. Cela ne
  garantit pas qu’une cellule ou un nom de colonne soit sans donnée sensible :
  minimisation et contrôle des données transmises au modèle restent applicatifs.

## Familles et consommateurs

| Schémas | Consommateurs et invariants de forme |
| --- | --- |
| Principal / Binding / Delegation | Admission/auth : acteur, sujet et propriétaire de connexion distincts. Une tâche sans acteur humain exige délégation ou grant partagé explicite. Binding personnel = sujet seulement. Révocation horodatée. |
| WorkflowProposal / Approval | Chat/édition : révision attendue, référence des opérations exactes, auteur, ressources, politique et expiration obligatoires. Approbation liée au digest/révision du workflow ou à procédure/snapshot/patch/destination Excel. |
| JobEnvelope / RunReceipt | Adaptateur JobQueueBackend/worker : noms de runners Sim connus, inputs hashés, autorité et politique d’effet explicites. Succès vérifié avec preuve ; effet inconnu avec réconciliation. |
| AgentCommand / SessionCapability | Serveur/Windows : cabinet, propriétaire, SID, session, agent, TTL, époque, clôtures de ressources, bundle, qualification et consentement local. Commandes fermées, capture bornée. Arrêt local indépendant du protocole. |
| ExcelProcedure | Auteur Chat/runtime Python : opérateurs tabulaires génériques fermés, correspondance sortie-destination, zones d’écriture/protection, contrôles, Decimal, formules, capacités et limites. |
| Snapshot / PatchSet / CommitReceipt | Python/Office.js/COM : empreinte source, valeurs et formules, plages, identifiants de mutations, préimages et postconditions. Tout reçu admettant une écriture exige une référence de sauvegarde persistée/vérifiée. Partiel, incertain et écrit-non-vérifié restent distincts du succès vérifié. |

L’intégrateur approuve les changements. Les consommateurs négocient version et
profil réel de capacités, régénèrent puis exécutent le corpus commun avant
intégration. Les consommateurs stricts refusent aussi les champs ajoutés : toute
forme ou signification incompatible demande une nouvelle version du protocole.
`0.1.0` est un candidat non gelé, sans client intégré ni qualification commerciale
implicite. Les ajustements issus de revue appartiennent encore à ce candidat.

L’admission explicite de `organizationId: null` élargit le candidat de scope,
également dans `JobEnvelope.authority`. Les messages contenant un identifiant
valide restent admis. Les anciens validateurs qui exigeaient une chaîne
refuseront les nouveaux messages personnels ; tout consommateur et toute
hypothèse TypeScript exigeant une chaîne doivent donc être adaptés et vérifiés
avant leur émission. Les exports Python doivent être régénérés avec cette
source. Aucun fallback ni négociation automatique n’est ajouté ; cette évolution
ne qualifie pas l’intégration des anciens consommateurs ni l’autorisation d’un
job personnel.

## Réutilisation et obligations d’admission

Source Sim autorisée : `c6cef5f87b6a1d1d01df89e7140bad9e9fd4c2e2`.

- `packages/auth/src/principal.ts` : les adaptateurs applicatifs utilisent ses
  `parsePrincipal`/`serializePrincipal`. Better Auth et platform-authz restent
  l’autorité. `SerializedSimPrincipal` est une projection de transport plus
  étroite : sujets externes authentifiés, resource scopes optionnels et familles
  hors exécution ne sont pas admis par ce profil initial. Une planification
  garde l’acteur système Sim et une référence de délégation distincte ; aucune
  fausse session navigateur ou identité copilot.
- `apps/sim/lib/workflows/editing/types.ts` et moteur d’édition : l’artefact
  d’opérations conserve `operation_type`, `block_id`, `params` de Sim. Il reste
  privé/immuable pour éviter un second schéma des paramètres de blocs et le
  transport de secrets. Le consommateur résout/vérifie l’empreinte puis emploie
  les validateurs/use cases Sim. Ce package ne valide pas son contenu.
- `apps/sim/lib/core/async-jobs/types.ts` : les noms de jobs et JobQueueBackend
  sont réutilisés. Aucun nouveau moteur ni registre. `run-data-drain` est exclu.
  Un nom accepté par le schéma ne prouve pas sa présence au registre déployé.

**Valider la forme n’autorise pas l’exécution.** Les use cases doivent vérifier :
identité acteur/sujet et portée réelle de délégation ; droits cabinet/workspace ;
propriétaire credentials, grants et révocation courante ; ordre des dates/TTL ;
exactitude du digest, des ressources et de la révision approuvés ; registre et
budget ; admission/outbox atomique et CAS ; SID/session/bail/fence actuels et
unicité commande-ID/digest ; consentement local réel ; persistance/relecture de
la sauvegarde avant toute écriture ; rectangles ordonnés et bornés, clés/IDs
uniques, clés de jointure correspondantes, typage des expressions, échelle
Decimal ≤ précision, capacités dérivées, inclusion des mutations dans les zones
permises, préimages, postconditions et authenticité des preuves. Ces relations
entre champs/états ne sont pas revendiquées comme garanties JSON Schema. Elles
exigent les tests d’intégration des use cases propriétaires. Aucune auth, CAS ou
moteur Excel n’est réimplémenté ici.

## Profil Excel initial

Le profil expose select/cast/map exact/join/aggregate/pivot/melt/sort/derive/filter.
Les expressions comportent un niveau borné d’arithmétique/comparaison/condition.
Les formules expriment une intention typée SUM/ROUND/IF/MIN/MAX/COUNT avec
arguments cellules/plages/littéraux. Un texte commençant par `=` reste du texte.
L’hôte doit inspecter/protéger les formules préexistantes et refuser celles hors
profil, les mutations structurelles, macros, BIFF8, rafraîchissements/TCD et
programmes de formules imbriqués. PatchSet ne représente que les mutations de
cellules. Un constat explicite `kind: no_changes` porte les mêmes identités,
version de procédure, snapshot et postconditions, avec zéro mutation, zéro zone
d’écriture et aucun recalcul. Le reçu `no_changes_verified` indique `effect: none`,
zéro mutation appliquée, identité/version du classeur et de la procédure,
snapshot, relecture et preuves de postconditions. Il ne prétend ni sauvegarde
ni nouvelle publication. Toute branche admettant une écriture conserve
obligatoirement la sauvegarde persistée/vérifiée. Les consommateurs doivent
vérifier la correspondance des identités/digests entre constat et reçu et
l’authenticité des observations : leur seule présence ne prouve pas l’idempotence.
Les styles sont des références immuables, pas une commande libre.
Fidélité OOXML, calcul natif, ordre de sauvegarde et coédition ne sont pas prouvés
par ces contrats. Toute capacité non implémentée doit être refusée explicitement.

## Vérification reproductible

Avec Bun 1.4.2, le package upstream `@typescript/typescript6` 6.0.2 et Python 3.12+
dans un environnement isolé :

```sh
bun run generate
bun run check:generated
PYTHON=/chemin/venv/bin/python bun run test
bun run type-check
bun scripts/verify-source.ts /chemin/checkout-sim-autorise
```

`verify-source` contrôle le SHA sans charger du code depuis le chemin fourni.
Le délai de test de 30 secondes couvre le corpus interopérable complet, dont
chaque cas est validé par Python à partir du schéma généré.
Le corpus comprend le refus d’un mauvais SHA et une divergence Python injectée :
le consommateur altéré refuse un binding personnel valide et le contrôle d’export
termine avec code 1. Un export surnuméraire est également refusé par le gate,
le consommateur et la construction du wheel. `bun test` contrôle l’égalité des
fichiers et du registre générés, le corpus partagé (fins de chaîne, Unicode,
bornes calendaires et résultat sans mutation inclus) et le refus de références réseau.
Le test de construction utilise pip et setuptools du venv, sans accès réseau ;
installer les dépendances de build figées dans `pyproject.toml` avant son exécution. Toutes les fixtures sont
fictives. Un wheel construit depuis ce package inclut les schémas, sans
installation editable requise.

La composition réelle avec les fonctions auth Sim sera un test à import statique
après admission P01 de ses sources dans le produit. Aucun helper produit ne charge
dynamiquement un checkout externe. Les résultats exploratoires de composition
restent archivés dans les preuves privées de l’intégrateur.

Ces tests ne qualifient pas le build Sim complet, les courses DB, l’auth réelle,
Windows/Excel, les calculs métier ni l’acceptation commerciale.
