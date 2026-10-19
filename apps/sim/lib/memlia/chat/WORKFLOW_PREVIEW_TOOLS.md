<!-- Copyright (c) 2026 Memlia. All rights reserved. -->

# Prévisualisation des opérations de workflow

`createWorkflowPreviewTools` prépare un outil interne `preview_workflow_operations`.
Il appelle le cas d’usage natif `applyWorkflowOperations.execute` avec `dryRun: true`.
Le binding serveur `runCatalogProvider` peut désormais le raccorder aux boucles
OpenAI/Anthropic existantes avec l’option explicite
`workflow: { workflowId, policy: 'sanitized_details', previewOperations: true }`.
Sans cette option, aucun outil preview n’est annoncé. Aucune route ni exécution
de Chat n’est activée ; la politique d’envoi P06 reste une condition bloquante.
Il ne persiste ni graphe, ni proposition, ni attestation d’application.

## Entrée et autorité

Le serveur fournit le principal déjà authentifié, le workspace et le workflow
sélectionnés. La fabrique en prend une copie avant toute attente ; les arguments du
modèle ne peuvent fournir ni principal, ni périmètre alternatif, ni graphe de base.
Cette copie ne prouve pas l’authenticité du principal. Le futur raccordement serveur
devra établir sa provenance et conserver les contrôles de session/délégation.

Le schéma exporté est **exactement** `v2ApplyWorkflowOperationsBodySchema` :
`expectedRevision` obligatoire, opérations natives, mode atomique, disposition et
changements d’activation facultatifs. Un champ `dryRun`, un `baseGraph` ou un champ
supplémentaire dans le corps est refusé. Aucun paramètre ne permet un véritable apply.

La capture JSON précède le premier `await`. Le mode strict de `stringifyBoundedJson`
refuse pertes de données et coercitions : valeurs indéfinies/non finies, fonctions,
symboles, accesseurs, sérialisation personnalisée, cycles, tableaux creux ou enrichis,
propriétés non énumérables et prototypes non ordinaires. Limites : borne native
`MAX_IMPORT_BODY_BYTES`, 100 000 nœuds et profondeur 64 ; borne d’octets entière,
finie et positive ou nulle. Le comportement historique du helper reste inchangé
lorsque `strict: true` n’est pas demandé. Ce filtre ne constitue pas un bac à sable
pour un objet Proxy hostile ; l’entrée attendue au raccordement est du JSON décodé.

Le funnel d’autorisation natif reste exécuté : rôle d’écriture, politique des
principaux et délégations, contexte canonique, verrou du workflow, visibilité des
blocs, configuration des permissions, révision et contrôles des identifiants.
Une délégation liée à un autre workspace est refusée avant ce parcours. Aucun
grant ou privilège supplémentaire n’est fabriqué. Les clés de workspace et les
délégations d’exécuteur ne deviennent pas admises par cet outil.

## Résultat limité

Un résultat `ok: true` signifie seulement que l’évaluation a produit un diagnostic.
Il porte `dryRun: true`, `persisted: false`, les deux révisions égales à la révision
demandée, les comptes d’opérations et les résultats de projection. Le workspace,
le workflow, les révisions, le mode et les comptes du résultat natif sont vérifiés
avant livraison ; une incohérence devient `unavailable`.

Les diagnostics contiennent des codes fixes, des comptes et les indices des
opérations ou changements d’activation soumis. La correspondance des identifiants
provisoires reste interne ; seul leur nombre est livré. Aucun graphe, contenu,
nom de bloc, paramètre, credential, identifiant généré, message du moteur ou cause
d’infrastructure n’est livré. Les avertissements et notes sont comptés seulement.
La sortie est limitée à 256 Kio avec le même contrôle JSON strict ; un dépassement
produit `result_too_large`, sans succès partiel.

Le lint porte toujours `completeness: best_effort`. Il ne prouve ni la validité de
tous les connecteurs, ni la disponibilité des credentials, ni la réussite d’une
future exécution. Un batch non atomique peut annoncer `ok: true` avec des refus ou
des entrées retirées. Un refus atomique reste `ok: false`, code `atomic_refused`,
avec diagnostics projetés ; aucun succès d’application n’en est déduit. La catégorie
`revision_conflict` représente les conflits natifs, y compris un identifiant déjà
occupé ; elle ne permet pas de déduire une nouvelle révision.

L’annulation avant le départ évite les lectures. Pendant une attente, elle clôt la
réponse avec `cancelled` et le checkpoint natif empêche la suite avant la préparation
d’une écriture. Une lecture d’infrastructure déjà lancée peut finir ; sa réponse
n’est pas livrée. Aucun arrêt d’une requête DB n’est promis.

## Vérifications et limites

Les tests exécutent le vrai schéma, funnel d’autorisation, moteur d’édition,
sanitisation et lint avec les blocs natifs Function et API. Les lectures de
contexte/permissions/graphe, le contrôle des identifiants, les notifications et
l’audit sont des doublures d’infrastructure ; aucun accès DB n’est qualifié ici.
Les tests adversariaux de résultat sont explicitement séparés : ils altèrent la
frontière du résultat après l’évaluation native pour vérifier la projection fermée.
Les refus et canaris de credential sont ainsi testés sans charger de secret.

Le cas lint requis utilise `ApiBlock.url` (obligatoire dans Sim). `Function.code`
n’est pas déclaré obligatoire : son absence ne justifie pas d’exiger ce diagnostic.
Le rouge initial correspondant est conservé dans les preuves privées de reprise.

L’activation réelle d’un fournisseur au titre de P06, la provenance du principal serveur, le rendu navigateur,
la persistance et confirmation d’une proposition, le contrôle de révision au vrai
commit et la vérification DB demeurent hors de cette tranche. Une prévisualisation
n’est jamais une autorisation d’appliquer ultérieurement le graphe.


## Port fournisseur optionnel

[PROVIDER_BINDING.md](PROVIDER_BINDING.md) décrit l’enveloppe SDK `request` : le
corps conserve le contrat v2 exact, tandis que les références JSON Schema locales
sont vérifiées puis relocalisées sous `properties.request` avec leurs `$defs`.
Le corps reçu est transmis sans normalisation préalable à cette fabrique. Le
modèle ne fournit pas le principal ou le workflow lié.

Un refus atomique garde `rawResponse.success: false` et produit un événement natif
en erreur. Pour que la boucle native conserve ses diagnostics, son seul
`modelResponse` utilise l’enveloppe technique `success: true` contenant
`{ok:false,error,diagnostics}`. Ce transport ne signifie ni succès d’application,
ni autorisation d’exécution ; le code et les indices projetés restent fixes.
Les tests du binding utilisent les vrais parseurs/boucles SDK avec HTTP et DB
doublés. Aucun fournisseur distant, secret réel ou chemin SQL n’est qualifié ici.
