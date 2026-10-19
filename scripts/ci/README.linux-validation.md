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

Les reçus de chaque phase conservent les mesures : temps, mémoire cgroup (dont cache
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

## Positions TypeScript publiables

Seule la phase `typecheck` peut joindre `typeScriptDiagnostics.locations` : au plus
100 tuples uniques `{path, line, column, code}`. Aucun message, extrait de source,
valeur ou commande n’est repris. `--pretty false` stabilise uniquement le format
du diagnostic ; le code de sortie et les critères de réussite restent inchangés.

Avant les phases, une liste privée est construite depuis les blobs réguliers TS,
TSX, MTS et CTS du commit Git courant. Ni fichiers non suivis, ni liens symboliques,
ni noms ambigus ne sont admis. Le manifeste, plafonné à 2 Mio et 50 000 chemins,
est monté en lecture seule ; il n’est ni imprimé ni uploadé. Les chemins publics
émis sont relatifs à la racine du dépôt, ASCII, sans segment vide, `.` ou `..`,
et limités à 512 caractères. La correspondance `../../packages/...` depuis
`apps/sim` est une clé exacte précalculée depuis cette liste ; aucune normalisation
d’un chemin fourni par le compilateur n’autorise une nouvelle cible.

L’extraction ne lit que les derniers 64 Kio de sortie. Si cette fenêtre commence
en cours de fichier, sa première ligne est ignorée par précaution. Les lignes
incomplètes, de plus de 4 096 octets ou contenant des contrôles/ANSI sont rejetées.
Lignes et colonnes doivent être positives et au plus 1 000 000 ; le code TS compte
3 à 5 chiffres. Une liste absente/invalide ne publie aucun chemin. Le champ
`truncated` signale une fenêtre réduite ou un plafond atteint ; cette liste n’est
pas un inventaire exhaustif des erreurs. Les diagnostics sans fichier versionné
(restes générés `.next`, dépendances, diagnostics globaux) ne produisent pas de
position. Les codes TS agrégés existants restent disponibles séparément.

Les tests portables utilisent de vrais dépôts Git jetables et un processus enfant
réel ; la lecture cgroup de ce test est une doublure explicitement déclarée. Ils
ne qualifient pas un nouveau typecheck Linux complet ni un build Next. Les journaux
bruts restent éphémères et sont détruits ; seules ces positions bornées sont ajoutées
aux reçus publics.

## Observations Webpack bornées

La phase `next` seule ajoute `DEBUG=next:build:webpack-build` et `DEBUG_COLORS=0`
à la commande native. Le superviseur lit le fichier privé par position indépendante,
au plus 64 Kio par échantillon et 8 Mio au total, puis termine cette lecture bornée
à la sortie de l'enfant. Il ne déplace pas la position d'écriture de l'enfant ni
celle du lecteur de diagnostics TypeScript/OOM. Aucun second collecteur, snapshot,
inspecteur, trace ou journal brut n'est publié.

`webpackObservation` contient uniquement `enabled`, `events`, `sequenceValid`,
`complete`, `truncated` et `readError`. Chaque événement contient un compilateur
fixe `server`, `edge` ou `client`, un état `started` ou `finished` et, pour une fin,
une durée entière `durationMs` entre 0 et 1 800 000. Seules les lignes complètes du
format exact du logger Next 16.4.2 sans couleur sont reconnues ; date et texte ne
sont pas recopiés. Les lignes de plus de 512 octets, les fragments finaux, les ANSI,
les suffixes/messages ajoutés et les marqueurs inconnus ne produisent aucun événement.
Une ligne trop longue est ignorée jusqu'à son saut de ligne, y compris si elle
contient un suffixe ressemblant à un marqueur. Le reçu conserve au plus 16 événements.

L'ordre attendu est début/fin serveur, début/fin edge, début/fin client. Un ordre
inattendu ou un doublon rend `sequenceValid=false`. Une séquence partielle demeure
`complete=false`; un plafond ou fragment perdu rend `truncated=true`. Un défaut de
lecture rend `readError=true` sans publier de cause. Hors phase Next, la collecte
est désactivée. Une absence de marqueur ne prouve pas qu'un compilateur n'a pas
commencé ; le format pourrait avoir changé ou la lecture avoir été tronquée.

Ces marqueurs restent de simples observations d'une sortie de processus : du code
peut imprimer le même texte. **Ils ne changent jamais le verdict**, le code de sortie,
les contrôles de descendants/OOM/nettoyage ou les critères standalone. `complete`
ne signifie que séquence de marqueurs complète, jamais build réussi. La phase
validation ne lance toujours aucun Next build. Les limites restent heap 10 Gio,
cgroup 13 Gio, swap du groupe 0 et CPU 4 ; aucun essai à 11 Gio n'est inclus.

Les nouveaux tests utilisent de petits enfants réels, un fichier temporaire et une
barrière stdin pour vérifier une écriture partielle avant la sortie. Les tests du
reçu doublent seulement les lectures Linux /proc/cgroup et le signalement mémoire
hôte sur les autres plateformes. Ils vérifient aussi les canaris, les bornes et
l'indépendance du verdict ; ils ne constituent pas une nouvelle construction Linux.
