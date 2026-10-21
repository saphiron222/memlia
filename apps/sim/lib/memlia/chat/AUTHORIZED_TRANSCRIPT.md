# Transcript texte autorisé pour le Chat local

`loadAuthorizedChatTranscript` reçoit une identité de session **déjà authentifiée par le serveur**, les identifiants du chat, de son workflow existant et de son espace canonique, ainsi que l'identifiant et le texte du message courant. Il capture ces valeurs avant le premier `await`, valide la forme native du principal et retourne uniquement `messages: { role: 'user' | 'assistant', content: string }[]`. Il n'authentifie pas une session à partir d'un objet fourni par le navigateur.

Le lecteur additif `loadBoundedCopilotChatText` réemploie l'autorisation propriétaire/chat vivant et l'autorisation native de lecture du workflow. Le workspace est confirmé par ce workflow, pas par l'assertion du chat seul ; une ancienne ligne de chat sans workspace est acceptée seulement lorsque le workflow fournit le workspace attendu. Un workspace rattaché à une organisation n'est pas exclu ; un **chat d'organisation** l'est. Le profil exige un workflow existant : la création d'un workflow depuis Home n'est pas couverte.

## Bornes et refus

- 128 lignes candidates au maximum, comptées par une lecture des seuls identifiants avec `LIMIT 129`, avant la lecture JSONB. Les messages supprimés sont exclus ; l'ordre natif séquence/date/identifiant reste inchangé.
- 64 Kio maximum pour le JSON logique complet de chaque message user/assistant lu. Une expression SQL `CASE` vérifie la taille dans la même lecture que la projection texte et retourne `null` sinon ; l'adaptateur refuse alors le transcript entier. Un message contenant de très gros paramètres d'outil peut donc être refusé même si son texte est court. Les autres rôles ne livrent aucun contenu.
- 256 Kio UTF-8 de texte total, 128 messages de sortie maximum, message courant inclus. Le texte courant a aussi une borne de 64 Kio ; la capture JSON stricte de l'entrée a une borne de 96 Kio. Les textes nécessitant beaucoup d'échappements JSON peuvent atteindre cette dernière borne plus tôt. Aucun découpage, coercition, résumé ou troncature silencieuse.

La taille logique JSONB exige du travail TOAST et une matérialisation côté PostgreSQL. Cette tranche borne les lignes candidates et les données remontées à l'application ; **elle ne supprime pas tout détoastage ni ne garantit un plafond de mémoire/temps interne PostgreSQL**. Les deux listes d'identifiants doivent être identiques entre le comptage et la projection ; une insertion, suppression ou réorganisation observée provoque un refus. Une modification de contenu entre les lectures reste protégée par la borne SQL au moment de sa projection.

Le message courant est ajouté une seule fois. S'il existe déjà, son rôle doit être `user`, son texte doit être exactement identique et sa ligne doit être la dernière ; toute divergence est refusée. Deux lignes portant le même identifiant sont refusées. Les blocs texte sont concaténés dans leur ordre, sans suppression des espaces. Un contenu invalide n'est jamais transformé en chaîne ni promu vers le rôle utilisateur.

Les champs d'outils, arguments, résultats, pièces jointes, contextes et références internes ne sont pas retournés. Aucun catalogue ni snapshot de workflow n'est ajouté : ces capacités restent des outils séparés. Le texte saisi par un humain demeure du texte non fiable ; ce lecteur n'est pas un détecteur de secrets contenus dans la prose et ne lui confère aucune autorité système. Erreur publique fixe : `Authorized transcript unavailable.` ; aucune cause, contenu ou session n'est journalisée par l'adaptateur.

Une entrée native `role=user` portant `origin=task` est une notification automatique, pas une saisie humaine. Ce profil refuse le transcript qui en contient plutôt que la promouvoir vers un message utilisateur ou l'effacer silencieusement. Le champ `origin` est lu seulement pour ce contrôle et n'est jamais retourné ; toute autre origine non nulle est également refusée.

## Autorité et qualification

Les droits et la propriété sont relus après la projection. Cette relecture **n'est pas une garantie atomique contre une révocation ultérieure**, ni une réservation d'autorité : le futur ingress doit authentifier la session et les droits avant le fournisseur, et chaque outil conserve ses contrôles frais. Cette fonction seule n'autorise aucun transport, dépense, proposition ou application.

Les fonctions historiques de lifecycle restent inchangées. Tests : lecteur/adaptateur réels, principal et capture JSON natifs ; frontières DB et autorisations doublées explicitement. Une sonde construit les requêtes avec Drizzle et le schéma PostgreSQL natifs, mais son pilote proxy renvoie des fixtures : **aucune connexion PostgreSQL ni plan TOAST exécuté**. Aucun endpoint, modèle, clé, interface, migration ou activation locale n'est ajouté. Le raccordement HTTP reste la tranche suivante.
