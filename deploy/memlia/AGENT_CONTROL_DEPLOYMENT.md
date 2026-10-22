# Contrôleur des agents — profil préparé, non qualifié

Ce profil réemploie le runtime Node24 intégré et **la même image workflow-worker admise par digest**. Il ne crée ni nouvelle pile, ni autorité de certification, ni rôle SQL. Son processus dédié exécute `node dist/memlia-agent-control.mjs`. Aucune clé CA privée n'y est montée.

## Sélection administrative et installation

Ajouter `"agentControlEnabled": true` au JSON protégé `memlia.operations/v1` active la sélection du seul fichier supplémentaire `compose.agent-control.yaml`. Sans ce booléen explicite, les opérations historiques gardent leurs deux fichiers Compose. Une variable d'environnement ne sélectionne pas le profil. Installer crée le conteneur mais **ne le démarre pas**, comme le worker ; `agentControlStarted=false` et `businessQualified=false` restent explicites.

Le fichier privé `compose.env` fournit quatre sources, toutes situées sous le répertoire de configuration déjà inclus dans la sauvegarde chiffrée :

- `MEMLIA_AGENT_CONTROL_CONFIG_SOURCE` : JSON public de configuration, propriétaire root, non modifiable par UID1001.
- `MEMLIA_AGENT_CONTROL_CERTIFICATE_SOURCE` : feuille serveur publique PEM, root, épinglée.
- `MEMLIA_AGENT_CONTROL_CLIENT_CA_SOURCE` : racine publique des certificats clients, root, épinglée ; jamais sa clé privée.
- `MEMLIA_AGENT_CONTROL_SECRETS_SOURCE` : seul sous-répertoire contenant `key.pem` chiffrée PKCS8 et `passphrase`, propriétaire UID/GID1001, mode0700 ; deux fichiers réguliers sans liens,0400/0600. Aucun troisième fichier n'est accepté.

Les trois fichiers publics sont montés individuellement en lecture seule sous `/etc/memlia-agent-control`, ce qui n'expose pas leur répertoire parent root privé. Le répertoire des deux secrets est monté en lecture seule sous `/run/memlia-agent-control`, en conservant0700/1001. Aucun chemin hôte n'est créé implicitement. Ne pas monter tout le répertoire de configuration ou l'autorité d'enrôlement.

Le JSON suit le schéma de [la configuration native](../../apps/sim/lib/desktop-automation/AGENT_CONTROL_RUNTIME.md). Les chemins internes sont imposés : `certificatePath=/etc/memlia-agent-control/server.pem`, `clientCaPath=/etc/memlia-agent-control/client-ca.pem`, `encryptedKeyPath=/run/memlia-agent-control/key.pem`, `passphraseFilePath=/run/memlia-agent-control/passphrase`. `installation.fqdn` est l'origine HTTPS exacte de l'application ; `controlOrigin` est l'origine HTTPS dédiée avec **port9443 explicite**, et `listenHost=0.0.0.0` concerne l'interface du conteneur. Renseigner les SHA256 exacts des fichiers selon le runtime existant. Les contrôles d'exploitation lisent seulement les fichiers publics et les métadonnées des secrets ; ils ne lisent ni clé ni passphrase et ne délivrent aucun certificat. Le runtime UID1001 reste chargé des vrais contrôles cryptographiques, SAN/EKU, validité, pins et paire clé/feuille avant listener/DB.

## Réseau, droits et disponibilité

L'hôte publie9443 sur **127.0.0.1 par défaut** : le PC Windows ne peut pas l'utiliser ainsi. `MEMLIA_AGENT_CONTROL_BIND_ADDRESS` peut désigner une adresse IPv4 RFC1918 explicite du cabinet. L'admission refuse wildcard, IP publique, lien local, changement de port et UDP. DNS, pare-feu, accès LAN/Hyper-V et chaîne de confiance restent à qualifier ; aucune ouverture Internet ni proxy public n'est ajouté. Le listener mTLS natif demeure séparé des routes navigateur ; aucun header proxy, cookie ou Principal synthétique ne remplace le certificat client.

Le processus est UID/GID1001, système de fichiersRO, capacités supprimées, réseau interne `backend`, CPU1/mémoire1Gio sans swap supplémentaire/PID128. Il reçoit uniquement le DSN web **exactement égal** à celui de l'application, sans superutilisateur, rôle migration ou transport. Le bootstrap existant donne au rôle web DML sur les tables publiques hors ledgers, ce qui couvre les tables agent/certificat/commandes/reçus/artifacts et les lectures d'autorisation. Cela doit être confirmé par `bootstrap verify` après les migrations réellement installées ; le profil ne modifie ni grants, ni SQL, ni validations métier.

DB saine et migrations terminées sont des préconditions Compose. **Il n'existe pas de readiness métier du contrôleur dans cette contribution.** Aucune santé HTTP publique, test TCP ou existence PID n'est utilisée pour affirmer que mTLS, permission ou Windows fonctionnent. La santé est explicitement désactivée ; une entrée `running` de Compose n'est pas une qualification. Le runtime est long-vivant, mais `restart: no` évite une relance aveugle après état inconnu. L'opérateur doit qualifier puis démarrer ce seul service de manière explicite. Un poste éteint, verrouillé ou non associé n'est jamais déclaré exécutable par cette configuration.

## Arrêt, sauvegarde et restauration

Les opérations arrêtent le contrôleur avant les autres producteurs et avant DB/cache. Elles exigent sa fermeture native avec code0, sans OOM, kill ou état encore actif ; sinon HOLD immédiat, aucune poursuite de la sauvegarde. Le runtime natif conserve ses ressources jusqu'à clôture réseau, handlers et pools ; une limite Docker ne prouve pas leur clôture. Les états inconnus ne sont ni effacés ni rejoués. La restauration et le staging gardent tous les services arrêtés, sans extension de TTL, réparation SQL ou reprise automatique des commandes.

La configuration et les deux secrets restent dans le snapshot chiffré existant, avec UID/GID/modes conservés. L'outil n'ajoute aucun nouveau volume persistant. L'image du contrôleur doit porter les mêmes provenance/source/lock admis que les autres services et, si le worker est présent, le même digest. Les certificats doivent être disponibles indépendamment ; ce profil n'en émet aucun.

## Limites avant activation commerciale

Les tests locaux couvrent des modèles Compose synthétiques, le YAML réel, l'opt-in, les refus de réseau/secrets et la composition d'arrêt. Ils ne qualifient pas Docker, UID1001/Linux, restauration du nouveau profil, readiness mTLS ni Windows.

L'outil d'exploitation compare aussi la configuration effective de chaque contrôleur au modèle et à l'image admise : ID d'image, commande Node, entrypoint hérité exact, répertoire et UID/GID, environnement sans doublon ni ajout hors image/configuration, init, restrictions et limites CPU/mémoire/PID. Les modes PID/IPC hôte, périphériques, demandes de périphériques et tmpfs supplémentaires sont refusés. `HostConfig.PortBindings` doit correspondre exactement à l'interface privée prévue ; lorsque le conteneur tourne, `NetworkSettings.Ports` doit confirmer la même liaison et son inventaire de réseaux doit contenir uniquement le backend prévu. Un conteneur arrêté peut ne plus publier de port ou réseau effectif, sans supprimer le contrôle de sa configuration. Un écart bloque avant tout arrêt ou snapshot. Le témoin portable exerce le même chemin d'inspection, mais double Docker ; **cette attestation reste NON TESTÉE avec Docker réel**.

Aucune activation automatique n'est offerte par cette préparation. Le jalon natif devra vérifier les fichiers, image/source, commande et interface privée effectives, refus sans certificat et après révocation, transactions avec le rôle prévu, fermeture propre et sauvegarde/restauration cohérente. Ces gardes et un code de sortie ne constituent pas, seuls, une qualification métier.
