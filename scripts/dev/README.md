# Contrôle des constructions locales sur macOS

Outil interne pour ce Mac de développement de 16 Go, sans dépendance Python
supplémentaire. Nos ajouts restent privés, tous droits réservés en attendant le
choix de licence. Il ne s'agit pas d'un contrôle de livraison Linux.

```sh
MEMLIA_LOCAL_BUILD=1 NODE_OPTIONS=--max-old-space-size=4096 \
  python3 scripts/dev/build_guard.py --report /chemin/prive/recu-unique.json \
  -- commande-de-construction
```

Utiliser une commande Next directe depuis `apps/sim`, avec `--webpack` pour le
profil local retenu. Le script `build` amont fixe lui-même NODE_OPTIONS à 8192 :
une valeur extérieure seule ne le remplace pas. Les commandes et variables ne
sont pas inscrites dans le reçu ; la sortie de la commande est relayée. Son
appelant doit donc filtrer les secrets de cette sortie avant de conserver un log.
Ne pas mettre des secrets dans les arguments. Fournir un emplacement de reçu
privé et réservé à cette exécution.

Avant lancement puis environ toutes les deux secondes, le garde lit :

- `vmmap -summary` : **physical footprint**, comprenant la mémoire compressée,
  pour le groupe et les descendants observés ; aucune substitution par le RSS ;
- `sysctl` : pression mémoire et swap global utilisé ;
- `memory_pressure -Q` : interrogation seulement, aucun mode de stress ;
- `proc_pidinfo(PROC_PIDTBSDINFO)` : identité PID/UID/création en microsecondes
  des processus suivis, sans arguments, environnement ou contenu utilisateur.

Budget conservateur de ce poste : empreinte observée totale au plus 7 Gio,
croissance du swap au plus 1 Gio depuis le prévol, pression normale `1`,
pourcentage mémoire disponible au moins 20 %. Le prévol refuse si ces
observations manquent ou si la situation est déjà mauvaise. Le swap ancien
n'est pas assimilé à une croissance provoquée par cette construction. Le budget
global peut aussi être dépassé par une autre application : le garde n'arrête que
la construction qu'il a lancée et ses descendants suivis.

À l'arrêt : TERM ciblé, courte grâce, puis KILL des processus suivis qui restent
identiques. Une disparition normale n'interrompt pas le nettoyage des autres
cibles. Les signaux utilisateur sont différés pendant le nettoyage et l'écriture
du bilan. Un descendant observé survivant au leader empêche un résultat
`completed`. Un échec de nettoyage est inscrit et ne devient jamais une réussite.

Codes : 0 commande réussie ; code de la commande en cas d'échec normal ; 125 refus
de prévol ; 126 lancement impossible ; 130 interruption/budget/suivi incomplet.
Le reçu conserve aussi le vrai code enfant et les observations/maxima disponibles.

**Limites** : outil de supervision pour les scripts Next de confiance, pas une
sandbox, une limite système stricte ou une garantie de récupération. La mesure
séquentielle peut compter deux fois de la mémoire partagée et manquer un pic.
Des descendants très courts ou détachés avant leur première observation peuvent
échapper au suivi ; comparer une identité et envoyer un signal n'est pas atomique
sur macOS. Ne pas l'utiliser pour exécuter des programmes hostiles. Une interruption
ou des mesures indisponibles ne qualifient aucun build. La CI Linux et les artefacts
finaux doivent encore être construits et testés dans leur environnement cible.

Privilégier le serveur de développement et les tests ciblés aux itérations.
Construire aux jalons, sans Docker lourd concurrent. Les options `cpus` et
NODE_OPTIONS ne bornent pas toute la mémoire native. Le profil local désactive
les maps navigateur/serveur/prérendu ; hors mode, la configuration amont est
préservée. Il active aussi l'option Webpack de réduction mémoire fournie par
[Next.js](https://nextjs.org/docs/app/guides/memory-usage), vérifiée dans la version
16.4.0 installée ; son effet réel doit être mesuré, sans garantie de réussite.
Effectuer le typecheck séparément sur les mêmes sources, même si
`DOCKER_BUILD=true` désactive le typecheck intégré à Next.

Le compilateur natif installé accepte `tsc --noEmit --singleThreaded`. Utiliser
ce mode pour les prochains contrôles locaux sous garde : le contrôle froid
parallèle a réussi mais a atteint 14,1 Gio. Cette option ne dispense d'aucun
diagnostic de type ; elle réduit le parallélisme.
Sur ce Mac, l'appel direct au binaire qualifié
`node_modules/@typescript/typescript-darwin-arm64/lib/tsc` évite le launcher Node
et sa transition `execve` pendant l'observation ; le premier essai avec ce launcher
a été interrompu pour mesure indisponible. Le binaire direct a terminé avec
code 0 en 21,655 s, empreinte maximale observée 5,70 Gio et aucune hausse du swap.

Tests : `python3 -m unittest discover -s scripts/dev -p 'test_*.py' -v`.
Ils combinent petits processus réels, observations natives macOS et mesures
simulées pour les dépassements : aucun test n'alloue 7 ou 8 Gio volontairement.

## Profil optionnel de jalon : `--profile milestone`

Ce profil répond au mandat explicite du propriétaire pour une **fenêtre Mac
libre**. Le mode sans option, ou `--profile strict`, conserve tous les seuils
conservateurs décrits plus haut. Aucun seuil de ce mode n’est supprimé. Le profil
jalon ne se sélectionne jamais automatiquement après un refus strict.

**Avant un véritable jalon**, prévenir le propriétaire et coordonner la fenêtre
avec les autres lanes : activité DB, libération des ressources et éventuel arrêt
propre de Colima par son responsable. Ce script n’arrête aucun service ni aucune
application de l’utilisateur. Codespaces et runners payants ne sont pas une
solution de repli. Ne supprimer aucun fichier pour contourner un refus disque.

Depuis le répertoire de travail de la construction :

```sh
python3 /chemin/checkout/scripts/dev/build_guard.py \
  --profile milestone --disk-path /volume-des-sorties \
  --report /chemin/prive/recu-jalon-unique.json -- commande-de-construction
```

`--disk-path` sélectionne un chemin existant sur le volume qui reçoit les sorties
et temporaires. À défaut, le volume du répertoire courant est mesuré. L’appelant
doit vérifier le placement réel des sorties et des caches ; une mesure d’un autre
volume ne les protège pas. Un montage qui disparaît ou une mesure absente refuse
ou interrompt. Si plusieurs volumes sont nécessaires, ce profil à volume unique
ne qualifie pas leurs espaces libres. Ni ce chemin ni la commande ne figurent
dans le reçu. `--disk-path` est refusé en mode strict pour éviter une fausse
impression de contrôle disque ajouté à ce mode.

### Règles du jalon

- Au moins **40 Gio disponibles** (`f_bavail × f_frsize`, soit 42 949 672 960
  octets) avant lancement, à chaque observation et au contrôle final. Un chiffre
  de 41 Go décimaux n’est donc pas suffisant. La mesure doit être refaite à la
  fenêtre réelle ; aucune observation ancienne n’autorise le prochain jalon.
- Délai maximal **5 400 secondes** depuis le début du prévol. Le délai comprend
  les mesures ; l’observation périodique peut retarder sa détection. Arrêt manuel
  et nettoyage ciblé restent actifs. L’horloge monotone est injectable pour les
  tests, sans option CLI qui permettrait un délai illimité.
- Pression **critique prolongée uniquement**, avec le modèle échantillonné
  suivant : seuls les intervalles dont les deux observations aux bornes valent
  `4` ajoutent au cumul critique. À **60 secondes** de cumul, interruption. Une
  phase normale/warning n’ajoute aucune seconde critique. Elle remet le cumul à
  zéro après **15 secondes continues observées hors critique** ; une amélioration
  plus courte conserve le cumul. Ainsi, le flapping ne remet pas immédiatement
  le compteur à zéro, sans compter le temps warning comme critique. Les
  transitions entre deux observations ne sont pas reconstruites.
- Les valeurs reconnues du sysctl sont les masques Dispatch **1 normal, 2
  warning, 4 critical**. Ce ne sont pas les valeurs de l’enum interne XNU. Tout
  autre nombre, mesure manquante/invalide ou horloge non monotone produit
  `monitoring-unavailable`, sans deviner le niveau.
- **Aucun arrêt jalon** sur footprint 7 Gio, croissance swap 1 Gio ou disponibilité
  mémoire 20 %. Ces grandeurs restent mesurées. Cela n’empêche pas macOS de
  ralentir ou tuer un processus ; le profil n’est pas une garantie de réussite.

La conversion du sysctl vers Dispatch est visible dans
[le code primaire XNU](https://raw.githubusercontent.com/apple-oss-distributions/xnu/main/bsd/kern/kern_memorystatus_notify.c)
(`sysctl_memorystatus_vm_pressure_level` appelle
`convert_internal_pressure_level_to_dispatch_level`). Les masques ont aussi été
lus dans le SDK local `usr/include/dispatch/source.h`, sous
`DISPATCH_MEMORYPRESSURE_NORMAL/WARN/CRITICAL`. Aucune commande ne force la pression
mémoire globale ; `memory_pressure -Q` reste une interrogation.

### Reçu, identité et limites

Le reçu jalon ajoute profil, seuil disque, délai, **pic swap absolu** et **pic de
croissance depuis le prévol** séparés, minimum de mémoire libre et de disque,
cumul critique courant/pic, et les 128 premières transitions de pression avec
leurs temps relatifs. La troncature de la séquence est explicite ; elle ne change
pas le verdict. Les champs supplémentaires d’un échantillon sont supprimés, les
raisons d’arrêt sont fixes. Aucune valeur de commande, environnement ou exception
brute n’est incluse. La sortie enfant reste relayée et doit toujours être filtrée
par l’appelant avant archivage.

Le pic de footprint est la somme des processus observés, mémoire compressée
incluse ; ce n’est ni du RSS, ni un pic de groupe atomique. La mémoire partagée
peut être comptée deux fois, les pics entre mesures peuvent être manqués. Swap et
pression sont globaux, sans attribution causale à la construction. Le délai de
mesure dépend aussi du nombre de descendants. Les vérifications natives
PID/UID/création, groupe propre et descendants détachés observés, ainsi que TERM,
grâce et KILL, restent celles du garde existant. Une panne de mesure disque ou
pression ne perd pas les identités déjà observées pour ce nettoyage. Les limites
sur les descendants détachés **avant leur première observation** restent entières.

Les tests utilisent des séries temporelles fictives, de petits enfants réels,
des identités/footprints natifs et des limites disque simulées. Dans les tests de
cycle de vie strict, seuls pression/swap/disponibilité globaux sont doublés pour
que l’activité du propriétaire ne décide pas si l’enfant de test démarre. La
lecture native globale et le refus strict de warning restent testés séparément.
Aucun stress mémoire, build ou compilateur n’est lancé par ces tests.

Le reçu historique Mac de **1 157,993 s** prouve son exécution ancienne seulement :
autre verrou, source SHA absente et standalone actuel manquant. Il ne qualifie
pas les nouvelles sources ni ce profil. Un succès de commande sous garde n’est
pas à lui seul une qualification Next/standalone, Linux, image ou release. Il
faudra les preuves de la construction complète sur le SHA réellement retenu.
