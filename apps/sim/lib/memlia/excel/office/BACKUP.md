# Copie Office privée — persistance serveur

`persistOfficeCompressedCopy` reçoit une session **déjà authentifiée** et des
octets bornés (1 à 10 000 000), avec `copyVersion: 1`. Cette version est celle du
format de l'adaptateur de copie, jamais une révision du classeur. L'identité de
session, l'espace et les octets sont capturés avant le premier `await`. Le code
ne charge pas Office.js et ne lit aucun classeur lui-même.

La création et la relecture utilisent les use cases natifs dédiés
`createPrivateOfficeBackup` / `readPrivateOfficeBackup` : session uniquement,
créateur humain exact **et** accès courant à l'espace (`files.create` ou
`files.read_content`). Aucun ID utilisateur reçu dans le corps n'accorde de droit.
Les clés d'espace, délégations et autres types de Principal sont refusés.

La catégorie canonique `office-backup` reste hors VFS, listes, copies de
workspace, index, partage et mutations génériques. Le stockage est celui de Sim,
avec une clé serveur réservée
`workspace/<workspaceId>/office-backups/<serverFileId>.xlsx` et écriture native
`createOnly`. Le garde des routes de fichiers refuse aussi cet emplacement avant
les fallbacks, même sans ligne canonique : les objets pré-COMMIT/orphelins ne
deviennent pas lisibles par métadonnées de stockage. Aucun autre stockage ni
table de sauvegardes n'est créé.

Une création réutilise staging, transaction et comptabilité natives. La version
est `workspace_files.content_updated_at` en millisecondes. Une relecture privée
revalide le propriétaire, l'espace et cette version, puis réautorise après le
chargement des bytes. L'adaptateur confirme seulement si ID/clé/version/taille
et SHA-256 correspondent à la copie capturée. Le reçu n'expose pas de clé de
stockage ni de nom de fichier fourni par le collaborateur.

La réautorisation après staging précède immédiatement l'ouverture de la
transaction d'insertion/comptabilité : elle ne fait pas de requête sur le pool
global depuis un callback transactionnel. Il s'agit d'un recheck applicatif ;
aucune atomicité contre une révocation concurrente n'est revendiquée. Un refus à
cet endroit conserve l'objet privé avec une issue non confirmée.

Les issues restent distinctes :

- `refused/before_creation` : refus d'admission ou annulation avant création ;
- `unconfirmed/creation_unknown` : stockage/COMMIT non confirmé, identité serveur
  fournie lorsqu'elle est connue ;
- `unconfirmed/created_unverified` : création terminée, mais relecture refusée,
  annulée ou différente ;
- `stored` : reçu de stockage après relecture exacte.

Une annulation après un effet possible n'affirme jamais que rien n'a été créé.
Aucun retry, suppression compensatoire ou promotion vers les fichiers partagés
n'est ajouté. Les objets privés non confirmés sont conservés pour rapprochement
explicite ; ce rapprochement et leur rétention administrée restent à raccorder.

Le reçu atteste des bytes relus au moment du contrôle. Il ne qualifie pas la
durabilité après panne de l'infrastructure, la restauration d'un XLSX, un
`WorkbookSnapshot`, la cohérence du classeur toujours ouvert, le consentement,
une approbation ou le droit d'appliquer un PatchSet. Aucun parseur XLSX ni moteur
de calcul n'est ajouté. L'autorisation/relecture est un contrôle applicatif,
pas une transaction atomique contre l'utilisateur Excel ou un administrateur du
stockage.

Les tests unitaires identifient explicitement leurs doubles DB/stockage. Une
intégration PostgreSQL/stockage puis un trajet Office réel restent distincts des
tests portables ; ce document n'annonce pas leur réussite.

## Transport HTTP dans Sim

`POST /api/workspaces/[id]/excel/office-backups` réemploie la session Sim,
ses permissions, son rate limit et son parseur borné. Il refuse les requêtes
cross-site et les champs d'autorité dans le corps ; la réponse est `private,
no-store`. `copyVersion: 1` et `contentBase64` sont les seuls champs admis.

Ce transport JSON est limité à **7 500 000 octets décodés**, afin que base64 et
JSON restent sous le proxy natif de 10 Mio. Le profil SDK et le stockage privé
acceptent jusqu'à 10 000 000 octets ; cela ne relève pas la limite HTTP.
Une copie plus grande est refusée avant création. Aucun plafond global du
proxy n'est modifié. Un statut HTTP 200 exige encore de lire `status` : seul
`stored` porte un reçu vérifié, `unconfirmed` exige un rapprochement sans relance.
