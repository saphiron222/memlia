<!-- Copyright (c) 2026 Memlia. All rights reserved. -->

# Job Windows possédé — port interne inactif

`owned_job.OwnedJob` est une primitive synchrone de propriété de handles, sans
superviseur additionnel. Aucun host ne l'appelle dans cette tranche. Elle
n'authentifie pas une commande, ne réserve pas le bureau et n'accorde ni lease,
ni consentement, ni droit de capture ou de replay. Les gates du host restent
fermées. Aucun paquet, verrou ou service Windows n'est ajouté.

Le futur host doit conserver l'objet **avant** `start()`, dans son propriétaire
de réservation/indicateur. L'objet appartient au PID, à l'objet Thread et au TID
qui l'ont construit. Un appel depuis une autre identité refuse avant toute API
native. Il n'existe ni context manager ni destructeur libérant des handles.

## Entrées et lancement

Le constructeur n'effectue aucune I/O native. Les entrées sont exclusivement de
configuration interne de confiance : exécutable et cwd locaux absolus, tuple de
64 arguments au maximum, dict de 1 à 32 variables explicites et échéance
monotone finie de 30 minutes au maximum. Chaque valeur est copiée en texte
immuable borné ; les clés d'environnement ambiguës en casse, `=`, NUL, chemins
UNC/relatifs/ADS et `..` sont refusés. `SystemRoot` est obligatoire. Aucune
variable ambiante n'est ajoutée : cette primitive ne décide pas quelles variables
un worker particulier peut recevoir. Ce choix et la vérification fraîche des
binaires/cwd possédés restent au futur host, hors de toute entrée réseau.

L'exécutable est explicite ; `subprocess.list2cmdline` construit la ligne mutable
de `CreateProcessW`, sans shell intermédiaire. Le bloc d'environnement Unicode
capturé reste limité à 16 Kio. Le Job est anonyme et non héritable ; aucun handle
du parent n'est hérité. Le worker devra ouvrir ses propres artefacts possédés.

Après contrôle de disque libre d'au moins 40 Gio et d'échéance, l'ordre est :

1. Créer le Job et poser/recontrôler exactement `KILL_ON_JOB_CLOSE`, sans breakaway.
2. Créer le processus suspendu, sans fenêtre et avec environnement Unicode.
3. Assigner le handle de processus au Job, confirmer `IsProcessInJob` et lire son
   FILETIME de création via ce même handle.
4. Reprendre son thread une seule fois : `ResumeThread` doit renvoyer exactement
   le compteur précédent `1`. Tout autre résultat refuse le lancement.

Un échec avant assignation termine et attend uniquement le processus suspendu
dont le handle est possédé. Un retour natif FALSE de `CreateProcessW` est
distingué d'une interruption ambiguë qui n'a pas livré les handles. Dans ce
dernier cas, l'objet demeure en HOLD ; aucun PID deviné n'est ouvert ou tué.

## Observation, arrêt et HOLD

`poll()` livre seulement un `JobState` immuable : nombre actif, fin de la tête,
code entier éventuel et indicateur de forçage. Le code 0 de la tête n'implique pas
que le Job est vide. Une mesure inconnue, une réponse native mal formée, un disque
insuffisant ou une échéance dépassée refuse la livraison. Une observation revenue
après l'échéance ne peut pas être acceptée. Les erreurs ordinaires sont des codes
fixes, sans cause, message système, commande ou environnement.

`cleanup()` est explicite et idempotent une fois fermé. Après reprise, il termine
uniquement le Job possédé si nécessaire ; il exige ensuite `ActiveProcesses=0`
et la fin du handle de la tête avant de fermer thread, processus, puis Job.
L'attente de réconciliation est bornée à 5 s, avec points de contrôle coopératifs.
Un retour `False` conserve les handles restants en HOLD. Seul le même propriétaire
peut réessayer cette réconciliation, sans recréer ni relancer un processus. Un
CloseHandle réussi n'est jamais répété ; un close refusé ne libère pas les autres
handles par défaut. Les interruptions de contrôle pendant `start()` conservent
leur propagation après tentative de nettoyage possédé.

Le futur host doit **retenir réservation et indicateur** lorsque le nettoyage
reste inconnu, ou rendre l'agent non réutilisable jusqu'à réconciliation. Lever
une exception puis sortir de ses context managers ne suffit pas. Après forçage,
annulation, échéance ou observation inconnue, aucune capture ne peut être
acceptée ou compilée sur la seule base d'un nettoyage ultérieur réussi. Le port
ne remet jamais un LocalStop à zéro.

## Limites de preuve

Les API synchrones ne sont pas préemptées : les échéances sont vérifiées entre
appels, pas garanties comme plafond mural d'un syscall bloqué. Les quotas CPU,
mémoire et nombre de processus Windows restent un profil à mesurer et qualifier.
La pause humaine du garde mémoire **Mac** n'autorise aucune conclusion sur ces
quotas Windows. `KILL_ON_JOB_CLOSE` est une protection de propriété, pas une
sandbox contre un compte compromis ou un worker lançant un service/WMI.

Les tests portables utilisent un faux kernel nommé, sans processus Windows. Ils
vérifient le cycle et les signatures/tailles/offsets Win64, ainsi que les refus
et la conservation en HOLD. Un faux DLL confirme les paramètres effectivement
transmis à la façade ctypes. Ces tests ne qualifient ni les syscalls réels, ni
les nested jobs de la session, ni la capture. La recette T2 historique utilisait
PyWin32 pour plusieurs appels : elle ne qualifie pas cette nouvelle façade.
Une future recette Windows x64 séparée devra vérifier Job vide, parent/enfant,
timeout, handles fermés et témoin sans rapport intact avant raccordement.

## Réutilisation et sources

Le port reprend la mécanique T2, avec `_function` du module `session` et les API
stdlib ctypes ; aucun moteur OpenAdapt n'est copié. Les structures utilisent des
entiers Win32 à largeur fixe et des pointeurs, sans dépendre de `c_long` du Mac.

- [CreateJobObjectW](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-createjobobjectw)
  : nom NULL et attributs de sécurité NULL.
- [CreateProcessW](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw)
  : exécutable explicite, ligne mutable, environnement Unicode, héritage désactivé.
- [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
  : association des enfants et limites de la primitive.
- [ResumeThread](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-resumethread)
  : compteur de suspension précédent.
- [QueryInformationJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-queryinformationjobobject)
  et [accounting](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_accounting_information)
  : tailles exactes et nombre actif.
- [Extended limits](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_extended_limit_information)
  et [TerminateJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-terminatejobobject)
  : flags et arrêt par handle possédé.

Code Memlia sous droits réservés ; pas de nouvelle dépendance redistribuée.
