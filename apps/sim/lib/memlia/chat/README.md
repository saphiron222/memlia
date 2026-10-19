# Chat local : composants raccordés, activation encore absente

Le Chat conserve le lifecycle, les événements SSE, le stockage des messages,
les cartes et les permissions natifs Sim. L’option **serveur** `localChat` de
`createSSEStream` / `runCopilotLifecycle` est absente par défaut. Cette tranche
ne fournit aucun champ HTTP permettant de l’activer, aucune clé et aucune
sélection implicite de budget. Sans cette option, le parcours existant reste
inchangé.

## Parcours local

`runBudgetedCatalogProvider` compose les boucles providers existantes avec la
réservation physique COMMIT avant chaque transport OpenAI, l’observation de son
usage et le règlement natif. Le profil tarifaire est explicitement une
**estimation au tarif catalogue**, pas une facture fournisseur. Un coût absent,
malformé ou incertain conserve la réserve ; une annulation n’efface pas une
dépense connue. Anthropic possède un binding borné mais son usage n’est pas
raccordé à ce profil budgétaire local.

Les outils catalogue, lecture de workflow et preview utilisent leurs schémas et
autorisations natifs. Le serveur choisit le workflow et les capacités. Les
arguments modèle ne portent ni principal, ni session, ni résultat d’application.
Le nouvel outil `propose_workflow_operations` reçoit le corps v2 avec la révision
observée ; le port proposition contrôle la révision serveur, le dry-run et les
permissions, persiste l’enveloppe puis la relit. Le callback serveur publie
seulement alors l’identifiant de la proposition via les handlers natifs.

La carte réservée `memlia_apply_workflow_proposal` n’est jamais `inbandOwned`.
Elle attend une décision unitaire liée au digest affiché, suivie du contrôle
courant des droits et du CAS natif. Le corps exact est consulté par le GET
session authentifié de la carte ; il n’est pas diffusé dans les événements SSE.
Les lectures catalogue déjà exécutées utilisent uniquement la présentation
native en bande, sans deuxième dispatch. Aucun workflow n’est exécuté ou déployé
par ce parcours.

Le callback distingue une application attestée d’un refus, d’un résultat inconnu
et d’un simple succès du transport de la porte. Après un effet incertain, aucune
synthèse ni répétition locale n’est lancée. Une fin SSE réussie exige la fin
finale réelle du provider ; EOF seul ne suffit pas.

## Bornes et portée

`runModelAdapter` conserve les plafonds de 12 appels physiques, 40 outils et
180 secondes ; l’appelant peut les réduire. Le délai reste actif pendant
l’attente humaine. La validité de dix minutes de l’enveloppe liée au digest
n’accorde pas dix minutes supplémentaires au run. Ni compteur d’appels ni texte
modèle ne servent de preuve de coût ou d’application.

Le profil actuel exige une session humaine, un chat interactif et un workflow
lié à un workspace. Un chat au niveau organisation sans workflow est refusé.
Dans le POST natif, `run.organizationId` désigne ce dernier périmètre ; il ne
représente pas l’organisation d’un workspace partagé. Le port proposition lie
séparément l’organisation canonique du workspace à son enveloppe. La composition
simulée ne qualifie pas les autorisations collaboratives de bout en bout.

La branche locale n’appelle ni worker ni génération distante du titre. Son
admission interne enregistre atomiquement avec le message un marqueur versionné
`requestContext.localExecution` sans clé ni callback. Elle ne persiste pas de
configuration de reprise worker. Un marqueur présent mais invalide, une
configuration contradictoire ou une tentative de démarrage sans options locales
sont refusés ; l’absence de marqueur conserve le comportement historique.

Le reconnect autorisé peut relire le run et son buffer, sans reprendre son
calcul, réserver de nouveau budget ou contacter un worker. Les scans natifs de
reprise automatique ne sélectionnent pas ces runs sans configuration worker.
Stop reste durable et conserve les droits natifs ; il signale le contrôleur
local et ferme l’admission. Un contrôleur absent ou un état inconnu ne produit
pas une confirmation de règlement. Même un contrôleur arrêté ne prouve pas
qu’un effet déjà commencé a été annulé. Le marqueur est transmis avant la
suppression du run aux routines de nettoyage. Le steering local est refusé
avant tout contact worker ou ajout de message. Aucune reprise de calcul,
rebase automatique ou garantie d’exécution exactement une fois n’est fournie.

## Vérifications et limites

Les tests locaux composent lifecycle, handlers, porte de permission, writer SSE,
ModelAdapter et boucles SDK natives. Les tests de persistance du marqueur et de
contrôle réutilisent les use cases avec doubles SQL, autorisations et réseau
explicitement identifiés ; ils ne qualifient pas PostgreSQL ou un redémarrage
réel du serveur. HTTP, persistance, attribution et frontière
COMMIT sont des doublures explicitement identifiées dans ces tests. Les recettes
PostgreSQL des ports restent distinctes et ne deviennent pas une recette HTTP
ou navigateur par composition. Aucun fournisseur réel, écran, coût facturé,
recovery complet, Linux ou Windows n’est qualifié par cette tranche.

Avant activation HTTP, il reste à raccorder l’admission session et les permissions
courantes aux messages autorisés, à une policy administrateur, à une fenêtre et
un profil tarifaire explicites, puis à la clé native et à la destination permise.
Pièces jointes, messages riches, desktop et autres providers restent hors profil.
La revue indépendante, les contrôles globaux et les évaluations réelles P05/P06
restent requis ; ce README ne déclare pas le Chat complet.

La route de relecture conserve le buffer natif et les états terminaux persistés. Une
relecture qui exige le journal worker (`source=log` ou trou de buffer) échoue en
503 pour le moteur local ; un marqueur présent inconnu refuse également la
relecture. Le balayage des runs abandonnés exclut toute présence de
`localExecution`, même NULL ou contradictoire avec une recovery worker, avant la
reprise et le Stop distant. Les nouveaux cas de ce balayage sont préparés dans
la suite d'intégration native PostgreSQL/Redis ; ils ne sont pas qualifiés par
les tests unitaires de cette tranche.
