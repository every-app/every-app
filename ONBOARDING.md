# Deploy Gateway
1. `git clone git@github.com:every-app/every-app.git`
1. `cd cli && pnpm i`
1. `bun src/bin/cli.ts gateway deploy`
1. `npx wrangler tail` to get logs (needed for next step)
1. Sign up to create an account
1. All done!

# Deploy Todo App
1. `cd ../apps/todo-app`
1. `bun src/bin/cli.ts app deploy`
1. Copy URL of app

# Add Todo App to Gateway
1. Go back to Gateway
1. Click "Add Custom App"
1. App Id = todo-app and App Url = URL from the last step 
1. Go to app and try to make a todo item

# Add PWA to your phone
1. Go to the gateway URL on your phone
1. Log in
1. Click Share Button => Add to Homescreen
1. Open PWA from Home Screen
1. Go to Todo App and get mobile-like UX

# Create an App for Development
1. Go to directory where you work on new projects
1. Run CLI by entering relative path to the every-app folder
    - e.g. `bun ./every-app/cli/src/bin/cli.ts app create`
1. Follow prompts
1. Run `npm run dev`
1. Go to Gateway and create custom app with the same App ID and the url being localhost:3001

