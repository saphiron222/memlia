# Première frontière Office.js — P12

Ce module appartient au futur complément Excel générique de Memlia dans Sim. Il observe le SDK puis copie le document actif au format compressé, sans modifier le classeur. Aucune interface séparée ou dépendance Office embarquée n'est ajoutée. Le futur taskpane chargera le SDK Microsoft officiel et transmettra son objet `Office` à `preflightOffice`.

## Utilisation et portée

1. `preflightOffice(Office, signal)` attend `Office.onReady()` au plus 10 secondes, puis exige Excel, la plateforme `PC` (Windows), le mode `readWrite`, les requirement sets `File` et `CompressedFile` version 1.1 et la méthode `getFileAsync`.
2. `copyOfficeCompressedFile(observation, signal)` accepte uniquement l'objet d'observation exact retourné dans ce runtime JavaScript. Une forme JSON, un clone ou un changement de contexte/document/méthode est refusé. Cette liaison ne vaut ni authentification, ni autorisation, ni consentement.
3. La copie demande `getFileAsync('compressed', { sliceSize: 65536 })`, lit séquentiellement tous les indices attendus et ferme le handle par `closeAsync`. Taille totale : 1 à 10 000 000 octets ; nombre, indices, tailles et octets des tranches vérifiés. Délai global d'acquisition : 30 secondes, puis au plus 2 secondes d'attente de fermeture.

Un résultat porte `kind: 'unpersisted_compressed_copy'`, `version: 1` (format de cet adaptateur, **pas** version du classeur), le nombre d'octets/tranches et ses propres octets détachés des tableaux du SDK. Il n'est rendu qu'après un accusé de fermeture réussi. Le contenu peut être sensible ; ce module ne le journalise et ne le transmet pas. Le consommateur doit le conserver uniquement pour le parcours autorisé et le libérer après usage.

Le profil Windows est une première restriction de l'adaptateur, **NON QUALIFIÉE sur Excel Desktop** à ce stade. Les API compressées existent aussi sur certains autres hôtes ; cela ne les rend pas qualifiés par cette tranche. `qualification: 'not_verified'` demeure explicite. La copie n'établit pas l'identité persistante du classeur, son chemin, son état sauvegardé, une version stable ou l'absence de coédition. Une vérification finale du contexte et des métadonnées SDK ne garantit aucune atomicité face aux modifications externes.

## Fermeture et annulation

Office ne fournit pas ici d'annulation native garantie des appels déjà envoyés. L'annulation empêche le retour de données réussies et tente une unique fermeture de tout handle reçu, y compris après un callback d'ouverture tardif. Les callbacks tardifs de tranches ne relancent ni lecture ni résultat. Un accusé de fermeture tardif peut libérer l'exclusion locale mais ne transforme jamais un échec en succès.

Les erreurs exposent uniquement un code fixe et une observation de fermeture : `not_opened` (refus avant ouverture ou résultat SDK explicitement échoué), `pending` (appel envoyé sans handle reçu), `confirmed` (accusé de fermeture réussi), `unconfirmed` (fermeture échouée/incomplète ou réponse malformée). Une ouverture qui lève une exception reste `pending` : elle ne prouve pas l'absence d'effet natif. Aucun message ou objet d'erreur du SDK n'est propagé.

Une seule acquisition de ce module est admise par objet document dans le runtime courant. Si la libération reste inconnue, l'exclusion est conservée ; aucune relance automatique n'est autorisée par l'adaptateur. Elle pourra se lever après un accusé tardif. Ce garde local n'est ni un bail serveur, ni un verrou Office interprocessus, ni une garantie après rechargement du taskpane. Si Office ne rappelle jamais, la fermeture native reste **NON CONFIRMÉE** ; l'adaptateur ne prétend pas pouvoir la garantir.

## Étapes P12 encore requises

Les contrats canoniques `SnapshotSchema`, `PatchSetSchema` et `CommitReceiptSchema` restent dans `packages/memlia-contracts/src/excel.ts`. Cette copie ne produit aucun de ces reçus. Restent notamment : capture générique des cellules/formules/styles/objets et scopes, contrôles d'identité/version/coédition, sauvegarde privée complète persistée et relue/hashée sur le serveur, autorité native Sim, preview, confirmation, patch, calcul et readback. Le téléchargement d'un fichier ne vaut pas sauvegarde persistée. Aucun parseur OOXML ou moteur de calcul parallèle n'est créé ici.

Tests : adaptateurs réels contre un SDK Office externe doublé et horloge contrôlée ; aucun SDK/CDN chargé, Excel Desktop, Windows, persistance, backup ou patch réel exécuté.

## Références Microsoft

Consultées le 21 octobre 2026 : [Document/getFileAsync](https://learn.microsoft.com/en-us/javascript/api/office/office.document?view=office-js), [File/getSliceAsync/closeAsync](https://learn.microsoft.com/en-us/javascript/api/office/office.file), [Slice](https://learn.microsoft.com/en-us/javascript/api/office/office.slice), [initialisation Office](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/connect-to-javascript-frameworks), [requirement sets](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/specify-api-requirements-runtime).
