# Adresse d’écoute du service realtime

`REALTIME_HOST` est une option de l’opérateur, lue et validée au démarrage du serveur. Elle accepte une adresse IP littérale IPv4 ou IPv6. Sans cette variable, l’écoute reste `0.0.0.0`, comme auparavant pour les conteneurs. Une valeur explicitement vide, une URL, un nom DNS ou une adresse invalide provoque un refus de configuration ; elle ne rétablit pas implicitement l’écoute générale.

Pour un service de développement accessible uniquement sur la machine, définir `REALTIME_HOST=127.0.0.1` avec un `PORT` possédé. Le client doit viser cette même origine et l’origine HTTP de l’application doit rester autorisée par la configuration CORS native. Le réglage ne modifie ni l’authentification Better Auth, ni les permissions, ni CORS. Il n’active pas `DISABLE_AUTH`.

Sans `REDIS_URL`, le service conserve son `MemoryRoomManager` natif, limité à une instance. Le réglage d’adresse n’apporte ni coordination multi-instance, ni persistance supplémentaire.

Le test `src/realtime-host.test.ts` utilise le vrai schéma et le vrai point d’entrée avec une écoute HTTP réelle sur un port temporaire loopback. Les frontières PostgreSQL, Socket.IO, authentification et handlers métier sont explicitement doublées. Une barrière propre au test empêche l’ouverture d’une écoute non-loopback, y compris pendant le RED historique. Le test ferme le listener et retire uniquement les handlers de processus qu’il a ajoutés. IPv6 est validé par le schéma ; son écoute n’est pas qualifiée par ce test.

La connexion collaborative réelle, son jeton Better Auth à usage unique, la création d’un workflow et le parcours Chat nécessitent une recette distincte avec l’application et le service natif. Un test de bind HTTP ne les qualifie pas.
