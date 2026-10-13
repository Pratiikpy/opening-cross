# ADR-0406: Comments weighted by holdings, signed by the wallet

Status: accepted (2026-10-13)

Row M8

## Context

A social layer around an offering attracts spam and impersonation.

## Decision

A comment is the plain text a wallet signs (`Opening Bell comment`, cross, time, body); the server verifies the Ed25519 signature. Only a wallet that placed an order in the cross or holds its token may comment. It is ordered by the share of the cross's matched amount the author held when posting, shown beside it, and promoted by nothing else. One comment a minute and twenty a day per wallet, no links, 500 characters, no control or direction-changing characters. A moderator token can hide a comment; nothing is deleted.

Not done: replies, reactions, notifications about comments, and any weighting by a holder's other crosses.
