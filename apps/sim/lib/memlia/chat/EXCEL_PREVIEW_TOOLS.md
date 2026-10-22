# Analyse Excel déclarative dans le Chat local

Les outils `excel_describe_capabilities` et `excel_preview_procedure` réalisent les deux capacités logiques `excel.describeCapabilities` et `excel.previewProcedure`. Ils sont annoncés par le provider contrôlé uniquement lorsqu'une session serveur possède le contexte workflow `sanitized_details` avec `previewOperations:true`. Les événements du driver local réutilisent la présentation native des outils déjà exécutés ; aucune seconde exécution client ni carte d'approbation n'est créée.

Il s'agit d'une analyse de déclarations : `analysis:declarative_draft`, `executionAvailable:false`, `persisted:false`. Un appel réussi signifie qu'une observation a été produite. Il ne signifie ni qu'un classeur a été testé, ni qu'un résultat métier est correct. La compatibilité des primitives et la validité du flux déclaré restent deux résultats séparés. Les diagnostics et résumés de types sont bornés et indexés, sans reprendre les noms ou valeurs de l'entrée.

## Entrées et autorité

La description accepte seulement `{}`. La preview accepte `{request: brouillon}`. Le schéma du brouillon est dérivé par `.omit` du contrat canonique `ExcelProcedureSchema`. Il conserve les opérations, expressions, types et contraintes métier à l'identique ; il exclut schemaVersion, organisation/cabinet/workflow/auteur, version/déploiement/digest/policy et identifiant de procédure. Ces champs ne sont pas facultativement ignorés : leur présence est refusée. Aucun identifiant de publication n'est inventé pour analyser un brouillon. Ce brouillon n'est pas un format persistable ni une procédure admise à l'exécution.

Les références de binding, feuille ou artefact présentes dans les champs métier restent des déclarations non résolues. Leur forme ne prouve aucune existence, autorisation ou intégrité. Les règles manquantes doivent être demandées à l'humain ; l'outil n'ajoute aucun défaut métier. La génération d'une procédure complète, son digest et sa publication ne sont pas raccordés ici.

L'appelant établit une session réelle ; une valeur TypeScript Principal ne l'authentifie pas. Le module possède une capture stricte du contexte serveur puis du JSON modèle avant tout await. Chaque appel traverse le use case natif workflow.read, résout le workflow actif et son cabinet canonique, vérifie les droits courants, puis `copilot.use` avec un executor natif explicite qui évite le cache de requête. Aucun graphe ou credential n'est chargé pour cette analyse. Ces lectures ne constituent pas une transaction de révocation atomique de session et ne donnent aucun droit d'écriture.

## Bornes et absence d'effets

Entrée JSON complète :512Kio ; sortie :256Kio. Réemploi des analyses P09 :128diagnostics,512résumés de colonnes,25000unités de travail. Les entrées complètes des deux ports historiques gardent leurs parsers et résultats ; les nouvelles entrées brouillon partagent leurs analyses. Les annulations suppriment la livraison ; les lectures natives déjà commencées peuvent terminer sans qu'une analyse soit délivrée.

Aucun import du runtime Python, aucun processus, accès fichier, résolution d'artefact, calcul XLSX, job, persistance, déploiement ou publication. La description des primitives n'affirme pas que le runner Linux est disponible : sa qualification et ses images restent séparées. Les budgets modèle et délais existants continuent de borner les vrais transports et outils ; cette tranche n'ajoute pas de fournisseur ni de fallback.

Les tests ciblés utilisent les vrais analyseurs P09, le schéma canonique, les factories d'autorisation, les boucles/parseurs providers et les handlers de présentation natifs. HTTP/provider et lookups DB/permissions sont doublés. Ils ne qualifient pas PostgreSQL, une session HTTP réelle, un navigateur, un fournisseur payant, une procédure calculée ou un environnement Linux.
