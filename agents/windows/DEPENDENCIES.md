# Dépendances Windows — session, secrets et HTTPS de préparation

Les primitives session/mutex/DPAPI/CredMan réutilisent uniquement la bibliothèque
standard et les API Windows. Le canal de préparation utilise **`httpx==0.28.1`**,
déjà sélectionné au laboratoire. La composition d’identité T2 ajoute
**`cryptography==50.0.2`**, auparavant utilisée seulement dans les tests, pour
valider les certificats et déchiffrer la clé en mémoire **avant toute écriture
temporaire**. Un label PEM ne prouve pas que le DER est chiffré. Aucun parseur
ASN.1 ou chiffrement maison, aucun framework web. Python minimal3.12 ;
CPython3.12.15 x64 reste le profil laboratoire historique, sans qualification T2
Windows déduite de ce seul inventaire.

## Fermeture exacte du canal

`requirements.lock` reprend les sept roues universelles HTTP déjà figées au
laboratoire et trois packages pour la validation crypto : Cryptography50.0.2,
CFFI2.0.0 et Pycparser3.11. SHA256, METADATA et textes des licences relus.
Les hashes crypto admis couvrent Windows CPython3.12 x64 (Cryptography cp311-abi3,
CFFI cp312-win_amd64) et le profil de test Mac CPython3.13 arm64 ; Pycparser est
universel. Cela ne qualifie pas tous les interpréteurs ou architectures permis
par `requires-python`, ni une installation exécutée sur Windows.
Installation reproductible dans un venv possédé :

```sh
python -m pip install --require-hashes -r requirements.lock
python -m pip check
```

Un cache vérifié peut être fourni par `--no-index --find-links <cache>`. Pas d’extras
CLI/HTTP2/SOCKS/Brotli/Zstandard, pas de téléchargement de moteur/poids. Le lock
concerne le runtime du package agent, pas toute la fermeture OpenAdapt ou l’installer
Windows futur. Le gel exact ne remplace pas la veille de sécurité ultérieure.

| Package/version | Licence du texte inclus dans la roue | Obligation à reprendre dans le futur artefact |
|---|---|---|
| HTTPX0.28.1 | BSD-3-Clause | Copyright, conditions, disclaimer ; pas d’endossement |
| HTTPcore1.0.9 | BSD-3-Clause | Idem |
| AnyIO4.15.1 | MIT | Copyright et licence |
| IDNA3.20 | BSD-3-Clause | Copyright, conditions, disclaimer ; pas d’endossement |
| H11 0.16.0 | MIT | Copyright et licence |
| Typing-Extensions4.16.0 | PSF-2.0 | Textes PSF et notices du package |
| Certifi2026.10.18 | MPL-2.0 | Notice/licence et disponibilité de la source couverte, y compris bundle CA modifié le cas échéant ; pas de mise sous MPL de nos autres fichiers par cette seule inclusion |
| Cryptography50.0.2 | Apache-2.0 OR BSD-3-Clause | Conserver LICENSE et les textes LICENSE.APACHE/LICENSE.BSD de la roue ; obligations des bibliothèques natives embarquées à inventorier dans l’installer |
| CFFI2.0.0 | METADATA : MIT ; texte inclus : MIT No Attribution | Conserver intégralement LICENSE et AUTHORS ; ne pas remplacer le texte inclus par un libellé déduit de METADATA |
| Pycparser3.11 | BSD-3-Clause | Copyright, conditions, disclaimer ; pas d’endossement |

Sources exactes : `httpx-0.28.1.dist-info/licenses/LICENSE.md`,
`httpcore-1.0.9.dist-info/licenses/LICENSE.md`, `anyio-4.15.1.dist-info/licenses/LICENSE`,
`idna-3.20.dist-info/licenses/LICENSE.md`, `h11-0.16.0.dist-info/licenses/LICENSE.txt`,
`typing_extensions-4.16.0.dist-info/licenses/LICENSE`,
`certifi-2026.10.18.dist-info/licenses/LICENSE`. Le futur packaging doit transporter
les textes des distributions réellement embarquées ; ce document n’est pas une
qualification juridique d’un installer non construit. Même si sa CA d’installation
est explicite, HTTPX importe Certifi : ne pas supprimer sa dépendance du lock.

Les trois nouveaux packages sont examinés à partir des roues exactes Windows
et Mac. Textes supplémentaires :
`cryptography-50.0.2.dist-info/licenses/{LICENSE,LICENSE.APACHE,LICENSE.BSD}`,
`cffi-2.0.0.dist-info/licenses/{LICENSE,AUTHORS}` et
`pycparser-3.11.dist-info/licenses/LICENSE`. Aucun extra SSH/Bcrypt.
METADATA impose `cffi>=2.0.0` pour CPython puis `pycparser` ; les versions et hashes
du lock ferment ces dépendances. Les marqueurs Typing-Extensions de Cryptography
pour Python<3.11 ne s’appliquent pas à ce package Python>=3.12 ; Typing-Extensions
reste néanmoins requis et figé dans la fermeture HTTP existante.

Les [roues officielles Cryptography](https://cryptography.io/en/50.0.2/installation/#static-wheels)
embarquent des bibliothèques natives ; les droits de la seule API Python ne
dispensent pas de reprendre leurs notices dans le futur binaire distribué.
Le [texte de licence amont](https://github.com/pyca/cryptography/blob/50.0.2/LICENSE),
les [licences CFFI](https://github.com/python-cffi/cffi/blob/v2.0.0/LICENSE) et
[Pycparser](https://github.com/eliben/pycparser/blob/release_v3.11/LICENSE) complètent
les textes inclus dans les roues. Aucun wheel, binaire ou fichier clé de fixture
n’est ajouté aux sources du produit par cette tranche.

Python et ses modules standard conservent la licence [PSF et notices](https://docs.python.org/3.12/license.html).
Les API Win32 sont fournies par Windows ; aucune DLL système n’est copiée ici.
Le backend de construction **`setuptools==80.9.0`**, déjà sélectionné, est MIT et
n’est pas une dépendance runtime. Un futur Python gelé/installer devra inventorier
ses propres binaires, OpenSSL et notices. Aucun élargissement des droits Windows
ou des ressources utilisateur n’est déduit de l’API système.

## Tests et runtime

Les tests TLS génèrent leurs seules fixtures fictives avec Cryptography50.0.2,
qui est désormais aussi une dépendance runtime de `client_identity`. Ils utilisent
les parseurs X.509/PKCS8 natifs et le vrai SSL/HTTPX loopback ; les appels Windows
CredMan sont explicitement doublés sur Mac. Les tests portables restent `unittest` ;
pas de nouveau framework global. L’examen des roues et les tests Mac ne prouvent
ni CredMan/ACL Windows, ni le packaging ou les notices d’un installer non construit.

Les ajouts Memlia conservent les droits réservés du LICENSE de ce package. Les
licences permissives des dépendances ne leur accordent aucune licence implicite.
