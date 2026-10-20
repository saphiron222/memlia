<!-- Copyright (c) 2026 Memlia. All rights reserved. -->
# Préparer une version Excel depuis une session

La page « Automatiser Excel » propose une observation explicite de la version
enregistrée d’un workflow, puis une préparation explicite d’une
nouvelle version inactive. Le reçu signifie « préparée pour test » ; il ne
signifie ni procédure validée, ni fichier exécuté, ni automatisation activée.
Le catalogue natif fournit les workflows autorisés. La présence d’un workflow
n’est pas une attestation de validité de sa procédure Excel.

## Frontière native

`GET` et `POST /api/workflows/[id]/excel/test-preparations` réemploient
`defineInternalJsonRoute`, `internalSessionAuth`, le rate limit utilisateur et
l’opération `workflows.excel.prepare_test` : session seulement, rôle write,
aucune délégation ou clé API. Le contrôle d’origine natif s’applique avant
lecture du corps, qui reste borné à 8 Kio. Réponses et erreurs sont no-store.
La query `workspaceId`, fermée et non répétable, est une assertion de destination,
jamais une autorité. Sujet, organisation et espace proviennent du contexte natif.

Le GET ouvre une transaction REPEATABLE READ en lecture seule. Dans cette même
vue il vérifie le workflow non archivé, son espace et son organisation, puis
charge la révision et le graphe brut avec les variables non estampillées. Le
hash réemploie exactement la projection normalisée du port de préparation.
La garde native des types de blocs s’applique en interne. La réponse contient
uniquement workflowId, workspaceId, expectedRevision et expectedStateDigest ;
aucun graphe ni type de bloc n’est livré.

Le POST capture strictement son entrée avant attente, refait l’autorisation et
l’observation, puis compare les valeurs reçues. Il ne remplace jamais le CAS
par une révision ou un hash plus récent. `prepareExcelTestSnapshot` refait son
verrou, CAS, relecture et contrôle de portée natifs avant COMMIT. La garde des
blocs s’appuie sur le même graphe attendu ; une modification entre observation
et écriture est refusée par le port. Un GET réussi n’accorde aucun droit au POST.
Le corps accepte seulement expectedRevision, expectedStateDigest, operationId
et previousTestVersionId facultatif. Aucune identité, politique, procédure,
autorité ou activation client n’est acceptée.

## Interaction, interruption et limites

Aucun GET ou POST n’est lancé automatiquement au montage. Les deux étapes sont
explicites. Le POST garde la révision, le digest et l’opération capturés même
si la réponse est perdue. Dans la vue courante, « Vérifier cette préparation »
réémet manuellement cette même opération avec ces mêmes préconditions ; il ne
promet pas une réussite après modification du brouillon. Ni le client HTTP ni
l’action ne réessaient automatiquement. Une annulation n’atteste pas un rollback.
Une révocation annule le transport possédé et interdit une réponse tardive ;
la même tentative incertaine est conservée jusqu’à une reprise autorisée.

L’état en mémoire est complété par une reprise dédiée dans `sessionStorage`, par
sujet, espace et workflow. Avant le premier POST, une enveloppe versionnée et
fermée conserve uniquement cette portée et le corps natif validé (révision,
digest, opération et éventuelle version précédente). Elle est bornée à 4 Kio
UTF-8 avant décodage JSON ; ni graphe, secret, fichier, reçu ni autorisation ne
sont conservés. Ce stockage ne donne aucun droit : le serveur refait les mêmes
contrôles et le même CAS. Les clés emploient un tuple JSON sans collision de
délimiteurs. Aucun store générique ou historique serveur n’est ajouté.

Après rechargement dans le même onglet, choisir le même workflow restaure une
incertitude, jamais une réussite. « Vérifier cette préparation » renvoie
manuellement le même operationId et les mêmes préconditions, sans GET préalable,
nouvel ID, rebase ni supposition de rollback. Une fermeture de l’onglet, un
nettoyage du stockage ou une politique du navigateur peuvent perdre cette
reprise ; cette tranche ne garantit aucune conservation après fermeture.
Certains navigateurs copient sessionStorage lors d’une duplication d’onglet :
cela ne déclenche aucun envoi et n’accorde aucun pouvoir supplémentaire.

Une écriture ou sa relecture refusée interdit le POST. Une entrée invalide,
inaccessible, étrangère ou remplacée bloque la reprise locale sans révéler son
contenu ni l’effacer. Une nouvelle tentative ne remplace jamais une entrée
existante. La comparaison, l’écriture et la relecture sont synchrones avant le
transport ; une reprise doit retrouver les octets exacts de son entrée. Si la
lecture après écriture échoue, l’entrée peut déjà exister : le message demande
une réparation du stockage ou un rechargement, sans nouvel envoi automatique.

Un reçu validé par le contrat natif, reçu sur la requête encore vivante et pour
le workflow capturé, autorise seulement le retrait de l’entrée exacte possédée.
Une entrée concurrente plus récente reste intacte. Si ce retrait échoue ou ne
peut être confirmé, la vue bloque toute nouvelle préparation et ne présente pas
une clôture locale réussie ; le serveur peut pourtant avoir déjà commité.
Une révocation, un démontage, un conflit ou une réponse invalide/tardive conservent
la reprise. Le changement de sujet, d’espace ou de workflow ne réutilise pas
l’opération précédente. Une réponse tardive d’un ancien composant ne peut pas
retirer l’entrée récupérée par le nouveau.

Après un reçu validé et un retrait confirmé, la poursuite dans la vue courante
peut reprendre son deploymentVersionId pour la filiation. Cette référence de
reçu reste en mémoire seulement ; le serveur revalide intégralement cette lignée.
Aucun ID de lignée n’est pris dans une URL ou un champ libre, ni aucune opération
certifiée récupérée automatiquement après rechargement.

Les tests de cette tranche composent les contrats, le funnel session/write,
la garde des blocs, la route, le client et le DOM React natifs. Session,
rate limit, résolution DB et SQL sont doublés suivant les suites ; les tests
UI doublent HTTP et permissions. La reprise compose React, le client HTTP,
les schémas natifs et le Web Storage de jsdom (les refus d’accès sont injectés
à cette frontière), sans navigateur réel. Ils ne constituent ni preuve PostgreSQL de
REPEATABLE READ, ni navigation navigateur réelle. La preuve historique native de l’accord observation/port a fermé trois cas
PostgreSQL sur la source de6f4109d272d8f34e56e2233674ae4b02735b38, dans
`engineering/p11-excel-test-observation-native/`. Elle n’est pas un rejeu de cette
modification client et conserve sa source et ses reçus propres.
Les treize cas PG du port 0440 conservent leur source et leurs reçus distincts.
Aucun outbox, opération de déploiement, fence, exécution, image admise, fichier
transformé, téléchargement, planning ou nouveau moteur n’est ajouté.
