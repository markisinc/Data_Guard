# DataGuard — Excel add-in (v1.0)

A task pane for Excel that checks a table for the problems analysts told us break their reports:

| Check | What it catches | Action |
|---|---|---|
| **Duplicate IDs** | IDs that should be unique but aren't, including ones that only differ by a space or capital letters | Select the cells, list each group |
| **Missing IDs** | Blank IDs, and placeholders like `N/A` / `NULL` in the ID column (counted as missing, not as a repeated ID) | Select; clear placeholders |
| **ID format** | Learns the usual format (`"TXN-" followed by 6 digits`, or `whole numbers 1 to N`) and groups the rest by cause: extra spaces, lower case, doubled separator, missing prefix, other prefix (`INV_`, `ORD-`). For number IDs, reports gaps | Fix spaces / case / separators in one click |
| **Placeholders** | `N/A`, `NULL`, `None`, `-`, `TBD`, `Unknown`, `NaN`, Excel errors (`#N/A`, `#REF!`) in any column | Clear them |
| **Numbers stored as text** | `"$ 12.345,50"`, `"8.900"`, `"(2.500,00)"`: values SUM skips. Shows how much money the total is missing | Convert to real numbers (asks first, never touches formulas) |
| **Words in number columns** | `"two"`, `"cinco"`, `"10 units"`, `"Included"`, `"Inf"` in a quantity or price column | Convert the number words; select the rest |
| **Mixed currencies** | USD amounts in an ARS column, in the text or in the number format | Select |
| **Date sanity** | Future dates (2035, 2099), default "unknown" dates (1900-01-01, 1970-01-01), stray rows before/after the main period, impossible dates (2026-13-01, 31 April, 0000-00-00), dates typed as text in several formats (and day-first vs month-first mixed), empty months inside the range. Bad dates are kept out of the monthly totals | Convert text dates to real dates (asks day-first or month-first once when ambiguous) |
| **Spelling variants** | `" Electronics  "`, `"ELECTRONICS"`, `"Elecronics"` showing up as separate categories. Spacing/capital/accent variants are certain; one-or-two-letter typos of a common value are suggested | Standardise (or only spaces & capitals) |
| **Same ID, different values** | Columns that follow an ID (customer_id → name, email): flags the odd row out and fills gaps from the ID's other rows | Use the usual value; fill missing |
| **Totals that don't add up** | Finds `total = quantity × price` and flags rows where it fails. Rows with a stand-in price are left out of "recalculate total" | Recalculate total, or recalculate price |
| **Stand-in numbers** | 999999.99, 9999, 0.01 repeated far outside the normal range. Kept out of monthly totals | Select (needs the real value from the source) |
| **Garbled accents** | `MarÃ­a GÃ³mez` from a CSV opened with the wrong encoding | Repair (exact) |
| **Shared personal values** | One email/phone/name on far too many different customers (`wrong.user999@unrelated.org` on 158), i.e. a default or test value | Clear, then "fill from the same ID" restores the real ones |
| **Malformed emails** | No @, nothing after @, spaces, no domain ending | Clear |
| **Off-trend totals** | The newest month's total (and row count) far from what this table's usual month-over-month change predicts | Explains whether text-stored amounts account for it |

## Fixes and undo

Every fix asks first and shows examples of what will change. Then:

- **Old values are saved.** Each changed cell gets a row in a **"DataGuard Changes"** sheet: batch, time, fix, cell, old value, new value, status. The sheet is very hidden (not in Excel's Unhide list); **View change log** in the pane shows it and **Hide change log** puts it away again.
- **"Undo last fix" puts the previous batch back.** It only restores cells nobody edited since the fix. Edited cells are kept and marked in the log.
- **Formulas are never overwritten**, and cells that changed after the check are skipped.

Three ways to see results:
- **By column** (default): worst first, high-severity columns open. A calculated column (total) always comes after the columns it's calculated from.
- **Fix order**: 1 Clean up values → 2 Fill gaps and resolve conflicts → 3 Recalculate → 4 Review. Following it avoids redoing fixes, e.g. recalculating totals before quantity and price are clean. A total's card says which columns to fix first.
- **By severity**: the flat list.

## How history works (options A + C)

**C. Month by month.** If the table has a date column, rows are grouped by month and each month is summarized
(row count, total per measure, distinct IDs). An append-style file already holds its own history, so off-trend works
on the first run.

**A. History lives in the workbook.** Those monthly summaries and the confirmed rules are stored in a custom XML part
inside the `.xlsx` (namespace `urn:dataguard:state:v1`). That covers all three habits we heard:

- **Overwrite the same file each month.** Earlier months are still in the stored summary.
- **Duplicate last month's file and paste new data.** The summary is copied with the file.
- **Append rows.** The months are in the data itself.

Rules for the stored history:

- **One entry per month, not per run.** Re-running on October overwrites October, so three runs never look like three months.
- **The file wins.** For any month in the current data, the file's numbers replace the stored ones (corrections stick).
- **No comparing old against new.** Opening an older copy compares its newest month only against earlier months.
- **No date column.** You pick which month the snapshot is, each time.
- **Size.** Up to 36 months per table, a few KB.

**Privacy.** Only aggregates are stored: row counts, totals per month, distinct-ID counts, column names and rules. No
row data. Nothing leaves the machine. But anyone who gets the file can see those monthly totals. The pane says so, and
has a button to remove everything DataGuard stored.

## How "off-trend" decides

- **Expected value.** Last month × (1 + the table's typical month-over-month change), using the median of up to 6
  earlier months. A business growing 5% a month is not flagged.
- **With ≥ 3 earlier growth rates.** Flag when this month's change is unusual for this table (robust z ≥ 3 on the
  median/MAD of earlier changes) and at least 10% off.
- **With fewer.** Flag when ≥ 30% off, and say it's a rough signal.
- **Half-finished months.** If the last date is well before month end, the warning drops to "info".

All thresholds are in [`config/checks.json`](config/checks.json), not in code. The JSON schema is in
`config/checks.schema.json`, so the Python profiler can read the same definitions later.

## Share it with testers (GitHub Pages)

The repo deploys itself: every push to `main` runs the tests, builds, and publishes to
`https://<your-user>.github.io/<repo>/`. That page has the install steps and the add-in file (`manifest.xml`)
pointing at the hosted copy, so testers need no Node, no terminal and no certificates.

One-time setup:
1. Create the repo on GitHub (it must be **public** for free GitHub Pages) and push this folder to `main`.
2. Repo **Settings → Pages → Source: GitHub Actions**.
3. Push again (or run the workflow from the **Actions** tab). When it's green, open `https://<your-user>.github.io/<repo>/`.

The hosted add-in has its own ID, so you can keep the localhost dev version installed next to it. Only the code is
public; testers' workbooks never leave Excel.

To build the hosted files locally: `SITE_URL=https://<your-user>.github.io/<repo> npm run build:pages`.

## Vocabulary shared with the schema profiler

Column names are recognised with the profiler's vocabulary (`schema_profiler/vocab/default.yaml`), copied to
`config/vocab.shared.json` and matched with the same rules (exact token, prefix like "cant" → cantidad, smushed names
like "fechapedido"). After changing the profiler's vocabulary, run `npm run sync-vocab` and commit the JSON.
Spreadsheet-only words (factura, remito, sku…) live in `config/vocab.json`.

## Run it (Windows, Excel desktop)

You need Node 18+ and Excel for Microsoft 365 or Excel 2021+ (ExcelApi 1.9).

```bash
npm install
npm run certs        # once: trusted HTTPS cert for localhost (Office requires HTTPS)
npm start            # starts the dev server and opens Excel with the add-in sideloaded
```

Then: **Data** tab → **Check data**, click a cell inside a table, **Check this table**.
Try it on `fixtures/Ventas_Sep.xlsx` and `fixtures/Ventas_Acumulado.xlsx`. `npm run stop` unloads the add-in.

**Excel on the web.** Run `npm run dev`, then Insert → Add-ins → Upload My Add-in → `manifest.xml`.

**No Excel at hand.** Run `npm run dev` and open `https://localhost:3000/dev/mock.html?fixture=Ventas_Sep` (or
`Ventas_Acumulado`). This is a fake Office.js backed by the fixture JSON, for clicking through the UI.

## Tests

```bash
npm test             # 97 tests: number parsing, each check, all three file habits, XML round-trip
npm run build        # type-check + production build
npm run fixtures     # regenerate the sample workbooks (needs Python + openpyxl)
```

The tests run on JSON snapshots shaped like Office.js output (`values` / `text` / `numberFormat`, Spanish
(Argentina) display), so they exercise the same inputs the add-in sees.

## Layout

```
src/core/        pure TypeScript, no Office.js: parsing, checks, periods, history (all tested)
src/excel/       the only code that calls Excel: read table, select cells, write numbers, load/save state
src/ui/          React task pane
config/          check definitions + thresholds (JSON); vocabulary (shared with the profiler + DataGuard extras)
scripts/         sync-vocab (from the profiler), make-manifest (hosted manifest)
public/index.html  tester landing page (install steps + manifest download)
.github/workflows  build, test and deploy to GitHub Pages
fixtures/        sample workbooks + generator + JSON snapshots
dev/             mock Office.js for browser testing
```

## Known limits / next steps

- **Multi-area selection needs ExcelApi 1.18.** On older Excel the pane selects the first cell and lists the rest as
  clickable addresses.
- **English only**, by decision: the data testers use is in English. Column names in Spanish/Portuguese are still recognised.
- **Table size.** Up to 1 million cells, read in slices. The checks took about 3 seconds on 35k rows in testing; bigger tables take proportionally longer.
- **"$" is ambiguous.** It counts as its own currency, so "$" next to "USD" is reported as "check they're the same"
  (medium), not as a definite mix.
- **No day-one baseline from one-sheet-per-month workbooks yet.** That's the backfill idea; it isn't built.
- **Manifest validation needs internet.** `npm run validate` couldn't reach Microsoft's service from the build
  machine, so run it locally.
