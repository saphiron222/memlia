# Validation Linux des types et bundles, sans build Next

Le workflow `memlia-linux-validation.yml` fournit le check **validate-linux**.
Il valide sur le runner public standard Linux x64 les étapes préparatoires du
produit. **Ce n'est pas un build Next réussi, une qualification standalone ou une
qualification de la RAM nécessaire au produit.** Il ne satisfait jamais le check
obligatoire `build`, qui reste celui du workflow de construction complet.

## Modes du script partagé

```sh
# Parcours complet existant : termine uniquement après Next et standalone.
bash scripts/ci/run-linux-build.sh

# Parcours borné : aucun Next build, aucun contrôle standalone.
bash scripts/ci/run-linux-build.sh --validation-only
```

Tout autre argument est refusé avant bootstrap. Le mode borné réutilise le même
bootstrap jetable, le superviseur, les cgroups, l'installation et le nettoyage.
Il exécute dans l'ordre les tests du superviseur, l'installation gelée sans scripts
lifecycle, les contrôles de versions/empreintes, l'inventaire CLI, `next typegen
--webpack`, `tsc --noEmit --singleThreaded`, le bundle CLI et les bundles sandbox.
Ces derniers sont aussi évalués par leur script natif avant écriture.

Ne pas remplacer ces appels par `bun run build` : cette commande de l'application
lancerait aussi Next. La génération de types ne compile pas les routes pour la
production. Le bundle CLI ne prouve pas un scénario utilisateur, et les bundles
sandbox ne constituent pas une image déployée. Les sorties générées restent sur le
runner éphémère ; elles ne sont pas publiées ni proposées comme artefacts de release.

L'installation est `--frozen-lockfile --ignore-scripts`, avec contrôle SHA256 du
verrou avant/après. Next installé doit correspondre à la **version exacte** du
manifeste applicatif et à l'override racine, sans plage ni tag flottant. Le reçu
outil indique aussi cette version attendue. Le script n'effectue aucune mise à
jour : un futur export de sources doit apporter lui-même les manifestes et le
verrou cohérents. Les versions Node24.22.0/Bun1.4.2/TypeScript7.0.2, les digests
images et le checksum Bun restent vérifiés.

## Résultats distincts

Une fin normale du mode borné produit :

```json
{
  "scope": "validation",
  "status": "validation_passed",
  "buildStatus": "not_run",
  "nextStarted": false,
  "standaloneVerified": false
}
```

Le mode complet conserve `scope=build`, et ne produit le statut global `passed`
qu'après Next et la vérification standalone. `normalCompletion` désigne uniquement
la fin normale du mode sélectionné. Une phase manquante, un signal, une erreur de
commande, un nettoyage incomplet ou un échec d'écriture/émission du reçu rend le
processus non nul ; aucun `continue-on-error` ne transforme cela en réussite.

Les reçus de chaque phase restent quantitatifs : temps, mémoire cgroup (dont cache
comptabilisé par le noyau), RSS échantillonnée, descendants, swap et événements OOM.
Une réussite d'une phase n'est pas une réussite de la construction entière. Aucun
log brut, source, source map, cache, dépendance, bundle ou image n'est uploadé.

## Exécution publique contrôlée

Le workflow est limité au dépôt public `saphiron222/memlia`, avec
`permissions: contents: read`, checkout sans credentials persistés, historique
complet pour le contrôle des notices et timeout de 45 minutes. Il utilise le
runner standard `ubuntu-24.04`, jamais un runner large payant. Si le dépôt devient
privé, la condition interdit ce job ; ne pas retirer ce garde pour consommer des
minutes privées sans décision distincte.

Déclenchement manuel ou push sur **validation/linux-typecheck** seulement. Cette
branche est distincte de `build/linux-16gb-measurement`, dont le push lance le build
complet existant. Pour le premier essai, publier la branche de validation après
revue/gates ; le déclenchement push évite d'exiger la présence préalable du nouveau
workflow sur la branche par défaut. Aucun événement de contribution privilégié,
secret d'application ou permission d'écriture n'est utilisé.

Le workflow de build et son check ne sont ni renommés, ni remplacés, ni conditionnés
par ce mode. En l'absence d'une vraie construction réussie du même candidat, le
check obligatoire build reste non satisfait. Aucune protection du dépôt n'est
modifiée par ces fichiers.

Le budget de chaque phase reste 13 Gio de cgroup sans swap supplémentaire, CPU4,
heap10Gio ; la DB jetable reste à 512 Mio. Le bootstrap DB est conservé pour garder
l'environnement du témoin et ne migre pas de schéma métier. Cela ne prouve pas
que toutes les phases utilisent la DB. Aucune conclusion sur un besoin de 24–32 Go
ou une solution aux OOM de Next ne résulte de ce parcours.

## Tests locaux du contrôle

```sh
python3 scripts/ci/test-linux-build-metrics.py -v
bash -n scripts/ci/run-linux-build.sh
```

Les tests de sélection de phases exécutent le code Bash de production avec la
seule frontière `phase` doublée pour enregistrer les appels. Ils ne lancent aucun
Docker, PostgreSQL, compilateur ou build. Les tests de version utilisent de vrais
fichiers de manifeste fictifs, sans installation. Les tests de nettoyage utilisent
les fonctions de production et de vrais défauts de fichiers/signaux aux frontières
indiquées. Une réussite de ces tests ne qualifie pas l'installation Linux ni le TSC
du futur snapshot : seule l'Action réelle sur ce snapshot peut le faire.

Copyright 2026 Memlia. Tous droits réservés.
