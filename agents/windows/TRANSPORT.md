# Canal HTTPS de préparation P07-T1

La primitive `PreparationChannel` T1 authentifie le serveur ; le wrapper T2 décrit
plus bas lui ajoute une identité cliente locale explicite. T1 ne fournit ni enrôlement,
identité cliente mTLS, polling, heartbeat, réception de commandes, exécuteur, capture,
Excel, consentement ou autorité d’agent. Il ne contacte
aucun endpoint au chargement et ne définit aucune route serveur Memlia.

## Contrat Python et autorité

```python
from memlia_agent.transport import PreparationChannel

# Valeurs venant d’une configuration d’installation approuvée, jamais d’une
# commande, d’un modèle ou d’une réponse HTTP. CA publique de cette installation.
async with PreparationChannel(
    origin='https://cabinet.example',
    ca_pem=ca_publique_installee,
    max_response_bytes=65536,
    total_timeout_seconds=5,
    max_connections=1,
) as channel:
    contenu = await channel.get_json('/chemin-de-preparation-defini-par-le-caller')
```

Le chemin illustré n’est pas une route produit. L’appelant de confiance fixe la
destination et le chemin technique autorisé. Cette API n’accepte aucun header,
`Host`, cookie, secret/query, URL absolue, proxy, méthode de mutation ou option TLS
par appel. Il n’existe pas de client HTTPX public ou de méthode d’envoi générique.
Les attributs Python privés ne sont pas une frontière contre le code hostile
exécuté sous le même utilisateur : aucun isolement de ce compte n’est promis.

L’origine doit être ASCII HTTPS canonique, hôte DNS minuscule sans point terminal
ou adresse IPv6 canonique entre crochets, port explicite1–65535 ou port TLS par
défaut. Un slash racine final est accepté puis retiré. Aucun identifiant intégré,
query, fragment, caractère de contrôle, backslash, `%` ou chemin de base. Le chemin
commence par `/`, comprend des segments ASCII de1–128caractères commençant par
alphanumérique/underscore, puis alphanumérique/underscore/tiret/point ; pas de
segment vide, point seul, `..`, escape `%`, query, fragment ou slash final.
Longueur origine/chemin≤2048caractères. Les destinations privées du cabinet ne
sont pas interdites par une règle SSRF publique ; c’est la configuration approuvée,
le FQDN et la CA explicite qui définissent le destinataire. Ce module ne décide pas
qu’un endpoint fourni par un client est approuvé.

## TLS et réseau réellement imposés par T1

- Contexte `ssl.SSLContext(PROTOCOL_TLS_CLIENT)` possédé par le canal, CA explicite
  en mémoire (`bytes` PEM ASCII1–262144octets), `CERT_REQUIRED`, hostname activé,
  TLS≥1.2. Pas de `create_default_context`, certificat client, CA système, magasin
  personnel, clé privée ou keylog ; `SSLKEYLOGFILE` n’est pas utilisé.
- HTTPX0.28.1/HTTPcore1.0.9 natifs, `trust_env=False`, proxy absent, retries0,
  HTTP/1.1, HTTP/2 désactivé. Pas de lecture de configuration proxy système.
- Redirections désactivées **et** toute réponse3xx refusée sans second envoi.
  Aucun repli HTTP, retry d’authentification ou autre destination.
- GET et headers techniques fixes `Accept: application/json` et
  `Accept-Encoding: identity`. CookieJar refuse leur stockage ; chaque requête
  est construite explicitement sans merge de cookies/headers/auth/params client.
- Réponse200 et type `application/json` requis ; Content-Encoding absent ou
  `identity` seulement. Pas de décompression. Corps lu par streaming brut avant
  décodage UTF-8/JSON natif ; doublons de clés, nombres non finis, overflow flottant,
  JSON invalide ou profondeur refusée par le décodeur ne deviennent pas un succès.
  Le résultat n’est **pas** un contrat métier validé : le futur caller doit utiliser
  `memlia_contracts.validate` et les contrôles d’autorité/références/TTL canoniques.

Limites obligatoires, sans valeur implicite : corps1–1048576octets,
connexions simultanées1–4, durée absolue finie strictement positive≤30secondes.
Ce sont les plafonds techniques de préparation ; ils n’augmentent aucune borne de
commande. La durée englobe attente du pool, connexion, handshake, lecture et
livraison, via `asyncio.timeout_at` ; un contrôle après **fermeture de la réponse** et un point
d’annulation précèdent la livraison (y compris si cette fermeture a pris du temps
synchrone). Les sections synchrones (notamment imports paresseux HTTPX/AnyIO lors du premier
appel, construction TLS et JSON borné) ne peuvent pas être préemptées par asyncio :
la durée murale peut dépasser l’échéance avant le refus ; aucun plafond de latence
murale n’est garanti. Le code empêche la livraison d’un JSON après échéance, pas
l’occupation du thread interpréteur pendant une initialisation synchrone. Les en-têtes/protocoles ont en
outre les bornes des parseurs HTTPX/HTTPcore/H11 ; ce module ne réécrit pas HTTP.

`asyncio.CancelledError` se propage. Une réponse possédée se ferme dans `finally` ;
`aclose()`/le context manager ferment le pool. Un échec de fermeture de réponse ou de pool est un refus `close_failed`,
laisse la fermeture non qualifiée et interdit la réutilisation ; il ne devient pas
un reçu de cleanup réussi. Si le corps était déjà annulé, son `CancelledError`
reste prioritaire même si la fermeture échoue ; le canal devient inutilisable et
le caller reste responsable de fermer le pool. Une annulation pendant fermeture
se propage également et interdit la réutilisation. Une erreur native non classée
(par exemple pendant la fermeture automatique du stream HTTPX) reste un refus
opaque `transport_failed` sans cause/contexte et rend le canal inutilisable. Un canal est utilisé dans une même
boucle asyncio, sans mutation de configuration. Le caller reste responsable de la
vie des tâches qu’il a créées et de leur annulation avant la fermeture du canal.
Aucune annulation n’est présentée comme une rétraction d’un effet serveur.

## Erreurs et données

`TransportError.code`/`str(error)` ne contiennent que des codes fixes :
`invalid_origin`, `invalid_path`, `invalid_limits`, `invalid_ca`, `channel_closed`,
`tls_failed`, `connection_failed`, `request_timeout`, `redirect_refused`,
`http_status_refused`, `compression_refused`, `content_type_refused`,
`response_too_large`, `invalid_json`, `transport_failed`, `close_failed`.

Aucun corps, statut détaillé, message HTTPX/SSL, cause ou contexte de décodeur
n’est attaché aux refus réseau/JSON publics. Ne jamais sérialiser frames/variables
locales, qui contiennent forcément la requête et sa réponse. Le module ne configure
ni ne produit de journal applicatif. HTTPX peut journaliser une URL technique si
le caller configure son logger : aucun secret ne doit entrer dans un chemin, et
le futur hôte agent doit définir sa politique de logs. Aucun effacement universel
des copies JSON/Python ou des buffers TLS, swap et crash dumps n’est revendiqué.

La validation de chaîne/nom/expiration ne constitue pas une politique de révocation
rapide : aucune CRL/OCSP ou association serveur n’est qualifiée ici. La configuration
de confiance doit être remplacée par création d’un nouveau canal, pas par mutation
d’un contexte déjà utilisé.

## Tests et limites

Le test `tests/test_transport.py` utilise le vrai SSL Python, HTTPX, HTTPcore et des
sockets **loopback** possédées, avec certificats/CA fictifs créés à l’exécution par
Cryptography50.0.2. Les seules clés de fixtures écrites sont des PKCS8 **chiffrées**,
dans un répertoire temporaire supprimé par la suite. Aucun certificat privé n’est
committé, aucune confiance globale/CertStore/CredMan n’est lue ou modifiée. Les
certificats attendus, étrangers, expirés et de mauvais nom sont vraiment négociés ;
les réponses HTTP adversariales viennent d’une fixture contrôlée et non du serveur
Memlia. Les tests ne prouvent pas le mTLS ou l’enrôlement.

Depuis `agents/windows`, dans un environnement isolé avec la fermeture runtime du
lock, comprenant maintenant Cryptography50.0.2 pour le runtime T2 :

```sh
PYTHONPATH=src python -m unittest discover -s tests -p 'test_*.py' -v
```

Le test chronométrique du flux lent préchauffe par l’API publique un canal et un
serveur TLS fictifs distincts, avec échéance2s, puis les ferme. Son canal mesuré
conserve deadline0,12s et tolérance0,65s : qualification réseau **à chaud** seulement.
Un témoin séparé vérifie le refus d’un résultat tardif au premier appel de la suite,
après imports/préparation des fixtures ; ce n’est pas un démarrage d’interpréteur à
froid mesuré. L’essai Windows historique17tests/1échec (0,921s contre0,65s au premier
appel) et le rejeu19tests/1erreur de warmup sont conservés. Le changement de fixture
ne corrige ni ne requalifie leur latence initiale ; sa cause fine n’est pas prouvée.

Les profils réellement exécutés et leurs reçus sont consignés dans le rapport P07
privé de la campagne ; ils ne qualifient ni installer commercial, ni session GUI,
ni capture/Excel. Ce test ne nécessite pas la console Windows interactive puisque
son TLS et ses fichiers de fixtures ne touchent pas le bureau.

La tranche P07-T2 ci-dessous compose maintenant l’identité TLS cliente avec HTTPX,
PKCS8 chiffré et secret court CredMan. Elle n’implémente toujours aucune
persistance/rotation/PKI. `SSLContext.load_cert_chain` attend
des fichiers : ne jamais écrire un PEM privé clair depuis CredMan pour contourner
cette limite. Le choix ne change pas les limites des modules CurrentUser existants.


## Identité cliente locale P07-T2

`MutualTLSChannel` est un wrapper strict de ce même transport. Il exige une
`ClientIdentity` et ne remplace jamais un échec par un canal T1 sans identité.
`PreparationChannel` appelé sans option conserve son comportement serveur-only.
Aucune route d’enrôlement, commande, UI, PKI, rotation ou serveur de certificats
n’est ajouté. Un certificat de chaîne valide n’est pas à lui seul une association
à un utilisateur/poste autorisé : cette liaison serveur reste manquante.

```python
from memlia_agent.client_identity import ClientIdentity
from memlia_agent.transport import MutualTLSChannel

# Configuration d’installation interne approuvée, jamais arguments d’un modèle.
identity = ClientIdentity(
    instance_id=installation_id,
    agent_id=agent_id,
    certificate_chain_pem=chaine_publique_pem,
    encrypted_pkcs8_pem=cle_pkcs8_chiffree_pem,
)
async with MutualTLSChannel(
    origin=origine_cabinet,
    ca_pem=ca_publique_cabinet,
    max_response_bytes=65536,
    total_timeout_seconds=5,
    max_connections=1,
    client_identity=identity,
) as channel:
    resultat = await channel.get_json('/chemin-technique-fixe-du-caller')
```

Il n’y a aucun nouveau chemin HTTP produit dans cet exemple. Le constructeur
accepte exclusivement des `bytes` immuables, bornés à256Kio pour la chaîne publique
et256Kio pour la clé chiffrée. Aucun filepath original, callback libre, cible
Credential Manager arbitraire ou option réseau n’entre dans l’identité. Les IDs
sont ceux validés par `CurrentUserCredentialStore` (1–128 caractères ASCII), avec
son namespace exact et sa protection DPAPI CurrentUser existante. Les champs de
l’identité sont masqués dans repr ; ils ne doivent pas être sérialisés en logs.

Les enveloppes PEM acceptées sont une chaîne de1–32 blocs CERTIFICATE uniquement
et un bloc ENCRYPTED PRIVATE KEY (PKCS8) unique, sans contenu supplémentaire.
Les labels ne sont pas considérés comme preuve : le parseur X.509 de Cryptography
doit accepter toute la chaîne et `load_pem_private_key(..., password=None)` doit
reconnaître une structure chiffrée. Une clé claire ré-étiquetée, un DER privé
présenté comme certificat ou des blocs privés ajoutés sont refusés **avant lecture
du secret ou écriture temporaire**. Cette première reconnaissance ne prouve pas
que le ciphertext est déchiffrable : avant tout fichier, le seul credential
instance/agent est lu et le même parseur natif doit réellement déchiffrer et valider
la clé avec ce `bytearray`. Aucun appel `private_bytes`, réencodage clair ou parseur
ASN.1 local. Un secret absent/erroné, un payload chiffré corrompu ou un échec natif
refusent le canal avant création du répertoire temporaire.

Le contexte strict appartient toujours au transport. Avant toute création du
clientHTTPX, l’identité écrit uniquement ces octets capturés (certificats publics
et clé chiffrée) dans deux fichiers `mkstemp` exclusifs/non héritables, sous un
répertoire temporaire possédé. Aucun PEM privé clair n’est écrit. Le callback
`SSLContext.load_cert_chain` réutilise directement le même `bytearray` déjà lu et
validé, sans seconde lecture du store. OpenSSL vérifie ensuite l’appariement
certificat/clé. Le buffer est écrasé dans finally, y compris après
échec, interruption ou refus du déchiffrement préalable. Les copies natives
Cryptography/OpenSSL/CPython ne sont pas garanties
effaçables. Le contexteSSL peut conserver la clé déchiffrée en mémoire tant qu’il
est référencé ; `aclose()` ne promet pas l’effacement de cette mémoire native. Les fichiers temporaires sont supprimés avant la constructionHTTPX ;
un échec de cleanup refuse le canal et ne devient pas une preuve de suppression.
L’interruption BaseException reste prioritaire après tentative de cleanup.

Les refus de `ClientIdentityError.code` sont fixes : `invalid_client_identity`,
`invalid_identity_context`, `identity_load_failed`, `identity_cleanup_failed`.
Le wrapper rend `TransportError('client_identity_required')` pour une identité
absente/incompatible et `client_identity_failed` pour un chargement/cleanup en
échec ; aucun message de credential, chemin, cause ou contexte natif n’est transmis.
Aucun prompt de mot de passe OpenSSL : le callback est toujours fourni. Ne pas
journaliser les frames ou variables locales.

Toutes les restrictions T1 restent effectives : CA serveur explicite, hostname,
TLS≥1.2, pas de proxy/env/redirect/retry/cookie/auth libre ou client brut. La clé
cliente n’est présentée que lors du TLS de l’origine fixe ; un3xx ne déclenche
aucun second échange. L’identité est chargée synchroniquement avant les appels
GET et leur échéance coopérative : cette étape n’est pas préemptée ou bornée en
latence/CPU par asyncio. Une configuration de clé approuvée et le futur processus
isolé avec contrôle externe des ressources restent indispensables.

Les tests Mac utilisent de vrais SSL/HTTPX/serveursTLSloopback exigeant un
certificat client, certificats/CA/clés fictifs générés en mémoire et seules clés
**chiffrées** écrites dans les fixtures. La lecture CredMan est explicitement
doublée sur Mac ; ils ne qualifient pas DPAPI/CredMan Windows ni ses ACL temporaires.
Les modes POSIX0700/0600 observés ne sont pas une preuve d’ACL Windows. Aucun CertStore
ou trustglobal n’est modifié. Stockage persistant du PKCS8 chiffré, installateur,
ACL/reparse points Windows, sauvegarde, rotation/révocation, attestation poste,
binding serveur device/utilisateur/session et qualification Windows de cette
composition restent **NON QUALIFIÉS** ; aucun confinement contre le compte courant
compromis n’est annoncé.

Références primaires : [Python SSLContext.load_cert_chain](https://docs.python.org/3.12/library/ssl.html#ssl.SSLContext.load_cert_chain),
[tempfile.mkstemp/mkdtemp](https://docs.python.org/3.12/library/tempfile.html#tempfile.mkstemp),
[Cryptography load_pem_private_key](https://cryptography.io/en/50.0.2/hazmat/primitives/asymmetric/serialization/)
et [lecture X.509](https://cryptography.io/en/50.0.2/x509/reference/#cryptography.x509.load_pem_x509_certificates).
Cryptography50.0.2 est maintenant requise au runtime T2 ; fermeture et licences
décrites dans `DEPENDENCIES.md`, versions et hashes dans `requirements.lock`.
