# Memlia Agent Windows

Le package fournit l’entrée `memlia-agent` (également `python -m memlia_agent`),
l’association durable, le transport de pilotage mTLS et le dispatcher supervisé
capture → compilation → résultat **à tester**. Ces compositions sont testées avec
des frontières Windows explicitement doublées et un vrai serveur TLS local fictif ;
leur parcours intégré sur Windows et le listener de production restent à qualifier.
Les développements Memlia restent tous droits réservés jusqu’au choix de licence.

## Démarrage et configuration

Les commandes fermées sont `enroll`, `resume`, `activate`, `status` et `run`.
Le lancement reçoit un seul objet JSON UTF-8 sur **stdin**, limité à 128 Kio ;
aucun code d’association ne doit apparaître dans les arguments, une URL ou les logs.
L’objet d’installation `memlia.agent-bootstrap/v1` comporte `installationId`,
`origin`, `organizationId` (ou `null` explicite), `workspaceId`, `ownerUserId`,
`enrollmentId`, `tlsCaPem` et `agentCaPem`. `enroll` exige aussi `code` et `expiresAt`.
Les champs supplémentaires et les clés dupliquées sont refusés.

`run` exige en plus **`controlOrigin` et `controlCaPem`**, fournis par
l’administrateur de l’installation, jamais par le Chat, une commande distante ou
une réponse non appairée. L’origine contrôle n’est pas dérivée de l’origine web.
Ce premier raccord ne prétend pas ajouter ces deux paramètres au contexte durable
d’association : leur configuration reste une frontière d’administration explicite.
La CA TLS du serveur, la CA d’émission des certificats agents et les futures clés
de signature des permis Flow assurent des fonctions distinctes.

L’association réutilise `EnrollmentClient`, DPAPI CurrentUser et le magasin de
credentials existant ; `resume` est une réconciliation explicite des mêmes octets,
sans recréation de clé ni retry d’effet. Après activation, `run` compose le certificat
issu avec le port fixe **`POST /v1/agent/control`**. Une session navigateur ou un
header de proxy ne remplace jamais l’identité du certificat.

## Exécution supervisée

Le dispatcher utilise les contrats générés `memlia-contracts==0.1.0`, installés
depuis la wheel locale construite par ce monorepo, avec `--no-index --no-deps`.
Ne pas télécharger un package homonyme sur un index public. Les dépendances externes
restent celles du verrou du projet ; aucune nouvelle capture, authentification,
queue métier ou bibliothèque de chiffrement n’est implémentée.

Chaque claim est contrôlé : digest canonique v2, cabinet/espace/propriétaire/agent,
SID et session, dates, locks/fences et références exactes. Le serveur conserve les
claims et la déduplication durables ; le registre du processus seul ne couvre pas
un redémarrage. Aucun effet ni publication incertaine n’est automatiquement rejoué.

Pour `capture.start`, le dialogue Windows existant produit l’observation uniquement
après le vrai clic Autoriser et les contrôles de bureau/visibilité. Le serveur doit
ensuite délivrer la capacité correspondant à ce digest exact avant tout worker.
L’indicateur et l’arrêt local restent ceux de l’adaptateur existant. Capture et
compilation sont exécutées sur **un même thread possédé**, conservé vivant pour
les fonctions `reconcile_*` si leur nettoyage reste incertain. Aucune nouvelle
commande ne démarre en état HOLD ; une fermeture non prouvée ne devient pas un succès.

Dans ce lancement CLI, **Ctrl+C demande l’arrêt coopératif**. Si le nettoyage
échoue ou si sa vérification dépasse dix secondes, l’hôte conserve le dispatcher,
son propriétaire natif et la boucle de contrôle. Il publie uniquement le statut
fermé `cleanup_required` et attend **un nouveau Ctrl+C pour demander explicitement
la réconciliation**. Les demandes répétées sont regroupées ; une tentative encore
en cours est réobservée sans être annulée ni dupliquée. Aucun nouvel effet n’est
autorisé par cette demande. Le handler de console précédent est restauré seulement
après nettoyage prouvé. Une incertitude réseau ou métier reste bloquante même si
le nettoyage réussit ensuite ; elle ne devient pas une réussite d’automatisation.
Le signal réel a été vérifié sur macOS avec composants métier doublés ; le parcours
Ctrl+C dans la console Windows reste à qualifier, ainsi que son futur packaging.

Le résultat exporté est un ZIP opaque borné à 33 Mio (contenu Flow : 128 fichiers,
8 Mio par fichier, 32 Mio au total), transféré en chunks de 256 Kio. Les octets,
offsets, références et digests sont vérifiés, sans chemin local ni URL arbitraire
dans le protocole. Le manifeste interne reste `to_test`. Le reçu
`memlia_capture_compile_v1` constate uniquement la capture et sa compilation ; il
ne qualifie aucune procédure métier et n’autorise aucun replay.

`procedure.run` et `excel.apply` restent **fermés dans ce dispatcher** tant que
l’admission Flow signée et l’exécuteur Excel natif ne sont pas composés. Les
adaptateurs bas niveau existants ne sont pas remplacés par des succès simulés.
Le service de démarrage automatique, l’installateur signé, le parcours serveur/DB,
les ACL/DPAPI réelles et la qualification Windows restent des contrôles distincts.

Les sections suivantes décrivent les primitives natives réutilisées.

## Réemploi et frontières

Le contrôle `OpenInputDesktop` / `GetUserObjectInformation` reprend le mécanisme
Win32 déjà exercé par le laboratoire P00. `ctypes`, `unittest` et les autres modules
utilisés pour ces seules primitives appartiennent à Python. Le dispatcher compose
les adaptateurs existants séparément ; l’observation seule ne charge pas OpenAdapt.

`observe_session()` interroge uniquement le SID utilisateur du token du processus,
son niveau d’élévation, l’architecture, les identifiants/états de session, le protocole
console, les noms des objets station/bureau et le nombre d’écrans. Il ne lit aucun
pixel, titre de fenêtre, événement clavier/souris, document, secret ou jeton Microsoft.
Le SID sert à vérifier la même identité locale ; il ne doit pas être journalisé
sans nécessité ni envoyé comme preuve d’autorisation.

Le profil de cette tranche est **Windows 11 x64 natif, console locale, processus non
élevé, session non nulle active, station WinSta0 et bureau d’entrée/thread Default**.
Un contexte non disponible, distant/RDP, élevé, sécurisé ou non qualifié par ce profil
est refusé. Ce profil n’interdit pas une future qualification RDP ; elle reste ouverte.
Le nombre d’écrans est une observation, pas un refus de session. DPI, multi-écrans,
fenêtre cible élevée et autres contraintes d’action doivent être qualifiés/contrôlés
par le moteur P08/P13 avant tout effet. Cette primitive ne les valide pas.

Une `SessionObservation` est un constat instantané. Elle n’est **pas** la
`memlia.session-capability/v1` de `packages/memlia-contracts/src/desktop.ts`.
Les schémas P00 ne sont ni dupliqués ni modifiés ici. Autorité serveur P02,
propriétaire/cabinet, commandes authentifiées, qualifications, TTL, consentement local,
lease/fence et droit de lancer un travail doivent encore être contrôlés à leur
frontière réelle. Aucun de ces contrôles n’est simulé pour brancher un transport.

## Réservation du bureau

```python
from memlia_agent.resources import reserve_desktop

with reserve_desktop() as reservation:
    current = reservation.ensure_current()
    # Aucun effet n'est autorisé par ce résultat seul.
```

`Local\Memlia.Desktop.v1` est un mutex Windows dans le namespace de la session,
commun aux instances/cabinets/agents de cette session. Il n’est pas partitionné par
agent : cela autoriserait deux prises de contrôle du même bureau. Son ACL reste celle
du token utilisateur ; le handle n’est pas héritable. Le mutex est demandé sans
attente (`WaitForSingleObject(..., 0)`) et la réentrance Win32 du même thread est
refusée par le registre local. Il protège tout le bureau Default, pas un seul écran.

Le même thread conserve la propriété jusqu’à `close()`/sortie du `with`. Son objet
`Thread` Python est conservé fortement et son identité/durée de vie contrôlées en plus
du PID et du numéro natif : ce dernier peut être recyclé après terminaison. Le profil
prend en charge le thread principal et les threads créés par `threading.Thread` ; les
`_DummyThread` de threads natifs étrangers sont refusés car leur fin n’est pas suivie.
Ce contrôle du type interne est borné au Python qualifié et reste à revérifier lors
d’un changement de version du runtime. La fermeture par un autre thread/processus
est refusée. Ne pas transférer la réservation à un pool
de threads. Arrêter les travaux possédés **avant** de libérer ce verrou. Un échec de
libération/fermeture ne devient pas une réussite ; le registre reste occupé pendant
la réparation de la fermeture. L’appelant doit disposer d’un chemin d’arrêt/diagnostic.
`ensure_current()` réobserve immédiatement la session et renvoie les métadonnées
courantes ; cela ne garantit pas que le bureau ne changera pas l’instant suivant.

`WAIT_ABANDONED` accorde la propriété native, mais le travail est **refusé** avec
`abandoned_desktop` ; cette propriété et le handle sont libérés. Le dispatcher futur
doit classer le run précédent incertain et réconcilier durablement effets/preuves,
lease/fences et consentement avant un nouveau dispatch. **Pas de retry automatique.**
Quand le dernier handle disparaît ou après redémarrage, Windows peut détruire le
mutex : un nouveau mutex ne révèle alors aucun abandon. Ce verrou n’assure donc ni
déduplication durable, ni fencing, ni exactement-une-exécution, ni reprise sûre après
crash/reboot. La réservation DB et le journal durable du plan restent indispensables.
Il protège les agents coopérants ; ce n’est pas une barrière contre un programme local
malveillant qui possède déjà les droits du même utilisateur.

## Tests reproductibles

Dans `agents/windows`, sans installation globale :

```sh
PYTHONPATH=src python3 -m unittest discover -s tests -v
```

Les tests portables simulent seulement les réponses système pour vérifier refus et
lifecycle. Ils ne qualifient pas Win32. Pour la qualification native sur Windows,
utiliser le Python x64 isolé depuis une session console limitée/déverrouillée :

```powershell
& <python-x64> -I tests\windows_integration.py
```

La suite native échoue si le bureau n’est pas disponible ; aucun skip ne remplace une
preuve. Elle réserve brièvement le bureau entre processus Python possédés, teste le
refus d’abandon réel, la libération normale/après exception, le thread propriétaire,
l’absence d’héritage et les cycles sans fuite de handles. Aucun hook/capture/Office
n’est lancé. Le laboratoire doit être réservé exclusivement pendant cet essai.
La campagne privée P07 conserve les hashes exacts des sources réellement exécutées.
Les essais de verrouillage/UAC/RDP physiques et le produit intégré restent distincts.

## Références primaires examinées

- [OpenInputDesktop](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-openinputdesktop)
- [WTSQuerySessionInformationW](https://learn.microsoft.com/en-us/windows/win32/api/wtsapi32/nf-wtsapi32-wtsquerysessioninformationw)
- [CreateMutexExW](https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-createmutexexw)
- [WaitForSingleObject et WAIT_ABANDONED](https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-waitforsingleobject)

La primitive [d’arrêt local coopératif](LOCAL_STOP.md) s'arme avant tout travail,
réemploie cette réservation et expose un signal monotone avec contrôle pré-action.
La fixture hotkey Windows reste NON EXÉCUTÉE ; elle ne donne aucun consentement et
ne livre pas encore d'indicateur de capture ou d'interface de gestion.

Les primitives décrites ici ne valent pas validation de leur composition avec le
serveur. P07/P08/P13 et toute qualification commerciale restent ouverts tant que
les recettes natives du livrable exact ne sont pas terminées.
