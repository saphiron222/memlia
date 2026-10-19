# Port providers borné — préalable P00 à P05

`runModelAdapter` borne une boucle streaming Sim existante et conserve ses types
et objets d’événements/résultats. Il ne crée ni moteur conversationnel, ni SDK,
ni contrat d’autorité concurrent.

Le serveur fournit `start`, `dispatch`, la liste des outils et les limites.
`start` doit brancher `beforeModelCall` immédiatement avant **chaque tentative
physique** d’appel modèle, y compris synthèse finale et retry, et `executeTool`
sur chaque invocation. Défauts : 12 appels, 40 outils, 180 secondes. Zéro outil
interdit les effets. La réservation précède le dispatch, même concurrent ; le
délai reste actif quand le consommateur SSE ne lit plus.

Le flux conserve les événements, propage les erreurs et s’annule sur demande,
épuisement du quota ou expiration. `usage()` compte les appels réservés, échecs
compris ; il n’annonce aucun prix. Les coûts et budgets installation/utilisateur
restent P06. Une fermeture normale du flux ne prouve aucune mutation réussie.

L’allowlist réduit les capacités sans accorder de permission. Le dispatcher doit
vérifier autorité courante, paramètres, révision attendue, approbation exacte,
reçus durables et projection sans secret. Le principal vient des contrats et
de l’authentification Sim, jamais des arguments du modèle. L’annulation ne
supprime pas un effet déjà commencé : son résultat peut rester partiel ou inconnu,
sans replay aveugle.

## Preuve d’extraction et limites

Une preuve privée reproductible a exécuté les boucles OpenAI Responses et
Anthropic inchangées du Sim `c6cef5f87b6a1d1d01df89e7140bad9e9fd4c2e2`, leurs
helpers et accumulateurs de tokens. Le parser SSE OpenAI SDK7.0.0 est réel ; HTTP,
stream SDK Anthropic, prix et câblage applicatif sont simulés explicitement.
Les tests exercent streaming, continuation outil→synthèse, séparation brut/modèle,
plafonds et annulation avant effet. Aucun vrai appel modèle ni coût n’est mesuré.
Le harness qui charge cette référence externe reste hors du produit distribué.

Le raccordement aux providers, routes et lifecycle attend P01 et la revue du
patch partagé. Il faut injecter le dispatcher serveur dans runtime-context et
borner chaque transport. Un hook par génération est insuffisant tant que SDK ou
transport garde des retries invisibles : les désactiver pour le Chat ou réserver
chaque tentative. Les chemins non streaming, compaction, pièces jointes, autres
providers et transports restent à qualifier séparément.

Non réalisés : outils catalogue/édition autorisés, CAS, runs/reprise durables,
adaptation au Chat/SSE existant, budgets globaux, vrais modèles et évaluations.
Ce port testé établit une faisabilité ; P05/P06 restent ouverts.
