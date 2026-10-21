# Valorant tracker — Kokosfjes#kokos

A public stats page for one Valorant account. It runs on Azure Static Web Apps (free plan) with your own subdomain.

- `web/` is the page: `index.html`, `styles.css` and `app.js`.
- `api/` is an Azure Function at `/api/stats`. It calls the HenrikDev API with your key and caches the result for 5 minutes. The key never reaches the browser.
- The Riot ID is fixed on the server, so the site can't be used to look up other players.

## 1. Get a HenrikDev API key

1. Join the HenrikDev Discord (linked from https://docs.henrikdev.xyz).
2. Request a **Basic** key through their dashboard. It's free.
3. Keep the key private. Don't commit it.

## 2. Push to GitHub

```bash
cd valorant-tracker
git init
git add .
git commit -m "Valorant tracker"
git branch -M main
git remote add origin https://github.com/<you>/valorant-tracker.git
git push -u origin main
```

## 3. Create the Static Web App

In the Azure portal: **Create a resource → Static Web App**.

| Setting | Value |
|---|---|
| Plan type | Free |
| Source | GitHub → your repo, branch `main` |
| Build presets | Custom |
| App location | `web` |
| Api location | `api` |
| Output location | *(leave empty)* |

Azure adds a GitHub Actions workflow to the repo, and every push to `main` deploys.

## 4. Add the API key

Static Web App → **Settings → Environment variables** → add:

| Name | Value |
|---|---|
| `HENRIK_API_KEY` | your key |
| `RIOT_REGION` | `eu` *(change if your account is on `na`, `ap`, `kr`, `latam` or `br`)* |

Optional: `RIOT_NAME` / `RIOT_TAG` (they default to `Kokosfjes` / `kokos`), and `CACHE_SECONDS` (default `300`, minimum `60`).

Save, then open the `*.azurestaticapps.net` URL to check that your stats load.

## 5. Point your Namecheap subdomain at it

1. Static Web App → **Custom domains → + Add → Custom domain on other DNS**. Enter for example `valorant.yourdomain.com`.
2. Azure shows a CNAME target like `happy-rock-0a1b2c3d.azurestaticapps.net`.
3. Namecheap → **Domain List → Manage → Advanced DNS → Add new record**:
   - Type: `CNAME Record`
   - Host: `valorant` (just the subdomain part)
   - Value: the `*.azurestaticapps.net` hostname from Azure
   - TTL: Automatic
4. Back in Azure, click **Validate**. DNS can take from a few minutes up to an hour. Azure issues the HTTPS certificate on its own.

## Preview without a key

Open `web/index.html` through any static server with `?demo` at the end of the address. The page then loads `web/demo.json`, which is clearly labeled sample data:

```bash
python3 -m http.server 5173 -d web
```

Then visit http://localhost:5173/?demo.

To run the real API locally, install the Azure Functions Core Tools and the SWA CLI. Copy `api/local.settings.example.json` to `api/local.settings.json`, add your key, then run `npx @azure/static-web-apps-cli start web --api-location api`.

## Notes

- **Sample size:** HenrikDev's match endpoint returns your last **10 competitive** games. The win rate, K/D, ACS, HS%, ADR, agents and maps are based on those. The RR chart uses your longer RR history.
- **Rate limits:** the cache means HenrikDev gets at most 4 requests every 5 minutes, however many people open the page. If HenrikDev is down, the page shows the last saved stats and marks them as saved.
- Not affiliated with or endorsed by Riot Games.
