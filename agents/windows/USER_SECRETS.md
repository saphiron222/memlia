# Protection des futurs secrets utilisateur Windows

Cette primitive de P07 protège des octets avec **Windows DPAPI CurrentUser**.
Elle n'accède à aucun magasin de secrets existant et ne crée ni compte, certificat,
clé d'agent, session serveur, transport ou fichier de stockage. Les nouveaux fichiers
restent soumis au `LICENSE` du package, avec droits réservés. La publication de
développement est autorisée par le propriétaire après les contrôles du candidat ;
aucune licence libre n’est attribuée implicitement aux ajouts.

## Utilisation et périmètre

`memlia_agent.user_secrets.CurrentUserProtector` expose `protect()` et `unprotect()`.
Les trois limites sont obligatoires, positives et bornées par le format DWORD natif :

```python
from memlia_agent.user_secrets import CurrentUserProtector

# Exemple de limites de test, à fixer explicitement pour le déploiement cible.
protector = CurrentUserProtector(
    max_secret_bytes=4096,
    max_protected_bytes=16384,
    max_context_bytes=512,
)
context = b'cabinet-fictif/agent-fictif/cle-test'
secret = bytearray(b'VALEUR FICTIVE UNIQUEMENT')
try:
    protected = protector.protect(secret, context=context)
finally:
    secret[:] = bytes(len(secret))

restored = protector.unprotect(protected, context=context)
try:
    # Consommation locale uniquement par le futur transport autorisé.
    pass
finally:
    restored[:] = bytes(len(restored))
```

Ces valeurs de limites ne sont pas une politique de production par défaut. Le futur
hôte doit les figer selon les formats de clés réellement retenus et rejeter une
configuration non bornée. `context` est une donnée publique stable, explicitement
fournie par l'appelant à partir de l'installation, de l'agent et de l'usage. Aucune
normalisation implicite ni sélection du cabinet depuis un prompt IA. L'entropie
optionnelle DPAPI lie les octets exacts du contexte ; un contexte différent refuse
la lecture. Cela n'établit ni identité serveur ni autorisation utilisateur.

`protect()` exige un `bytearray` non vide et ne l'efface pas : il appartient à
l'appelant. `unprotect()` rend un nouveau `bytearray` à effacer après consommation.
Les copies possédées par l'adaptateur et les allocations natives sont effacées au
mieux ; les allocations natives sont libérées par `LocalFree`, même après erreur.
Python/Windows, leurs copies internes, le swap et les traces de débogage ne donnent
aucune garantie d'effacement intégral de la mémoire. Ne pas convertir ces valeurs
en chaînes immuables, les journaliser ou enregistrer des dumps contenant des secrets.

Le chiffrement et le MAC sont réalisés exclusivement par `CryptProtectData` et
`CryptUnprotectData` de Windows. Les DLL sont chargées depuis System32. Le seul
flag demandé est `CRYPTPROTECT_UI_FORBIDDEN` ; aucun flag `LOCAL_MACHINE`, prompt,
repli en clair, clé globale, algorithme ou chiffrement maison. Un format versionné,
une longueur et un checksum SHA-256 **à l'intérieur du contenu DPAPI** permettent
également de refuser une sortie mal formée/corrompue. Un checksum public du blob
chiffré détecte aussi la corruption de métadonnées que Windows peut ignorer. Ce
checksum public peut être recalculé par quiconque ; il n'ajoute aucune garantie
contre une falsification volontaire. Ces checksums ne constituent ni signature,
ni preuve de provenance, ni nouveau mécanisme d'autorisation.

## Limites de confiance

La portée utilisateur est celle du compte Windows qui appelle DPAPI. Un autre
processus exécuté sous le même compte peut accéder aux mêmes secrets ; administrateur,
compromission du poste et récupération de domaine ne sont pas neutralisés. Les
exceptions documentées pour profils itinérants et mécanismes de récupération Windows
restent applicables. Cette tranche ne revendique pas une clé non exportable ou TPM.

Le préfixe du blob n'est pas une preuve d'origine. `CryptUnprotectData` ne fournit
pas à cet adaptateur de requête documentée permettant de certifier la portée d'un
blob importé. **Ne jamais exposer `unprotect()` comme outil réseau ou à un modèle,
ni importer de blobs arbitraires.** L'appelant ne doit lire que des blobs émis par
`protect()` et conservés dans son futur stockage possédé. Les ACL, l'atomicité, la
provenance, la révocation, le remplacement autorisé et la rotation de ce stockage
restent à implémenter/revoir avec l'enrôlement. Un checksum n'empêche pas un programme
malveillant disposant déjà du même compte de fabriquer d'autres blobs.

Cette primitive ne vérifie pas que le bureau est déverrouillé : la disponibilité du
bureau, la réservation, le consentement et l'autorité P02/P07 sont contrôlés par le
futur dispatcher avant une action. Une lecture DPAPI réussie n'autorise pas une
connexion à un serveur ou une automatisation. Aucun appel de transport n'est ajouté.

## Erreurs et vérification

`SecretProtectionError.code` expose seulement un code : `invalid_limits`,
`invalid_secret`, `invalid_context`, `invalid_protected_secret`,
`unsupported_platform`, `dpapi_failed`, `invalid_payload` ou
`native_output_out_of_bounds`. Aucun retour en clair en cas d'échec, aucun retry
implicite et aucune erreur système brute à journaliser. Ne pas sérialiser les
frames/variables locales d'une exception.

Depuis `agents/windows` :

```sh
PYTHONPATH=src python3 -m unittest discover -s tests -v
```

Les tests portables simulent la frontière Win32 ; ils vérifient refus, budget,
intégrité de format, absence de valeurs dans les sorties et nettoyage. Ils ne
qualifient pas les garanties de chiffrement ou l'isolation des comptes Windows.
Pour les essais natifs, sur le laboratoire x64 réservé et une session limitée :

```powershell
& <python-x64-isole> -I tests\windows_user_secrets_integration.py
```

Cette suite exige la session console qualifiée par `observe_session()` et échoue
si elle est indisponible. Elle utilise uniquement des octets fictifs, teste leur
aller-retour, un autre contexte, des altérations, un nouveau processus sous le même
compte et les limites configurées. Aucun magasin, certificat, compte Microsoft ou
secret existant n'est lu. L'essai avec un **autre compte**, sur une autre machine,
avec roaming/récupération de domaine, et le cycle de stockage/mTLS/enrôlement du
produit complet demeurent **NON TESTÉS**. Les preuves exactes sont conservées dans
le rapport privé P07, et ne constituent pas une clôture du lot commercial.

## Réutilisation et références

OpenAdapt `128fd581` utilise `keyring` dans Capture/shadow/keys.py et Flow/hosted.py
pour ses clés éphémères/tokens hébergés. Ces magasins, leurs noms et leurs replis
ne sont pas repris. `win32crypt` de pywin32 est disponible dans la fermeture
OpenAdapt du laboratoire, mais l'hôte agent ne dépend pas de cette fermeture :
l'adaptateur réutilise directement la même API système via `ctypes` standard, sans
ajouter les binaires pywin32 au package minimal. Aucun code OpenAdapt n'est copié.
Credential Manager peut convenir à de petits tokens, mais sa limite de 2 560 octets
n'est pas retenue comme format universel pour les futurs octets de clé/certificat.

Aucune dépendance Python ou DLL redistribuée n'est ajoutée. `hashlib`, `hmac` et
`ctypes` appartiennent à la bibliothèque standard et conservent les notices Python.
Les API système sont fournies par l'installation Windows autorisée.

- [CryptProtectData et ses flags](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata).
- [CryptUnprotectData, intégrité et libération](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptunprotectdata).
- [CREDENTIALW, taille du blob et persistance utilisateur](https://learn.microsoft.com/en-us/windows/win32/api/wincred/ns-wincred-credentialw).
- [Chargement sécurisé des DLL avec ctypes](https://docs.python.org/3.12/library/ctypes.html#ctypes.WinDLL).
