# Tests rapides indépendants du build Next

`memlia-fast-tests.yml` exécute une sélection explicite des tests existants, sans
attendre ni déclencher Next. Le check ne remplace ni le build Linux complet,
ni l'admission des sources, ni une validation navigateur ou Windows.

Les six groupes de `fast-tests.py` utilisent leur moteur existant :

| Groupe | Moteur | Couverture |
|---|---|---|
| contracts | Node24 | Cas positifs/négatifs des contrats Zod |
| limiter | Bun1.4.2 | Bornes appels modèles/outils, annulation, flux et profil tarifaire |
| catalogue | Vitest5.0.1 | Catalogue natif, outils de lecture, corpus et oracles Chat |
| chat | Vitest5.0.1 | Admission/politique, bindings, SSE, budget et providers à transport doublé |
| chat_ui | Vitest5.0.1 | Notice de sortie limitée, blocs de conversation, persistance et relecture à frontières doublées |
| authority | Vitest5.0.1 | Autorisations, édition, proposition immuable et confirmation avant mutation |

Les contrats de contexte Function, de reçu workflow, de motif de fin du modèle et
le trajet admission → SDK avec réflexion configurée font aussi partie de cette
sélection. Ils réemploient leurs tests existants, avec les frontières doublées
déclarées ; ce portage ne déclenche aucune inférence réelle.

La liste est fermée : pas de glob collectant accidentellement un test live ou une
intégration nécessitant des comptes. Les assertions et fixtures existantes sont
réutilisées. Les doublures DB/auth/permission/transport présentes dans ces suites
ne qualifient pas ces infrastructures réelles. La suite Node/Python interop n'est
pas incluse : ce job ne prépare pas les dépendances Python de ces contrats.

Installation avec le verrou inchangé, `--frozen-lockfile --ignore-scripts`,
Node24.22.0 par digest et Bun1.4.2 par SHA256 identiques au build Linux existant.
Le superviseur public `linux-build-metrics.py` reste PID1 de chaque conteneur :
4Gio, aucun swap configuré,2CPU,256PID, deadline600s par phase (660s externe),
répertoire temporaire512Mio. Chaque groupe a un timeout180s ; Vitest emploie un
seul worker et un plafond de tas V8 de3072Mio. Les limites configurées du conteneur
ne sont pas une qualification de RAM pour le produit ; le reçu natif du superviseur
enregistre le cgroup et les éventuelles erreurs/fermetures. Aucun build natif ou
Next, cache partagé, service central ou environnement du laboratoire n'est créé.
Le groupe contrats Node interdit les addons natifs (`--no-addons`). Vitest charge
le binding précompilé Rolldown fourni par une dépendance optionnelle du verrou ;
il conserve ce mécanisme natif. Le job n'effectue pas de rebuild `isolated-vm`.
L'installation Linux fraîche de toutes ces dépendances reste à vérifier en CI.

Les tests tournent avec `--network none`, sans secret transmis au conteneur ni
fournisseur réel. Leur environnement enfant est réduit à une liste d'outillage ;
une présence `.env` inattendue refuse ce parcours. Les journaux et fixtures
synthétiques restent sur le runner public standard éphémère, sans artefact publié.
Une erreur d'un groupe arrête les suivants et les classe `not_run`, jamais PASS.

Exécution après installation des dépendances verrouillées et des outils ci-dessus :

```sh
python3 -B scripts/ci/test-fast-tests.py -v
python3 -B scripts/ci/fast-tests.py --group all --report /tmp/fast-tests-new.json
```

Le reçu est créé en exclusif. Son statut décrit uniquement les groupes exécutés.
Le workflow reste à qualifier sur GitHub après publication admise ; une réussite
locale Mac des commandes ne prouve pas Linux/Docker. Aucune exécution CI n'est
revendiquée lors de l'ajout de ce workflow.

Ces groupes ne qualifient ni PostgreSQL ni le cache. Le job PostgreSQL distinct
est décrit dans `README.postgres-tests.md` ; il utilise sa propre préparation
publique et ses contrôles de cleanup. Le script `scripts/test-integration.ts`
mentionné par le manifeste amont reste absent du fork. Aucun harnais privé ou
fournisseur IA réel n'est ajouté à cette sélection.
