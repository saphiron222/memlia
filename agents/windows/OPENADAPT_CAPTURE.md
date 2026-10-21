# Capture OpenAdapt — propriétaire et refus avant enregistrement

Cette tranche prépare une frontière d'orchestration **inactive**. Elle ne lance
ni `Recorder`, ni interface locale, ni worker, ni conversion ou compilation.
`record_capture` refuse sur Windows avec `capture_source_filter_unavailable`
après revalidation de l'autorité courante. Hors Windows, il refuse avec
`capture_runtime_unavailable`. Aucun booléen réseau ou paramètre ne lève ce refus.
Il n'existe aucun résultat réussi, même si le port interne retourne par erreur.

Les contrôles locaux existants restent ceux de `capture_controls.py`,
`stop.py`, `resources.py` et `session.py`. Ce module ne fournit ni authentification,
ni consentement, ni bail/fence, ni nouvelle identité. Aucun dispatcher, route ou
commande P00 n'est raccordé. Il n'importe pas les moteurs OpenAdapt/ONNX et ne
modifie pas les dépendances ou le verrou.

## Contrat interne

`record_capture(operation_digest=..., deadline_monotonic=..., max_bytes=...,
revalidate=...)` est réservé à un futur caller serveur de confiance :

- digest exact `sha256:` suivi de 64 caractères hexadécimaux minuscules ; il reste
  interne, ne remplace pas la description lisible et la décision locale ;
- échéance monotone finie, dans les 1 800 secondes à venir ;
- `max_bytes` entier entre 1 et 2 147 483 648, sans booléen ;
- callback d'autorité/session/lease courant obligatoire, dont le seul retour
  admis est `None`. Un booléen, une exception ou une échéance dépassée refuse.

Le callback ne constitue pas un nouveau mécanisme d'autorité. Son implémentation
future doit réutiliser les contrôles natifs à chaque action et à l'acceptation de
la fin normale. Les bornes sont validées mais aucune capture ne les exerce ici.
L'appel synchrone du callback n'est pas préempté par l'échéance ; le retour tardif
est refusé. La supervision possédée du futur host restera nécessaire.

## Propriété et HOLD

Un registre conserve une référence forte au propriétaire, lié au processus,
à l'objet Thread et à son identifiant natif. Il refuse toute réentrée tant que
le précédent owner n'a pas confirmé son cleanup. Aucune portée `with/finally`
externe n'est chargée de libérer implicitement les ressources retenues.

Le lifecycle de cleanup est prêt à recevoir les objets possédés du futur host :
demander l'arrêt monotone, constater/fermer le Job, nettoyer les fichiers possédés,
accuser l'arrêt auprès de l'indicateur, fermer cet indicateur, fermer LocalStop,
puis fermer DesktopReservation. Ces objets ne sont **pas créés** par cette tranche.
Une erreur ou un résultat inconnu interrompt cette séquence, garde les références
restantes et renvoie `capture_hold` avant toute reprise. Le caller ne doit pas
extraire ces objets pour les fermer à travers son propre unwind.

`reconcile_capture()` retente uniquement le cleanup du même owner, sur le même
thread vivant. Il ne recommence aucune capture, n'accepte aucune démonstration et
ne remet jamais LocalStop à zéro. Si le thread propriétaire disparaît ou si la
propriété native ne peut plus être établie, l'agent demeure non réutilisable ;
une réconciliation native distincte est requise. Le registre Python ne promet ni
survie après crash du processus, ni isolation contre ce compte Windows compromis.
La primitive DesktopReservation conserve ses limites propres de fermeture native.

## Manque démontré avant capture

Dans Capture 1.3.0, `Recorder` appelle `record`, puis `read_input_events`, qui
construit directement `create_input_observer`. Les hooks Windows réservent une
position dans le journal **avant** livraison/normalisation. Aucun paramètre
public n'injecte actuellement un filtre/factory d'entrée permettant d'exclure
la fenêtre et les commandes Memlia à cet endroit.

`live_event_tap` reçoit une copie après persistance. Supprimer ou tronquer ensuite
« Terminer l'enregistrement » n'est donc pas une solution admise. Les événements
normalisés ne contiennent pas de HWND/PID ; la détection de la séquence d'arrêt
native arrive après `handle_key`. Une suppression après réservation peut aussi
laisser une place de journal inachevée. La prochaine couture doit décider au
temps source avant réservation, préserver l'ordre et l'état clavier, et refuser
une identité de fenêtre/processus inconnue. Aucun patch global/monkeypatch n'est
présent ici. Une démonstration contenant la commande Memlia n'est pas prête.

Le futur parcours doit distinguer la fin normale locale, revalidée contre
l'autorité/session/lease, de l'urgence, du forçage et de l'incertitude. Un Job
fermé de force ou un cleanup inconnu interdit conversion/compilation. Le moteur
Capture reste responsable du recording ; `CaptureSession.load_verified`,
`convert_capture` puis `compile_raw_recording` dans un processus neuf restent
les réemplois prévus. Ils ne sont pas exécutés par cette préparation.

## Preuves et limites

Les tests portables vérifient validation/refus, absence d'import moteur,
propriété du thread, réentrée, arrêt avant cleanup, rétention HOLD et ordre de
libération. Les objets Job/fichiers/UI/stop/réservation y sont des doubles
explicitement nommés. Ils n'accordent aucune décision locale et n'exercent aucun
desktop ni JobObject natif. Les primitives déjà qualifiées ont leurs reçus
historiques séparés ; ce module ne se réattribue pas cette qualification.

Consentement humain positif, capture native, indicateur pendant une vraie
capture, filtrage source-time, limites de stockage en activité, arrêt/reap,
conversion et compilation composées, ACL temporaires, egress et packaging de
ce host restent **NON TESTÉS / bloqués**. Aucune protection universelle des mots
de passe, pixels, textes ou noms de fenêtres n'est annoncée. Aucun changement
Windows, confiance globale, capture, Office ou replay n'a lieu dans ce lot.

Les trois ajouts Memlia gardent leurs droits réservés. Les moteurs OpenAdapt
retenus restent MIT et ne sont ni copiés ni redistribués par cette tranche.
