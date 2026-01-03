---
description: Review database schema for normalization and drizzle best practices
subtask: true
---
**Focus area:** $ARGUMENTS

Please review or create the database schema based on the below principles.

Ensure that you're using drizzle as designed:
- https://orm.drizzle.team/docs/relations
- https://orm.drizzle.team/docs/indexes-constraints

## Guiding Principles
- Maximal normalization - everything should be normalized as much as possible. This is to avoid keeping tables in sync or having optional columns that only apply to certain record types. Down the line, this will make it challenging to do migrations and lead to bugs due to faulty assumptions.
- As many assumptions as possible should be enforced at the database layer via the schema / unique constraints.
- Make sure you properly use drizzle relations.
  - Be sure to read the docs: https://orm.drizzle.team/docs/relations

## Before you design
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

Don't make any changes, just write a report on the schema review.
