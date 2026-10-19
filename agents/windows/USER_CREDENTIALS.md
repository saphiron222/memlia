# Credentials utilisateur persistants de Memlia Agent

Ce module standard Python ajoute uniquement `store`, `load` et `delete` pour un
credential générique du compte Windows courant. Il réutilise `user_secrets.py`
pour DPAPI CurrentUser et ne crée aucun coffre fichier, clé globale, ACL ou
nouveau chiffrement. Ce n’est pas un agent enrôlé, un transport mTLS ou un
mécanisme d’autorisation du serveur.

```python
from memlia_agent.user_credentials import CurrentUserCredentialStore

store = CurrentUserCredentialStore(instance_id='instance-validee', agent_id='agent-valide')
secret = bytearray(b'EXEMPLE-FICTIF-NE-PAS-UTILISER')
try:
    store.store(secret)
finally:
    secret[:] = bytes(len(secret))

value = store.load()  # bytearray ou None si la cible exacte n’existe pas
if value is not None:
    try:
        pass  # Utilisation après les contrôles d’autorité applicatifs nécessaires.
    finally:
        value[:] = bytes(len(value))
store.delete()  # True si supprimé, False si déjà absent
```

## Identité et portée

Les deux IDs doivent être des chaînes ASCII de 1 à 128 caractères, commencer par
une lettre/chiffre et ne contenir ensuite que lettres, chiffres, `_` ou `-`.
Le module construit la cible `Memlia:agent:v1:<instance-en-hex>:<agent-en-hex>`.
L’encodage préserve la distinction entre majuscules et minuscules des IDs malgré
l’insensibilité à la casse du magasin natif. Aucune méthode publique n’accepte
un nom de cible Windows, un compte à usurper ou un type de credential arbitraire.
Aucune énumération ou recherche globale n’est implémentée.

La cible complète sert de contexte DPAPI. Copier ses octets protégés vers la
cible d’un autre agent ne constitue pas un credential utilisable par l’adaptateur.
Ce contexte est public : il ne prouve ni identité serveur, ni propriété d’un
poste, ni consentement. Les futurs callers doivent valider l’association et les
autorisations avant d’appeler le module.

La persistance utilise **`CRED_PERSIST_LOCAL_MACHINE=2`** : même utilisateur,
même ordinateur, entre sessions, sans roaming Enterprise. Ce nom ne désigne pas
une portée de chiffrement accessible aux autres comptes. Le flag DPAPI
**`CRYPTPROTECT_LOCAL_MACHINE=4` n’est jamais demandé** ; la protection existante
reste CurrentUser, UI interdite. Voir la [structure CREDENTIALW Microsoft](https://learn.microsoft.com/en-us/windows/win32/api/wincred/ns-wincred-credentialw).

Credential Manager utilise le jeu de credentials du token courant ; une session
de connexion réseau peut ne pas disposer de ce jeu. Le module ne bascule pas
vers SYSTEM, un autre utilisateur, un fichier ou une portée machine pour y
remédier. Il n’isole pas les logiciels exécutés sous le même compte Windows et
ne protège pas un poste ou compte compromis. L’observation de session et les
contrôles du futur agent restent distincts.

## Limites et erreurs

Entrée mutable de 1 à 2 048 octets. Le blob protégé doit réellement tenir dans les
**2 560 octets** admis par l’API ; aucune garantie n’est déduite de la seule taille
en clair, car l’expansion DPAPI dépend du système. Aucun découpage de credential,
usage d’attributs pour dépasser la limite ou repli en clair. Les chaînes de
certificats et autres grandes valeurs ne sont pas prises en charge.

`CredentialStoreError.code` fournit seulement des codes fixes. `None` à la lecture
et `False` à la suppression signifient exclusivement `ERROR_NOT_FOUND`. Une session
inadaptée (`credential_logon_unavailable`), un refus d’accès
(`credential_access_denied`), un échec DPAPI (`credential_protection_failed`) ou une
valeur native invalide restent des erreurs. Aucun message driver ou secret n’est
journalisé. Ne pas sérialiser les frames/variables locales des exceptions.

Les buffers natifs lus sont bornés, effacés au mieux puis libérés avec `CredFree`,
y compris après refus. Les copies mutables possédées sont effacées ; l’appelant
reste responsable des octets d’entrée et de la valeur retournée. Cet effort ne
garantit pas l’absence de copies Python/Windows, swap, debugger ou crash dump.
Une taille native hors contrat n’est pas parcourue pour tenter un effacement.
La primitive ne promet pas de rotation atomique multi-credentials, CAS,
anti-retour à une ancienne clé, révocation ou preuve de provenance serveur.

## Vérification et sources

Depuis `agents/windows` :

```sh
PYTHONPATH=src python3 -m unittest discover -s tests -p 'test_*.py' -v
```

Les tests portables simulent l’ABI du magasin et la frontière DPAPI ; ils ne
qualifient pas Windows. L’essai natif explicite est
`python -I tests/windows_user_credentials_integration.py`, sur Windows x64,
dans une session console limitée. Il utilise exclusivement des IDs aléatoires
et valeurs fictives, vérifie l’absence préalable de chaque cible exacte, puis
supprime et revérifie ses seules cibles en cleanup. Aucun skip hors Windows.
Il couvre aussi un nouveau processus, les limites, l’altération et la copie
de blob entre deux cibles possédées. Un arrêt brutal du processus n’est pas une
preuve d’exécution de ses blocs de cleanup ; le laboratoire ne doit pas le tuer
avant son reçu et les vérifications de fin.

Sources Win32 examinées, sans copie d’implémentation tierce :

- [CredWriteW](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credwritew)
  pour l’écriture générique, flags zéro.
- [CredReadW](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credreadw)
  pour la lecture de la cible exacte et sa mémoire native.
- [CredDeleteW](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-creddeletew)
  pour la suppression et l’absence distinguée.
- [CredFree](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credfree)
  pour la libération obligatoire, sans valeur de retour.

Autre compte, autre ordinateur, logout/reboot, profils itinérants/récupération,
compromission, véritables clés/certificats et intégration serveur sont NON TESTÉS
par cette tranche. Les ajouts Memlia conservent les droits définis dans le LICENSE
du package et les règles du dépôt ; aucune nouvelle dépendance n’est ajoutée.
