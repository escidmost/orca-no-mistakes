# Draw the Shippable Parity Releases

Linear: [ONM-4](https://linear.app/escidmore/issue/ONM-4/draw-the-shippable-parity-releases)

Type: grilling
Status: resolved
Blocked by: 04, 05, 06, 07, 08, 09, 11

## Question

How should the resolved guarantees be grouped from most to least important into independently shippable releases, and what explicit acceptance evidence, limitations, and upgrade boundary define each release?

## Answer

Ship four independently useful releases in safety order: Local Adversarial Validation Core; Guarded Remote Delivery and Branch Custody; Authoritative PR/CI Proof and Guarded Merge; then Resilient Coordinator Recovery and Custody Sync. Every release requires automated live Git and Orca scenarios covering fault and adversarial injection.

Documented in ADR: `docs/adr/0010-shippable-parity-releases.md`
