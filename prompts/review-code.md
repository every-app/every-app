# Prompts
## Simplify
Can you please review this codebase?
I want to know:
- Is there anyway that we can simplify / things that are unnecessary?
- Is there any code that sticks out as needing refactored?
  - Does anything need split up into smaller functions?
  - Were there any shortcuts taken or hardcoded assumptions that we never came back to?
  - Can anything be simplified?

Our guiding philosophy is making code as simple as possible, avoiding premature optimization. Some things we don't consider a premature optimization:
- Optimistic updates by using TanstackDB and that data is properly and securely stored to our database. 
- Normalized database schemas to make future migrations and iteration cleaner.
- Service / Repository pattern is desired even if its a bit overkill so that it is more natural to implement more complicated features in the future. 
- Defense in depth and ensuring that authentication and authorization is happening.

Other patterns we consider acceptable:
- Hard coding llm related info such as models, reasoning effort and prompts is fione. 

Don't make any changes, just write a report on the above questions. 

## Security
Can you please review this repo for security? The main priority should be that authentication and authoriztion is properly set for all api routes and backend services. We want defense in depth and don't want to rely on things like user checks happening earlier.

Additional things to check:
- Ensure no hard coded secrets or keys
- Any other security considerations unique to this project

## Database Scehma
### Task
Please review or create the database schema based on the below principles.

Ensure that you're using drizzle as designed:
- https://orm.drizzle.team/docs/relations
- https://orm.drizzle.team/docs/indexes-constraints

### Guiding Principles
- Maximal normalization - everything should be normalized as much as possible. This is to avoid keeping tables in sync or having optional columns that only apply to certain record types. Down the line, this will make it challenging to do migrations and lead to bugs due to faulty assumptions.
- As many assumptions as possible should be enforced at the database layer via the schema / unique constraints.
- Make sure you properly use drizzle relations.
  - Be sure to read the docs: https://orm.drizzle.team/docs/relations
### Before you design
- Ask the users clarifying questions about use cases down the line
  - We don't want to build out support in the schema for any future features, but we want to make sure that our schema is designed intelligently so that it is easy to migrate the schema to support new features later.

## Example problem with current schema
Summary: Session History Data Model Problem

Current Behavior
When a workout session is created, the programName and workoutName are snapshotted (copied) into the session record at creation time (useWorkoutSession.ts:121-122). The session stores these as static strings rather than referencing the source data.

The Problem
If a user renames a program or workout after sessions have been created, the history page still displays the old names because:
1. Sessions store copies of names, not references to the live program/workout
2. There's no mechanism to propagate name changes to existing session records
Current Data Flow
Program (name: "My Program")
    ↓ copied at session creation
Session (programName: "My Program")  ← static, never updates 

## Flexibility Requirements
- Users should be able to change their workout names
  - This should reflect when users finish their workout moving forwards
  - All previous completed workouts should have the name at the time it was completed
- Exercises should behave like workouts
  - Users should be able to change the exercise name and it should apply to future set logs, but not past

## Guidance
- Normalized data is a key requirement
