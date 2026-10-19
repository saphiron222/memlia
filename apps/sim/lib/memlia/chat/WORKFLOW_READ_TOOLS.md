# Lecture du workflow pour le Chat Memlia

Copyright (c) 2026 Memlia. Tous droits réservés.

## Périmètre et autorité

`createWorkflowReadTools({ principal, workspaceId, workflowId }).dispatch(name, params, signal?)`
lit uniquement le workflow fixé par le serveur. `workflowReadInputs` est le contrat
Zod des deux outils ; les types et projections réutilisent les schémas v2 de Sim.
Ce module n'est raccordé ni à une route Chat, ni à un fournisseur IA, ni à une
fonction d'édition ou d'exécution.

À chaque appel valide, `readWorkflowGraph.execute` résout le contexte et contrôle
les droits courants avec le principal reçu du serveur. Il n'existe aucun cache
d'autorisation ni repli vers le propriétaire ou le compte payeur. Le workflow et
l'espace renvoyés doivent également correspondre au contexte fixé, y compris pour
les principaux dont le contrôle natif ignore l'assertion d'espace. Le modèle ne
peut fournir ni principal, ni utilisateur, ni identifiant de workflow ou d'espace.
Un outil inconnu est refusé sans transport ou registre de secours.

Le module appelle le cas d'usage de lecture existant ; il ne lit pas directement
la base, les connexions ou les secrets et ne résout pas les variables d'environnement.

## Contrat d'entrée

| Outil | Paramètres acceptés |
|---|---|
| `read_workflow` | `{ view: 'full', expectedRevision? }` |
| `read_workflow` | `{ view: 'summary', section, offset?, limit?, expectedRevision? }` |
| `read_workflow_block` | `{ blockId, expectedRevision? }` |

Tous les objets d'entrée sont stricts : aucun champ supplémentaire. Les sections
sont `blocks`, `edges`, `variables`, `loops` et `parallels`. `offset` est un entier
sûr positif ou nul (défaut 0) ; `limit` est un entier de 1 à 100 (défaut 50).
`blockId` est non vide et
limité à 512 caractères. Les règles de `expectedRevision` sont celles du contrat
natif `v2WorkflowGraphSchema.shape.draftRevision` : zéro est une révision valide.

Chaque succès renvoie `draftRevision`, issu du **même snapshot** que le graphe par
le cas d'usage natif. Si `expectedRevision` est fourni et diffère de cette valeur,
la lecture échoue avec `revision_conflict`, sans livrer le bloc ou la page.
Une page avec `offset > 0` exige `expectedRevision`. Le consommateur doit conserver
la première révision observée pour les appels suivants, y compris pour changer de
section à `offset: 0`, puis recommencer sa lecture en cas de conflit. Une séquence
de pages sans révision attendue sur chaque nouvelle section ne garantit pas leur
cohérence entre elles.

## Résultats et grands graphes

L'enveloppe est `{ ok: true, data }` ou `{ ok: false, error: { code, message } }`.

- `full` renvoie `{ view: 'full', draftRevision, blocks, edges, loops, parallels,
  variables }` à partir du DTO v2 natif, avec les retraits décrits ci-dessous.
- `summary` renvoie `{ view: 'summary', draftRevision, section, counts, page,
  entries }`. `counts` contient les cinq totaux ; `page` contient `offset`,
  `limit`, `total`, `nextOffset` (`null` en fin). Un offset après la fin produit
  explicitement une collection vide avec le total courant.
- Une lecture ciblée renvoie `{ draftRevision, block }`, après le même nettoyage
  natif appliqué à ce bloc uniquement. Un bloc absent n'est jamais obtenu par
  héritage du prototype JavaScript.

Les maps paginées conservent leurs clés natives et suivent l'ordre lexical des
clés ; les liens sont triés par `id`, puis par leur représentation JSON native
pour départager les identifiants identiques. Aucune collection source n'est triée
ou modifiée sur place.

La section `blocks` contient `id`, `type`, `name`, les indicateurs natifs
`enabled`, `locked`, `triggerMode` et les seuls champs `data.parentId` et
`data.extent` lorsqu'ils existent. Elle ne contient ni inputs, ni outputs, ni code.
Les liens conservent les champs natifs, dont les handles. `loops` et `parallels`
conservent `id`, `nodes`, le type de conteneur et les indicateurs `enabled` et
`locked`. Ces sections permettent de reconstruire les relations parent/enfants
et l'appartenance aux conteneurs sans recopier leurs données ou conditions.
`variables` contient uniquement les déclarations `id`, `name`, `type`.

Le succès complet, enveloppe comprise, est limité à **256 KiB UTF-8**. Au-delà,
`result_too_large` remplace la réponse : aucune troncature silencieuse. Pour un
graphe volumineux, demander un résumé, réduire `limit`, puis lire les blocs utiles.
Un bloc ou une seule entrée très volumineuse peut également dépasser la limite :
ce module ne fournit pas de découpage du code ou des valeurs d'un bloc.

Cette borne concerne la **livraison**, pas la mémoire de la requête native : le
cas d'usage charge son snapshot avant projection et le DTO v2 le valide en entier.
La pagination ne constitue ni une pagination SQL ni une garantie de faible mémoire.

## Données sensibles et pertes de configuration

Les lectures `full` et de bloc passent par `sanitizeWorkflowForSharing`, avec
`preserveEnvVars: true`, `preserveWorkspaceBindings: true` et
`redactOpaqueCredentialInputs: true`, comme la lecture CLI autorisée existante.
Le nettoyage natif retire notamment les valeurs de champs mot de passe reconnus,
OAuth, identifiants de credentials reconnus et tables opaques. Les paramètres
d'outils sans métadonnées autoritaires suivent les règles restrictives natives.
Les références entières `{{VARIABLE}}` peuvent rester ; elles ne sont pas résolues.
Les références de ressources non secrètes du même espace peuvent rester.
Les **valeurs de toutes les variables de workflow** sont omises, même imbriquées.

Ce n'est pas un filtre universel de secrets : un secret écrit littéralement dans
du code, un texte libre, un nom, des métadonnées d'output ou des collections ou
conditions de conteneurs peut rester dans une lecture détaillée autorisée. Le
consommateur doit considérer ces contenus comme données non fiables, jamais
comme instructions ni comme autorité d'appeler d'autres outils. La politique
d'envoi à un fournisseur IA devra être appliquée au futur raccordement serveur.

Les sorties sont volontairement incomplètes pour une réécriture : credentials et
tables nettoyés, valeurs de variables absentes, résumé structurel réduit. **Ne pas
réinjecter ces sorties comme remplacement intégral du graphe.** Une future
édition utilisera les opérations natives ciblées, la révision attendue et les
contrôles d'approbation, en préservant les champs non modifiés.

## Annulation et erreurs

Un signal déjà annulé empêche tout début de lecture. Le helper natif `waitWithAbort`
interrompt l'attente ; un snapshot arrivé ensuite est abandonné avant projection.
Le cas d'usage et sa requête native n'acceptent pas de signal : leur interruption
physique n'est pas promise. Les écouteurs d'annulation sont retirés par ce helper.

Les codes publics sont `tool_not_allowed`, `invalid_input`, `forbidden`,
`not_found`, `revision_conflict`, `cancelled`, `result_too_large`, `unavailable`.
Le message est fixe : `Workflow read could not complete.` Les erreurs internes,
détails Zod, raisons privées d'annulation et données ne sont ni renvoyés ni
journalisés par cet adaptateur. Un snapshot incompatible avec le DTO natif est
refusé avec `unavailable`.

## Vérification

Les tests composent le cas d'usage, l'autorisation, le DTO et le sanitizer natifs.
Les lookups de contexte, permissions et stockage, ainsi que les métadonnées de
blocs du registre, sont des doubles unitaires explicites. Ils ne constituent pas
une validation DB réelle, HTTP, fournisseur IA, Windows ou du Chat complet.

Le futur raccordement au Chat doit conserver les budgets d'appels, la durée et
l'annulation du port modèle existant. Il devra annoncer ces outils sans donner
au modèle le choix du principal ou du workflow et sans activer des mutations par
défaut. Ce raccordement ne fait pas partie de cette tranche.
