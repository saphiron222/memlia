# Lectures du catalogue pour le futur Chat Memlia

`createCatalogTools({ principal, workspaceId })` fournit `dispatch(name, params,
signal?)`. Le principal provient de l'authentification Sim côté serveur et son
type est dérivé du use case natif. L'espace est fixé par le serveur. Aucun
identifiant d'acteur, rôle, clé API, audience ou espace fourni par le modèle
n'est accepté dans `params` ; les schémas sont stricts.

| Nom | Schéma d'entrée dérivé | Use case Sim réutilisé |
|---|---|---|
| `list_blocks` | `v2ListBlocksQuerySchema` sans workspace/cursor, offset borné | `listCatalogBlocks.execute` |
| `get_block` | `v2GetBlockParamsSchema.strict()` | `getCatalogBlock.execute` |
| `list_tools` | `v2ListToolsQuerySchema` sans workspace/cursor, offset borné | `listCatalogTools.execute` |
| `get_tool` | `v2GetToolParamsSchema.strict()` | `getCatalogTool.execute` |

Les schémas Zod réutilisables sont exportés dans `catalogToolInputs`. Il ne
s'agit pas d'un nouveau catalogue : définitions de blocs/outils, filtres,
versions, intégrations autorisées, previews et custom blocks restent gérés par
les fonctions natives sous `lib/catalog/application/`. Chaque invocation
repasse par leur autorisation courante. L'allowlist des quatre noms ne donne
aucune permission et ne permet aucune exécution de l'outil découvert.

Les listes conservent la pagination interne native `{ entries, offset, limit,
hasMore }`. Les limites de page viennent des contrats v2 (1–100, défaut 50) ;
l'offset doit être un entier de 0 à 10 000. Ce port n'accepte pas les curseurs
HTTP signés et ne recrée pas leurs routes. La pagination n'est pas un snapshot
immuable : une évolution du catalogue entre deux appels peut décaler une page.

Les résultats de détail restent `{ block }` ou `{ tool }`. Entrées de liste et
détails sont validés/projetés par les schémas de réponse v2 natifs. Cette étape
est nécessaire : `projectToolOutputs` conserve des objets de métadonnées par
assertion de type, alors que le contrat de réponse supprime les propriétés
supplémentaires. Les champs documentés tels que descriptions, exemples,
defaults et schémas `items` sont conservés. Ils restent des données non fiables
pour un modèle, jamais des instructions ou une autorisation d'action.

Cette lecture porte sur les schémas/configurations du catalogue autorisé.
Aucune route de connexion, valeur de secret ou état de draft n'est consultée.
Elle ne promet pas de reconnaître une donnée sensible qu'un auteur aurait
lui-même placée dans un champ descriptif/default autorisé. La future sortie
modèle devra conserver les contrôles de provenance et de traitement des données
appropriés ; la projection structurelle n'est pas un filtre universel de secrets.

Une réponse qui dépasse 256 Kio de JSON UTF-8 est refusée avec
`result_too_large`, sans renvoyer un schéma partiellement coupé. Réduire la page
ou préciser la recherche. Aucun résultat n'est mis en cache par ce port.

Les échecs portent seulement un code fixe (`tool_not_allowed`, `invalid_input`,
`forbidden`, `not_found`, `unavailable`, `cancelled`, `result_too_large`) et un
message fixe. Aucun message DB, stack, argument ou raison d'annulation n'est
recopié ou journalisé. Un signal déjà annulé empêche le démarrage de la lecture ;
une annulation en cours arrête la livraison du résultat. Les use cases natifs
n'acceptant pas de signal DB, une lecture déjà lancée peut terminer en arrière
du dispatcher ; son résultat ne sera pas délivré et son rejet reste traité.

Le futur runtime devra brancher ce dispatcher sur `runModelAdapter` pour les
limites de nombre d'appels, délai, annulation et outils autorisés. Aucun second
compteur d'agents, framework IA, authentification ou serveur n'est ajouté ici.
Ne pas construire de principal à partir du JSON du modèle. La conservation de
la session serveur ne remplace pas les contrôles natifs à chaque lecture.

## Qualification de cette tranche

Les tests de composition exécutent les vrais use cases, schémas, projections et
contrôles applicatifs Sim avec les fixtures unitaires amont pour la DB,
résolution des rôles/visibilité et définitions de registre. Loop/Parallel
proviennent des descripteurs natifs. Ce ne sont pas des tests HTTP/DB réels,
une lecture exhaustive du registre distribué ou une campagne modèle payante.

Cette tranche n'active ni route Chat, worker, streaming, appel modèle, lecture
de draft, édition, preview/apply ou exécution. Le raccordement à l'interface et
les opérations de mutation attendent les contrats et validations P03/P04. Elle
ne clôt pas P05 et ne démontre pas une génération conversationnelle complète.
