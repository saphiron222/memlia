# Transmission d'un snapshot inbox

Copyright (c) 2026 Memlia. Tous droits réservés.

`persistInboxSnapshot` et `resumeInboxSnapshot` sont des adaptateurs serveur internes
entre `memlia_excel.ingestion.take_snapshot` et les fichiers workspace natifs Sim.
Ils ne surveillent pas de dossier, n'authentifient pas de requête, n'admettent pas de
job et n'exécutent pas Excel.

L'application doit fournir un **SessionPrincipal actuellement authentifié**, une
liaison autorisée en interne et un identifiant d'occurrence explicite du producteur.
Aucun endpoint n'est fourni ici. Un ordonnanceur ne doit pas fabriquer de session
ou présenter une inbox comme une requête API/schedule. L'autorité pour une inbox
autonome et l'admission durable d'une occurrence restent à raccorder.

## Persistance et reprise

Le snapshot contient exactement `name`, `content` (Buffer) et `sha256` (`sha256:`
suivi de 64 chiffres hexadécimaux minuscules), conformément aux champs du snapshot
Python natif après transmission d'une copie possédée des octets. Il n'existe ici ni
endpoint JSON/base64 d'upload, ni nouveau lecteur de système de fichiers inbox. Le
nom est un basename UTF-8 de 255 octets au maximum, avec extension XLSX ; séparateurs,
ADS, caractères de contrôle et noms réservés Windows sont refusés. Le contenu reste
opaque : cette étape ne valide ni le classeur XLSX, ni ses formules, ni son innocuité.

Les octets doivent être non vides et limités à 10 000 000, comme dans le profil
d'ingestion Python et l'exécuteur de fichiers Excel. Avant son premier await,
l'adaptateur capture une copie du Buffer, la configuration JSON stricte et bornée,
ainsi que le principal, puis vérifie le hash. La preuve de découverte et de
transmission stable appartient à la frontière d'ingestion Python : cette fonction
ne peut pas la reconstituer ou l'authentifier depuis des octets arbitraires.

Le lecteur natif de contexte déployé résout le workflow, le workspace, l'organisation
et l'identifiant de déploiement immuable. Le droit courant de lecture du workflow
est contrôlé nativement. Le sujet de la liaison doit être l'utilisateur du principal
authentifié. L'identifiant et la version de liaison, le digest de procédure, le rôle,
la feuille et le dossier constituent une **configuration interne** ; leur présence
ne suffit pas à en faire des faits autorisés. Aucun registre de liaison ni égalité
entre ce digest et une procédure déployée n'est vérifié ici. L'appelant possède
l'autorisation de cette configuration ; l'exécution ultérieure devra admettre
indépendamment sa procédure complète et son autorité.

La création réutilise `createWorkspaceFileFromBuffer`, avec `exactName: true`, le
type XLSX fixe, `secretProvenance: {status: 'unrecorded'}` explicite et les contrôles
natifs de dossier, d'écriture, de stockage, de comptabilité et d'unicité. Une inbox
externe n'a pas de lignée de secrets Sim enregistrée ; elle ne doit jamais recevoir
la classification vide/exacte par défaut. Cette transmission interne ne demande
aucune notification de changement de fichier.

Le nom stocké est `inbox-<digest d'occurrence>.xlsx`. La clé hash un tuple versionné
fixe : organisation (null explicite compris), workspace, sujet, identifiant/version
de liaison, workflow, déploiement immuable, digest de procédure et occurrence du
producteur. Nom source et hash du contenu restent des champs séparés du reçu. Un
même nom peut ainsi représenter une nouvelle occurrence ; une livraison répétée
d'une occurrence, même avec un contenu différent, rencontre la contrainte native
de nom exact. Un conflit est un refus à réconcilier, jamais une exécution idempotente
réussie. La contrainte porte sur les fichiers actifs d'un workspace/dossier :
archiver, déplacer ou supprimer un fichier peut libérer son nom et ne constitue
**pas** un tombstone métier durable.

Après création, `readWorkspaceFileContent` relit le fileId explicite sous autorité
native, avec la même borne d'octets et la provenance liée à cette version. Workspace,
uploader, dossier, nom généré, type, fileId/key, version de contenu, longueur/hash et
classification unrecorded doivent correspondre. Le mapper workspace natif peut
omettre `storageContext`, dont la valeur implicite documentée est workspace ; les
contextes mothership et les namespaces possédés sont refusés. Une version de contenu
est obligatoire dans le DTO relu, même si le DTO de création l'omet. L'autorité sur
le workflow est recontrôlée après cette relecture.

Alors seulement, l'adaptateur retourne `status: 'verified'`, un reçu sérialisable et
`sources[role] = {fileId, sheetName}`, conforme à la sélection native attendue par
`executeExcelFile`. `durableOccurrenceAdmitted` et `executionAvailable` restent
toujours false. Le reçu est une métadonnée : il ne vaut ni capacité, ni approbation,
ni qualification de procédure.

L'application doit persister ce reçu dans une transaction native appropriée avant
de compter sur une reprise après redémarrage. Ce module **ne persiste pas le reçu**
et n'introduit pas de registre volatile. `resumeInboxSnapshot` exige un reçu sauvegardé
explicite, le capture, compare la configuration complète et sa clé, réautorise puis
relit exactement le fileId/version/hash/provenance attendu. Il ne recherche jamais
par nom source ou généré et ne relit aucun chemin source. Une référence absente,
révoquée, modifiée ou incertaine reste refusée. Ces contrôles fonctionnent aussi dans
une nouvelle instance du module : le reçu sauvegardé ne dépend pas de sa mémoire.

## États partiels et incertains

Toutes les erreurs sont des projections fermées ; aucun message de driver, cause,
chemin ou octet n'est retourné. `before_creation` signifie qu'aucun appel de création
n'a été effectué. `creation_unknown` signifie que l'appel natif a été entamé sans
résultat correspondant vérifié ; même un conflit natif reconnu reste un refus, sans
présumer une copie existante. `created_unverified` conserve un fileId correspondant
retourné, sans exposer de reçu vérifié. `resume_unverified` ne fournit aucune nouvelle
métadonnée vérifiée. Il n'y a ni retry automatique, ni remplacement, ni suppression,
ni déplacement en quarantaine. Une annulation après écriture n'annule pas cette
écriture. L'appelant doit réconcilier les créations partielles/incertaines avant
toute nouvelle tentative ; un crash avant persistance du reçu n'est pas résolu ici.

## Couverture et composition restante

Les tests unitaires utilisent le hashing, la capture JSON stricte, les schémas natifs
et la logique d'adaptateur réels. Lecteurs canoniques, permissions et infrastructure
de fichiers workspace sont explicitement doublés. La fixture de conflit représente
le refus natif d'unicité ; elle ne qualifie ni cette contrainte en DB, ni un commit de
stockage. Les tests couvrent livraison répétée, même nom/contenu ou occurrence
nouveaux, capture avant await, références malformées, refus de périmètre/droits,
changement d'identité/version/hash/provenance, annulation tardive et reprise depuis
un reçu sérialisé après redémarrage du module.

PostgreSQL, montages inbox locaux/SMB, livraisons entre processus, vrai upload/readback,
admission de trigger/job et exécution Excel Linux sont NON TESTÉS par cette suite.
Une future transaction d'occurrence native, l'autorité locale sur le dossier et la
composition des jobs/outbox/workers existants devront être revues avant exécution
autonome. Aucun nouvel ordonnanceur, queue, migration partagée ou image qualifiée
n'est fourni ici ; `QUALIFIED_IMAGES` reste inchangé.
