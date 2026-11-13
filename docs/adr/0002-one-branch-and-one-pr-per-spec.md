# One integration branch and one PR per spec

On 13 Nov 2026 we decided a lane follows Matt Pocock's `implement-spec`: every ticket of a spec is built on one integration branch, and the spec ships as one PR to `main`. The old Squadron opened one PR per ticket.

A spec has about eight tickets. One PR per spec means one place to see the whole change, about an eighth as many PRs, and an integration branch where workers' work meets early. The cost is a bigger final diff, which the per-ticket reviews (ADR-0004) keep in check.
