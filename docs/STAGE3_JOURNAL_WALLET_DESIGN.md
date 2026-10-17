# Stage 3 — journal and wallet accounting design

Status: design and normalization helper only. No wallet balances are changed and no database migration is applied in this stage.

## Current findings

- `Wallet.balance` exists but is not updated by exchange or expense create/edit/delete routes.
- The dashboard's `balanceVnd` is an estimated single-currency budget, not a set of actual RUB, USDT, and VND wallet balances.
- Exchange and expense records are stored independently. A change or deletion changes the source record but there is no persistent unified journal.
- Card purchases can have both a local purchase amount (usually VND) and a separate USDT card debit. These are two views of one purchase and must not be subtracted from both currency wallets.
- Unknown conversion values must remain null and must not affect a confirmed balance.

## Proposed ledger rules

1. Every exchange is one journal operation with separate actual amounts: RUB spent, USDT received when applicable, and target currency received only when actually known.
2. Every expense keeps its source amount/currency. If a card debit is recorded, `usdtCharged` is the actual USDT outflow; a VND amount is the purchase-value/reference amount and must not also be treated as a VND wallet outflow.
3. Direct cash/VND expenses without a card debit reduce VND; RUB expenses reduce RUB; USDT expenses reduce USDT.
4. Balances require an explicit opening balance or a recorded balance adjustment for each currency. Without it, only net movement can be calculated; it must not be labelled "available balance".
5. Editing/deleting a source operation must update its ledger representation atomically in the same database transaction. Each source operation must have at most one current ledger representation per currency.
6. Historical RUB cost estimates are valuation metadata and are not additional wallet movements.
7. No exchange rate is inferred for a currency without a reliable observation or an explicit user-entered rate.

## Next implementation steps

- Expose the normalized chronological journal through an authenticated API.
- Add opening balance / adjustment operations and derive per-currency balances from signed ledger movements.
- Synchronize create, edit, and delete of expenses/exchanges transactionally.
- Add integration tests for duplicate prevention, user ownership, card-debit accounting, edits/deletes, and unknown rates.
- Prepare forward-only migrations; do not apply them to any database without explicit permission.
