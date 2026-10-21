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

## 4b. Keep every match (optional, recommended)

Without this, the page only knows what HenrikDev returns: about 50 archived games, of which the last 10 carry lobby ranks. With it, the function saves every match it sees, so your history and the hidden MMR estimate keep improving as you play. It costs a few cents a month.

1. Azure portal → **Create a resource → Storage account**. Use the same resource group, **Standard** performance and **LRS** redundancy. Any name works.
2. Open the storage account → **Security + networking → Access keys** → copy **Connection string** (key1).
3. Static Web App → **Environment variables** → add `STORAGE_CONNECTION_STRING` with that value and save.

The function creates a table called `valorant` on first run. Matches are saved from then on. Earlier games only come back if HenrikDev's archive still has them.

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

- **Sample size:** the last 10 competitive games come with full detail, including the other players' ranks. HenrikDev's archive adds up to 50 more games with your own stats (`ARCHIVE_PAGES`, default `2` pages of 25, maximum `4`). With storage set up, everything is kept, up to the latest 200 games shown on the page.
- **Hidden MMR estimate:** blends three signals in "division units" (Gold 3 at 62 RR = 14.62):
  - **RR gains vs losses (35%):** average RR per win minus average RR per loss over the last 40 games. Every 8 RR of gap moves the estimate one division, capped at ±3.
  - **Lobby rank (50%):** the average rank of the other players across your last 40 full matches.
  - **Performance (15%):** your ACS divided by the lobby's ACS (or 215 for archived games). Every 20% above average adds one division, capped at ±2.
  The weights are a best guess, not Riot's formula. Confidence goes up with the number of games behind each signal.
- **Rate limits:** each refresh costs HenrikDev 4 requests plus 1–4 archive pages, at most once every 5 minutes however many people open the page. If HenrikDev is down, the page shows the last saved stats and marks them as saved.
- Not affiliated with or endorsed by Riot Games.
