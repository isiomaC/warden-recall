---
id: checkout-api
kind: service
name: Checkout API
tier: 1
dependsOn: [payment-queue]
---
# Checkout API

Order placement and payment orchestration. Publishes payment requests to the Payment Queue.
