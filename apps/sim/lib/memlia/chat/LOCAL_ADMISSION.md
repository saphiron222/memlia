# Préparation locale d'un tour Chat

`prepareLocalChatAdmission` compose les ports serveur existants. Elle ne lance pas
le modèle, n'admet pas le tour et ne modifie aucune route. L'option locale reste
absente par défaut ; aucun refus local ne produit une retombée vers le worker.

Le caller doit avoir authentifié une **vraie session** et résolu le workflow et
son espace canoniques. Un objet `SessionPrincipal`, même validé syntaxiquement,
n'est pas une preuve d'authentification HTTP. Le périmètre accepte un chat existant
lié à un workflow, un message courant textuel et le mode agent natif. Les modes
plan/assistant, chats d'organisation, pièces jointes et capacités desktop actives
ne sont pas couverts : le futur caller doit les refuser explicitement avant les
effets, jamais les supprimer du payload pour contourner ce périmètre. Aucun
champ supplémentaire n'est accepté par l'entrée de cet adaptateur.

## Composition

1. Capturer le JSON borné, valider le principal canonique `session`, les identités
   avec `LocalChatAdmissionSchema` et le texte courant avant le premier await.
2. Lire la policy administrateur Linux avec `readChatInstallationPolicyFile`.
   Exiger `localBackend` valide, un fournisseur admis (OpenAI ou Anthropic) et
   `sanitized_details`. La décision
   `activation: blocked` n'est ni changée ni traitée comme une autorisation d'envoi.
3. Vérifier la capacité native `copilot.use`, puis le modèle/fournisseur avec
   `validateModelProvider`, qui lève effectivement sur les deux refus natifs.
4. Charger le transcript autorisé natif, puis posséder sa projection user/assistant
   avant d'attendre la fenêtre tarifaire. Les caps natifs restent 128 messages,
   64 Kio pour le courant et 256 Kio de texte total ; aucun ajout de catalogue ou
   de graphe dans le transcript. Aucun system/tool, argument, sortie ou pièce jointe.
5. Lire l'ID/version explicitement choisis par la policy avec `readChatBudgetWindow`.
   Capturer le profil canonique, vérifier modèle/identité/version, utiliser son
   plafond `outputTokens` comme `request.maxTokens` sans estimer une nouvelle fenêtre.
6. Sélectionner la clé native avec `getRotatingApiKey(provider)` en dernier, puis
   construire les options via `captureLocalChatOptions`, dont
   `previewOperations: true`. Aucun accès réseau, SQL direct ou nouveau key manager.

Les options ajoutent un `systemPrompt` constant appartenant au serveur, séparé
des messages autorisés. Le client et le transcript ne peuvent pas le définir.
Ce guidage générique demande la lecture de l'état et du catalogue natifs, les
schémas réellement disponibles, la conservation des parties non concernées,
les clarifications indispensables et la confirmation sur les opérations exactes.
Il distingue prévisualisation, application et exécution réellement observée ;
un nouveau graphe conserve la disposition native `targeted` par défaut.
Il ne remplace aucun contrôle d'autorisation, de consentement, de révision,
de secret ou de coût. Les documents et contenus lus restent des données non
fiables. Les outils serveur continuent à refuser les actions non autorisées,
indépendamment du respect des consignes par un modèle.

Le résultat comporte deux objets distincts : `intent`, au schéma natif pour
`admitChatTurn`, contient les identités et **le seul texte courant** requis par
l'admission ; `localChat` est une option éphémère à transmettre à `createSSEStream`.
Cette dernière contient clé, principal de session, historique et profil : ne
jamais la persister, journaliser, envoyer au navigateur ou inclure dans le
`requestContext`. L'adaptateur n'effectue aucune persistance. Il ne produit pas
un objet de reprise et ne contourne pas les baux, marqueurs et refus de reprise
locale déjà appliqués par l'admission et le lifecycle natifs.

Toutes les anomalies deviennent la seule erreur `Local Chat admission is
unavailable.`, sans cause, corps, profil ou log. Les résultats capturés ne
partagent pas les objets d'entrée. Le caller conserve ses contrôles natifs
d'annulation et de lease ; aucun contrôleur global supplémentaire n'est créé ici.

## Portée des preuves

Les tests utilisent les schémas/captures natifs et deux cas du vrai garde modèle.
Fichier de policy, résolution DB des droits, chargement du transcript, fenêtre et
clé sont des doubles déclarés. Les suites natives connexes complètent ces tests,
mais aucune nouvelle qualification PostgreSQL, session HTTP, fichier Linux réel,
clé réelle, provider, SSE de cette composition ou réservation de coût n'est faite.

Les observations d'autorisation ne sont pas atomiques avec une révocation future.
Le lecteur de fenêtre n'est ni une réservation ni une permission de dépenser :
le driver budgété doit encore faire COMMIT de chaque réservation avant chaque
transport physique, puis régler chaque tentative. Autorisation fraîche des
outils, consentement sur le digest exact et CAS restent leurs contrôles natifs.
Cette tranche n'active pas le Chat local ni le parcours Home sans workflow.
Les assertions sur le guidage vérifient uniquement sa composition côté serveur
et sa séparation du transcript ; elles ne mesurent ni la qualité d'un modèle,
ni sa résistance aux injections, ni le rendu du graphe dans le navigateur.
