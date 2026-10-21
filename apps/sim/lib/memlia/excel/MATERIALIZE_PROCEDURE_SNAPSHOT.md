# Matérialiser une procédure dans un snapshot natif

Ce port serveur pur prépare le contenu exact d'un snapshot de workflow. Il n'authentifie pas, ne persiste rien et n'autorise ni test ni activation. Le futur use case doit établir les droits, la portée canonique, l'auteur, la politique et la filiation de version avant de lui confier ces métadonnées. Une donnée typée ou une capture opaque n'est pas une autorité.

`captureExcelProcedureSnapshot` copie le plan JSON strict avant toute attente, avec une borne totale de 2 Mio et 512 Kio par demande Excel. Le graphe est vérifié avec le schéma natif sans perdre ses métadonnées supplémentaires. Son empreinte attendue, les empreintes des demandes et la liste exacte des blocs Excel sont vérifiées. Chaque `request.value` doit être le JSON littéral d'un champ `code`, contenant `procedure`, `sources` et `output`. La procédure est un brouillon canonique, sans identité ni digest fournis par le modèle ; son dataflow déclaré est vérifié par le validateur existant. Les sources et la sortie sont conservées sans interprétation : cette étape ne les autorise pas et ne remplace pas la validation complète d'exécution.

La capture est détenue par une WeakMap privée. Sa copie JSON ou un objet fabriqué est refusé. Les données initiales peuvent ensuite changer sans altérer le plan détenu. Il faut pourtant relire le graphe, sa révision et sa portée sous le verrou natif : `materializeExcelProcedureSnapshot` exige qu'ils correspondent encore exactement au plan capturé. Le futur raccordement fournit alors le véritable ID et le numéro de déploiement alloués par la persistance native. Aucun ID fictif ni version déployée nullable n'est introduit.

Seules les valeurs `subBlocks.request.value` des blocs Excel ciblés changent. Elles reçoivent une `ExcelProcedureSchema` complète, avec les métadonnées serveur et un digest SHA-256 du JSON normalisé de la procédure entière sans son champ `digest`. Les champs `version` et `parentVersion` sont ceux de la procédure ; le numéro du déploiement est distinct et n'est jamais substitué automatiquement à cette filiation. La fonction vérifie les formes et l'ordre local des versions, pas l'existence d'un parent en base.

`inputDigest` couvre le plan capturé, sans le nouvel ID aléatoire du déploiement. `snapshotDigest` couvre le graphe final réellement retourné, après matérialisation. Le résultat et ses descendants sont gelés pour éviter une divergence silencieuse entre le hash et le contenu avant l'INSERT. Le mécanisme d'idempotence natif devra incorporer l'empreinte d'entrée et conserver l'empreinte finale appropriée ; ce port ne change pas ce mécanisme.

Toutes les erreurs sortent sous le message fixe `excel_materialization_refused`, sans cause, données ou message de validation. Il n'y a ni callback d'I/O, ni accès DB, ni mutation du graphe fourni, ni appel modèle, ni écriture de fichier.

## Raccordement encore nécessaire

Le point prévu est situé dans `prepareWorkflowDeployment`, après l'allocation serveur sous verrou et avant l'INSERT du snapshot. Les droits et le CAS doivent être établis par le use case autorisé ; ce module seul ne prouve pas qu'un verrou a été pris.

Un test sur copie doit avoir une admission inactive explicite. **Ne pas appeler `finishPreparedWorkflowDeployment` ne suffit pas** : `prepareWorkflowSnapshotDeployment` ajoute déjà un événement d'outbox que le traitement natif peut activer plus tard, avec schedules, webhooks ou MCP. Ce chemin ne doit donc pas être utilisé tel quel pour tester une procédure non validée. Le raccordement partagé et son contrat de test restent à réaliser et à relire.

Aucune route, aucun outil Chat de publication, aucun déploiement, aucun scheduler ni aucune image n'est activé ici. `QUALIFIED_IMAGES` reste inchangé. Les tests de cette tranche portent sur les vrais schémas et validateurs purs, avec données synthétiques ; ils ne prouvent ni résultat XLSX, ni téléchargement, ni exécution Linux, ni permissions réelles en base.
