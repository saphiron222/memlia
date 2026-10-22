# Capture MIT — filtre d'entrée avant journal

Cette tranche ajoute une couture **inactive** au moteur Capture sélectionné et un
adapter Windows interne. Elle ne lève pas `capture_source_filter_unavailable`
dans `openadapt_capture.py`, ne lance pas Recorder et n'accepte aucun consentement.
Aucun dispatcher, route, commande P00 ou contrôle réseau ne peut l'activer.

## Source et local version

Base OpenAdapt `128fd58176f20b107ac4fb854887b8c548522bf6`, package Capture 1.3.0,
licence MIT. `openadapt-capture-1.3.0-source-time.patch` porte seulement :

- `openadapt_capture/recorder.py` : factory optionnelle transmise de Recorder
  jusqu'au reader ; `None` conserve la factory native ;
- `openadapt_capture/input_observer/windows.py` : ports protégés de rétention
  avant la réservation du journal ;
- `tests/test_input_observer.py` et `tests/test_input_observer_windows.py` :
  tests ajoutés, assertions historiques conservées ;
- seul champ `version` de `pyproject.toml` : `1.3.0+memlia.1`.

La version native provient de ce champ statique ; `__init__.__version__` lit déjà
`importlib.metadata.version`, sans autre fichier de version à patcher. Aucun
nouveau moteur, parseur, dépendance ou extra n'est ajouté au package amont.
Les commentaires `Modified by Memlia` identifient les deux sources modifiées.
La licence et les notices amont restent celles de Capture et doivent accompagner
le futur wheel. Cette licence ne s'applique pas implicitement à l'adapter Memlia.

## Rétention et journal

Une factory est transmise par identité, sans sérialisation maison ni variable
d'environnement. Le worker emploie `CaptureInputFactory`, objet de référence
module contenant uniquement des scalaires immuables validés. Aucun lock, fenêtre
Python vivante, closure ou booléen d'autorité réseau n'est transporté. L'observer
est construit dans le worker ; il n'est pas transmis à Windows spawn.

Les hooks protégés `_retain_keyboard` et `_retain_mouse` renvoient par défaut
`True`, sans nouvelle observation Windows. La sous-classe créée par l'adapter les
réemploie ; aucun monkeypatch global ou `live_event_tap` n'est installé.
Une suppression a lieu avant `_reserve_receipt`. L'activité native reste marquée
pour les frontières de frames ; aucun événement supprimé ne réserve une place
ou n'atteint `_emit_received`. Les transitions passent encore par la normalisation
native, y compris les modificateurs/dead keys et leurs releases. Une file saturée,
une erreur de filtre, une réponse non booléenne ou une réservation sur une
transition supprimée restent des refus, jamais une perte silencieuse.

## Binding Windows interne

`CaptureInputFactory.from_controls(controls, operation_digest=...)` est réservé au
futur host possédant le vrai contrôle local. Il exige le type natif exact, ses
checkpoints et le même digest ; une fixture `accept=True` ne le remplace pas.
Le profil emporte PID et naissance du processus UI, HWND/TID exacts, SID/session,
digest et échéance monotone. Il n'est ni une autorité serveur ni une preuve de
présence physique. Il ne doit jamais être construit depuis une requête modèle.

Le worker revalide ces scalaires et les observations Windows avant construction
et avant chaque décision d'entrée, puis après la résolution de la fenêtre. Les
API sont en lecture seule et réutilisent `observe_session` et les signatures
Win32 du package. Identité, fenêtre, session ou échéance inconnue/changée : refus
fixe `capture_input_filter_unavailable`, sans message natif ni contenu d'événement.
Aucun HWND/PID observé ou texte de frappe n'est journalisé par l'adapter.

Les événements dirigés vers la fenêtre UI ou le même processus possédé sont
supprimés. Les paires down/up supprimées restent supprimées après changement de
focus. Traverser depuis une pression déjà retenue vers Memlia refuse l'ensemble
du recording, pour ne pas produire de demi-geste. Une release métier orpheline
refuse ; une release arrivant dans Memlia au début ne devient pas un geste métier.
Ctrl+Alt+Shift+F11 est une urgence, jamais une fin normale : le recording entier
reste inutilisable, sans troncature après coup. Le host conserve LocalStop monotone.

Ce binding ne protège pas contre un utilisateur Windows compromis ni un code déjà
hostile dans le même processus. Un HWND peut être réutilisé dans le même processus
et thread ; les observations de naissance du processus ne fournissent pas une
naissance de fenêtre. La durée de vie du vrai contrôle local et ses checkpoints
restent indispensables. Ce filtre ne crée ni JobObject, ni consentement, ni lease.

## Limites de qualification

L'exclusion porte sur les entrées, pas sur les pixels. L'indicateur peut encore
apparaître dans une capture globale. Aucun masque de mot de passe, texte, secret,
nom de fenêtre ou donnée personnelle universel n'est annoncé. Une page Sim peut
partager le processus/fenêtre d'un outil métier : ce lot ne permet pas d'exclure
arbitrairement un navigateur entier ou de qualifier ce parcours.

Les modules observer/normalisation peuvent être exercés hors Windows avec des API
Win32 doublées. L'extraction ciblée de `read_input_events` évite explicitement
l'initialisation de Recorder ; elle ne qualifie pas son démarrage complet. Le
positif humain, les vrais hooks/latences, les changements de bureau, le source-time
native, le transport Windows spawn, les pixels et la capture composée restent à
qualifier sous une recette relue. Une suite portable verte n'autorise pas une
capture. Le host demeure bloqué avant tout effet jusqu'à ces preuves.

## Reconstruction offline vérifiée

Utiliser le seul package Capture et sa licence du ZIP source figé, vérifier les
hashes avant application et refuser tout delta hors les cinq chemins listés.
Réemployer Hatchling 1.32.4 dans un environnement privé, sans resolver, réseau,
extra ou installation globale. La copie de construction doit être hors de tout
dépôt Git détectable. Si elle se trouve sous un dépôt parent, fixer explicitement
`GIT_CEILING_DIRECTORIES` à son parent et refuser si `git rev-parse
--show-toplevel` ne retourne pas 128 avec une sortie vide. Sans cette précaution,
`git apply` peut ignorer les chemins alors qu'il retourne zéro. Le premier refus
de préparation de cette tranche a été conservé avant toute invocation du backend.

Dans cette copie isolée :

```sh
git apply --check openadapt-capture-1.3.0-source-time.patch
git apply openadapt-capture-1.3.0-source-time.patch
SOURCE_DATE_EPOCH=<commit-source> python -m hatchling build -t wheel
```

Vérifier ensuite les cinq fichiers appliqués contre les octets épinglés, avant
l'appel au backend. Le processus testé utilise `GIT_CONFIG_GLOBAL=/dev/null` et
`GIT_CONFIG_NOSYSTEM=1`, sans `--unsafe-paths` ni réécriture manuelle du patch.

Le wheel local doit porter `1.3.0+memlia.1`, sa licence MIT intacte et ses nouveaux
RECORD/METADATA natifs. Sa closure doit rester identique à celle de la base, hors
version. Seuls les deux fichiers Python runtime listés peuvent différer.
L'adapter vérifie la local version et les hashes des deux sources installées avant
import de l'observer ; aucun fallback vers la roue 1.3.0 non patchée n'est admis.
Deux builds propres ont produit le même fichier de 353 673 octets, SHA256
`adea28a87d7bd35617732f458a1ab02593ee3d9f7461b4c9ad8f8ae0e3cb10ba`.
Ses 79 membres et chaque entrée RECORD sont vérifiés ; 74 fichiers runtime sont
présents, dont 72 identiques à l'amont et les deux seuls fichiers modifiés listés
ci-dessus. La licence et le point d'entrée CLI sont exacts. Le hook METADATA natif
sur le projet amont vierge donne les mêmes octets après remplacement de la seule
Version ; dépendances déclarées et extras sont donc inchangés. Cette comparaison
ne résout ni n'installe leur environnement complet et ne qualifie pas Recorder.
`SOURCE_DATE_EPOCH` vaut `1792359874`, époque du commit source figé.
Aucune roue, donnée de fixture ou environnement privé n'est publié dans ces sources.

Sources Win32 primaires : [GetProcessTimes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes)
retourne la naissance via FILETIME ; [GetWindowThreadProcessId](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getwindowthreadprocessid)
lie la fenêtre au thread/processus ; [WindowFromPoint](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-windowfrompoint)
et [GetAncestor](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getancestor)
servent à résoudre la fenêtre racine, avec leurs limites Windows (dont fenêtres
masquées/désactivées). [GetAsyncKeyState](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getasynckeystate)
fournit l'état courant des modificateurs ; son bit historique bas n'est pas utilisé.

## Licence des portions amont et du patch

Texte original de Capture (conservé intégralement dans le futur wheel) :

```text
MIT License

Copyright (c) 2025-2026 OpenAdapt.AI

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

```

Le patch dérivé conserve cette licence MIT. L’adapter et ses tests Memlia restent
sous droits réservés, comme le LICENSE du package agent.
