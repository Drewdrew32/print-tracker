# Print Tracker

A small web app for tracking 3D printing orders: order entry, labour and filament cost calculation, shared shipping, payments with overage, status tracking, and printable customer statements.

The app is a static page (plain HTML, CSS and JavaScript, no build step) hosted on GitHub Pages. It holds no data itself. Orders are stored as `data.json` in a separate **private** repository and read and written through the GitHub API with a personal access token that stays in your browser. Every save is a commit, so the data repo keeps the full history.

## Signing in on a new device

1. On GitHub, open **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. Repository access: **Only select repositories →** your data repository.
3. Permissions: **Contents → Read and write**.
4. Open the app, enter the owner, data repository name and the token, then **Connect**.

The token is saved in that browser's local storage. Use **Settings → Sign out on this device** to remove it.

## How costs are calculated

- **Labour** = hours × the labour rate in effect on the order's received date (Settings).
- **Materials** = for each filament line, grams × quantity × (spool price ÷ spool weight).
- **Shipping** = the shipment's cost split evenly across the orders in it, to the cent.
- **Payments** cover what the ticked orders still owe; anything over is recorded as overage and split evenly across those orders. A short payment is shared in proportion to what each order owes.
- Orders imported from the original spreadsheet keep the amounts that were billed at the time. Each one can be switched back to calculated amounts on its order page.

## Files

- `index.html`, `styles.css`, `app.js`: the app.
- `vendor/xlsx.full.min.js`: [SheetJS](https://sheetjs.com) 0.18.5 (Apache-2.0) for Excel export.
