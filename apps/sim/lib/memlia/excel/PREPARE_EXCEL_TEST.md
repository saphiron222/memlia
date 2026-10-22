<!-- Copyright (c) 2026 Memlia. All rights reserved. -->
# Préparation inactive d’un snapshot Excel

`prepareExcelTestSnapshot` est un port serveur de persistance. Son appelant natif
`prepareExcelTest` impose une session et le droit write, puis dérive sujet et
portée du contexte autorisé. La route dédiée ne transmet que des préconditions
et identifiants d’opération/version ; les paramètres du port ne sont pas un DTO
client ni une preuve d’autorisation. Voir [la frontière HTTP](EXCEL_TEST_PREPARATION_HTTP.md).

Le port copie son entrée avant toute attente, possède sa transaction, verrouille
le brouillon avec le CAS natif, puis relit sa portée, sa révision et le graphe
normalisé dans cette transaction. Le digest attendu couvre le graphe complet.
Il réemploie le matérialiseur canonique ; seuls les champs `request` des blocs
Excel changent. Il persiste une nouvelle version inactive avec son digest final
et `preparationKind: 'excel_test_v1'`. Il ne crée ni opération de déploiement,
ni outbox, ni fence, ni exécution. Un retour positif suit le COMMIT ; un échec
ou une confirmation de COMMIT inconnue rend seulement l’erreur fixe
`excel_test_preparation_refused`, sans relance automatique.

Pour une première procédure, le serveur génère son ID, attribue version 1,
parent null et le sujet autorisé comme auteur. Le brouillon n’impose aucune de
ces valeurs. La constante `memlia_excel_test_admission_v1` désigne uniquement
cette préparation et son refus d’activation : elle ne qualifie ni image,
ni consentement, ni droit d’exécution.

La filiation facultative exige une ancienne version inactive marquée par cette
voie. Son graphe doit correspondre exactement au digest stocké ; chaque procédure
repasse le schéma canonique, son propre digest, la portée organisation/espace/
workflow/bloc, l’identité de déploiement et la politique connue. Les ensembles
de blocs doivent correspondre. L’ID et l’auteur sont conservés, la version
augmente de un et le parent devient la version précédente. Le sujet actuel peut
être un collaborateur autorisé : il n’est pas forcé d’être l’auteur initial.
Une version legacy, un JSON client ou un simple digest ne fournissent pas cette
filiation. Ce port ne prétend pas imposer une seule branche de filiation.

L’idempotence réutilise la table et le helper transactionnels natifs, sous verrou
du workflow, avec une empreinte de l’entrée capturée. Une reprise relit la
version, les digests et la destination, puis rematérialise pour comparer tout le
graphe. Une ligne manquante, déplacée ou altérée ne devient pas une réussite.
La conservation de la clé suit la politique native existante ; aucune garantie
d’idempotence éternelle n’est ajoutée.

La migration 0440 ajoute seulement une colonne nullable et un CHECK : NULL
préserve le legacy ; `excel_test_v1` exige inactive et digest non nul, dont le
format reste contrôlé par 0439. Les voies natives de préparation d’activation,
de reprise et de cutover refusent ce marqueur avant création d’une opération
ou publication. Cette tranche n’offre volontairement aucune promotion vers une
version active. Un rollback de schéma consiste à retirer le CHECK puis la colonne
sur une copie contrôlée ; cela retire aussi la restriction portée par le marqueur
et n’est donc pas une procédure d’activation ni une opération de production.

## Limites de qualification

Les tests ciblés utilisent les contrats, matérialiseur, CAS et idempotence natifs
avec les réponses SQL doublées. Ils ne prouvent pas le COMMIT PostgreSQL, les
verrous réels ou la migration 0440. Une nouvelle base dédiée et une campagne
revue seront nécessaires. La preuve PostgreSQL antérieure de 0439 reste distincte.
La route et l’action de page sont désormais décrites séparément dans
[EXCEL_TEST_PREPARATION_HTTP.md](EXCEL_TEST_PREPARATION_HTTP.md) ; leurs tests
SQL doublés ne requalifient pas cette preuve de persistance. Aucune exécution
de test, image admise, téléchargement, planification ou activation n’est ajoutée.
`QUALIFIED_IMAGES` reste inchangé.
