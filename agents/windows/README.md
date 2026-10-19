# Memlia Agent Windows — primitives de session et de réservation

Cette tranche P07 ajoute uniquement l’observation native en lecture seule du bureau
et un verrou d’exclusion interprocessus. Elle n’est pas encore un agent exécutable,
un service, un installateur ni un dispatcher. La publication de développement des nouveaux fichiers est autorisée par le
propriétaire ; ils restent sous droits réservés jusqu’au choix de leur licence.

## Réemploi et frontières

Le contrôle `OpenInputDesktop` / `GetUserObjectInformation` reprend le mécanisme
Win32 déjà exercé par le laboratoire P00. `ctypes`, `unittest` et les autres modules
utilisés appartiennent à Python ; **aucune dépendance runtime n’est ajoutée**.
Le backend Windows OpenAdapt, les actionneurs et ExcelMcp ne sont pas chargés.

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
propriétaire/cabinet, commandes signées, qualifications, TTL, consentement local,
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

P07 reste ouvert : mTLS/DPAPI/enrôlement, commandes/TTL/déduplication durables,
consentement et indicateur local, arrêt d’urgence, transport et intégration backend
ne font pas partie de cette tranche. P08/P13 et toute qualification commerciale
restent ouverts.
