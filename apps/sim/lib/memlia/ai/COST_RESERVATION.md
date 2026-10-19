# Réservation de coût du Chat — port interne

**Port interne de persistance, aucune activation.** USD natif uniquement ; seules les tentatives
du Chat Memlia passant par ce port sont couvertes. Une fenêtre d'installation
explicitement configurée, sans fenêtre utilisateur ni couverture globale des workflows.
La fenêtre budgétaire est distincte de la période canonique du ledger ; le fallback
1970→9999 reste intact. Pas de clé, route, LLM, Redis, ordonnanceur ou nouvelle auth.

Les types de `cost-reservation.server.ts` sont l'unique contrat TypeScript de ce port
interne. Les résultats `*_in_transaction` sont provisoires : le caller doit encore
committer et traiter une issue COMMIT inconnue. Ils ne sont ni un jeton d'autorité
ni un permis de renvoi. Pool/autocommit refusés ; données primitives figées et
validées avant le premier await ; aucune fonction de l'appelant sous verrou.

## Deux tables autorisées, migration native0437

- `memlia_chat_cost_window` : ID, version, devise USD, début/fin explicites, plafond
  decimal borné, état ouvert/bloqué. Configuration par administrateur serveur hors
  du port ; jamais auto-créée à partir du payload. Une seule fenêtre sélectionnée
  explicitement, pas de rollover automatique.
- `memlia_chat_cost_reservation` : tentative unique, fenêtre/version, sujet et scope
  canoniques, attribution/période figées, maximum réservé, état réservé/inconnu/réglé,
  eventKey produit par le serveur et identité/coût attendu du reçu ledger après
  règlement, horloges DB. Pas de cascade utilisateur/workspace vers ces engagements.
  Le reçu de règlement sert à contrôler l'intégrité du ledger, pas à agréger un
  deuxième compteur de dépenses.

Sous verrou de la fenêtre, comparer SUM decimal des dépenses natives liées aux
seules tentatives réglées de ce port + engagements réservés/inconnus + nouvelle
réserve au plafond. Avant la somme, chaque engagement réglé doit retrouver son
événement ledger exact (acteur, scope, payeur, période, source, coût). Événement
absent, coût modifié ou identité étrangère : `reconciliation_required` ; aucune
somme avec COALESCE pour masquer l'absence. Verrouiller les lignes ledger lues
contre une suppression concurrente pendant la TX. Au prochain accès, une cascade
ultérieure est détectée et bloque ; aucun budget n'est recréé.

Un doublon strict rend `created:false` sans nouvel engagement ; une divergence
refuse. La réserve ne possède aucun TTL libérateur. Annulation/timeout/réseau
inconnu gardent intégralement le maximum engagé. Le futur caller doit authentifier,
revalider permissions et tarif/borne avant envoi ; aucune autorité déduite du snapshot.

## Règlement natif et refus

Pour un coût connu, l'événement natif `workspace-chat`/`model` possède un eventKey
stable unique par tentative. `recordUsage({tx,...})` écrit le ledger avec sa période
canonique ; le changement d'état de la réserve est dans la même TX. Vérifier le
contenu en cas de conflit eventKey : `onConflictDoNothing` seul ne suffit pas.
Pas de double écriture cumulative : `recordCumulativeUsage` ouvre une autre TX et
n'est pas appelé ici. Échec DB = rollback, message fixe, jamais release implicite.

Montants : texte decimal USD non négatif, borne technique du port numeric(21,12),
maximum999999999USD ; les12décimales servent notamment aux coûts de microtokens.
Ce choix ne prétend pas que le ledger natif possède6décimales fixes (son coût est
un numeric sans cette limite de schéma). Comparaison exacte en SQL ; avant
`recordUsage`, conversion vers son number uniquement si sa représentation decimal
retourne exactement la valeur attendue. Aucune conversion silencieuse/Infinity/NaN.
Le coût connu zéro retourne reconciliation_required et garde l'engagement, car le
contrat natif filtre les coûts model non positifs : aucun événement facturé inventé
ni model_unbilled détourné pour libérer le budget.
Un dépassement connu doit être enregistré puis bloquer la fenêtre, jamais disparaître
par rollback prétendant que la dépense n'a pas eu lieu ; résultat explicite settled_and_blocked_in_transaction, avec COMMIT encore requis. Une borne tarifaire non démontrée bloque le
futur envoi ; ce port ne promet pas de plafonner un prix fournisseur inconnu.

## Préparation des preuves

La suite associée est préparée pour une DB migrée dédiée avec deux rôles : fixtures
propriétaire, runtime non propriétaire. Elle ne génère aucun schéma et ne doit pas
être exécutée sur la DB native de build. Numéro libre observé :0437 après0436,
**réservé exclusivement par root** pour ce worktree. DB séparée attribuée
memlia_p06_budget_test ; migration native appliquée et droits DML applicatifs vérifiés, sans DDL/superuser. Le RED du besoin monétaire a été constaté dans le mécanisme natif self-hosted (deux maxima0,75 sous un plafond1 admis sans engagement). Il ne constitue pas une régression native. La composition locale a exécuté29tests :28cas utilisant les fixtures PostgreSQL réelles et1doublure explicite qui interdit tout accès SQL pour prouver le refus préalable d'une conversion perdante.
29scénarios vérifiés, dont : admissions concurrentes, doublon/conflit, rollback, règlement unique,
coût inconnu conservé, suppression réelle de ledger par cascade empêchant toute
nouvelle admission. Les preuves couvrent aussi le refus du pool, les mutations pendant attente, les échéances après verrou, la collision eventKey concurrente, le coût modifié et les bornes exactes. Une suppression concurrente sous verrou ledger n'a pas été sondée séparément ; la cascade réelle après règlement et le verrou transactionnel restent distincts.

## Limites administratives et transactionnelles

Une fenêtre expirée ne supprime pas une dette : un règlement déjà engagé reste
possible. Changer sa version avec des engagements existants retourne window_changed ;
le port ne migre ni ne libère ces obligations. L'administration future doit interdire
cette transition ou fournir une réconciliation explicite. Aucune interface admin
n'est activée par cette tranche.

L'horloge pertinente est celle de PostgreSQL après les attentes de verrou, distincte
de transaction_timestamp. Même une admission transactionnelle valide ne prouve pas
que le COMMIT ou un futur envoi auront lieu avant l'échéance : la revalidation avant
premier envoi reste à raccorder. Les délais SQL sont locaux à la transaction : plafonds5s pour instruction/transaction/inactivité et1s pour verrou ; toute limite caller plus stricte est conservée, via les valeurs normalisées en millisecondes de pg_settings. Ces délais ne libèrent jamais une réserve.

Le rôle SQL du laboratoire a les DML natifs sur ces tables. Ce port n'est pas une
politique RLS et ne confère pas une identité SQL différente à chaque utilisateur.
L'intégrité contre un writer arbitraire possédant ces droits n'est pas garantie.


Le précontrôle utilise le comparateur Decimal natif sur `Number.toString()`, format
réellement écrit par `recordUsage`, y compris les petits nombres exponentiels.
`toFixed(12)` ne prouve pas ce roundtrip. PostgreSQL compare ensuite exactement
le numeric libre du ledger avec le coût demandé et le reçu réglé ; aucun arrondi
ni troncature du ledger à l'échelle du port.

La génération native0437, la notice JSON ajoutée séparément et la lecture native
du journal sont contrôlées. L'index0437 suit436entrées historiques : le journal
amont n'est pas supposé contigu. Aucun historique de migration précédent n'est modifié.
Les doubles de contrôle ne qualifient ni une route, ni une clé, ni un fournisseur,
ni une issue COMMIT incertaine ; un caller d'envoi autorisé reste à raccorder.

## Provenance tarifaire facultative (0438)

Les fenêtres historiques sans `pricingProfile` et leurs appels restent inchangés.
Une fenêtre profilée exige désormais `expectedPricingProfileHash` à la réservation
et au règlement, vérifié sous verrou contre la fenêtre et le snapshot de réserve.
Le wrapper COMMIT conserve ce snapshot et fournit lui-même l'empreinte au règlement.
Le profil décrit un budget **estimatif USD** admis explicitement, jamais une facture.
Voir [CHAT_PRICING_PROFILE.md](./CHAT_PRICING_PROFILE.md) pour le schéma V1, les bornes,
la capture/empreinte et les refus conservant l'engagement. Aucun observateur/provider
n'est branché par cette extension et le mécanisme natif `recordUsage(tx)` reste seul.
