# KizRadar

Carte communautaire mobile des événements Kizomba, Urban Kiz, Semba, Tarraxo, Bachata, SBK, festivals et workshops.

## Modération

- Soumission publique avec statut `pending`
- Publication uniquement après approbation
- Page `/admin` protégée par session HttpOnly
- Correction, approbation, refus, archivage et suppression
- Masquage automatique des événements expirés
- Compatibilité avec les anciennes données Upstash

## Variables Vercel

```text
KV_REST_API_URL
KV_REST_API_TOKEN
ADMIN_PASSWORD
ADMIN_SESSION_SECRET
```

Consultez `A_LIRE.txt` avant le déploiement.
