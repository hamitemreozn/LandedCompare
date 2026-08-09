# Product Requirements

## What LandedCompare is

LandedCompare is a local-first, desktop-first responsive web application. Its core
job is to normalize supplier quotations from an import/purchasing scenario into a
common cost model, and show the user which complete quotation has the lowest
calculated landed cost under the assumptions the user enters — not just the lowest
unit price.

## Primary users

- Small and medium-sized importers
- Distributors

## Secondary users

- Procurement / purchasing professionals
- Small manufacturers

## Core product job

Given multiple supplier quotations (possibly in different currencies, with
different MOQs, pack sizes, and cost structures), normalize them to a shared
landed-cost model and produce a deterministic comparison of the calculated landed
total and effective landed unit cost per quotation.

## Local-first principle

The application runs entirely in the browser. User data (projects, suppliers,
quotations, costs) is not sent to a server. Persistence, backup, and data exchange
are handled client-side (planned: IndexedDB, JSON backup/import, clipboard paste,
controlled CSV/XLSX support).

## MVP boundaries

The MVP is scoped to the comparison workflow: projects, product requirements,
suppliers, quotations, currencies/exchange rates, quantities, MOQs, pack/unit
normalization, additional costs (freight, insurance, duty, brokerage, fees, local
transport, tax, discounts, surcharges), shared cost allocation, incomplete-quote
detection, and a deterministic results/comparison view. See
[Roadmap](ROADMAP.md) and [Implementation Plan](IMPLEMENTATION_PLAN.md) for the
phased build order.

## Notable excluded scope (not planned for MVP)

- Backend/server, authentication, cloud sync
- Automatic currency or customs/duty APIs
- AI/LLM integration, OCR, PDF parsing
- Payments, subscriptions, licensing
- Analytics/tracking of user data

## Phase 0 status

As of this phase, the repository contains only the engineering foundation
(build tooling, test setup, placeholder UI). No product features described above
are implemented yet.
