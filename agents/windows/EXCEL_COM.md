# Excel COM : frontière CLI contrôlée

Cette tranche prépare le protocole de la CLI ExcelMcp 2.4.1, révision MIT
`70c4ded99c8a35d8bf13d47661162c8b7d11312d`. Elle ne lance aucun processus,
n'ouvre aucun classeur et n'accorde aucun droit. Elle n'est pas encore un
adaptateur d'exécution Desktop utilisable de bout en bout.

## Contrat livré

`prepare_batch(pipe_name=..., session_id=..., operations=...)` capture puis valide intégralement
un lot avant toute émission. Le profil initial accepte seulement
`range.set-values` et `range.get-values` avec les noms natifs `sheetName`,
`rangeAddress`, `values`. Chaque entrée comporte la même session reçue du caller.
Pas d'ouverture implicite, de `valuesFile`, de session alternative, de formule,
de VBA, de refresh, de calcul, d'attachement, de sauvegarde ou de remplacement
non vide : la politique native reste `reject-nonempty`.

`new_pipe_name()` prépare un nom UUID avant la création de session. Le plan
immuable reprend ce même pipe possédé (aucun nouveau daemon par batch), un tableau argv sans shell,
`batch --input - --stop-on-error`, JSON privé pour stdin et l'environnement
obligatoire `EXCELMCP_TELEMETRY_MODE=off` et `EXCELMCP_CLI_PIPE=<pipe>`.
`--pipe-name` appartient à `service run`, pas à la commande batch.
Le caller doit réutiliser **ce pipe**
pour tout le cycle de la session dédiée (service, ouverture, batch, fermeture).
Le plan ne prouve ni que ce pipe est libre ni que la session lui appartient ;
aucun fallback vers le daemon/Excel utilisateur n'est permis. Les valeurs et la
session ne figurent pas dans argv ou repr. Le hash lie des bytes ; ce n'est ni
une approbation ni une authentification.

Bornes de ce premier profil : 16 commandes, plages A1 contiguës de 4096 cellules
au plus chacune, 256 Kio JSON d'entrée ; chaînes de 4096 caractères sans
contrôles, nombres finis représentables sans dépasser les entiers sûrs JSON.
Les préfixes de formule sont refusés à l'écriture. Cela ne sécurise pas les
formules préexistantes, les connexions, les événements ni les fonctions d'un
classeur externe. Aucun parseur de classeur ou moteur Excel n'est recréé.

`BatchReader` reçoit les chunks NDJSON, avec 1 Mio total et 64 Kio par ligne.
Le runner doit interrompre la lecture dès son refus et garder la responsabilité
des seuls processus possédés. Index, ordre, nom de commande, flags booléens et
résultats natifs sont vérifiés ; readback vérifie feuille, plage, dimensions,
absence d'erreur cellule et types des valeurs. Les valeurs de readback restent
privées sous forme JSON immuable ; chemins, messages et états partiels natifs
ne sont pas projetés. Une écriture doit être suivie immédiatement de la lecture
de la même plage : ses valeurs sont comparées cellule par cellule (nombres
int/float équivalents admis, booléens et chaînes distincts). Une divergence reste
inconnue, avec la lecture privée conservée. Cela ne garantit pas l’absence de
modification concurrente après cette observation. Le sens métier reste au caller.

- `reported_complete` signifie uniquement que chaque item a rapporté un succès
  concordant avec exit 0. Ce n'est pas une preuve de sauvegarde, fermeture,
  résultat métier, absence d'effet réseau ou commit atomique.
- `partial_or_unknown` conserve le préfixe ayant rapporté un succès et l'index
  de l'échec. Même l'item échoué peut avoir modifié la copie. Aucun rollback ni
  retry automatique, aucune suppression de la copie de diagnostic.
- `unknown` couvre transport interrompu, sortie incomplète/malformée/trop grande,
  contradiction ou violation de stop-on-error. Un préfixe déjà observé n'est pas
  effacé, mais aucun succès global n'est fabriqué.

Le protocole de réponse de `BatchCommand.cs` fait foi ; cette tranche ne reprend
pas son implémentation. Les tests portables utilisent des documents JSON fictifs,
aucun daemon ni Excel doublé présenté comme qualifié.

## Raccordement natif restant, refusé pour l'instant

Les primitives `observe_session`, `DesktopReservation.ensure_current()` et
`OwnedJob` restent les ports à réutiliser : elles ne fournissent pas l'autorité
serveur, les leases/fences, le consentement ni la qualification de la copie.
`OwnedJob` ne propose actuellement ni stdin ni collecte stdout bornée. Aucun
nouveau lanceur ou faux port ne contourne cette limite dans `excel_com.py`.
De plus, le CLI auto-démarre son daemon avec `UseShellExecute=true` ; posséder
le processus CLI ne prouve pas que le daemon et Excel appartiennent au même
Job. Leur création/identité/fermeture doivent être qualifiées séparément, sans
assimiler une invocation `service stop` à une fermeture prouvée par handles.

La CLI figée dispose de :

- `BatchCommand.cs` : validation de toutes les commandes, mais un préfixe valide
  peut être exécuté avant une erreur de validation ultérieure ; la validation
  locale complète demeure nécessaire ; l'exécution n'est pas transactionnelle.
- `ExcelBatch.cs:368,454,778` : `AutomationSecurity=3` pour `.xlsx`, ouverture avec
  `UpdateLinks:0`, vérification de verrou local. `.xlsm` demande au contraire
  `AutomationSecurity=1` ; ce profil n'est pas accepté par Memlia.
- `TelemetrySettings.cs` : opt-out explicite `EXCELMCP_TELEMETRY_MODE=off`.

`UpdateLinks:0` n'établit pas la neutralisation de tout refresh-on-open ou de
connexions existantes. Le contrôle XLSX Linux déjà présent est strict et refuse
formules/objets/liens ; il n'est pas une preuve universelle des capacités COM
avancées, ni une dépendance installée dans l'agent. Une future ouverture exige
une copie stable possédée et une qualification native/contrôle de contenu
approprié avant lancement. Le chemin seul ou un booléen de confiance ne suffit
pas. En attendant, cette tranche n'expose aucune fonction d'exécution.

Développé et testé isolément : codec/prévalidation. Intégration et exécution
Windows/Excel réelle : à revoir/qualifier séparément. Aucun résultat Office.js,
Excel Linux ou test avec doubles ne qualifie cette exécution COM.
