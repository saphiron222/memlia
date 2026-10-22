# Intégration PostgreSQL séparée de Next

Le job `budget-window-postgres` prépare une base neuve, migre le schéma avec le
runner natif `packages/db/scripts/migrate.ts`, puis exécute sans modification
`chat-budget-window.integration.test.ts` via Bun1.4.2. Ses neuf cas utilisent le
vrai client primaire : sélection/version/profil exact, capture immuable, fenêtres
expirées/futures/bloquées, profils absents/invalides et refus des getters/extras.
La suite vérifie qu'aucune réservation ne résulte d'une lecture. Elle ne valide
pas encore les courses de réservation, le ledger, les permissions utilisateur,
les jobs persistants ou Redis. Aucun modèle ni Next n'est appelé.

Les helpers publics `assertDisposableTestDatabaseUrl` et
`clearInheritedDatabaseUrls` restent appliqués. Le nom exact imposé par la suite
est `memlia_p06_budget_test`. **Toute base ou tout rôle déjà présent refuse le
bootstrap** : ne jamais réutiliser une ancienne base de laboratoire pour ce job.
Les deux rôles sont uniques à l'essai (`pgwin_m_<nonce>`/`pgwin_w_<nonce>`).
Seul le propriétaire de schéma migre et insère les fenêtres fictives ; le rôle
runtime n'a que SELECT sur les deux tables concernées, sans DDL, création de
rôle/base ou superuser. Cette identité SQL ne remplace pas une autorisation
applicative et ne qualifie pas les permissions d'un collaborateur.

La fixture est exécutée avec Bun1.4.2 : le module postgres résolu depuis
`packages/db/package.json` expose sa fonction en `.default`, vérifiée avant toute
connexion. Ce contrat conditionnel diffère du chargeur CommonJS de Node24 ; la
fixture n'annonce pas d'exécution directe avec Node et n'ajoute aucun fallback.

Le provisioning des extensions vector/pg_trgm/btree_gin dans cette seule base
réemploie les prérequis publics du migrateur. Le journal complet et son dernier
hash, les index valides et les183 tables sont vérifiés. Un digest de la baseline
de toutes les tables est comparé après les tests. Suppression de la base et des
deux rôles seulement après succès/readback ; aucun DROP FORCE ni terminaison de
session. Une phase échouée ou ambiguë retient les ressources dans le reçu pour
diagnostic. En CI, le cleanup retire ensuite le seul conteneur PostgreSQL
éphémère identifié par CID/label ; aucun serveur partagé n'est utilisé.

Le workflow reprend Node24.22.0 par digest, Bun1.4.2 par SHA256,
`--frozen-lockfile --ignore-scripts` et le superviseur public existant. Installation
et tests sont deux conteneurs distincts ; sources RO pendant migration/tests.
PostgreSQL17 pgvector est épinglé au digest déjà utilisé par le déploiement.
Le réseau interne ne publie aucun port. Le conteneur de tests rejoint uniquement
son namespace réseau, donc les helpers loopback natifs restent stricts, sans
accès fournisseur. Aucun credential du runner ou du propriétaire n'est passé.
Les mots de passe aléatoires sont synthétiques, éphémères et jamais imprimés.

Tests :2CPU/4Gio/aucun swap/256PID, `/tmp`512Mio, deadline1200s et60s de marge
externe ; PostgreSQL :1CPU/1Gio/aucun swap/128PID, données en tmpfs1Gio.
Le contrôleur vérifie son cgroup ; les mesures et fermetures restent celles du
superviseur. Chaque phase est bornée (600s migration,180s autres). La sortie brute
est privée et refusée au-delà de8Mio à sa lecture finale ; ce seuil n'est pas un
quota disque continu. Seul le verdict de phases fermé est publié, sans log/URL,
capture, artefact, image ou release. Runner gratuit public, token contents:read,
checkout sans credentials persistés, aucun pull_request_target ni secret protégé.

Commande après préparation des dépendances/outils verrouillés :

```sh
python3 -B scripts/ci/test-postgres-tests.py -v
# MEMLIA_PG_CI_ADMIN_URL fourni dans l'environnement d'un serveur jetable neuf.
python3 -B scripts/ci/postgres-tests.py --report /tmp/postgres-new.json
```

Le rapport est réservé en exclusif et son nonce/base/deux rôles non secrets sont
persistés avant toute phase DB, afin de retrouver un namespace retenu même après
interruption. `--nonce` peut fixer une identité fraîche ; il n'autorise aucune
réutilisation. Ne transmettre aucune
clé IA ou URL DB réelle ; les enfants reçoivent une liste réduite de variables.
Une réussite locale native sera distincte de la future exécution Docker/GitHub.
Lors de l'ajout de cette tranche, CI Linux/GHA est **NON TESTÉE** ; aucune
qualification commerciale, cache, navigateur ou Windows n'est déduite.

Copyright2026 Memlia. Tous droits réservés.
