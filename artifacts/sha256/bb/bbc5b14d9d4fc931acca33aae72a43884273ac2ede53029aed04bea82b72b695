# Synthetic comparison fixture notice

The SQLite file named `chinook-candidate-<sha256>.sqlite` is a synthetic test fixture derived from the upstream Chinook SQLite database in `data-source/source.sqlite`. It is provided only to demonstrate a bounded query-result comparison. It is not a QA, UAT, production, or live customer database.

The derivative preserves the upstream schema, primary keys, foreign keys, indexes, and row counts. It changes three values in `Invoice`: the raw `InvoiceDate` text for invoice 98, the `CustomerId` for invoice 121, and the `CustomerId` for invoice 97. These controlled edits create one changed result row, one baseline-only key, and one candidate-only key in the maintained Customer 1 invoices query. They do not delete database rows and do not imply a cause.

The upstream license text is preserved in [`../../data-source/LICENSE.md`](../../data-source/LICENSE.md). This notice records the modifications and fixture-only purpose; it does not replace or alter that license.
