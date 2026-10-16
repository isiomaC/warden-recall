---
id: checkout-web
kind: service
name: Checkout Web
tier: 2
dependsOn: [checkout-api]
---
# Checkout Web

Customer-facing checkout pages. Calls Checkout API for cart totals and order placement.
