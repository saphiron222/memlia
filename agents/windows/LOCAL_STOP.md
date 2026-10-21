# Arrêt local coopératif — P07

`stop.arm_local_stop(reservation, deadline_monotonic=...)` fournit un signal
d'arrêt lié à la durée de vie d'un contexte et au thread propriétaire de la
réservation du bureau. Il utilise `DesktopReservation.ensure_current()` et
`observe_session()` existants. Aucun nouveau mutex, transport, contrat P00 ou
dépendance n'est introduit.

```python
import time
from memlia_agent.resources import reserve_desktop
from memlia_agent.stop import arm_local_stop

# Exemple de durée locale seulement : le dispatcher futur doit vérifier la
# vraie autorité/commande/TTL/qualification/consentement AVANT tout effet.
with reserve_desktop() as reservation:
    with arm_local_stop(reservation, deadline_monotonic=time.monotonic() + 60) as local_stop:
        local_stop.checkpoint()
        # Juste avant chaque prochaine action/frame/batch possédé : checkpoint().
        # Aucun moteur/capture/replay n'est lancé par cette primitive.
```

## Contrat et lifecycle

- Le contexte n'est livré qu'après un enregistrement réussi et un nouveau contrôle
  de la réservation/session. Une collision ou un échec natif interdit de démarrer.
- `request_stop()` pose un `threading.Event` privé depuis n'importe quel thread.
  `stopped` est en lecture seule ; aucun reset/clear/transfert de signal vers un
  autre run n'est proposé. Chaque contexte possède son propre signal.
- Le thread possédé enregistre **Ctrl+Alt+Shift+F11**, avec `MOD_NOREPEAT` et un ID
  d'application fixe. F12 est réservé au débogueur Windows. La touche n'est pas
  fournie par le modèle, le réseau ou une commande. Il n'y a pas de hook clavier,
  d'écoute générale des touches, de fenêtre ou de capture.
- `RegisterHotKey(NULL, ...)` livre les notifications à la file du thread qui
  l'enregistre. Ce même thread dépile au plus32 messages par tour par
  `PeekMessageW(HWND(-1), WM_HOTKEY, WM_HOTKEY, PM_REMOVE)` et appelle
  `UnregisterHotKey(NULL, ...)` en `finally`. Seuls l'ID et la combinaison exacts
  déclenchent l'arrêt ; un WM_QUIT inattendu refuse la poursuite.
- `checkpoint()` doit être appelé sur le thread propriétaire **avant chaque
  prochaine action/batch** et avant de conclure un résultat. Il contrôle le signal,
  la durée monotone, le moniteur et la réservation/session, puis recontrôle le
  signal/délai après l'observation native. Un changement de nombre d'écrans suit
  les règles natives existantes, pas une nouvelle politique ici.
- Un signal, une erreur de moniteur/session/réservation ou une échéance provoque
  un arrêt monotone. `StopRequested` ne signifie pas que les actions déjà réalisées
  sont annulées. `StopUnavailable` ne doit jamais devenir un résultat réussi.
- `close()` pose le signal, attend le thread possédé et exige son nettoyage
  confirmé. Seul le propriétaire (référence forte Thread, PID et ID natif) ferme
  le contexte ; un autre thread peut demander l'arrêt. La fermeture ne dépend pas
  du maintien d'une session déverrouillée, afin de permettre le cleanup après perte
  de session. Elle est idempotente seulement après succès confirmé.

Les codes fixes sont `invalid_deadline`, `reservation_unavailable`,
`unsupported_thread`, `session_unavailable`, `hotkey_unavailable`,
`hotkey_start_failed`, `hotkey_start_timeout`, `hotkey_pump_failed`,
`hotkey_monitor_unavailable`, `stop_owner_mismatch`, `stop_closed`,
`stop_requested`, `deadline_expired`, `hotkey_cleanup_failed` et
`hotkey_cleanup_unverified`. Pas d'exception native, contenu de session, SID,
argument de commande ou journal clavier dans ces erreurs.

## Bornes et limites de sécurité

Le moniteur attend au plus50ms entre tours, avec une échéance explicite finie et
future. L'armement et la fermeture attendent au plus2s chacun le thread possédé.
Ces attentes ne préemptent **pas** un appel synchrone Python/Win32 bloqué. Un thread
non terminé ou une désinscription refusée impose un **HOLD/non confirmé** ; le
caller ne doit pas libérer le bureau, lancer un nouveau travail ou déclarer un
succès en supposant le nettoyage réalisé. Aucun kill global ou réparation supposée
ne masque ce refus. Le thread n'est pas détaché silencieusement : il est non-daemon.

Un arrêt est coopératif. Il ne coupe pas une action native déjà en cours, n'annule
pas une écriture comptable et ne garantit pas un délai mural entre frappe et fin.
Un changement de session ou un signal peut survenir immédiatement après un contrôle.
La fermeture du contexte ne qualifie pas le résultat métier du travail. Le futur
dispatcher devra conserver ses fences/réservations/journal durable et classifier
les effets incomplets/incertains. Cette primitive ne les remplace pas.

**Aucun droit de capture, authentification de commande, enrôlement ou consentement
local n'est accordé ici. Aucun indicateur d'enregistrement ou dialogue de consentement
n'est livré.** Ces éléments restent bloquants avant une vraie capture/replay P08.
Le profil Windows autorisé reste celui de `session.py` : console Windows11 x64
non élevée/déverrouillée, bureau Default. UAC, verrouillage, RDP et appui physique
hors fenêtre Memlia nécessitent une qualification native distincte. Un programme
ayant déjà les droits du même utilisateur peut envoyer un message d'arrêt : ce
message n'accorde aucune autorité et ne sert pas d'authentification.

## Tests et état de qualification

`tests/test_stop.py` utilise une vraie réservation et de vrais threads Python avec
les réponses Win32 doublées. Il vérifie les refus, signaux, propriétaires, délais,
messages filtrés et nettoyage. Les appels/bindings Win32 doublés ne prouvent ni ABI
ni disponibilité d'une touche sur le poste Windows.

`tests/windows_stop_integration.py` est une fixture **préparée, NON EXÉCUTÉE**.
Sa revue et la réservation du laboratoire doivent précéder toute exécution :

```powershell
& <python-x64-isolé> -I tests\windows_stop_integration.py --allow-local-hotkey-test
```

Elle doit vérifier enregistrement/désinscription/réutilisation, collision réelle,
échéance, propriété et arrêt par WM_HOTKEY synthétique envoyé uniquement au thread
possédé. Elle n'injecte aucun appui clavier. Cette dernière preuve ne qualifiera
pas un appui physique ni l'accessibilité du futur indicateur/UI. Aucun skip ne
vaut réussite native ; un profil indisponible doit être enregistré comme NON TESTÉ.
Ne pas l'exécuter sous SSH/session0 par supposition : réemployer le mécanisme
interactif limité du laboratoire après revue explicite du payload/cleanup.

## Sources examinées

- [RegisterHotKey](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-registerhotkey) :
  file du thread avec HWND NULL, collisions, MOD_NOREPEAT, IDs et réservation F12.
- [UnregisterHotKey](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-unregisterhotkey) :
  désinscription par le thread appelant possédant l'enregistrement.
- [PeekMessageW](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-peekmessagew) :
  HWND(-1), filtres, PM_REMOVE, zéro sans message et WM_QUIT hors filtre.
- [WM_HOTKEY](https://learn.microsoft.com/en-us/windows/win32/inputdev/wm-hotkey) :
  ID, touche et modificateurs du message.

Les nouveaux fichiers Memlia restent sous droits réservés ; `ctypes`, `threading`,
`contextlib` et `unittest` sont fournis par Python. Aucun code OpenAdapt ou composant
Enterprise n'est copié ou chargé pour cette primitive.
