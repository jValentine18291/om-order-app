# Setting prices from the app (write-back to AutoCount)

Almost everything this app does with AutoCount is read-only. This is the
exception, so it is written down.

## What it does

On the **Parts Diagram** screen, tapping **Check Price** shows the List and
Contractor price from AutoCount. If one of them is **blank**, Sales and
Purchaser see a **Set price** button. They type a value and their initials,
confirm, and the price is written into AutoCount.

## The rules it enforces

| Rule | Why |
|---|---|
| Only fills a price that is blank or zero | There is nothing to overwrite, so nothing can be lost |
| Never changes a price that already exists | Existing prices stay AutoCount's to own |
| Re-checks "still blank?" inside the write itself | If someone prices it in AutoCount at the same moment, they win, not us |
| Writes to the exact item the user picked | A diagram number can match more than one item — `848BE058B2` matches both `SZEN 848BE058B2` and `SZEN 848BE058B2R`, which are priced differently. The user chooses which one, and stock, price and any write all follow that choice |
| One column, one row (the item's base-UOM row) | Smallest possible change |
| Refuses if the item has no unit-of-measure row | Creating one is a bigger change and belongs in AutoCount |
| Rejects zero, negatives, and anything over 100,000 | Catches the realistic mistake: an extra digit |
| Sales and Purchaser only | Technicians see prices but do not set them |
| Initials required | See the audit note below |

## The audit trail — read this part

Writing straight to the database **bypasses AutoCount's own audit trail**.
AutoCount will not show who set the price. The only record is:

    backend/price-updates.log

One line per attempt, including the ones that changed nothing. Plain text,
append-only, opens in Notepad:

    2026-08-24 11:20:05 | Parts Diagram | SZEN 612912230C | List Price | not set -> 12.80 | JT (sales) | updated in AutoCount

**Do not delete this file.** If a price is ever queried months later, it is the
only place that answers "who set this, and when". It is excluded from git on
purpose — it belongs to the server it was written on, and it carries staff
initials.

## Turning it on and off

Two separate switches, both **off** unless set to `true`:

- `AUTOCOUNT_PRICE_WRITEBACK` — the Parts Diagram feature described above.
- `AUTOCOUNT_PRICE_WRITEBACK_ORDERS` — a separate, older path that writes
  prices keyed on a slip when a Sales Order is created. Deliberately its own
  switch, so turning the first one on does not quietly start this one too.

With the switch off, the app still shows prices; the Set price button does not
appear, and the server refuses the request even if one is sent.

On the server these live in the OMService service configuration, alongside the
AutoCount credentials — not in a file in this folder.

## The one thing this cannot do

It cannot undo itself. Once a price is written it is a normal AutoCount price,
and correcting it means correcting it in AutoCount.
