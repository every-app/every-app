**Every App app boundaries** (the Gateway in front of this app does the sign-in and passes identity in; what it promises and what the app must do itself is docs/threat-model.md in the Every App repository):

- A route, server function or tool that reads who the user is from anything but the SDK (`everyApp()`, `getEveryAppUser()`, `requireEveryAppUser()`, a tool call's identity): a client-supplied `x-everyapp-*` header, a cookie, a query parameter or a body field naming a user or organization
- A route listed under `public` in `everyapp.config.ts` that returns member data or changes state without a check of its own (a webhook signature, a bearer token the app verifies): `public` means anyone on the internet reaches it, and the Gateway forwards their `Authorization` header untouched
- A database query that doesn't scope by the user or organization from the identity, so one person's rows reach another; SQL built from strings instead of the query builder's parameters
- Agent tools (`defineTools()`): a tool that deletes or changes data without declaring the matching risk, or that trusts an argument as a path, URL or id without a check
- A secret read from anywhere but the Worker's bindings, or printed, logged or sent to a client
- `fetch()` to a URL whose host or scheme comes from user input, and HTML built from user input outside React (`dangerouslySetInnerHTML`, string templates)
