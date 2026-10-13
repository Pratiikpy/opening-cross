# ADR-0413: How WCAG 2.2 AA is audited

Status: accepted (2026-10-13)

Rows M10, M11

## Context

Earlier checks used axe 2.1 AA and hand checks.

## Decision

axe-core 4.13 with the rule tags `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa` and best-practice, over every route (including dynamic ones with real addresses), at 1440 and 390, light and dark, on a production build, with zero console errors required on each page. Rules axe cannot decide by machine (focus order, meaning of text, motion) stay manual and are listed in the evidence file as not covered.
