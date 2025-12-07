# CookingMat — Product Decisions

This document captures key product decisions made during schema design discussions.

---

## Chat System

### Multiple Chat Sessions
- The app supports multiple chat sessions (not a single continuous conversation)
- Each chat has a title that is:
  - AI-generated initially
  - User-editable

### Chat Activity
- A chat is considered "active" if created within the last 3 hours (computed, not stored)
- When clicking "Cook" on a recipe:
  - If an active chat exists → add recipe to that chat's active recipes
  - If no active chat → create a new chat

### Message Storage
- Messages store raw text content
- No message-level linking to recipes (only chat-level)

---

## Recipes

### Recipe Content
- Recipes are stored as markdown
- Each recipe has a title (separate from content for list display)

### Recipe Ownership
- Users own their recipes
- Recipes survive chat deletion (orphaned recipes are fine)

### Recipe Versioning
- Full markdown snapshots are stored for each version
- Version history enables "undo" and viewing past states
- Each version optionally links to the chat that created it:
  - `chatId` is set when version came from AI-assisted edit
  - `chatId` is null when user manually edited in markdown editor
  - `chatId` becomes null if the originating chat is deleted
- The "originating chat" is derived from the first version's `chatId`

### Recipe Modifications During Cooking
- When user tweaks a recipe while cooking, AI offers:
  - "Update recipe" → creates new version of current recipe
  - "Save as new" → creates entirely new recipe

---

## Active Cooking Sessions

### Persistence
- Active recipes persist across app restarts
- Stored in database (not local/session storage)

### Chat-Recipe Linking
- Recipes are linked to chats (many-to-many via junction table)
- Junction table tracks:
  - `activatedAt` — when recipe was added to chat
  - `sortOrder` — for card stacking order in UI

### UI State
- Expand/collapse state for recipe cards is UI-only (not persisted)

---

## Future Considerations

These features are NOT in MVP but the schema should accommodate them:

### Meals / Collections
- Grouping recipes into meals or collections
- Adding tags/labels to both meals and recipes

### Sharing
- Initial sharing will be markdown export only
- No multi-user recipe sharing planned for now

### Features Explicitly NOT Planned
- Image upload / camera
- Timers
- Shopping lists
- Search/filter (MVP)

---

## Multi-Device Behavior

- All data is stored in the database
- Refreshing from any device shows the latest state
- No special sync logic needed

---

*Product Decisions v0.1 — December 2024*
