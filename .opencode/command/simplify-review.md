---
description: Review codebase for simplification opportunities
subtask: true
---
**Focus area:** $ARGUMENTS

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
- Hard coding llm related info such as models, reasoning effort and prompts is fine. 

Don't make any changes, just write a report on the above questions.
