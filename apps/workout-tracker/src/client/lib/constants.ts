/**
 * Shared constants for the workout tracker app.
 */

/**
 * Default progression increment in lbs.
 * This is the weight added when an exercise is completed successfully.
 */
export const DEFAULT_PROGRESSION_INCREMENT = 5;

/**
 * Grid column definitions for exercise tables.
 * These define the column widths for the exercise table header and rows.
 */
export const EXERCISE_TABLE_GRID = {
  /** Grid columns when in edit mode: [grip, name, sets, reps, lbs, incr, delete] */
  editMode: "grid-cols-[1.5rem_8rem_4.5rem_4.5rem_4.5rem_4.5rem_2.5rem]",
  /** Grid columns when in view mode: [name, sets, reps, lbs, incr] */
  viewMode: "grid-cols-[1fr_3.5rem_3.5rem_4rem_3.5rem]",
} as const;
