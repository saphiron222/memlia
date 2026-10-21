# Processus déclaratif Excel — transport interne v1

`memlia_excel.process` est une entrée fixe vers `prepare_procedure`. Le module
Sim `lib/execution/sandbox/excel-process.ts` lance uniquement l'interpréteur
installé choisi par le serveur, avec les arguments fixes
`-I -B -m memlia_excel.process`. Il réemploie les champs `signal` et `requestId`
de `RunSandboxTaskOptions`, pas la capacité JS/code des tâches V8 ou les commandes
des providers E2B/Daytona. Aucun registre, route, workflow, ordonnanceur ou choix
de provider n'est ajouté/activé.

Un appel explicite retourne seulement un ensemble complet de nouveaux octets
XLSX, relus par le noyau. **Ce transport n'est pas une sandbox OS, une autorité,
un reçu de publication ni un lancement de job Sim.** Le déploiement devra encore
isoler Linux non-root, filesystem hors temporaire en lecture seule, réseau,
CPU/RAM/PID/disque et descendants, puis brancher autorité, admission et publication.

## Entrée

Un seul objet JSON UTF-8 puis EOF arrive sur stdin. Les champs sont exactement :

- `schemaVersion: "memlia.excel-process/v1"`, `requestId` non vide (128 caractères),
  `profile: "memlia.excel-memory/a1-header-v1"` ; ces deux constantes sont posées
  par le caller Sim et ne sont pas une autorité.
- `procedure` : **ExcelProcedure entière**, validée par le contrat canonique TS
  puis par le package Python installé. Aucun champ du contrat n'est retiré pour
  exécuter seulement les opérations. Le noyau conserve tous ses refus de profil,
  références, contrôles, types, limites et readback.
- `sources` : dictionnaire rôle → `{bindingId,sheetId,sheetName,contentBase64,sha256}`.
- `targets` : dictionnaire rôle → `{bindingId,sheetId,sheetName}`.

Rôles et métadonnées ont au plus 128 caractères, 1..32 entrées par dictionnaire.
Les contraintes plus strictes du noyau restent applicables (feuille 31 caractères,
références exactes, sortie distincte des sources). Les bindings/artefacts doivent
avoir été résolus et autorisés **avant** cet appel ; leurs chaînes ne le prouvent
pas. Aucun chemin, URL, commande, argv ou environnement n'est reçu en données.
Les champs inconnus, doublons de clés JSON, trailing JSON, non-finis, base64 non
canonique et digest faux sont refusés. Les getters/toJSON/sous-classes ne sont
pas exécutés par la capture JSON stricte native du caller.

Les plafonds sont 512 Kio pour la procédure, 10 000 000 octets cumulés de XLSX,
14 Mio de transport. Le caller et le worker bornent le base64 avant décodage.
Le worker lit au plus14 Mio+1 ; sans EOF le caller arrête à l'échéance. Les octets
source restent privés dans les pipes/mémoire, jamais arguments ou logs.

## Sortie et refus

Le succès est un JSON compact UTF-8 avec un seul LF final, dans l'ordre de champs
émis par le worker : `schemaVersion`, `requestId`, `status`, `published`,
`outputs`, `controls`. `status` reste `prepared_in_memory`, `published` reste false.
Chaque sortie contient `role,bindingId,sheetId,contentBase64,sha256` ; chaque
observation `index,kind,severity,satisfied`. Aucun chemin physique n'est renvoyé.

Le caller revalide forme stricte, identité de requête, nombre et références de
toutes sorties et tous contrôles, absence de doublon, succès des contrôles
blocking, octets non vides/base64/digests et budget cumulé 10 M. Il exige la sérialisation exacte
après validation : doublons de clés, ajouts, trailing input ou encodage UTF-8
malformé ne sont pas silencieusement normalisés. Les sorties sont rendues comme
Buffer possédés, uniquement après exit 0 et nettoyage du répertoire temporaire.
Le readback XLSX appartient au noyau Python ; le caller ne crée pas un parseur XLSX.

Un refus enfant est `{schemaVersion,status:"refused",code}` et exit 2, avec un code
fixe parmi invalid_request/input_limit/procedure_refused/output_limit/runtime_unavailable.
Il ne transporte ni valeur, exception, chemin, cause native, ni sortie partielle.
Le caller replie refus, erreur, sortie incomplète, dépassement ou interruption
vers `excel_process_refused`, sans journaliser stdin/stdout/stderr. Il ne rejoue
jamais un appel et n'interprète jamais un refus comme une autorisation de fallback.

## Processus possédé et environnement

Le caller reçoit séparément deux chemins **serveur** absolus : interpréteur
installé et racine temporaire privée appartenant au UID courant (mode 0700).
Il crée un nouveau sous-répertoire 0700, utilisé comme cwd/HOME/TMPDIR avant import
Python. Le worker refuse TMPDIR manquant, lien, non privé ou non possédé. Le
packager existant reste responsable de la provenance des paquets ; ce module ne
valide pas une installation arbitraire et ne télécharge rien.

L'environnement transmis est fermé : PATH système, HOME/TMPDIR privés, locale,
un thread Polars/BLAS/OMP et flags Python ; aucun DSN, clé API ou environnement de
l'application. `shell:false`, aucune commande/gabarit reçu de l'IR. Le stdout est
borné14 Mio et stderr 64 Kio ; tout stderr non vide refuse le résultat. La limite de
temps est min(limite déclarée, 120 s). Timeout, overflow et AbortSignal déclenchent
TERM puis KILL après 1 s pour l'enfant encore possédé, et attendent sa clôture avant
retour/nettoyage. Aucun signal de groupe global/PID arbitraire n'est utilisé.
Une panne OS empêchant la clôture nécessite le superviseur externe du job ; le
processus seul ne garantit pas le confinement ou le nettoyage de descendants
qui s'échappent. Aucune interruption ne promet d'annuler un effet externe ; le
profil présent ne publie aucun fichier et le temporaire natif openpyxl est privé.

## Tests et activation

Tests Python : vrais enfants, contrat canonique, Polars/openpyxl et XLSX fictifs,
refus fermés, source inchangée, aucun temporaire restant. Tests TS : vrais enfants
avec programme de protocole doublé pour erreurs/overflow/cancel, et composition
vers les deux wheels réellement installés en venv neuf par `scripts/package.py`.
Le test installé exige `MEMLIA_TEST_EXCEL_RUNTIME` explicitement : absence est un
échec, pas un téléchargement ni repli PYTHONPATH. Les données de test sont fictives.
Les autres tests Python peuvent utiliser les sources dans leur environnement de
test ; ce fait est distinct de l'exécution installée `-I`.

Les tests Mac ne qualifient ni Linux/ABI, ni container, réseau isolé, protection FS,
Windows/Office, budgets de job commercial, dépôt durable, approbations ou écriture
atomique. Le packaging, contrats, noyau et port général restent inchangés. Le
raccordement à un job Sim autorisé et à une vraie image Linux est une gate suivante,
pas une propriété déduite de l'existence de ce processus.
