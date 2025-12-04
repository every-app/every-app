I want to go about actually implementing this project now. 

I want to break it into multiple specs so that we can incrementally build out the actual logic and review each spec independently before actually implementing.

Please create a new folder called `/implementation_plan.` These should be detailed plans describing how to build the full stack application with TanStack Start. 

In general, try to design a quality application that is DRY, but be pragrammatic and do not overengineer or overabstract. Code readability is our number one goal. Functions should be small and have descriptive names so that the code does not have unnecessary comments throughout.

Within that `implementation_plan` create independent md files for each step:
1. Copy of the daisy UI custom styling and any custom components we've created. If there are any components that should be created that aren't to make the code more consumable, detail those new components here and how they should be used. 
2. Define the drizzle schema. Make sure that normalize the data as much as possible. Avoid storing unstructured data like json at all costs. Use enums when possible instead of strings or booleans. 
    - Make sure to define relations in addition to the schema
3. Define the folder structure, remember that we may be working off a todo-app starter template which we can delete code from, but we should try to keep a similar code organization. 
    - Specifically, keeping client only code in the client folder when possible. 
    - This should also define what pages / routes we need to create in TanStack.
    - Roughly:
        /client
            /components
            /hooks
            /tanstack-db
            etc
        /server
            /db
            /repositories
            /services
            etc
        /middleware
        /routes
        /serverFunctions
        /types
4. Decide whether the Tanstack DB client side database makes sense for this apps use case.
    - TanStack DB is a client side database that makes optimistic mutations easier. It is totally seperate from the Cloudflare D1 database on the backend. 
        - https://tanstack.com/db/latest/docs/overview
    - Can we load all the users state into the app easily or will it require complex pagination?
    - For a todo list app, Tanstack DB is a great use case because optimistic mutations are complicated otherwise + all the todos can be loaded pretty easily.
    - A chat app is a worse use case for Tanstack DB since we likely only want to load some chats at once and only the most recent messages instead of all messages at once. 
    - It could be possible that we want to use Tanstack DB for some collections, but not others. Example: a Chat App may use Tanstack DB for Chats and other tables, but not for loading messages where it just uses normal react query. 
    - Prefer TanstackDB unless the app will definitely need complex pagination / partial data loading for all users like with the chat app since it will make queries / mutations simpler in our routes and components.
5. Decide what serverFunctions we need. These should be grouped by domain like todo, chat, message etc. 
    - Please break backend logic up into services and repositiories.
        - server/services - Any business logic for validation or calling repositories
        - server/repositories - Any interactions with the database should be handled via repositories, this is so that multiple database calls so be put behind a nicer interface
    - Server functions should then call services. 
    - Remember that we may be able to simplify the server functions, services and repos dramatically if we're using Tanstack DB since we'll do the querying clientside.
6. For EACH route identified in step 3, create a separate file 
   (e.g., `06a-route-index.md`, `06b-route-programs.md`) containing:
   - Data requirements
   - User actions/JTBD
   - UI/UX details including loading/error states
            - Make sure no errors are suppressed, but don't be heavy handed with try catches everywhere.
            - Please refrain from spinners if at all possible, prefer to show nothing when things are loading or do optimistic mutations via react query / tanstack db.
7. Please review all the plans you've written and make sure that they are unified and coherant. Make sure that you update any duplicative work or add any extra details to make sure that the app is properly implemented across the stack.
   - Schema fields match what routes need
   - All server functions have a calling route
   - All routes have defined server functions for their actions
   - Component names are consistent across docs
   - No orphaned features (defined but never used)

Dependencies:
- Step 3 (routes) depends on understanding features from step 1
- Step 4 (TanStack DB) depends on step 2 (schema)
- Step 5 (server functions) depends on steps 2, 3, and 4
- Step 6 (route plans) depends on all previous steps

Please use context7 to access docs for Tanstack, DaisyUI, drizzle and any other docs you need. Make sure to add this instruction to the end of each plan that you implement so that this instruction is not lost

# Checklist before doing any planning
Please ask the user for this additional context before doing any of the planning:
- If you don't have access to the code for the designed mock of the application, confirm with the user that they have given you context of the mock of the app. 
- Ask for images on the app that they have designed if they haven't uploaded any. 
- Review the app code and images and write a doc called [app-purpose/name]-high-level.md and ask the user to confirm that you understand the app before implementing the more detailed plan
    - What are the core features/user stories?
    - Is there a design doc, PRD, or existing mockups?
    - What's the MVP scope vs future features?

## Confirming with the user
- Don't suggest additional features. Assume that their goal is just to actually implement what they've already designed in this mockup.
- Don't ask about user authentication as you will use the Authentication already configured in the Every App template during implementation. Don't worry about this in your planning. 
- Don't ask them to tell you the core features and user stories, figure that out by reading the code and understanding the provided images instead, then ask for user confirmation.
