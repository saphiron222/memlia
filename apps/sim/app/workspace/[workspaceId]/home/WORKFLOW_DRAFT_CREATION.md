# Créer un workflow depuis Home

L’action **Créer un workflow avec ce brouillon** crée un workflow avec les blocs par défaut de Sim par la mutation native. Elle attend sa confirmation, relit les capacités locales de ce workflow puis ouvre son panneau Chat avec le texte comme brouillon. Elle ne lance aucun message, modèle, exécution ou activation. Dans ce panneau, l’utilisateur doit adopter les réglages du cabinet et envoyer explicitement ; la file, les confirmations unitaires et le CAS restent ceux du parcours natif.

L’action concerne seulement Home sans conversation, en mode agent, avec un profil local et les droits d’écriture observés. Le serveur de création reste l’autorité Write/Admin. Les fichiers, contextes et ressources ne sont pas transférés. Le modèle demeure celui de l’administration, en lecture seule. Le texte n’est ni un nom de modèle ni une instruction de création pour un outil : il reste du texte dans le composer.

Une perte de permission, un changement de sujet, de workspace, de profil ou de texte, ainsi qu’un démontage avant la réponse, empêchent la navigation. Le brouillon Home n’est pas effacé. Si la création a déjà été commise, le workflow peut rester avec ses blocs par défaut : aucune suppression automatique ne tente d’annuler cet effet. Une seule création est émise par montage après un clic admissible ; les doubles clics et relances implicites sont refusés, y compris après une réponse incertaine. L’utilisateur peut retrouver le workflow dans la liste native. Une nouvelle visite reste une nouvelle action, sans garantie d’idempotence entre rechargements.

## Restriction persistée du brouillon

`DraftPayload.localOrigin` est facultatif. Seul `true` est valide : il impose le Chat local sans apporter d’autorité, de ticket d’adoption ou de consentement. Le lecteur traite toute autre valeur présente comme invalide ; le texte reste visible et aucun envoi n’est possible avant une reprise explicite dans le profil local. Une valeur `undefined` présente est conservée comme `null` à l’écriture pour que JSON ne supprime pas cette restriction. Un brouillon sans ce champ conserve le parcours natif précédent. Aucun effacement ni migration de stockage n’est introduit.

Le composer conserve cette restriction lors d’une édition, d’une sauvegarde et d’un remontage. Sous un profil legacy, inconnu ou indisponible, Entrée et le bouton d’envoi refusent un brouillon local. Une reprise de marqueur invalide n’adopte pas les réglages et n’envoie rien. Aucun champ `localOrigin` n’est ajouté au POST : seuls les paramètres déjà admis par l’envoi natif circulent.

## Vérification et limites

Les tests exercent React, les stores, le composer, le schéma de capacités et une mutation de création React Query native. Les réponses HTTP, la session/observation de permissions et les capacités sont des doublures déclarées ; aucun PostgreSQL, fournisseur ou navigateur réel n’est qualifié par ces tests. Le raccordement Home et la clé du brouillon de panneau sont relus contre leurs sources natives. Une observation du parcours dans le navigateur reste nécessaire. Le contrôle de disponibilité des confirmations natives appartient au backend intégré séparément ; cette tranche ne le remplace pas.
