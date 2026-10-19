# Transport Memlia pg-boss — préparation bornée P00/P03

Le `DatabaseJobQueue` Sim persiste `async_jobs` puis lance un runner en promesse
détachée. Ce port ajoute une livraison durable derrière cette frontière ; **ce
n’est pas encore une implémentation de JobQueueBackend**. Aucun nouveau moteur,
ordonnanceur, registre, contrôle d’autorité ou transaction d’admission/outbox.

`PgBossTransport.connect({connectionString, schema, queueName, onError})` ouvre un
client et crée sa queue standard si nécessaire. Le déploiement doit réserver son
schéma/sa queue ; pg-boss gère ses tables. Son scheduler est désactivé, Sim garde
la planification. Rôles DB/migrations et déploiement restent à intégrer.

- `publish(nativeJobId, envelope)` utilise le `JobEnvelopeSchema` canonique de
  `@memlia/contracts`, puis renvoie `{transportJobId, duplicate}`. L’ID Sim reste
  opaque, non vide, limité à512 unités UTF-16 ; aucun UUID exigé de l’appelant.
  Un UUIDv8 déterministe lie queue et ID natif ; le stockage interne contient
  cet ID, le SHA256 et l’enveloppe normalisée. Ordre des clés objet ignoré,
  ordre des tableaux conservé ; aucun second contrat réseau public.
- Une collision doit correspondre à l’ID natif, au digest **et au contenu complet**,
  sinon `identity_conflict`, sans modifier le job accepté. Des publications égales
  concurrentes donnent une seule livraison et le même identifiant.
- `work(handler)` remet `(nativeJobId, envelope, AbortSignal)` via le worker pg-boss,
  après validation identité/digest/schéma. Le futur runner Sim doit écrire son
  reçu durable avant retour/rejet. Un acquittement de transport n’est pas une
  réussite métier ; une exception devient un code fixe expurgé.
- Chaque envoi impose `retryLimit:0`, même pour une action réputée idempotente.
  Aucun retry après rejet, expiration ou mort du processus, ni API redrive cachée.
  Toute politique métier de reprise exige admission/réconciliation vérifiées.
- `stop()` refuse de nouvelles opérations, attend publications/registrations en
  vol, arrête le polling puis attend les promesses réelles des handlers, même
  expirés et même rejetées, avant fermeture du pool. L’état failed reste conservé.
  L’arrêt est idempotent ; il ne prouve ni effets externes vérifiés ni arrêt de
  travail détaché. Chaque handler doit inclure son travail dans sa promesse.
  Une promesse bloquée retient l’arrêt : le superviseur fixe un délai de processus
  et réconcilie un effet incertain, sans déguiser un arrêt forcé en succès.

## Limites de durabilité

`deleteAfterSeconds:0` conserve les lignes terminales indéfiniment. La déduplication
vaut seulement tant que la ligne existe : les lignes non actives expirent selon
la rétention pg-boss (14jours par défaut) et un administrateur peut supprimer
queue/schéma/lignes. Pas de tombstone applicatif. P03 doit composer admission,
outbox et rétention avant de garantir une déduplication bout en bout ; la
rétention illimitée nécessite aussi une politique de stockage.

Une réponse DB perdue donne `acceptance:'unknown'` : le send a pu committer.
Conserver l’admission native et réconcilier/réémettre **le même ID et la même
enveloppe**. Validation/conflit/fermeture sont rejected. Aucun message driver,
credential, payload ou exception métier dans les erreurs. `onError` est un
consommateur synchrone non levant, limité au code fixe de diagnostic.

Le schéma valide une forme, pas une autorité ni l’existence d’un runner enregistré.
Le futur adapter doit revérifier les droits et refuser tout runner non associé.
Statuts, annulation, batches, concurrence, attente, process-outbox et passes
planifiées doivent composer les mécanismes Sim existants ; ils ne sont pas
implicitement fournis par cette classe.

## Tests et dépendances

`MEMLIA_QUEUE_TEST_ENV_FILE` désigne le fichier privé de la DB dédiée P00. Le test
lit uniquement le mot de passe en mémoire et utilise localhost15432,
memlia/memlia_development. Ne jamais afficher ce fichier. Chaque essai crée un
schéma aléatoire `queue_<uuid>` conservé comme preuve ; pas de suppression de
ressource partagée.

Le manifeste isolé est `tests/memlia/queue/package.json`. L’intégrateur doit ajouter
pg-boss12.38.0, son peer OpenTelemetry et @memlia/contracts au manifeste/lock
applicatifs. Les essais préalables utilisent des dépendances jetables et un lien
node_modules ignoré, retiré après test. Lancer Bun test ou
`node --experimental-strip-types --test` sur le test adjacent.

Amont retenu : pg-boss12.38.0 MIT, source d4400859eed280b58c346f5289a0312913d558bd ;
queue/runners Sim Apache2.0. Ajouts Memlia sous droits réservés provisoires.
Détail des licences transitives et cinq erreurs TS2724 des déclarations pg-boss
sans skipLibCheck dans le rapport privé. Le typecheck ciblé avec skipLibCheck
comme Sim n’est pas un typecheck d’intégration.

NON TESTÉ : build Sim complet, workflow réel, transaction Drizzle, worker Linux,
crash après effet externe, intégration d’annulation et atomicité de l’outbox.
