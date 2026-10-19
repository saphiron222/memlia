# Raccordement catalogue et lectures de workflow aux providers Sim

`runCatalogProvider({ provider, request, principal, workspaceId, workflow?, limits, signal })`
compose `runModelAdapter`, `createCatalogTools`, les lectures optionnelles de
`createWorkflowReadTools` et les providers **existants**
OpenAI Responses / Anthropic. C'est un raccordement serveur de découverte en
lecture seule ; aucune route ni interface Chat n'est activée par ce module.

Le serveur choisit le provider, le modèle et sa clé, fournit le principal Sim et
fixe l'espace. Les arguments du modèle ne sélectionnent jamais cette autorité.
Sans option `workflow`, seuls `list_blocks`, `get_block`, `list_tools`, `get_tool` sont annoncés, avec les
schémas JSON dérivés de `catalogToolInputs`. Leurs use cases et permissions
courantes restent ceux de Sim. L'accès au catalogue n'autorise pas l'exécution
des connecteurs dont il expose les schémas.

## Lecture optionnelle d'un workflow fixé par le serveur

Le serveur peut ajouter `workflow: { workflowId, policy }`. Cette option stricte
exige un identifiant natif non vide et la politique explicite `summary_only` ou
`sanitized_details` ; aucun défaut n'autorise les détails. L'option est validée et
copiée avant le premier appel modèle. Une clé inconnue, une politique manquante
ou invalide fait échouer la création avec un message fixe, sans appel réseau.
Ni l'identifiant ni la politique ne sont des paramètres choisis par le modèle.

| Option serveur | Outils et données supplémentaires autorisés |
|---|---|
| Absente | Aucun : les quatre outils catalogue restent identiques. |
| `summary_only` | `read_workflow`, vue `summary` uniquement ; cinq outils au total. |
| `sanitized_details` | `read_workflow`, vues `summary`/`full`, et `read_workflow_block` ; six outils au total. |

Les arguments des deux nouveaux outils sont enveloppés dans `request` :

```json
{"request":{"view":"summary","section":"blocks","limit":10}}
```

Une lecture de bloc utilise `{"request":{"blockId":"…","expectedRevision":7}}`.
Le wrapper et son contenu sont validés strictement. Les schémas intérieurs sont
exactement ceux de `workflowReadInputs`, sans copie manuelle de leurs champs.
En `summary_only`, seule la branche summary native est annoncée ; un appel
frauduleux demandant `full` est également refusé côté serveur **avant le use case**.
Le bloc détaillé n'est ni annoncé ni admis au dispatcher sous cette politique.

Ce wrapper est nécessaire : le formatter Anthropic natif reconstruit uniquement
`type`, `properties`, `required`, et perdrait une union à la racine. Zod 4.3.6
sérialise actuellement la union discriminée native en `oneOf` ; le code reconnaît
aussi `anyOf` pour sélectionner sa branche summary. Le schéma complet est placé
dans `properties.request`, où les deux formatters le conservent. Seule l'indication
de dialecte `$schema` est retirée. Les tests inspectent les objets réellement
sérialisés aux SDK ; aucun formatter natif n'est modifié et aucun outil vide
n'est annoncé. Cela ne remplace pas une qualification d'acceptation par les API
distantes, qui n'ont pas été appelées dans ces tests.

Chaque lecture réutilise le principal et l'espace du serveur ainsi que le use
case natif autorisé ; aucune lecture SQL, cache de droits, copie privée ou mutation
n'est introduite. La révision, la pagination, la limite de 256 KiB UTF-8 et les règles
de projection restent celles de [WORKFLOW_READ_TOOLS.md](WORKFLOW_READ_TOOLS.md).
Le consommateur doit conserver `expectedRevision` entre pages et sections.
Les sorties nettoyées ne doivent jamais remplacer intégralement un graphe.

Les variables de workflow sont livrées sans valeur ; mots de passe, OAuth, credentials
reconnus et tables opaques suivent le sanitizer natif. Un secret littéral dans du
code, texte libre ou autre contenu non reconnu peut toutefois rester dans les
détails. **`sanitized_details` n'est pas une politique universelle de confidentialité.**
L'activation future d'une route HTTP reste bloquée sur la politique d'envoi P06,
les modèles/endpoints autorisés, leurs secrets et budgets. Le binding local ne
donne aucune permission de transmettre des données client réelles à un fournisseur.

## Contrôles dans les chemins natifs

`ProviderRuntimeContext.controlledRun` est optionnel et doit être installé par du
code serveur de confiance. Le binding crée un contexte neuf : aucune session de
workflow, replay, identité de payeur, registre de secrets ou fonction de
compaction héritée n'est reprise. `executeProviderTool` utilise ce dispatcher
**avant** replay, alias et registre natif, et n'y retombe jamais après un refus.
Sim ajoute `_toolSchema` lors de sa préparation des arguments : seul ce champ
technique est retiré avant la validation stricte du catalogue. Les autres champs,
dont `_context` ou `workspaceId` injectés par un modèle, restent rejetés.

| Frontière physique | Branchement |
|---|---|
| OpenAI `core.ts` : callback `post` → `fetchImpl` | `beforeProviderModelCall` à chaque tentative du retry natif, chaque tour/synthèse et fallback reasoning summary |
| Anthropic `core.ts` : `createMessage` | Réservation puis options SDK par appel, y compris le passage streaming interne pour grand max_tokens |
| Anthropic `core.ts` : stream sans outils | Préparation du payload puis réservation/options avant `messages.create` |
| Anthropic `streaming-tool-loop.ts` | Préparation du tour puis réservation/options avant chaque `messages.stream`, synthèse comprise |

Dans ce contexte, les options SDK Anthropic `maxRetries: 0` désactivent les
retries internes non observables ; un échec remonte, sans retry Anthropic
additionnel inventé. OpenAI conserve son retry explicite, où chaque send passe
la garde. Le client Anthropic en cache et les constantes globales de transport
restent inchangés ; hors contexte, les options et retries natifs sont conservés.
Une réservation est comptée même si l'appel échoue ou est ensuite annulé : ce
compteur borne des tentatives, et ne représente ni tokens facturés ni prix.

Les plafonds, réservations synchrones avant les outils concurrents, durée et
annulations restent ceux de `runModelAdapter`. Le signal atteint les transports
et les boucles natives ; l'annulation du consommateur est propagée. La deadline
reste active même sans lecture. Les use cases catalogue actuels peuvent terminer
une lecture DB après annulation de sa livraison, comme expliqué dans
`CATALOG_TOOLS.md`.
Les lectures de workflow propagent le même signal : une annulation arrête la
livraison et évite la projection d'un snapshot tardif, sans prétendre interrompre
physiquement la requête native de stockage.

## Entrée et résultat de cette tranche

Les champs de requête repris sont : modèle, clé, messages texte (role/content),
systemPrompt, température, maxTokens, reasoningEffort et thinkingLevel. Le binding
force le streaming `agent-events-v1` et fournit uniquement ses quatre à six outils
selon la politique explicite ci-dessus. Les
fichiers attachés sont refusés. Les autres champs ProviderRequest ne sont pas
transmis : pas d'environnement workflow, connexion privée, historique natif de
tool calls, API d'édition ou compactor. Le maxTokens par défaut est 2048 ; ce n'est
pas une politique de quotas financiers et le serveur doit autoriser sa
configuration. Aucun nom de modèle n'est figé dans le produit.

Le résultat est `{ stream, usage }` du port existant, avec les événements et
résultats projetés du catalogue. Les providers conservent leurs erreurs natives ;
la future exposition HTTP/Chat devra les projeter avant affichage. Les descriptions,
schémas et réponses du modèle restent des données non fiables, sans pouvoir
ajouter des capacités à ce dispatcher. Ce module n'ajoute aucun journal de clé,
prompt ou réponse.

Pour les seuls refus des deux outils workflow, `rawResponse` reste en
`success:false` : les événements natifs `tool_call_end` restent en erreur.
Les boucles natives supprimeraient sinon le code de refus en reformattant leur
résultat. Le seul `modelResponse` utilise donc une **enveloppe de transport**
`success:true`, contenant `output:{ok:false,error:{code,message}}`. Ce `ok:false`
explicite conserve `revision_conflict`, `invalid_input`, `forbidden`, etc. au tour
suivant, sans donnée brute ni transformation d'une action en réussite. Le message
reste fixe. Le comportement de refus des quatre outils catalogue est inchangé.
Les erreurs de transport/model restent celles du provider et nécessitent encore
une projection sûre avant exposition HTTP.

## Vérifications et limites

Les tests composent les boucles des providers, leur préparation d'arguments, les
parseurs SSE **OpenAI SDK 7.0.0 et Anthropic SDK 0.115.0 réels**, le catalogue et ses
schémas natifs. Réseau HTTP, DB et recherches de permissions sont explicitement
doublés ; aucune API payante ni clé réelle n'est utilisée. Ils vérifient
outil→synthèse, retries OpenAI/summary, SDK Anthropic sans retry caché (trois
entrées), même client conservant sa politique hors contexte, concurrence,
annulation avant appel/transport/backoff/stream, deadline et absence de fallback.
Les tests natifs de providers/transport/retry/runtime-context sont rejoués aussi.
Les tests du raccordement workflow vérifient en plus les définitions SDK et
résultats au tour suivant, l'option serveur, le wrapper strict, les permissions
courantes, les révisions/pages, les retraits connus de secrets, les refus raw et
modèle distincts, les limites d'appels et l'annulation pendant une lecture.

**Non couverts ou non fournis** : autres providers/endpoints compatibles, parcours
public non streaming de ce binding, fichiers, compaction/historique durable,
réconciliation tokens/coûts et budgets d'installation P06, lifecycle/reprise/SSE
HTTP, authentification des routes, politique d'envoi P06, preview/apply/CAS,
confirmation, mutation ou exécution. Les hooks de transport sont qualifiés pour
ces chemins précis ; leur présence ne rend pas automatiquement d'autres SDK
bornés. Le choix et l'appel d'un modèle réel, sa qualité et le Chat complet
restent à qualifier. Ce raccordement n'est pas le backend conversationnel final.
