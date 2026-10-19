# Décision de configuration IA côté serveur — P06

Ce module prépare une **décision de configuration à appliquer ultérieurement**.
Il ne lit aucune clé, ne lance aucun provider, ne charge aucun `.env`, ne consulte
aucune DB et ne crée aucune route. Les seules métadonnées qu'il consulte sont le
catalogue natif des modèles et leurs statuts de retrait.

**L'activation reste bloquée.** Aucun consommateur HTTP ou UI n'est raccordé.
Le contrôle effectif du transport et l'autorisation du premier envoi doivent
être réalisés et revus avant toute activation. Ce module n'est pas un contrôle
de destination du client Anthropic déjà en cache.

## Configuration acceptée

`parseChatInstallationPolicy(raw)` reçoit une configuration chargée par la
composition **serveur**, jamais un corps de requête du navigateur ou une réponse
du modèle. Elle exige tous les champs suivants :

| Champ | Valeur admise |
|---|---|
| `enabled` | `true` explicite |
| `provider` | `openai` ou `anthropic`, les deux ports P05 déjà qualifiés |
| `model` | ID exact du catalogue natif de ce provider, non deprecated ; 1–256 caractères |
| `destination` | `official` uniquement, une intention à appliquer au transport |
| `data.conversation` | `true` explicite : le texte de conversation peut sortir |
| `data.catalogue` | `true` explicite : les projections catalogue peuvent sortir |
| `data.workflow` | `catalogue_only`, `summary_only` ou `sanitized_details`, sans défaut |

Configuration absente, inactive, incomplète, modèle inconnu/d'un autre provider,
wildcard, ID avec alias de casse/espace absent du catalogue, destination arbitraire
ou champ inconnu : refus. Aucune coercition, substitution ou fallback vers Ollama,
un autre modèle ou un autre compte. Le produit ne fige aucun nom commercial de
modèle : l'administrateur choisira dans le catalogue de la version déployée.
Un modèle connu n'est pas pour autant qualifié par un appel réel à son API.

Les objets doivent être des records ordinaires (prototype objet ou nul), avec
uniquement des propriétés propres, énumérables et de données. Accesseurs,
propriétés cachées, symboles et champs hérités sont refusés. Les erreurs publiques
restent `Chat installation policy is unavailable.`, sans contenu de configuration
ni cause brute. Les configurations sémantiques sont strictes aux deux niveaux.
Les bornes de champs ne sont pas une limite mémoire d'un futur lecteur JSON/HTTP.

Le résultat est un clone figé, y compris `data`, portant les mêmes champs validés
et deux marqueurs : `kind: 'configuration_decision'`, `activation: 'blocked'`.
Il ne contient ni clé, ciphertext, référence de credential, identité utilisateur,
endpoint, header, prompt, graphe ou catalogue. Il n'est pas une preuve d'autorité
administrateur. Passer un objet au parseur ne prouve pas sa provenance serveur.

## Source administrateur : fichier Linux POSIX

`readChatInstallationPolicyFile()` est un lecteur **serveur Linux uniquement**,
sans argument. Il lit le chemin absolu canonique de `MEMLIA_CHAT_POLICY_FILE`
dans l'environnement du processus, sans charger de `.env`, sans registre partagé
et sans repli sur une variable `NEXT_PUBLIC_*`. Aucun accès au fichier n'a lieu
à l'import. Son absence, sa suppression ou sa corruption entraînent un refus ;
il n'existe pas de cache de dernière configuration valide.

Le fichier et tous ses répertoires parents doivent appartenir à UID 0, sans droit
d'écriture groupe/autres, sans lien symbolique et sans écriture autorisée par
l'OS à l'identité web. Le serveur doit fonctionner sous une identité non-root,
avec UID/GID réels et effectifs identiques : le contrôle POSIX d'accès ne doit pas
évaluer une autre identité. Un UID web 1001 peut lire un fichier root en mode
0444 ou 0644 dans une arborescence root traversable, sous réserve des ACL et des
permissions effectives. Le lecteur n'accorde aucun droit et ne modifie aucun mode.

La lecture reprend l'algorithme borné du helper natif Sim
`packages/sim-cli/src/config/json-file.ts` (Apache-2.0), avec vérification de
propriété, comparaison inode/métadonnées avant/après lecture et fermeture stricte.
La limite est de **4096 octets**, avec au plus un octet supplémentaire pour détecter
un dépassement. Le descripteur utilise `O_NOFOLLOW` et `O_NONBLOCK` ; les fichiers
non réguliers, UTF-8 invalide, BOM, JSON invalide et erreurs d'accès/fermeture sont
refusés. Le parseur de politique existant valide ensuite le contenu sans coercition.
Toutes les erreurs restent fixes, sans chemin, contenu ou cause brute.

Le résultat figé `{ kind: 'installation_file_observation', policy }` décrit une
observation de fichier administrateur au moment de la lecture. La politique reste
`activation: 'blocked'`. Ce marqueur structurel est reproductible : il n'est ni
un jeton d'autorité, ni une admission utilisateur, ni une attestation permanente.
Un administrateur peut remplacer le fichier après la lecture ; aucun cache,
watcher, engagement de révocation ou admission atomique n'est fourni ici.

Le raccordement Compose reste **à réaliser et qualifier** : fichier non secret
monté en lecture seule, par exemple sous `/etc/memlia/chat-policy.json`, variable
serveur associée, ownership root et identité non-root vérifiés dans le conteneur.
Aucun montage ni variable du déploiement n'est modifié par cette tranche. La
configuration ne contient pas de clé, de credential ou d'endpoint personnalisé.
L'interface administrateur, l'admission du premier envoi, les clés et les budgets
restent des raccordements séparés ; ce lecteur n'active aucun appel IA.

Les tests utilisent de vrais fichiers, descripteurs, liens et remplacements
atomiques possédés. Sur macOS, la plateforme Linux et les métadonnées root/parents
sont explicitement doublées ; les contenus et opérations de lecture restent
réels. Cela **ne qualifie pas un montage root-owned Linux réel**, les ACL Linux,
un namespace Docker ou un déploiement Compose. Un fichier réellement détenu par
l'utilisateur de test est également refusé. Aucun privilège n'est élevé.

## Plafond de lecture dérivé

`selectWorkflowReadPolicy(decision, serverWorkflowId?)` revalide la décision et
le modèle, puis dérive seulement l'option workflow déjà comprise par P05. Son type
est lié à la signature existante de `runCatalogProvider` par un import **type-only**.
Ce n'est pas un appel de ce provider.

| Plafond serveur | Option dérivée lorsqu'un workflow serveur est lié |
|---|---|
| `catalogue_only` | Aucune ; P05 conserve exactement ses quatre outils catalogue |
| `summary_only` | `{ workflowId, policy: 'summary_only' }` |
| `sanitized_details` | `{ workflowId, policy: 'sanitized_details' }` |

Sans workflow serveur, aucun workflow n'est inventé : résultat `undefined` pour
les trois plafonds, donc les quatre outils catalogue uniquement. L'ID doit suivre
le schéma natif, avec une borne de livraison supplémentaire de512 caractères,
sans découpage ni normalisation. Un ID invalide, y compris en mode catalogue,
ou un objet de paramètres client à sa place est refusé. Une décision annoncée
comme déjà active, une configuration brute ou des options supplémentaires
key/modelOverride/baseURL/policy/tools sont également refusées.

La sélection n'autorise aucune lecture : les use cases natifs doivent toujours
contrôler le principal, le workspace et le workflow à chaque appel. Les schémas
des outils, révisions, pagination, sanitizer et limites P05 restent réutilisés,
sans duplication ou seconde boucle. La décision et la sélection peuvent être
reproduites depuis des objets valides ; elles ne sont pas des jetons de capacité.

## Conditions avant le raccordement effectif

- Raccorder explicitement la source d'installation serveur décrite ci-dessus
  à la future admission. Ne jamais fusionner `provider`, `model`, `apiKey`, `baseURL`, headers,
  outils, policy ou limites venus d'un client. Le futur contrat HTTP devra refuser
  ces champs ; aucun test de cette route inexistante n'est revendiqué ici.
- Autoriser la session, le workspace et la capacité Chat **avant le premier envoi**
  et avant résolution d'une clé d'installation. Les lectures P05 ne remplacent
  pas cette admission d'un appel IA financé par le cabinet.
- Raccorder les clés natives `getRotatingApiKey` côté serveur seulement, sans les
  retourner au navigateur, modèle, journal ou DTO. Le chiffrement natif des
  secrets existe pour une future gestion en DB ; ce module ne réalise pas ce stockage.
- Intersecter les restrictions courantes de l'installation et des permissions
  natives (denylist/blacklist/groupes). Ce parseur pur n'importe pas les lecteurs
  env/DB et ne prétend pas les avoir consultés. Aucune politique désactivée ne
  devient une autorisation implicite.
- Vérifier la destination et les réglages **effectifs** des transports. OpenAI
  utilise son URL native fixe et le post Responses refuse désormais les redirections
  sous `controlledRun` ALS ; cette protection contextuelle est détaillée ci-dessous.
  Anthropic peut conserver baseURL, authToken,
  headers ou logging issus de son SDK/cache. L'intention `official` ne neutralise
  pas ces paramètres. Leur durcissement contextuel doit précéder l'activation ;
  aucun changement temporaire d'env ou nettoyage global du cache n'est proposé.
- Conserver les réservations de chaque tentative, quotas, annulation et compteurs
  P05 ; ajouter ensuite les réservations/rapprochements monétaires persistants
  P06. Ce module ne calcule pas un coût et n'appelle pas un modèle.

## Redirections Responses sous contrôle serveur

Le point POST partagé de Responses capture la présence de `controlledRun` dans
le contexte ALS serveur avant la préparation asynchrone du corps. Il transmet
`redirect: 'error'` à chaque tentative physique de fetch dans ce contexte, y
compris les retries natifs et le repli sans reasoning.summary. Le champ
`maxRetries` n'est pas utilisé comme signal de politique. Hors contrôle ALS,
l'init natif reste sans option redirect ajoutée.

Les réservations de tentative, signaux d'annulation, parseurs et chemins streaming
restent natifs. Ce changement empêche le fetch natif de suivre une redirection ;
il ne remplace ni la sélection serveur de la destination initiale, ni l'admission
du premier envoi, ni la gestion des clés ou les budgets monétaires. Une fonction
fetch injectée doit respecter RequestInit ; aucun transport arbitraire qui ignore
ces options n'est qualifié. L'activation Chat et le transport Anthropic restent
soumis aux autres conditions ci-dessus.

La suite dédiée utilise le vrai fetch Node et deux serveurs possédés sur
127.0.0.1 avec ports éphémères. Les redirections 302/307/308, en modes classique
et streaming, n'atteignent pas la cible sous contrôle ; elles suivent encore le
comportement natif hors contrôle. Les retries, le repli sans résumé, les refus
budget/abort, les succès simples et l'isolation ALS concurrente sont vérifiés.
Les outils sans rapport sont doublés comme dans les tests natifs du provider ;
le transport HTTP, ALS et la réservation de chaque tentative ne sont pas doublés.
Aucune clé réelle, requête OpenAI, DB ou qualification d'un endpoint distant.

## Limites sur les données

Le catalogue expose des descriptions et defaults, dont des champs personnalisés.
Le résumé expose des noms et déclarations de variables. Les détails natifs
retirent les valeurs de variables et les credentials reconnus, mais du texte/code
libre peut contenir un secret littéral. Le texte utilisateur peut lui aussi être
sensible. Les opt-ins expriment donc un choix d'envoi explicite, **pas un détecteur
universel ni une suppression automatique de secrets**. Aucun filtre supplémentaire
ou engagement DLP n'est ajouté par cette tranche.

## Vérification

Les tests utilisent le vrai catalogue/schéma natif et des configurations fictives.
Ils ne lancent ni provider ni stockage. Les mocks globaux ordinaires de la suite
Vitest sont sans rôle dans les décisions ; aucun résultat DB/HTTP n'est utilisé.
Les contrôles couvrent modes, absence de workflow, refus stricts, bornes, erreurs
fixes, modèles obsolètes/incohérents, immutabilité, accesseurs et données cachées.
Pas de qualification d'une route, clé réelle, modèle distant, endpoint local,
interface admin, transport Anthropic, budget monétaire ou Chat complet.

Copyright 2026 Memlia. Tous droits réservés.
