---
id: adr-002
kind: adr
title: Bounded retries with dead-letter routing
service: payment-queue
date: 2026-10-10
amends: adr-001
---
# ADR-002: Revise retry behavior

## Context
Synchronous fixed-delay retries (ADR-001, retry sub-decision) caused retry storms when the processor degraded, which backed up the queue.

## Decision
Amend the retry sub-decision of ADR-001: use bounded retries with exponential backoff and dead-letter routing. The original queue-introduction rationale in ADR-001 remains valid and is unchanged.
