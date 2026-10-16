---
id: adr-001
kind: adr
title: Introduce a payment queue between Checkout API and billing
service: payment-queue
date: 2026-09-02
---
# ADR-001: Introduce a payment queue

## Context
Checkout API called the billing system synchronously. A slow processor made checkout latency spike, and processor outages failed whole orders.

## Decision
Introduce a durable Payment Queue so order placement is decoupled from payment processing. Checkout API enqueues a payment request and returns; Billing Worker settles asynchronously.

## Sub-decision: retries
Failed settlements are retried synchronously by Billing Worker with a fixed delay.

## Consequences
Checkout stays available during processor incidents. Payment settlement becomes eventually consistent.
