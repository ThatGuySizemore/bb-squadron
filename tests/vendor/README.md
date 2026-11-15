# GraphQL validation fixtures

`linear-schema.graphql` is the unmodified published SDL from
https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql,
supplied for SQD-251 on 2026-11-14. Its MIT licence notice is retained in
`LINEAR-LICENSE`. It is a pinned snapshot, not a live schema fetch.

`graphql/` contains the CommonJS JavaScript runtime of graphql-js 16.15.0
(https://github.com/graphql/graphql-js), used only by tests. Its MIT licence
notice is retained in `graphql/LICENSE`. No runtime plugin dependency is added.
