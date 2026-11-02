# TravelMuz Bedbanks

Outil interne TravelMuz pour comparer les bedbanks (Halalbooking, TBO, RateHawk, Bedsonline/Hotelbeds) et suivre des réservations. Il sert uniquement à consulter : il ne réserve, ne modifie et n'annule rien.

Hébergement : un Worker Cloudflare avec une base D1 (décision D-016). Chaque envoi sur `main` est redéployé automatiquement une fois le dépôt relié à Cloudflare.

## Structure
- `src/worker.mjs` : point d'entrée. `src/router.mjs` : toutes les pages et API exigent une session, sauf la connexion.
- `server/` : comptes (`auth-*`), connecteur Halalbooking, tests.
- `public/` : pages (comparateur, démo, connexion, administration).
- `wrangler.jsonc` : configuration Cloudflare, sans aucun secret.

## Secrets (Cloudflare → Worker → Paramètres → Variables et secrets, type « Secret »)
| Nom | Rôle |
|---|---|
| `SETUP_CODE` | Code d'installation à usage unique pour créer le premier administrateur (16 caractères minimum). À supprimer après l'installation. |
| `HALALBOOKING_PARTNER_CODE` | Identifiant API Halalbooking |
| `HALALBOOKING_SECRET_KEY` | Clé secrète API Halalbooking |

Ne jamais écrire de secret dans ce dépôt, dans un ticket ou dans une conversation.

## Commandes
- `npm test` : tests locaux, sans réseau.
- `npm run dev` : site local sur http://localhost:8787 (code d'installation dans `.dev.vars`, fichier ignoré par Git).
