# Raccordement catalogue aux providers Sim

`runCatalogProvider({ provider, request, principal, workspaceId, limits, signal })`
compose `runModelAdapter`, `createCatalogTools` et les providers **existants**
OpenAI Responses / Anthropic. C'est un raccordement serveur de découverte en
lecture seule ; aucune route ni interface Chat n'est activée par ce module.

Le serveur choisit le provider, le modèle et sa clé, fournit le principal Sim et
fixe l'espace. Les arguments du modèle ne sélectionnent jamais cette autorité.
Seuls `list_blocks`, `get_block`, `list_tools`, `get_tool` sont annoncés, avec les
schémas JSON dérivés de `catalogToolInputs`. Leurs use cases et permissions
courantes restent ceux de Sim. L'accès au catalogue n'autorise pas l'exécution
des connecteurs dont il expose les schémas.

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

## Entrée et résultat de cette tranche

Les champs de requête repris sont : modèle, clé, messages texte (role/content),
systemPrompt, température, maxTokens, reasoningEffort et thinkingLevel. Le binding
force le streaming `agent-events-v1` et fournit ses quatre propres outils. Les
fichiers attachés sont refusés. Les autres champs ProviderRequest ne sont pas
transmis : pas d'environnement workflow, connexion privée, historique natif de
tool calls, API d'édition ou compactor. Le maxTokens par défaut est2048 ; ce n'est
pas une politique de quotas financiers et le serveur doit autoriser sa
configuration. Aucun nom de modèle n'est figé dans le produit.

Le résultat est `{ stream, usage }` du port existant, avec les événements et
résultats projetés du catalogue. Les providers conservent leurs erreurs natives ;
la future exposition HTTP/Chat devra les projeter avant affichage. Les descriptions,
schémas et réponses du modèle restent des données non fiables, sans pouvoir
ajouter des capacités à ce dispatcher. Ce module n'ajoute aucun journal de clé,
prompt ou réponse.

## Vérifications et limites

Les tests composent les boucles des providers, leur préparation d'arguments, les
parseurs SSE **OpenAI SDK7.0.0 et Anthropic SDK0.115.0 réels**, le catalogue et ses
schémas natifs. Réseau HTTP, DB et recherches de permissions sont explicitement
doublés ; aucune API payante ni clé réelle n'est utilisée. Ils vérifient
outil→synthèse, retries OpenAI/summary, SDK Anthropic sans retry caché (trois
entrées), même client conservant sa politique hors contexte, concurrence,
annulation avant appel/transport/backoff/stream, deadline et absence de fallback.
Les tests natifs de providers/transport/retry/runtime-context sont rejoués aussi.

**Non couverts ou non fournis** : autres providers/endpoints compatibles, parcours
public non streaming de ce binding, fichiers, compaction/historique durable,
réconciliation tokens/coûts et budgets d'installation P06, lifecycle/reprise/SSE
HTTP, authentification des routes, lecture du graphe, preview/apply/CAS,
confirmation, mutation ou exécution. Les hooks de transport sont qualifiés pour
ces chemins précis ; leur présence ne rend pas automatiquement d'autres SDK
bornés. Le choix et l'appel d'un modèle réel, sa qualité et le Chat complet
restent à qualifier. Ce raccordement n'est pas le backend conversationnel final.
