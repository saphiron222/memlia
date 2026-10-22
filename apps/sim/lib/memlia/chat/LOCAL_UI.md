# Composeur natif et profil local

Cette tranche raccorde le hook `useChat`, Home et le panneau du workflow au GET authentifié des capacités. Elle conserve le composeur, les chips, les fichiers visibles, la file et les handlers SSE natifs. Aucun choix de backend dans le navigateur, aucune clé ou fenêtre tarifaire exposée.

La lecture est liée à la session, au workspace et au workflow. Chargement, erreur (même avec une ancienne réponse en cache), portée étrangère et absence de workflow bloquent l'envoi. Home explique qu'il faut ouvrir un workflow existant. Une surface organisation sans workspace ne peut pas demander ce profil et reste indisponible : ce n'est pas une qualification du Chat organisation historique.

Le modèle administrateur est affiché en lecture seule. « Utiliser les réglages du cabinet » adopte explicitement ce profil pour cette surface et les préférences/picks observés, sans modifier le store global. Le choix demeure valable tant que ce tuple ne change pas. Ce choix n'est ni une approbation d'outil ni une autorisation de dépense. Le serveur revalide toujours droits, policy, budget et propositions.

Les pièces jointes, contextes, compétences, autres onglets et modes non couverts restent refusés, sans effacement de la demande. Les ressources natives restaurées ne portent pas une provenance automatique fiable : aucune n'est omise sur la seule égalité de son ID au workflow courant. La référence canonique du workflow du panneau voyage séparément dans le corps, sans ajout d'une ressource artificielle.

Le composeur ne se vide que si son envoi est accepté localement. Le texte est borné à 64 Kio UTF-8 et son corps JSON prévisible à 96 Kio, avant effacement; le corps effectif est revérifié avant POST. La branche locale ne construit ni paramètres desktop ni sélection de modèle/effort client. La branche legacy conserve son corps natif après observation explicite de ce profil.

Les intentions locales passent dans la file existante. Une attestation éphémère par ID d'entrée lie leur portée et leurs réglages; aucun texte supplémentaire ou second store de messages n'est créé. Après changement ou remontage sans attestation, l'entrée reste visible et exige une édition/validation explicite. Elle n'est pas réattribuée au nouveau workflow. Les attentes et les callbacks relisent l'état avant envoi; une suppression pendant attente ne peut envoyer l'ancien texte. Aucun échec local n'est transformé en hors-ligne ni en ACK serveur.

Qualification de cette tranche : tests ciblés du vrai hook/stores/QueryClient et DOM jsdom du composeur, frontières HTTP/session/desktop simulées. Aucun navigateur réel, PostgreSQL, modèle payant, coût, déploiement ou création de workflow depuis Home n'est qualifié par ces tests. La correction de la métadonnée modèle enregistrée par le POST est une tranche séparée. L'indépendance complète de livraison nécessite une policy serveur obligatoire et les autres gates du produit.

## Origine durable des messages en attente

`localOrigin: true` dans l’entrée de la file native est une borne de refus client, jamais une autorité serveur. Toute présence de ce champ, y compris malformée, interdit le parcours legacy. Son absence conserve le comportement des anciennes intentions legacy. Le ticket de réglages reste éphémère : aucun profil, modèle ou jeton d’adoption n’est persisté. La présence du marqueur ne permet donc jamais à elle seule un envoi local.

Migration de clé, réinsertion, mise en attente et restauration sessionStorage conservent l’origine. Un montage neuf exige une édition/revalidation explicite en local ; « Envoyer maintenant » ou une simple adoption de réglages ne réattribuent pas une intention existante. Une édition legacy ne retire pas l’origine locale et ne vide pas le composeur. Une intention legacy explicitement rééditée sous réglages locaux acquiert cette borne.

Un POST local interrompu au démontage reste une seule entrée dans la file native, avec son identité de tentative et son état d’admission inconnu. Il ne passe pas dans les handoffs historiques qui ne portent pas cette origine. Le marqueur ne voyage ni dans le corps HTTP ni dans un handoff distant. Ces contrôles client ne remplacent aucune validation ou déduplication serveur ; ils ne peuvent pas empêcher un navigateur hostile de fabriquer sa propre requête.
