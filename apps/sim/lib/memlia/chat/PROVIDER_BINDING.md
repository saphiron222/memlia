# Raccordement catalogue, lectures et prévisualisation aux providers Sim

`runCatalogProvider({ provider, request, principal, workspaceId, workflow?, limits, signal, beforeModelTransport?, observeModelAttempt? })`
compose `runModelAdapter`, `createCatalogTools`, les lectures optionnelles de
`createWorkflowReadTools`, la prévisualisation optionnelle `createWorkflowPreviewTools`
et les providers **existants**
OpenAI Responses / Anthropic. C'est un raccordement serveur de découverte en
lecture seule ; aucune route ni interface Chat n'est activée par ce module.

Le serveur choisit le provider, le modèle et sa clé, fournit le principal Sim et
fixe l'espace. Les arguments du modèle ne sélectionnent jamais cette autorité.
Sans option `workflow`, seuls `list_blocks`, `get_block`, `list_tools`, `get_tool` sont annoncés, avec les
schémas JSON dérivés de `catalogToolInputs`. Leurs use cases et permissions
courantes restent ceux de Sim. L'accès au catalogue n'autorise pas l'exécution
des connecteurs dont il expose les schémas.

## Lecture optionnelle d'un workflow fixé par le serveur

Le serveur peut ajouter `workflow: { workflowId, policy, previewOperations? }`. Cette option stricte
exige un identifiant natif non vide et la politique explicite `summary_only` ou
`sanitized_details` ; aucun défaut n'autorise les détails. L'option est validée et
copiée avant le premier appel modèle. Une clé inconnue, une politique manquante
ou invalide fait échouer la création avec un message fixe, sans appel réseau.
Ni l'identifiant ni la politique ne sont des paramètres choisis par le modèle.

| Option serveur | Outils et données supplémentaires autorisés |
|---|---|
| Absente | Aucun : les quatre outils catalogue restent identiques. |
| `summary_only` | `read_workflow`, vue `summary` uniquement ; cinq outils au total. |
| `sanitized_details` sans opt-in | `read_workflow`, vues `summary`/`full`, et `read_workflow_block` ; six outils au total. |
| `sanitized_details` avec `previewOperations: true` | Les six outils précédents et `preview_workflow_operations` ; sept outils au total. |

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

## Prévisualisation optionnelle, sans application

L'option serveur `previewOperations: true` est admise uniquement avec
`policy: 'sanitized_details'`. L'absence ne change rien ; `false`, une chaîne ou
`true` avec `summary_only` sont des configurations refusées avant tout appel modèle.
Le modèle ne peut activer ce port depuis ses arguments. Un outil non annoncé est
refusé dans le chemin natif, sans fallback vers le registre général ; une synthèse
peut néanmoins suivre ce refus, selon le comportement habituel du provider.

L'outil reçoit `{"request": <corps v2 apply-workflow-operations>}`. Son schéma
intérieur dérive de l'objet v2 exact utilisé par la fabrique preview, avec
`expectedRevision` obligatoire. L'enveloppe est stricte ; le corps original est
transmis à la capture JSON stricte du preview **avant** les défauts/transformations
Zod, puis au véritable use case avec `dryRun: true`. Aucune identité modèle, graphe
alternatif ou demande d'application n'est autorisée.

Le générateur v2 émet des `$defs` et des références locales `#/$defs/...`. Comme
le corps devient `properties.request`, ses seuls pointeurs sont relocalisés en
`#/properties/request/$defs/...`, après vérification de leur cible propre dans
le schéma d'origine. Les définitions, contraintes et annotations sont conservées.
Une référence externe, mal formée, pendante ou visant une valeur non schéma fait
échouer la création avec un message fixe, avant le réseau. Aucun formatter partagé
n'est changé. Les tests inspectent les JSON réellement envoyés par les deux SDK :
chaque pointeur doit se résoudre depuis leur racine et la relocalisation inverse
redonne exactement le schéma natif. L'acceptation par les API distantes reste non
qualifiée, comme pour les autres schémas de cette tranche.

Le principal preview et la sélection serveur sont capturés avant toute attente.
Les droits, la révision, les contrôles natifs et la projection restent ceux de
[WORKFLOW_PREVIEW_TOOLS.md](WORKFLOW_PREVIEW_TOOLS.md). Ni graphe ni paramètres ni
credentials du snapshot ne sont retournés. Les arguments que le modèle a déjà
soumis restent dans son historique natif : ce n'est pas une nouvelle lecture du
graphe ni une suppression d'historique. Les mêmes limites d'appels et signaux
s'appliquent. Aucun résultat n'est persisté et aucune confirmation/attestation
n'est créée. La politique d'envoi P06 reste inchangée et bloque l'activation HTTP.

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
force le streaming `agent-events-v1` et fournit uniquement ses quatre à sept outils
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

Pour les seuls refus des outils de lecture ou prévisualisation workflow, `rawResponse` reste en
`success:false` : les événements natifs `tool_call_end` restent en erreur.
Les boucles natives supprimeraient sinon le code de refus en reformattant leur
résultat. Le seul `modelResponse` utilise donc une **enveloppe de transport**
`success:true`, contenant `output:{ok:false,error:{code,message},diagnostics?}`. Les diagnostics du refus
`atomic_refused` sont ceux, fixes et bornés, projetés par la fabrique preview ;
ils restent présents dans le raw output également, sans rendre `rawResponse.success` vrai. Ce `ok:false`
explicite conserve `revision_conflict`, `invalid_input`, `forbidden`, etc. au tour
suivant, sans donnée brute ni transformation d'une action en réussite. Le message
reste fixe. Le comportement de refus des quatre outils catalogue est inchangé.
Les erreurs de transport/model restent celles du provider et nécessitent encore
une projection sûre avant exposition HTTP.

## Attente serveur optionnelle avant chaque transport

`beforeModelTransport(signal, attempt?): Promise<void>` est une option du serveur capturée
une seule fois à la création du binding. Elle n'est ni un argument du modèle,
ni un champ de `request`, ni un outil annoncé. Une valeur présente non callable
est refusée avec un message fixe. Sans option, les politiques natives restent
identiques ; le helper synchrone `beforeProviderModelCall` est conservé.

Le nouveau helper attendu réutilise ce compteur synchrone une fois par tentative,
puis attend le callback avant le fetch OpenAI ou l'appel SDK Anthropic. Cela couvre
les retries OpenAI, le fallback de résumé, les tours d'outils et la synthèse finale,
ainsi que les trois entrées Anthropic. Les retries SDK cachés restent désactivés
uniquement sous contrôle ALS. Un refus du compteur empêche aussi le callback.
Le signal est capturé avant l'attente ; une annulation avant, pendant ou après
celle-ci interdit le transport. L'attente peut être interrompue même si le callback
ignore son signal, et ses rejets tardifs sont consommés. Le callback doit néanmoins
coopérer pour arrêter son propre travail : cette primitive ne peut pas annuler une
écriture déjà engagée dans un service externe.

Un rejet du callback devient `Server model transport guard refused.`, sans cause,
code réseau ni message privé, et ne déclenche pas de retry de transport. Les autres
erreurs natives et compteurs conservent leur sémantique. Sans observateur OpenAI, le callback ne reçoit que
le signal ; sa résolution n'est **pas** une preuve d'autorité, de tarif, de réservation
COMMIT ou de règlement. Aucun port budgétaire, principal, clé, route HTTP ou politique
d'activation n'est ajouté ici. Le futur raccordement P06 doit encore établir ces
preuves avant chaque envoi ; un refus ou une annulation ne libère aucun engagement
budgétaire par cette seule interface.

## Observation optionnelle OpenAI par tentative physique

`observeModelAttempt(attempt, observation): Promise<void>` est une seconde option
serveur, capturée une fois par le binding. Elle exige OpenAI ; Anthropic est refusé
avant transport, son mécanisme d'attente existant restant inchangé. Le port natif
OpenAI refuse également l'observation hors streaming ou pour un autre provider
compatible Responses. Aucun champ d'observation n'est transmis au modèle ou au SDK.

Avec cette option, le hook prétransport reçoit en second argument une référence
opaque locale, vide et gelée. Elle existe avant l'attente et peut corréler une future
réservation serveur ; elle n'atteste aucune autorité ni COMMIT. Une WeakMap locale
lie la réponse HTTP physique à cette référence. Chaque retry, fallback de résumé
et synthèse reçoit sa propre référence. Les parseurs SSE existants fournissent leur
réponse terminale au port : aucun second parseur, répartition du cumul, identifiant
modèle ou journal de contenu n'est ajouté.

La fermeture est marquée avant le callback et ne s'exécute qu'une fois ; références
étrangères, doublons et notifications tardives sont sans effet. Les compteurs et
l'estimation sont copiés/gelés avant l'attente du callback. La référence est locale
à ce processus et n'est pas un reçu durable. Les fonctions d'observation sont des
ports internes de confiance, jamais une validation d'une facture fournie par un client.

- `unknown` : raisons fixes `not_sent`, `transport_error`, `http_error`, `incomplete`
  ou `usage_unavailable`. Aucune de ces raisons ne signifie coût zéro ni libération.
- `usage` : les compteurs terminalement observés sont validés avant les normaliseurs
  natifs (entiers sûrs non négatifs, total cohérent, caches non supérieurs à l'entrée,
  raisonnement non supérieur à la sortie). Les détails cache/raisonnement absents
  suivent les valeurs optionnelles natives ; une valeur présente invalide est refusée.
  Les réponses partielles, même utilisables pour du texte, restent inconnues ici.
- `cost.kind=list_price_estimate` : estimation au tarif liste enregistré, via
  `priceModelUsage` et sa politique liste, caches/paliers natifs inclus. Ce nombre
  arrondi n'est ni une facture fournisseur, ni une preuve USD/ledger, ni une garantie
  de plafond. Zéro estimé n'autorise pas un règlement gratuit ; P06 garde sa règle
  native de réconciliation quand aucun événement ledger modèle ne peut être écrit.
  Sans tarif enregistré, `cost.kind=unavailable` ; le fallback d'affichage n'est pas utilisé.

Un observateur rejeté produit seulement `Server model observation failed.`, sans
cause/code réseau ; même sur HTTP503 il ne provoque aucun retry. La fermeture n'est
pas rejouée après cet échec : le futur port budgétaire doit conserver l'incertitude.
L'annulation après un premier tour peut laisser ce tour observé et la tentative
suivante inconnue ; la collecte d'un coût déjà engagé ne dépend pas d'un nouveau droit
d'envoi. Le callback doit être borné par son propre port ; aucune transaction DB,
politique de libération, relance ou règlement n'est fournie par ce raccordement.

## Vérifications et limites

Les tests composent les boucles des providers, leur préparation d'arguments, les
parseurs SSE **OpenAI SDK 7.0.0 et Anthropic SDK 0.115.0 réels**, le catalogue et ses
schémas natifs. Réseau HTTP, DB et recherches de permissions sont explicitement
doublés ; aucune API payante ni clé réelle n'est utilisée. Ils vérifient
outil→synthèse, retries OpenAI/summary, SDK Anthropic sans retry caché (trois
entrées), même client conservant sa politique hors contexte, concurrence,
annulation avant appel/transport/backoff/stream, deadline et absence de fallback.
Les tests natifs de providers/transport/retry/runtime-context sont des suites de régression du raccordement.
Les tests preview composent le véritable moteur dry run avec des lectures DB
et un registre de blocs doublés (configuration native Function). Ils contrôlent
les deux schémas SDK, leurs références, les diagnostics atomiques, les refus
d’identité/scope/révision/permissions, les budgets, l’annulation et l’absence de
persistance. Les tests du raccordement workflow vérifient en plus les définitions SDK et
résultats au tour suivant, l'option serveur, le wrapper strict, les permissions
courantes, les révisions/pages, les retraits connus de secrets, les refus raw et
modèle distincts, les limites d'appels et l'annulation pendant une lecture.

**Non couverts ou non fournis** : autres providers/endpoints compatibles, parcours
public non streaming de ce binding, fichiers, compaction/historique durable,
réconciliation tokens/coûts et budgets d'installation P06, lifecycle/reprise/SSE
HTTP, authentification des routes, politique d'envoi P06, apply/CAS,
confirmation, mutation ou exécution. Les hooks de transport sont qualifiés pour
ces chemins précis ; leur présence ne rend pas automatiquement d'autres SDK
bornés. Le choix et l'appel d'un modèle réel, sa qualité et le Chat complet
restent à qualifier. Ce raccordement n'est pas le backend conversationnel final.

## Diagnostics d'erreur OpenAI sous contrôle serveur

Le chemin OpenAI capture la présence du contrôle serveur avant les attentes et
conserve cette décision dans la boucle. Ses erreurs de transport, de requête,
d'outil et de streaming sont journalisées avec des codes fixes, sans message,
cause, stack ou en-tête du provider. Le retry natif reçoit une option interne
explicite : ses avertissements conservent seulement le code, le numéro de
tentative, la limite et le délai. Aucun champ modèle ne choisit cette politique.

Hors de ce contrôle, les diagnostics natifs restent inchangés. Les exceptions,
leurs causes et les résultats transmis au caller ne sont pas réécrits par cette
projection de logs ; la fermeture des sorties HTTP/SSE appartient au caller.
Anthropic et les autres providers ne sont pas requalifiés par ce changement.

Le binding crée une requête et un contexte propres, sans `agentConversation`.
Le helper natif `recordProviderConversationToolError` ne possède donc aucune
cible durable dans ce contexte fermé. Cela ne garantit pas la même propriété
pour une autre composition ALS qui ajouterait explicitement une conversation.
