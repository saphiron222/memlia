# Dépendances de cette tranche

Aucune dépendance Python d’exécution hors bibliothèque standard n’est déclarée.
Le laboratoire utilise CPython3.12.15 x64 isolé, déjà préparé et figé en P00.
Les modules ctypes, dataclasses, threading, unittest et autres modules standard
conservent la licence de Python ([PSF et notices](https://docs.python.org/3.12/license.html)).
Les API Win32 sont fournies par Windows ; aucune DLL système n’est copiée dans
ce package. L’utilisation de Windows demeure soumise aux droits de son installation.

Le backend de construction `setuptools==80.9.0` est le même outil de build MIT
déjà retenu pour memlia-contracts. Il n’est pas une dépendance runtime et ne requiert
ni téléchargement ni installation globale pour les tests à partir des sources.
Un futur gel Python/installer doit produire son propre inventaire et conserver
les licences/notices de Python et de ses binaires ; cette tranche ne qualifie
pas encore un bundle Windows commercial ou OpenAdapt.

Les nouveaux fichiers Memlia restent privés, avec droits réservés en attendant
le choix du propriétaire. Leur présence auprès de code Apache/MIT n’accorde
aucune licence permissive implicite.
