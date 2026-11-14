# Design

LiquidityX should read like a term sheet: calm, exact, and easy to scan. A lender at a desk compares rates in daylight; a borrower checks their liquidation price on a phone late at night. Both need the numbers first, so the interface stays quiet and the figures do the talking. Light and dark themes are first-class, and the default follows the OS.

## Principles

1. **Numbers first.** Every figure uses tabular lining numerals (`.num`). Amounts never round up (balances are truncated), dust shows as `< 0.000001` rather than `0`.
2. **One accent.** Plum carries primary actions, the current selection and focus. Semantic colours (positive, warning, danger) only ever mean state.
3. **Structure from lines, not boxes.** Hairline borders and spacing group content. Panels exist only where they hold a task (vault, form, loan figures). No nested cards, no shadows except popovers and the side sheet.
4. **Plain words.** Sentence case everywhere. Errors state the action and the numbers: "Not enough MUSD. You have 12.5, this needs 40."
5. **Honest testnet.** A small "Testnet" tag in the header, the BTC price always labelled "Mezo testnet oracle" with its age, collateral named "BTC (Mezo testnet)", unofficial assets carry "Not in Mezo's official contract list". No invented stats: if the contracts aren't deployed, the app says so and shows nothing.

Avoided on purpose: tracked uppercase eyebrows, pills, "LIVE" or "VERIFIED" badges, glow blobs, gradient text or lines, identical icon-card grids, oversized hero type, heavy shadows.

## Tokens

Defined in `web/app/globals.css` as CSS variables, swapped by `[data-theme]` on `<html>` (set before paint by an inline script) with a `prefers-color-scheme` fallback. Exposed to Tailwind v4 through `@theme inline`, so classes read `bg-surface`, `text-ink-2`, `border-line`.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `oklch(0.992 0.0015 340)` | `oklch(0.165 0.006 340)` | page |
| `--surface` | `oklch(0.975 0.003 340)` | `oklch(0.198 0.008 340)` | second layer: previews, notices, row hover |
| `--surface-2` | `oklch(0.955 0.004 340)` | `oklch(0.232 0.009 340)` | controls tracks, skeletons, disabled |
| `--line` / `--line-strong` | `0.905` / `0.82` L | `0.295` / `0.38` L | hairlines / input borders |
| `--ink` / `--ink-2` / `--ink-3` | `0.21` / `0.41` / `0.50` L | `0.95` / `0.78` / `0.67` L | text: primary / secondary / tertiary (all ≥ 4.5:1 on bg) |
| `--accent` | `oklch(0.47 0.165 340)` | `oklch(0.73 0.14 340)` | primary buttons, active tab, focus |
| `--accent-soft` | `oklch(0.955 0.022 340)` | `oklch(0.27 0.05 340)` | selected segment |
| `--positive` / `--warning` / `--danger` | hue 155 / 65 / 25 | lighter in dark | CR health, statuses, errors |

Neutrals carry 0.0015 to 0.012 chroma toward the accent hue so greys and plum belong together. The plum (hue 340) was chosen to sit away from both the category reflexes (BTC orange, fintech navy) and from Mezo's own red, so nothing suggests LiquidityX is a Mezo product.

## Type

**IBM Plex Sans** (400/500/600) for everything, **IBM Plex Mono** (400/500) for addresses and hashes only. Plex was drawn for financial and technical interfaces, has true tabular figures, and has enough character (the `g`, the `t`) to avoid looking like a default. One family keeps product UI consistent; the mono is a different axis (fixed width) for strings people compare character by character.

Fixed rem scale, ratio about 1.2 from a 14px UI base:

| Step | Size / line | Use |
|---|---|---|
| `text-2xs` | 12 / 16 | sub-labels under figures, footnotes |
| `text-xs` | 13 / 18 | labels, table headers, hints |
| `text-sm` | 14 / 20 | body and controls (default) |
| `text-base` | 16 / 24 | sheet titles, lead copy |
| `text-lg` | 19 / 26 | figures, section titles |
| `text-xl` | 23 / 30 | landing sub-sections |
| `text-2xl` | 28 / 34 | page titles, large figures |
| landing h1 | 38 → 48 | the only display size |

Headings use `text-wrap: balance` and `-0.012em` tracking (h1 `-0.025em`). Prose is capped near 60ch.

## Space, shape, depth

- Spacing: Tailwind's 4px scale. Page gutter 16px (phones) / 24px, max width 1240px. Page sections 32 to 40px apart; landing sections 64 to 80px.
- Radius: 4px tags, 6px controls and buttons, 10px panels. Nothing is fully rounded except status dots.
- Depth: none by default. `--shadow-pop` only on the side sheet, RainbowKit modal and toasts.
- z-index: sticky header 20, sheet uses the native `<dialog>` top layer, toasts use Sonner's layer.

## Motion

150 to 250ms, ease-out-quart, state changes only: hover/press colour, the 1px press on buttons, the sheet sliding 16px in, the repayment bar width, skeleton shimmer. No entrance choreography. `prefers-reduced-motion` collapses everything to instant and stops the shimmer.

## Components (`web/components`)

| Component | Notes |
|---|---|
| `ui/button` | `primary` (accent), `secondary` (bordered), `ghost`, `danger` (outlined, red text). Sizes 32/36/44px. `loading` shows a spinner and sets `aria-busy`. Disabled primary turns neutral, not washed-out plum. |
| `ui/field` | Label above, hint or error below (`role="alert"`). `AmountInput` = decimal keyboard, unit suffix, `aria-invalid`. Native `Select`. |
| `ui/tabs` | Underlined tabs with arrow/Home/End keys (WAI-ARIA). `Segmented` for 2 to 4 options. |
| `ui/data-table` | One column definition renders a table on md+ and stacked definition lists on phones. Sortable headers set `aria-sort`. Skeleton rows match row height, so nothing shifts. |
| `ui/sheet` | Native `<dialog>` side sheet: focus trap, Esc, inert background for free. Full width on phones. Used for row actions (fund, borrow, match). |
| `ui/misc` | `Status` (dot + word), `Tag` (flat), `Notice` (tinted, no side stripe), `Figure`, `Row`, `Section`, `EmptyState`, address and tx links. |
| `domain` | Asset names with the unofficial-asset note, status labels, CR tone (danger under liquidation, warning in the lower half of the safe band), `PriceLine`. |
| `forms` | Shared validation that returns sentences with numbers; `DurationInput` (hours or days). |

## Transactions

Every write goes through `hooks/use-tx.tsx`: connect if needed, switch network, check BTC for gas (and for `msg.value`), check token balance, approve the exact amount if the allowance is short, simulate (so reverts are explained before the wallet opens), sign, one toast that updates in place from "confirm in your wallet" to "waiting for the network" (explorer link) to success or a decoded failure, then refresh all queries (and the API again after 4s and 12s, since the index trails the chain). `hooks/tx-errors.ts` maps every custom error in the interfaces and implementations, plus OpenZeppelin's, to one sentence; a unit test fails if a new error appears without one.

## Pages

| Route | Shape |
|---|---|
| `/` | Split hero with a live example loan you can edit (oracle-priced, labelled "Example loan"); one sentence of live market state; the four-step loan sequence; lending vs borrowing; the collateral ratio line drawn from live risk params; a comparison table against pooled markets; plain testnet notes. |
| `/marketplace` | Totals strip, tabs (requests / offers / mine), compact filters with "More filters", sortable table, row actions in a side sheet. Match sheet explains which offers fill what and why others are excluded. |
| `/lend`, `/borrow` | Two columns: balance panel and form. Forms show a live preview, then a review step before signing. |
| `/loans/[id]` | Figures panel with owed ticking every second (marked estimate), health, countdown, repayment bar; terms; history; role-aware action column (repay / withdraw / liquidate) that comes first on phones. Per-loan OG image. |
| `/portfolio`, `/activity` | Figure strips and tables; every transaction links to the explorer. |

## Site basics

The mark in `public/icon.svg` (adapts to dark), `favicon.ico` (16/32/48), `apple-touch-icon.png`, 192/512 and maskable 512 PNGs, `manifest.ts`, `opengraph-image` + `twitter-image` (root) and a per-loan OG image, `robots.ts`, `sitemap.ts`, `not-found`, `error`, `global-error`, route `loading` skeletons. Tab titles stay neutral ("Lend · LiquidityX"), with no "on Mezo" in `<title>`.
