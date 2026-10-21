# Capture OpenAdapt possédée — raccordement interne

`record_capture` raccorde les contrôles locaux existants au Recorder natif patché.
Il ne reçoit aucune commande réseau, ne fournit aucune autorité et ne démarre
rien à l’import. Le caller de confiance reste responsable des permissions, de la
commande exacte, de sa qualification, de son lease/fence et de leur revalidation.
Le transport mTLS de préparation n’est pas un dispatcher.

## Entrée et parcours

La signature interne reste `record_capture(operation_digest, deadline_monotonic,
max_bytes, revalidate)` avec arguments nommés. Digest P00 exact, échéance monotone
finie dans les1800s, limite entière1–2Gio et callback d’autorité retournant seulement
`None` sont requis. Un booléen ne vaut jamais autorisation. Les environnements
Windows x64 interactifs limités sont contrôlés par les primitives déjà présentes.

Avant toute UI, le host vérifie Capture `1.3.0+memlia.1` et ses deux sources patchées
par hash/taille, Flow2.2.0 et le package agent installé0.0.0. Pas de repli vers
Capture non patché. Le verrou actuel ne ferme encore que le transport HTTP/Crypto :
il ne faut pas présenter ce contrôle comme une installation OpenAdapt acquise.

Le host possède successivement le mutex DesktopReservation, LocalStop et les vrais
contrôles Windows de consentement/indicateur. Il conserve chaque objet avant son
activation pour pouvoir retenir un état partiel. Après accord local, la factory
CaptureInputFactory lie le vrai HWND/processus/thread/session/digest et son délai.
Le filtre source-time existant exclut les commandes de l’UI avant persistance.
Il ne masque pas les pixels, les secrets ou toutes les applications du bureau.

Le Recorder tourne dans un `OwnedJob`, avec `-I -m
memlia_agent.openadapt_capture_worker`, environnement filtré et seulement les trois
pipes bornés existants. Aucun shell, chemin de commande réseau, pickle libre,
proxy ou variable secrète ambiante. HOME est hérité s’il existe, jamais réaffecté.
Le cwd est un nouveau répertoire privé. Python doit pouvoir importer le même
package installé en mode isolé ; PYTHONPATH n’est pas un mécanisme de déploiement.

Le worker désactive explicitement audio, vidéo, navigateur, profil envoyé,
observations structurelles et séquences d’arrêt du moteur. Il utilise les images
natives à2fps. Il publie `ready` seulement après `Recorder.wait_for_ready` et un
contrôle d’échéance. L’indicateur ne propose la fin normale qu’après ce constat.
Seul le clic local « Terminer l’enregistrement », revalidé par le host, crée le
fichier `finish` exclusif avec le même digest. Une fin autonome ne vaut pas fin
normale. Urgence, refus, lease perdu, délai, forçage ou EOF inconnu refusent.

Après la fermeture native du Recorder, `CaptureSession.load_verified` crée son
snapshot vérifié. `convert_capture` consomme ce snapshot via son API publique ;
aucun SQL ni reconstruction d’événements Memlia. Le snapshot est fermé avant la
livraison. Le host exige sortie0, Job vide, stdin livré, deux EOF et aucun forçage.
Les diagnostics Python ET natifs stdout sont dirigés vers le pipe stderr privé
borné ; stdout est réservé au reçu fermé. Le descripteur de sauvegarde temporaire
est non héritable puis fermé. Aucun diagnostic n’est publié.

## Limites, résultat et fermeture

Ce premier profil capture/conversion est borné à `min(max_bytes,32Mio)` pour tout
le staging actif,128fichiers et256entrées, chemins ASCII portables déjà utilisés
par le compilateur. Lecture finale8Mio/fichier ; les fichiers Flow normalisés
conservent les caps natifs existants (50événements, PNG4millions de pixels au stade
compilation). Un dépassement refuse ; aucun élément n’est tronqué ou supprimé pour
faire passer un résultat. L’inventaire coopératif n’est pas un quota disque atomique
ou une limite RAM. Le Job impose sa propriété/arrêt et les40Gio libres existants.
Les sorties natives sont plafonnées à8Kio stdout et64Kio stderr.

`CapturedRecording` contient des tuples de noms/bytes immuables : recording Flow,
bruts Capture, digest de commande et empreinte source calculée par le mécanisme
existant du compilateur. Son statut est `to_test`, jamais une procédure qualifiée.
Les octets bruts et `private_output` sont privés, masqués dans repr. Sur un refus,
`CaptureError.private_output` conserve le JobOutput borné obtenu avant parsing,
y compris les buffers partiels repris une seule fois après cleanup Job confirmé,
sans transformer leurs EOF faux en succès. Avant création IO, aucun buffer n’est
présumé disponible. Ne jamais sérialiser ces données ou les frames d’exception
dans une réponse publique. Un échec de transport/processus peut empêcher cette
capture ; une valeur absente reste inconnue.
Une exception Recorder/conversion conserve d’abord sa traceback sans variables
locales (12frames maximum) sur ce même pipe privé borné, avant le code de refus fixe.

Aucun résultat n’est livré avant Job fermé, staging nettoyé, arrêt acquitté auprès
de l’indicateur, UI fermée, LocalStop fermé puis mutex libéré. Le host revalide
encore autorité/échéance après cleanup. Si une étape est inconnue, le propriétaire
reste fortement retenu et `capture_hold` interdit un nouveau travail.
`reconcile_capture` ne reprend que cette fermeture, jamais la capture.
Une annulation au milieu de `recording_preparing` reprend son état pending réel
sous le verrou du contrôle : le Job connu fermé est acquitté avant de fermer l’UI.

Le caller produit doit persister les artefacts privés retenus avant de les perdre,
avec la politique de bruts locaux24h du plan. Cette persistance, un deuxième worker
neuf de compilation, l’admission/lease réseau, le replay natif qualifié et la page
Sim ne sont pas implémentés par cette couture. Aucun faux endpoint ni callback
réseau toujours vrai ne les remplace. Le verrou, les contrats et migrations restent
inchangés ; une installation et une recette Windows relues restent nécessaires.

## Tests et portée

Les tests exécutent le host et ses vraies opérations de fichiers. Win32, consentement,
Job, Recorder, CaptureSession et convert_capture sont des doubles externes déclarés,
jamais une preuve de capture Windows. Un sous-processus Python réel vérifie que les
écritures Python et FD natif ne corrompent pas le reçu. Liens/hardlinks réels, fin
native tardive, source non scellée, dépassement, annulation, autorité perdue et HOLD
sont couverts. Aucun ancien cas interactif n’est rejoué.

Les implémentations Microsoft/CPython sont réemployées :
[horloge monotone système](https://docs.python.org/3.12/library/time.html#time.monotonic),
[duplication et héritage des descripteurs](https://docs.python.org/3.12/library/os.html#os.dup2),
[spawn Windows](https://docs.python.org/3.12/library/multiprocessing.html#contexts-and-start-methods).
Ces contrats ne qualifient ni les ACL Windows du staging, ni les hooks source-time,
ni les latences Recorder/arrêt, ni la conversion réelle sur ce PC. Pas de capture,
replay, Office, service ou réglage de confiance exécuté dans ces tests Mac.
