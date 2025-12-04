# Prompts
## Simplify
Can you please review this codebase?
I want to know:
- Is there anyway that we can simplify / things that are unnecessary?
- Is there any code that sticks out as needing refactored?
  - Does anything need split up into larger functions?
  - Were there any shortcuts taken or hardcoded assumptions that we never came back to?
  - Can anything be simplified?

Our guiding philosophy is making code as simple as possible, avoiding premature optimization, all while ensuring that the app has optimistic updates by using TanstackDB and that data is properly and securely stored to our database. 

Don't make any changes, just write a report on the above questions. 

## Security
Can you please review this repo for security? The main priority should be that authentication and authoriztion is properly set for all api routes and backend services. We want defense in depth and don't want to rely on things like user checks happening earlier.

Additional things to check:
- Ensure no hard coded secrets or keys
- Any other security considerations unique to this project

## Database Scehma
# Task
I want to reevalutate our database schema from the ground up.
I want the schema to be as normalized as possible, but also want the schema to be mindful of how users will use the app. We also may want to rename some tables given the usage patterns of the app now that we have the prototype built.

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
