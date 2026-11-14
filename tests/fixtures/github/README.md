# GitHub response fixtures

`native.json` records synthetic `gh api graphql --paginate --slurp` response pages.
The invented repo is `fixture/repo` on `github.example`; no owner data or login is used.
Tests derive a body-line-only response from these same issue records.

Response fields follow GitHub's [Issue GraphQL reference](https://docs.github.com/en/graphql/reference/issues#issue).
The CLI pagination and hostname options follow [`gh api`](https://cli.github.com/manual/gh_api).
The fixture is not evidence of a live Enterprise host or an owner's login.
