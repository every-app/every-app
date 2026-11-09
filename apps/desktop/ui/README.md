# @every-app/desktop-ui

The Every App desktop app's React 19 + Tailwind 4 components and screens
(`apps/desktop`). It came from Talk's `packages/ui`; the Scribe web app keeps
its own copy in its repository, so the two now change separately.

- `src/components/ui`: the component library (shadcn on Base UI).
- `src/styles/app.css`: the theme. `src/styles/desktop.css`
  layers the desktop look on top of it (system font, 13px UI text, quiet warm
  neutrals, a translucent sidebar for vibrancy). Import `@every-app/desktop-ui/styles.css`.
- `src/screens`: the desktop screens. They're data-agnostic: they take
  `Loadable<T>` values and callbacks, and they never fetch. The router and
  query layer in `apps/desktop/src/renderer` wire them up.
- `src/types.ts`: the shapes the screens draw. They mirror the `/api/v1`
  contract and the helper protocol structurally.

## Playground

```sh
pnpm --filter @every-app/desktop-ui playground    # http://127.0.0.1:5188
pnpm --filter @every-app/desktop-ui screenshots   # with the playground running
```

The playground renders every screen and state with mock data at Mac window
sizes, in light and dark mode. `?scene=<id>&theme=dark&bare` renders one scene
full-window. That's what `scripts/screenshots.mjs` captures into
`screenshots/` at 1200×800 (not committed).

## Using it from an app

Tailwind must scan this package's sources. Add
`@source "<path to>/apps/desktop/ui/src";` next to your `@import
"@every-app/desktop-ui/styles.css"` (desktop.css already sources itself when it's imported
directly).
