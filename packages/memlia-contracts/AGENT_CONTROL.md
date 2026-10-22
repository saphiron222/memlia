# Canal de pilotage de l’agent Windows

La source unique est `src/agent-control.ts`, exportée en JSON Schema pour Python.
Le transport utilise exclusivement `POST /v1/agent/control`, sur un listener
HTTPS natif qui exige le certificat client. L’origine et la CA du listener sont
des paramètres explicites de l’installation. Aucune identité issue d’un header
de proxy, d’un cookie, du modèle ou du corps HTTP ne remplace le certificat.

Le client vérifie le schéma, l’opération et le `requestId` de chaque réponse.
Les requêtes sont du JSON compact UTF-8, sans BOM, clé dupliquée ou représentation
alternative : leur texte doit égaler la sérialisation JSON compacte du document
validé, sans imposer un tri des clés. Les champs de ce canal sont ASCII.
Les refus n’exposent que les deux codes fermés du contrat. Le serveur revalide
le certificat, son propriétaire et ses permissions à chaque appel ; les mutations
de commande vérifient également ces droits dans leur transaction.

`claim` réserve au plus une commande pour la session observée. `checkpoint`
renouvelle uniquement le bail de la commande déjà possédée ; il n’en modifie
ni le digest, ni les dates, ni les fences. Une commande expirée ou un bail perdu
ne peut pas être récupéré automatiquement. Le capabilityId préalloué dans la
commande ne constitue aucun consentement : seul `consent`, appelé après le
contrôle local natif, peut créer la capacité correspondant à ces mêmes valeurs.
La qualification et les références doivent être résolues et admises par le
serveur ; leur présence dans un JSON ne vaut pas admission au replay.

Chaque artefact opaque est borné à 33 Mio, chaque chunk décodé à 256 Kio ; une
publication comporte au plus 128 artefacts et 33 Mio au total. Un bundle compilé
reste limité à 128 fichiers internes, 8 Mio par fichier et 32 Mio décompressés ;
la marge de 1 Mio couvre son conteneur ZIP sans lever ces limites internes. Le serveur vérifie encodage
base64 canonique, offsets contigus, limites, digest complet et appartenance à la
commande. Une lecture avant consentement est limitée aux références explicitement
admises de cette commande. Une écriture exige sa capacité active. Les fichiers
restent privés, adressés par références opaques, sans chemin ni URL arbitraire.

L’upload d’un chunk persiste son offset par CAS ; des octets différents au même
offset sont refusés. Les uploads utilisent des chunks de 256 Kio, sauf le dernier
(ou le chunk vide d’un artefact de taille nulle). Un succès de capture/compilation
exige un export non vide. Aucun replay automatique n’est permis après une réponse
perdue. `publish` accepte uniquement un reçu de la commande/session/bail courant,
des artefacts complets vérifiés et une séquence attendue. Un reçu sans capacité
ne peut constater que l’attente du consentement, un arrêt ou un refus sans effet.
Un succès de capture/compilation constate seulement les artefacts préparés à
tester ; il ne qualifie pas leur futur replay ni un résultat métier. Les états
incertains restent bloquants et ne deviennent jamais une réussite par timeout.

Ces schémas sont un contrat de transport. Ils ne remplacent ni le stockage
durable, ni les vérifications sémantiques, ni le consentement Windows, ni les
signatures d’admission du moteur OpenAdapt.
