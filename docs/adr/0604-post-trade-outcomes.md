# ADR-0604: Pushed refunds, locked fills, challenges and outcomes after the clear

Status: accepted (2026-10-14). Builds on ADR-0453, ADR-0454 and ADR-0457.

## Decision

A refund-only order can be refunded by anyone (`push_refunds`). The claim center says so on every refund-only row; when a claim fails and the order's account is gone from chain, the row is marked paid out instead of failed. An order closed on chain whose amounts the index has not yet recorded shows as paid out, without a claim button.

A settled order states its outcome in words (filled, partly filled, refunded in full) and gives a reason only where the data supports one; "lost the lottery or was priced out" is not guessed between.

Locked fills are listed on the cross page and on /orders with what has vested and a release button.

After a clear, a cross with a bond shows its challenge window, the challenges filed, a form to file one (evidence hash, deposit disclosed), and a way for anyone to close one the arbiter left unanswered.
