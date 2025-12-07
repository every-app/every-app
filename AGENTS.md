# Every App Background
`every-app-gateway` - This is a parent app in which other apps are embedded. This parent app provisions session tokens scoped to each embedded app so that the child app can leverage authentication. The apps are embedded in an iframe and sync all routing to the parent app via the `EmbeddedProvider`
`todo-app` - This is an example todo application demonstrating how child apps are implemented and leverage the `EmbeddedProvider`.

# Testing Code Guidelines
- Always type check your code by running `npm run types:check`
- Never run dev servers yourself. I will run and test them on my own.
