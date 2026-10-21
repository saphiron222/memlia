# Contrôles locaux d’une capture

`capture_controls.py` compose les primitives existantes `DesktopReservation` et
`LocalStop` avec un dialogue système Windows. Il ne crée aucun Recorder, ne capture
rien et n’authentifie aucune commande. Aucun raccordement au transport, à un host
ou à un dispatcher n’est activé par ce module.

`request_capture_controls(reservation, signal, operation_digest=...)` est un
contexte possédé par le même processus/thread que la réservation et le signal.
L’empreinte est une chaîne immuable au format P00 `sha256:` suivi de 64 caractères
hexadécimaux minuscules. La décision est liée à cette empreinte et au bureau local
déjà observé (SID, session et nombre de moniteurs). Un autre signal, une autre
réservation ou une autre empreinte ne peuvent pas réutiliser ce contexte.

Il n’existe ni paramètre `consent=True`, ni fonction d’acceptation, ni résultat
sérialisé à importer depuis un modèle, le réseau ou un ancien run. Le seul chemin
positif est la notification du bouton **Autoriser cette opération** du dialogue
système affiché sur ce poste. Une nouvelle opération exige un nouveau contexte.
Cela ne protège pas contre un programme compromis sous le même compte Windows :
Windows permet aussi l’envoi de messages de fenêtre par des programmes locaux.

Le futur caller doit d’abord valider l’`AgentCommand` et l’utilisateur/agent/poste,
la durée, les capacités, la qualification, le bail et les fences natifs. Ce module
ne produit pas de `SessionCapability`, ne persiste aucun consentement et ne
remplace aucun de ces contrôles. Il ne lit aucun secret ni contenu du bureau.

## Dialogue, fin normale et arrêt

Le dialogue TaskDialog décrit en français l’enregistrement des images du bureau,
des clics et des frappes au clavier, la nécessité de ne pas afficher ou saisir de
mot de passe ou de donnée confidentielle et l’exclusion du microphone de cette
autorisation. L’empreinte reste interne : elle lie toujours l’opération exacte,
mais n’est pas présentée comme une information à interpréter par la personne.
Ni lien ni texte libre provenant d’une commande n’est affiché.

**Refuser / Arrêter maintenant** est le choix par défaut. Après accord local,
le dialogue reste au premier plan des fenêtres ordinaires avec le titre
« autorisation donnée ; démarrage en attente ». Cela ne prétend pas qu’un
Recorder a démarré. Le bouton **Terminer l’enregistrement** est désactivé dès
la création native du dialogue et ne peut être activé que lorsque le propriétaire
a signalé un démarrage vérifié ; le timer UI passe alors au titre
« enregistrement en cours ». Le contrôle local reste accessible lorsque
l’application enregistrée n’a pas le focus ; aucune seconde application de
gestion n’est créée.

Le futur host doit utiliser, dans ce même thread et pour cette même empreinte :

1. `recording_preparing(operation_digest=...)` **avant** de créer le processus
   possédé. Cela impose la vérification du cleanup même si le démarrage échoue,
   sans afficher « enregistrement en cours ».
2. `recording_started(operation_digest=...)` seulement **après** avoir vérifié
   les identités/Job et la readiness réelle du Recorder. Le composant ne reçoit
   pas de booléen `started=True` du modèle ou du réseau et ne vérifie pas lui-même
   un Recorder absent de cette tranche. Cet appel reste une obligation du host
   local de confiance, pas une nouvelle preuve native créée par une méthode.
3. `finish_requested(operation_digest=...)` pour constater la seule demande
   locale de fin normale. Le composant recontrôle son contexte avant et après
   la lecture de cet état. Le host doit aussi revalider l’autorité, la session,
   le lease et les fences courants avant d’accepter la demande et le résultat.
4. `recording_stopped(operation_digest=...)` seulement **après** le constat
   natif du cleanup des travaux possédés : Job vide, handles fermés et aucun
   processus Recorder encore actif. Cet acquittement permet la fermeture de
   l’indicateur, y compris après échec de démarrage ou urgence ; il ne constitue
   jamais une réussite, une autorité ni une permission de compiler.

La fin normale laisse le dialogue en état « finalisation ; arrêt en cours de
vérification », désactive Terminer et garde Arrêter accessible. Elle ne ferme
pas la fenêtre et **ne pose pas LocalStop** : les contrôles et l’arrêt d’urgence
restent actifs pendant la finalisation. Aucun reset ou nouveau signal ne remplace
LocalStop. Une demande répétée ne recommence pas l’enregistrement. Une urgence,
une échéance, une perte de fenêtre/session ou une erreur prend toujours le pas
sur une fin normale, même si celle-ci avait déjà été demandée.

Refuser, Arrêter maintenant, Échap, Alt+F4, le signal `LocalStop`, l’échéance ou une erreur
demandent un arrêt monotone. Le dialogue reste affiché en état « arrêt demandé »
tant que son propriétaire n’a pas quitté le contexte. **L’arrêt demandé ne prouve
pas la fin d’une capture.** Le futur raccord doit arrêter puis vérifier la fin de
ses seuls travaux/threads Recorder avant de fermer ce contexte. Le `join` natif
OpenAdapt n’est pas rendu borné par cette primitive. Tant qu’un travail préparé
n’a pas son cleanup confirmé, `close()` pose l’arrêt, refuse avec
`capture_cleanup_unverified` et garde le dialogue hors de son état de fermeture.
Le host conserve HOLD ; aucune compilation après urgence, sortie forcée ou
cleanup incertain n’est autorisée.

**Limite de l’unwind :** ce module ne peut pas empêcher un appelant extérieur de
quitter ses propres contextes `DesktopReservation` / `LocalStop` après une
exception. Le refus de `close()` conserve ses ressources dans le cadre courant,
mais ne prétend pas retenir le mutex à travers cet unwind. Le futur propriétaire
du Job doit rester HOLD jusqu’au constat natif, ou rendre l’agent non réutilisable
jusqu’à réconciliation. Un simple `raise` suivi de `finally` qui relâche tous les
verrous ne suffit pas. Ne jamais accepter un autre run par ce chemin.

`checkpoint(operation_digest=...)` est obligatoire juste avant chaque prochaine
action/batch possédé. Il recontrôle le signal, sa réservation, la session et le
bureau interactif actuels, la même empreinte, le thread et la fenêtre possédés,
ainsi qu’un battement récent du dialogue. Aucun effet déjà acquis n’est annulé.

Un thread non daemon possède le dialogue et ses callbacks. Le timer système
(environ 200 ms) constate aussi la perte de session ou de fenêtre et pose l’arrêt,
même si le thread appelant ne reprend pas immédiatement. Un battement vieux de
plus d’une seconde est refusé au checkpoint. Ces vérifications coopératives ne sont
pas une préemption CPython/Win32 ni une garantie de délai mural pendant un appel
natif bloqué. Le futur lanceur possédé devra conserver ses délais et son cleanup.

Les contrôles de fenêtre combinent propriétaire PID/thread, style visible,
non-minimisation, TOPMOST, absence de cloaking DWM, rectangle dans une zone de
travail d’écran et bouton Arrêter visible/activé. Des hit-tests natifs vérifient
plusieurs points du dialogue et du bouton contre l’occlusion. `IsWindowVisible`
seul ne prouve pas la visibilité : ces contrôles ne garantissent ni l’absence de
toute occlusion entre échantillons, ni qu’une personne a effectivement vu/lu le
dialogue. Une perte du bureau d’entrée Default ou de session interdit la suite.

La fermeture est demandée par le propriétaire uniquement, puis le thread est
joint au maximum deux secondes. Une fenêtre encore référencée, un thread vivant
ou une fin non confirmée donnent `dialog_cleanup_unverified` et imposent HOLD.
Aucun kill de processus arbitraire, aucune libération supposée ni retry automatique
n’est effectué. Le mutex/signal gardent leurs propres lifecycle et propriétaires.

## Compatibilité et qualification

Le backend emploie `TaskDialogIndirect` de Comctl32 v6 et les API Win32 de la
stdlib `ctypes`, déjà utilisée dans l’agent. Les structures reprennent l’ABI SDK
packée sur un octet (bouton 12 octets, config 160 octets en x64). Les DLL système
sont chargées depuis System32. Une fonction/activation Comctl32 v6 indisponible
est un refus fixe `dialog_unavailable` ; aucun changement global de manifeste,
activation context, registre, service ou réglage Windows n’est tenté. La fermeture
du dialogue n’envoie que le bouton Arrêter, jamais Autoriser.

Les tests portables exercent les refus, l’ownership, le timer, le maintien de
l’indicateur après arrêt, la distinction fin normale / urgence, les notifications
de démarrage/cleanup et les structures/configurations natives avec
Win32 doublé. Ils ne simulent aucune acceptation livrée au caller. Quelques états
internes altérés servent à vérifier des refus et des transitions de lifecycle,
sans jamais livrer le contexte d’un consentement simulé ni lancer un Recorder. Les threads,
événements, `LocalStop` et `DesktopReservation` utilisés dans ces tests sont réels ;
les observations Windows, le mutex/hotkey et les appels UI sont explicitement
doublés. Ce n’est pas une décision humaine ni une qualification Windows.

**NON TESTÉ :** affichage et accessibilité réels, Comctl32 v6/manifeste effectif,
décision locale réelle, maintien visuel pendant capture, multi-écrans Windows,
changement de bureau/session natif et raccordement OpenAdapt. Une fixture native
séparée doit être relue avant tout essai visuel distant. Aucun test de capture,
replay, Office, COM ou SSH n’est inclus dans cette tranche.

La recette native du gel précédent `dbc411ae` est **NON TESTÉE** : son unique
connexion a expiré avant le parseur et toute demande de création distante. Les
contrôles TCP/SSH distincts ne requalifient ni ces cas, ni la nouvelle UI. Aucune
capture humaine positive, mécanique Win32 synthétique ou preuve antérieure du
hotkey n’est présentée comme qualification de ce dialogue.

## Références et provenance

Nouveaux fichiers Memlia sous droits réservés ; aucune implémentation OpenAdapt
ou PyWin32 n’est copiée. Les déclarations ctypes décrivent l’API système publiée :

- [TaskDialogIndirect](https://learn.microsoft.com/en-us/windows/win32/api/commctrl/nf-commctrl-taskdialogindirect),
  [TASKDIALOGCONFIG](https://learn.microsoft.com/en-us/windows/win32/api/commctrl/ns-commctrl-taskdialogconfig)
  et [en-tête SDK CommCtrl.h](https://github.com/microsoft/win32metadata/blob/main/generation/WinSDK/RecompiledIdlHeaders/um/CommCtrl.h).
- [Notifications du callback](https://learn.microsoft.com/en-us/windows/win32/api/commctrl/nc-commctrl-pftaskdialogcallback),
  [bouton cliqué / S_FALSE](https://learn.microsoft.com/en-us/windows/win32/controls/tdn-button-clicked)
  et [timer](https://learn.microsoft.com/en-us/windows/win32/controls/tdn-timer).
- [Limites d’IsWindowVisible](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-iswindowvisible),
  [SetWindowPos / TOPMOST](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowpos),
  [DwmGetWindowAttribute](https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/nf-dwmapi-dwmgetwindowattribute)
  et [WindowFromPoint](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-windowfrompoint).

Les API système ne permettent pas d’inférer un consentement réel depuis un test
automatisé ni d’accorder l’autorité serveur manquante au futur host.
