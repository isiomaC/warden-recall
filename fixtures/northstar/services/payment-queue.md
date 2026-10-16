---
id: payment-queue
kind: service
name: Payment Queue
tier: 1
dependsOn: [billing-worker]
---
# Payment Queue

Durable queue between Checkout API and billing. Introduced to decouple order placement from payment processing (see ADR-001).
