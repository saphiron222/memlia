# Composition du budget estimatif et du provider catalogue

`runBudgetedCatalogProvider` raccorde les ports existants : `runCatalogProvider`, corrélation opaque des tentatives OpenAI, réservation après COMMIT, règlement natif et ledger. Aucun endpoint, fournisseur réel, clé, politique d’installation ou Chat n’est activé.

Le caller serveur doit avoir authentifié la session et autorisé son accès au workspace avant cet appel. Cette première composition accepte la forme native `SessionPrincipal`, sans vérifier une session en DB ni créer une autorité à partir de sa forme. Le résolveur natif d’attribution choisit le payeur ; il ne remplace pas ce contrôle d’accès. La source administrateur de la fenêtre/profil et le funnel d’envoi restent des raccordements nécessaires.

## Configuration et bornes

Les options reprennent le binding catalogue, avec un budget serveur explicite `{windowId, windowVersion, pricingProfile}`. Les hooks, le provider et l’identité ne sont jamais sélectionnés par un argument d’outil modèle. La copie JSON stricte précède toute attente. Le signal reste un signal natif séparé, jamais une valeur sérialisée.

Le profil0438 doit porter `native_list_price_estimate_v1`, le modèle OpenAI statique exact et le tarif natif complet actuel, avec ses paliers et sa date. Le contexte doit égaler la limite explicitement déclarée du modèle ; une limite de sortie native explicite est indispensable. `request.maxTokens` doit égaler `profile.bounds.outputTokens` et rester inférieur ou égal à cette limite native. Aucun fallback2048/4096 ne sert à prouver une borne. Le binding transmet ensuite cette limite en `max_output_tokens`, y compris aux retries, fallback de résumé et synthèse finale.

Le plafond couvre tout le contexte déclaré, pas seulement le premier prompt. Pour chaque intervalle de tarifs, le helper soumet à **l’estimateur natif** `priceModelUsage` les extrémités supérieures et les trois allocations extrêmes : entrée non cachée, lecture de cache, écriture de cache avec le multiplicateur natif exporté. Les taux non négatifs sont constants dans chaque intervalle ; chaque mélange est donc borné par ces extrêmes. Les paliers ouverts, non monotones et le fallback natif `cachedInput ?? input` sont conservés. Le coût de sortie utilise le plafond réellement transmis. Aucun calculateur de prix parallèle ni tarif supplémentaire n’est ajouté.

Cette borne est conditionnelle aux limites déclarées du modèle et au tarif liste enregistré. Elle n’est ni une facture fournisseur, ni un plafond global des workflows ou de l’installation. Les seules tentatives de ce port consomment la fenêtre USD explicite. Un compteur fournisseur hors borne peut encore produire un dépassement : le port natif enregistre alors le coût connu et bloque la fenêtre, sans rollback de la dépense.

## Une tentative physique, un engagement

Avant chaque transport, un nouvel identifiant serveur réserve le plafond via le port possédant la transaction. Seul `reserved_committed` laisse continuer. Un doublon, un refus ou un COMMIT inconnu ne confère aucune permission de renvoi. Le tarif est recontrôlé synchroniquement après l’attente de COMMIT ; aucun await ne sépare la comparaison de registre du calcul natif. Un changement après admission conserve l’engagement et refuse l’envoi.

Une WeakMap privée rattache la référence physique au reçu COMMIT de cette instance. L’observation termine cette relation au plus une fois. Une observation étrangère ou répétée est refusée. La réserve et sa copie durable du profil sont relues/vérifiées par les ports natifs ; le caller ne fournit pas une autre empreinte au règlement.

Pour un usage complet, le coût estimé est recalculé avec le même registre/profil natif, comparé à l’observation puis sérialisé en décimal sans nouvel arrondi ; les contrôles exacts du port USD restent applicables. Une absence, un usage partiel/malformé, un coût arrondi à zéro, un tarif absent/modifié ou une représentation non admissible ne libère jamais l’engagement à zéro. Un coût inconnu reste en attente de réconciliation. Le retry déjà prévu par le provider peut réserver un **autre** plafond si la fenêtre le permet ; cette composition ne déclenche aucun retry.

Une erreur/refus/COMMIT inconnu du ledger ou un dépassement arrête la boucle avec l’erreur fixe du hook natif, sans cause réseau réessayable. Le règlement d’une dépense connue reste possible après annulation ; il peut terminer après l’erreur du stream consommateur. Une panne du processus ou une absence d’observation laisse la dette durable. Il n’existe ici ni libération par TTL, ni reprise automatique, ni réconciliation interprocessus ou promesse exactly-once.

## Preuves et limites

La suite utilise PostgreSQL dédié pour attribution, fenêtres, réserves, COMMIT et ledger, avec un rôle applicatif DML sans DDL et un propriétaire distinct pour les fixtures. Le vrai binding, les boucles OpenAI, le parseur SSE, la normalisation et les prix sont conservés. HTTP est doublé ; les outils catalogue/workflow non concernés et le nombre de tours avant synthèse sont doublés explicitement. Un recorder transparent capture les callbacks pour les sondes de références, puis délègue sans modifier leurs arguments. Les barrières d’ACK COMMIT, d’erreur de transaction et d’annulation sont des doubles de frontières autour de transactions réelles, pas des coupures réseau PostgreSQL.

Les preuves couvrent notamment refus avant HTTP, COMMIT visible, concurrence, retry/fallback/synthèse, plafond transmis, cache/paliers, mutation pendant attente, dette inconnue et règlement après abort. Elles ne qualifient ni un fournisseur payant, ni l’authentification/funnel HTTP, ni l’UI, ni Anthropic, ni le chargeur administrateur, ni le build global. Les tests historiques des ports et providers restent requis en composition, puis une revue distincte avant intégration.
