# Excel : fichiers autorisés et résultat du run

`executeExcelFile(input, context, runtime, signal)` compose les portes natives. Ce module serveur est réservé au worker de confiance ; il n'est pas encore enregistré comme outil et n'active aucune image. Le socket hôte ne doit pas être monté dans Next. Son absence refuse sans repli Python.

## Entrée et autorité

L'entrée stricte contient la procédure `ExcelProcedureSchema`, une sélection `sources[role] = { fileId, sheetName }` et `output = { sheetName, fileName }`. Aucun chemin, URL, provenance, principal, socket, UID ou image n'est fourni par cette entrée. Les bindings et métadonnées de procédure n'accordent aucun droit. Son auteur peut différer de l'exécutant ; `ownerUserId` n'est jamais employé pour fabriquer une identité ou interdire un partage autorisé.

Le `InternalToolOperationContext` provient du moteur. Cette tranche exige workflow, workspace, run, sujet Sim et origine de délégation concordants ; elle refuse Copilot, les appels sans workflow/run et les origines sans principal. Elle ne crée pas d'acteur humain pour les déclencheurs qui n'en ont pas. `createExecutorPrincipalFromExecutionContext` réemploie la liaison native du run et l'audience fichiers. `resolveActiveWorkflowApplicationContext` fournit la portée canonique, puis `readWorkspaceFileContent.execute` applique les permissions natives sur chaque sélection avant lecture.

Les paramètres, l'origine, les sélections, la procédure et le runtime opérateur sont capturés avant toute attente. Le profil de cette tranche exige des entrées XLSX de cardinalité `one` (un artefact, pas une ligne), une seule sortie et une écriture `regenerate_owned_zone` vers un binding distinct. Les autres options sont validées par le contrat et le kernel existants ; aucun calculateur ou parseur XLSX n'est ajouté. Le nom de fichier n'est jamais un chemin ; le stockage alloue une nouvelle clé native.

## Octets, versions et publication

La lecture autorisée capture les octets, le workspace, l'identifiant, la clé, le contexte de stockage, `contentUpdatedAt`, SHA-256 et la classification liée à cette version. Le total est borné à 10 000 000 octets. Une classification absente, inconnue ou malformée refuse ; `unrecorded` reste distinct d'une classification exacte vide. Le merge natif conserve les contributions chiffrées connues.

`prepareExcelThroughHost` reçoit les octets et les bindings résolus ; sa validation native vérifie la réponse, ses identités, contrôles et empreintes. Le résultat devient un `InternalToolFileResult` natif, sans stockage à ce stade. Une liaison privée WeakMap attache une copie des octets et de la provenance ainsi qu'une revalidation du principal/run et des sources. Elle ne traverse aucun JSON. Le présentateur natif doit recevoir exactement le résultat et son fichier d'origine ; copie, remplacement, modification des octets ou seconde présentation refusent. Cette consommation en mémoire n'est pas une garantie durable d'exactly-once.

Avant `uploadExecutionFile`, puis avant présentation, les droits sont relus et les sources comparées à leur capture, y compris octets et classification. Un changement refuse sans rebase ni retry. La provenance est transmise au sixième argument natif d'upload ; son écriture de métadonnées et classification demeure la transaction existante. Si le second contrôle échoue, le rollback natif retire le nouvel objet avant de propager le refus. Aucun écrasement d'entrée ni publication partielle volontaire.

Ces lectures fraîches ne verrouillent pas les sources pendant tout le stockage distant : aucune atomicité globale entre permissions, sources, stockage et téléchargement ultérieur n'est revendiquée. Le téléchargement demeure soumis aux portes natives ; le présentateur ne remplace pas leurs contrôles. Les erreurs propres à la composition sont fixes (`excel_file_refused`), sans cause ou contenu de fichier.

## Raccordement restant

L'appelant prévu est un `InternalToolOperationHandler` de l'outil Excel générique via `GenericBlockHandler → executeTool → executeDeclaredInternalOperation → presentInternalToolOperationResult`. Il devra conserver la référence protégée et recevoir la configuration opérateur uniquement côté worker. Les coutures suivantes restent à attribuer : configuration de l'outil dans `tools/excel/`, entrée `tools/registry.ts`, chargeur `lib/internal/tool-operations/registry.server.ts`, configuration opérateur worker. `tools/index.ts`, les registres et l'environnement n'ont pas été modifiés ici. Le run moteur conservera sa finalisation native ; aucun `LoggingSession.complete` manuel.

Les tests de cette tranche composent les vrais schémas, le protocole de réponse et le présentateur/rollback. Le chargement du run, les permissions/lectures de fichiers, le transport hôte et le stockage sont doublés explicitement. Les suites natives de délégation, de lecture et d'upload sont rejouées séparément. Aucune DB, image, exécution Linux, UI, téléchargement réseau ou fournisseur n'est qualifié ici. `QUALIFIED_IMAGES` reste vide ; une image distribuable admise et la qualification Linux du socket/UID sont préalables à l'activation.
