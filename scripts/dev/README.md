# Contrôle des constructions locales sur macOS

Outil interne pour ce Mac de développement de 16 Go, sans dépendance Python
supplémentaire. La publication de développement est autorisée ; nos ajouts restent sous droits
réservés en attendant le choix de leur licence. Il ne s'agit pas d'un contrôle de livraison Linux.

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
