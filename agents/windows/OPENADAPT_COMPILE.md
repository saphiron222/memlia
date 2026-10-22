# Compilation locale OpenAdapt — P08-A

`memlia_agent.openadapt_compile.compile_raw_recording` est une adaptation interne
du compilateur **OpenAdapt Flow 2.2.0**, avec Types0.24.0, RapidOCR1.4.4 et
ONNX Runtime1.31.0. Elle ne contient ni moteur de capture, ni interpréteur de
workflows, ni lanceur/dispatcher. Elle n'est branchée à aucune commande, route,
interface ou service. Les ajouts Memlia restent sous droits réservés.

## Entrée et préconditions

L'entrée est exactement un `dict[str, bytes]`, copié en tuple trié de références
immuables **avant tout IO**. Aucun objet sérialisable arbitraire, chemin de source
utilisateur, archive ou outil fourni par un modèle. `name` est une donnée transmise
au compilateur, jamais un chemin ou une commande. La deadline monotone absolue et
l'éventuel `threading.Event` d'annulation viennent du futur appelant serveur/agent
de confiance ; le module ne confère aucune autorité.

Le profil **raw-recording-v1** attend les fichiers **Flow normalisés**, tels que
produits par `openadapt_flow.adapters.capture.convert_capture`, pas les mouvements
bruts des hooks Capture, une vidéo ou une base SQLite. Il exige `meta.json` et
`events.jsonl`, conserve `check.json` et tous les autres fichiers admis sans les
réécrire. Les actions/paramètres/checks restent validés par les schémas et le
compilateur natifs. Aucun parseur sémantique Memlia ne les remplace.

Les marqueurs `.openadapt-approval.json`, `.openadapt-sanitization.json` et les
fichiers `*.approved.zip` sont **refusés**, jamais retirés silencieusement. Le
chemin natif d'approbation vérifie la dérivée entière et une archive sœur ; ce
profil ne prétend pas le prendre en charge. Une future extension devra réutiliser
ce validateur dans son intégralité.

Limites d'admission de ce petit profil, sans troncature :

| Ressource | Plafond |
|---|---|
| Entrée | 128 fichiers, 32Mio agrégés, 8Mio par fichier |
| meta.json / check.json | 256Kio chacun |
| events.jsonl normalisé | 1Mio, 50 lignes non vides, 64Kio par ligne |
| PNG | 4 millions de pixels, format/vérification via Pillow existant |
| Sortie | 128 fichiers, 32Mio agrégés, 8Mio par fichier, 50 steps natifs |

Les noms sont un sous-profil portable ASCII visible, sans espaces ni `~` (alias
Windows8.3), chemins absolus/traversal/ADS, noms de devices Windows, segments
terminés par point, collision de casse, ou collision fichier/répertoire. Profondeur
≤8, segment≤128 et chemin≤240 caractères. Ce sous-profil n'est pas présenté comme
la grammaire universelle de Flow. Les fichiers spéciaux, liens symboliques,
reparse points et hardlinks de sortie sont refusés ; les seules sources acceptées
sont des bytes, donc elles ne portent aucune référence à un lien sur disque.

## Processus et confidentialité

**Processus Python neuf obligatoire**, environnement filtré fourni par le futur
lanceur supervisé, `ORT_DISABLE_TELEMETRY=1` fixé avant initialisation et
`OPENADAPT_FLOW_OCR=rapidocr`. Le module refuse un second job, un appel hors du
thread principal, des threads Python concurrents et un moteur ONNX/RapidOCR/Flow
déjà dans `sys.modules`. Ces vérifications ne prouvent pas à elles seules qu'un
interpréteur est neuf : cette propriété appartient au lanceur futur. Aucun
lanceur produit n'est ajouté ici. Ne pas appeler cette fonction dans le processus
agent durable ou dans un serveur web.

Après vérification des quatre versions, le worker appelle l'API publique
`onnxruntime.disable_telemetry_events()` avant d'importer le compilateur. La
[politique du tag ONNX1.31.0](https://raw.githubusercontent.com/microsoft/onnxruntime/v1.31.0/docs/Privacy.md)
documente un opt-out1DS précoce par environnement ; l'API seule peut arriver après
un événement initial. Windows ETW est distinct. **Aucune garantie d'egress OS**
n'est attribuée à ces réglages.

`annotate=False`, `mine_effects=False` et `admit_api_bindings=False` sont transmis
explicitement à `compile_recording`. Aucun annotateur ou endpoint d'admission ne
peut être passé par l'appelant. L'OCR reste nécessaire : RapidOCR construit ses
trois sessions ONNX avec les poids embarqués. Ce pin ne télécharge pas les poids
dans le chemin lu, mais l'absence de tout réseau natif n'est pas qualifiée.

Le worker neuf chargé des captures Windows transmet aussi le paramètre natif
`target_surface='windows'`. Le compilateur Flow résout la surface et le mode
d'exécution, et refuse lui-même une surface contradictoire dans le recording.
Memlia ne réécrit ni `meta.json` ni `backend_hints`. Le loader natif doit relire
`surface == 'windows'` dans le bundle, sinon aucun résultat n'est livré.
Le port générique conserve `target_surface=None` par défaut (kwarg omis) ; seul
`None` ou la chaîne exacte `windows` est accepté avant IO. Cette liaison indique
la surface d'exécution ; le statut reste `to_test`, sans qualification ni accord
de replay de production.

Le staging appartient au worker, racine/répertoires0700 et fichiers0600 sur POSIX ;
umask077 temporaire restauré. **Une ACL Windows n'est pas qualifiée par chmod** :
le répertoire utilisateur/temp et l'installateur devront être qualifiés sur cet
OS. Les caps ne constituent ni un plafond RAM ni un sandbox. ONNX peut créer des
threads natifs ; un seul job n'est pas une preuve d'inférence monothread.

Les logs Python du moteur et ses stdout/stderr Python sont désactivés/écartés
pendant la compilation. Un `NullHandler` temporaire possédé empêche les appels
standards `logging.error(...)` d'installer implicitement un handler lié au flux
temporaire. Il est retiré à la fin, sans fermer ni remplacer les handlers du
caller. Les diagnostics après compilation ne restent donc pas liés à ce flux
fermé, y compris après un refus. Les exceptions publiques contiennent seulement un code
fixe, sans cause/contexte natif. Aucun dump de données, d'environnement ou de
version de clé. Les sorties C natives ne sont pas interceptées par cette fonction :
le futur lanceur doit conserver ses propres FD/logs privés bornés, sans publication.
Le module ne charge pas de secret. La configuration de confidentialité Presidio
optionnelle du runtime doit rester explicitement qualifiée ; les fixtures fictives
peuvent sélectionner `OPENADAPT_FLOW_SCRUB=off`, sans promesse de désidentification.

## Sortie et arrêt

Le résultat immutable contient les fichiers opaques et leurs SHA256, les versions,
le nombre de steps lu par le schéma natif, et les deux empreintes source/bundle.
Les empreintes sont SHA256 du domaine respectif
`memlia.raw-recording-v1\0` / `memlia.openadapt-bundle/v1\0`, puis de chaque fichier
trié : longueur du chemin ASCII sur4octets big-endian, chemin, longueur du contenu
sur8octets big-endian, contenu. Le contenu n'est pas concaténé en une archive géante.
Le loader natif valide structure/intégrité ; ses références d'assets sont d'abord
contrôlées comme chemins internes existants. Une deuxième capture de sortie vérifie
qu'aucun octet n'a changé pendant cette validation.

### Identité des fichiers entre vues système

L'énumération fournit les chemins ; leur identité provient de
`os.stat(path, follow_symlinks=False)`, pas de `DirEntry.stat`. La
[documentation Python 3.12](https://docs.python.org/3.12/library/os.html#os.DirEntry.stat)
indique que Windows met dev/ino/nlink à zéro dans cette dernière vue. Le contrôle
de fichier régulier, lien unique et absence de reparse point reste obligatoire ;
un nombre de liens nul n'est jamais accepté comme identité de remplacement.

Sur Windows, la comparaison entre stat de chemin et fstat exige dev/ino/nlink,
taille, mtime et **st_birthtime_ns entier strictement positif** identiques. Une
valeur absente ou non valide refuse. Le [problème CPython documenté](https://github.com/python/cpython/issues/157671)
explique pourquoi ctime peut différer entre ces vues. Ce champ est omis seulement
pour cette comparaison inter-vues Windows : il reste obligatoire pour comparer
fstat avant/après et stat du chemin avant/après. Les changements de birthtime,
liens, identité, taille, mtime ou ctime dans une même vue refusent la sortie.
Sur POSIX, ctime reste aussi dans les comparaisons inter-vues.

Le chemin est recontrôlé non suivi après lecture et comparé au descripteur encore
ouvert ; une substitution de chemin, un lien ou reparse point n'autorise pas la
livraison des anciens octets. Ces observations ne sont ni un verrou exclusif du
fichier ni une isolation contre le même compte compromis. Aucune mutation ne peut
être annulée par ces contrôles.

`workflow.py` est **opaque, jamais exécuté/importé**. Les fichiers workflow.json,
manifest.json et workflow.py sont requis ; annotations.json est refusé dans ce
profil sans annotation. Les rendus/crops peuvent contenir des valeurs littérales
ou pixels sensibles : le hash n'est ni un filtre de secrets, ni une autorisation
de partage. Aucun artefact n'est livré avant nettoyage réussi et dernier contrôle
d'annulation/d'échéance. La sortie est exclusivement **`status='to_test'`** ; elle
n'est ni prête ni approuvée, et ne correspond pas à un succès métier de replay.

Les checkpoints ne préemptent pas l'OCR synchrone/une extension C ; **la deadline
murale et le nettoyage du processus complet restent à la charge du futur lanceur
possédé**. Aucun annulateur de capture ni rollback d'effet n'est fabriqué ici.
Interruption Python préservée ; absence/échec de cleanup ⇒ aucun bundle livré.

Codes fixes : `invalid_recording`, `approved_recording_unsupported`, `invalid_path`,
`recording_limit`, `invalid_request`, `fresh_worker_required`, `runtime_unavailable`,
`invalid_image`, `compile_cancelled`, `compile_timeout`, `invalid_output`,
`output_limit`, `compile_failed`, `compile_cleanup_failed`.

## Provenance et qualification

API examinée dans OpenAdapt `128fd58176f20b107ac4fb854887b8c548522bf6` :
`compiler/compile.py:1800`, `compiler/readback_authoring.py:340`, `ir.py:2591`,
`vision/ocr.py:45`, `sanitized_artifact.py:1157`. API MIT réutilisée par import ;
aucune source du compilateur, règle OCR ou fixture OpenAdapt copiée ici.

Les [attributions RapidOCR1.4.4](https://raw.githubusercontent.com/RapidAI/RapidOCR/v1.4.4/README.md)
séparent le copyright des modèles Baidu du code du projet Apache2.0. La roue locale
contient les trois poids mais pas le texte Apache ; le futur artefact doit reprendre
ce texte/attributions et vérifier leur provenance. ONNXMIT et ses tiers, OpenCV et
ses codecs, NumPy et ses tiers, ainsi que **GEOS LGPL2.1 embarqué par Shapely** ne
deviennent pas droits réservés Memlia. Aucune roue ni poids n'est ajouté à ce lot.
`requirements.lock` agent ne ferme toujours que TLS/crypto, pas toute la pile Flow.

Les tests de cette tranche exercent les vrais fichiers, permissions POSIX et Pillow.
**Flow, ses schémas/loader et ONNX sont explicitement doublés** faute d'environnement
qualifié : ils vérifient composition/kwargs/ordre et refus, pas la compilation.
Compilation native, mémoire/threads OCR, télémétrie/egress et Windows sont
**NON TESTÉS**. Ni capture ni replay n'ont été lancés. La recette future doit utiliser
le vrai moteur dans un nouveau worker sur un recording entièrement fictif, vérifier
le bundle natif et les refus, sans remplacer un échec par un fake. Elle n'accorde
aucun consentement local ni droit serveur et ne clôt pas le lot P08 commercial.

Le correctif d'identité est testé avec de vrais fichiers/descripteurs POSIX et
des vues de métadonnées Windows explicitement doublées. Les 32 méthodes de test
antérieures sont conservées. Les observations Windows d'un journal fictif ont
montré DirEntry dev/ino/nlink nuls et ctime différent entre lstat/fstat ; elles
n'étaient pas une observation du fichier de sortie Flow refusé. La cause effective
du résultat natif `invalid_output` ne sera établie qu'au rejeu Windows ultérieur
relu. Ce correctif, le vrai OCR/loader et les garanties ACL/egress ne sont pas
qualifiés par les tests portables. Le lecteur privé du journal et ses refus sont
inchangés par ce lot.
