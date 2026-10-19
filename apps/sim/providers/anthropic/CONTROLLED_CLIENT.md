# Transport Anthropic des appels serveur contrôlés

La présence du contexte serveur `controlledRun` sélectionne un client Anthropic neuf pour cette exécution. `anthropicProvider` conserve exactement sa factory et son cache natifs hors de ce contexte. Aucun champ de `ProviderRequest`, outil ou réponse du modèle ne choisit le profil, la destination ou les options du SDK.

`createControlledAnthropicClient(apiKey)` reçoit uniquement la clé déjà fournie par le serveur au provider. Il ne consulte ni le stockage de clés ni la politique d’installation, et ne résout aucune clé depuis l’environnement. Une valeur absente, vide ou invalide pour un en-tête HTTP est refusée avec le message fixe `Controlled Anthropic transport is unavailable.` ; l’erreur native susceptible de contenir la valeur n’est pas exposée. Cette vérification du transport ne donne aucun droit d’utiliser une clé.

## Options effectives du profil

| Réglage | Comportement contrôlé |
|---|---|
| Destination | `https://api.anthropic.com` explicite ; pas d’endpoint fourni par le client ou hérité d’un ancien objet du cache. |
| Authentification | `apiKey` explicite ; `authToken:null` et `webhookKey:null`. Le SDK installé ne lance pas sa résolution credentials/config/profile avec une clé explicite. |
| En-têtes ambiants | `ANTHROPIC_CUSTOM_HEADERS` absent ou chaîne vide seulement. Toute valeur non vide, espaces compris, est refusée avant construction du SDK, sans la parser ni l’afficher. |
| Logs SDK | `logLevel:'off'` explicite, même si `ANTHROPIC_LOG=debug`. Ce réglage ne constitue pas une politique de journalisation globale de Sim. |
| Répétitions SDK | `maxRetries:0`. Les hooks existants réservent toujours chaque tentative physique ; aucune nouvelle boucle de reprise. |
| Redirections | `fetchOptions:{redirect:'error'}`. Ni suivi automatique ni transfert des identifiants vers la cible d’une redirection. |
| Annulation et streaming | Signal et réservation par tentative natifs conservés ; aucun wrapper réseau de production ni nouveau délai total qui couperait un stream. |
| Cache | Ni lecture, ni écriture, ni vidage du cache partagé dans le profil contrôlé ; le client créé sert aux tours de la même exécution native. |

Le SDK **réellement installé et examiné est `@anthropic-ai/sdk@0.115.0`**. Son constructeur `src/client.ts:521–584` lit des valeurs d’environnement malgré certaines options explicites. En particulier, les en-têtes de `ANTHROPIC_CUSTOM_HEADERS` sont fusionnés après construction des options et peuvent remplacer `X-Api-Key`. `withOptions()` reconstruit le client avec ses anciennes options et ne supprime pas cette fusion. Ajouter seulement `baseURL` à un client en cache ou le cloner ne suffit donc pas.

Le refus des en-têtes précède synchroniquement la construction du client, sans mutation de `process.env`. Le profil ne tente pas de nettoyer l’environnement du processus, de remplacer son mécanisme réseau global, de modifier le SDK ou de vider le cache des autres consommateurs. Les invariants dépendent des sources et versions examinées ; une mise à jour du SDK doit repasser les tests. Un processus compromis capable de changer les objets JavaScript ou son environnement n’est pas isolé par cette fonction.

## Vérifications et portée

Les tests adjacents passent par le vrai SDK, le cache Sim, le contexte serveur et le provider natifs. Les réponses HTTP sont des doubles explicites ; les mocks DB/auth/logger du harness Sim ne constituent pas une validation d’infrastructure. Ils vérifient notamment : URL et clé transmises, absence de bearer ambiant, refus des en-têtes, cache antérieur ignoré puis conservé pour l’appel natif suivant, erreurs fixes, absence de reprise SDK, annulation et concurrence de clés distinctes. Les suites existantes de provider-binding et des boucles Anthropic couvrent aussi les parseurs SSE, tours outils, synthèse et compteurs.

La campagne privée ajoute une sonde du vrai SDK et du `fetch` natif sous **Node24.22.0 et Bun1.4.2**, vers un serveur HTTP de bouclage possédé : redirection réellement refusée, cible jamais appelée, SSE réellement parsé, réponse503 sans répétition. La sonde réécrit la destination officielle vers ce serveur uniquement dans son double réseau de test. Elle **ne qualifie ni DNS, ni TLS, ni l’egress distant vers Anthropic**.

## Ce qui reste requis avant activation du Chat

Cette tranche n’ajoute aucune route, UI, lecture de clé administrateur, configuration P06 ou activation de transport depuis une policy. Le premier envoi doit encore être autorisé côté serveur pour le principal et l’espace courants, puis être lié à la décision d’installation et aux restrictions natives de modèle. La policy P06 conserve donc son état `activation:'blocked'`.

Le profil sécurise sa destination et ses options ; il ne filtre pas un secret arbitraire présent dans du texte libre, du code, des noms ou des defaults du catalogue. La politique d’envoi de conversation/catalogue/résumé/détails reste explicite et distincte. Il ne fournit ni génération/modification de workflow, ni backend Chat complet. Les autres providers, notamment Azure Anthropic, et les appels Anthropic hors contexte contrôlé conservent leur comportement antérieur.
