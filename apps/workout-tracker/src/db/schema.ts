import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { relations, sql } from "drizzle-orm";

// === Enums (as const arrays for SQLite) ===

export const difficultyLevels = [
  "beginner",
  "intermediate",
  "advanced",
] as const;
export type DifficultyLevel = (typeof difficultyLevels)[number];

export const sessionStatuses = [
  "in_progress",
  "completed",
  "abandoned",
] as const;
export type SessionStatus = (typeof sessionStatuses)[number];

// === Users table ===

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(current_timestamp)`),
});

// === Programs table ===

export const programs = sqliteTable(
  "programs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull(),
    difficulty: text("difficulty", { enum: difficultyLevels }).notNull(),
    templateId: text("template_id"),
    currentWorkoutIndex: integer("current_workout_index").notNull().default(0),
    isActive: integer("is_active", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    index("programs_user_id_idx").on(table.userId),
    index("programs_active_idx").on(table.userId, table.isActive),
  ],
);

// === Workouts table ===

export const workouts = sqliteTable(
  "workouts",
  {
    id: text("id").primaryKey(),
    programId: text("program_id")
      .notNull()
      .references(() => programs.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    sortOrder: integer("sort_order").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [index("workouts_program_id_idx").on(table.programId)],
);

// === Exercise Library table (NEW) ===
// Global exercise definitions that can be reused across workouts

export const exerciseLibrary = sqliteTable(
  "exercise_library",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    notes: text("notes"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [index("exercise_library_user_id_idx").on(table.userId)],
);

// === Workout Exercises table (RENAMED from exercises) ===
// Links exercises from the library to specific workouts with workout-specific config

export const workoutExercises = sqliteTable(
  "workout_exercises",
  {
    id: text("id").primaryKey(),
    workoutId: text("workout_id")
      .notNull()
      .references(() => workouts.id, { onDelete: "cascade" }),
    exerciseId: text("exercise_id")
      .notNull()
      .references(() => exerciseLibrary.id, { onDelete: "restrict" }),
    sets: integer("sets").notNull(),
    targetReps: integer("target_reps").notNull(),
    weight: integer("weight"),
    sortOrder: integer("sort_order").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    index("workout_exercises_workout_id_idx").on(table.workoutId),
    index("workout_exercises_exercise_id_idx").on(table.exerciseId),
  ],
);

// === Workout Sessions table ===

export const workoutSessions = sqliteTable(
  "workout_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Keep FKs for queries, set null on delete to preserve history
    programId: text("program_id").references(() => programs.id, {
      onDelete: "set null",
    }),
    workoutId: text("workout_id").references(() => workouts.id, {
      onDelete: "set null",
    }),
    // Snapshots captured at session completion for historical display
    programNameSnapshot: text("program_name_snapshot").notNull(),
    workoutNameSnapshot: text("workout_name_snapshot").notNull(),
    status: text("status", { enum: sessionStatuses })
      .notNull()
      .default("in_progress"),
    startedAt: text("started_at").notNull(),
    completedAt: text("completed_at"),
  },
  (table) => [
    index("workout_sessions_user_id_idx").on(table.userId),
    index("workout_sessions_program_id_idx").on(table.programId),
    // Partial unique index to enforce single active session per workout
    // Allows multiple in-progress sessions across different workouts/programs
    uniqueIndex("workout_sessions_single_active_idx")
      .on(table.workoutId)
      .where(sql`status = 'in_progress'`),
  ],
);

// === Workout Set Logs table ===

export const workoutSetLogs = sqliteTable(
  "workout_set_logs",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => workoutSessions.id, { onDelete: "cascade" }),
    // FK for queries (PRs, history by exercise), set null on delete to preserve history
    exerciseId: text("exercise_id").references(() => exerciseLibrary.id, {
      onDelete: "set null",
    }),
    // Snapshot captured when set is logged for historical display
    exerciseNameSnapshot: text("exercise_name_snapshot").notNull(),
    setNumber: integer("set_number").notNull(),
    targetReps: integer("target_reps").notNull(),
    actualReps: integer("actual_reps").notNull(),
    weight: integer("weight"),
    sortOrder: integer("sort_order").notNull(),
  },
  (table) => [
    index("workout_set_logs_session_id_idx").on(table.sessionId),
    index("workout_set_logs_exercise_id_idx").on(table.exerciseId),
  ],
);

// === Relations ===

export const usersRelations = relations(users, ({ many }) => ({
  programs: many(programs),
  exerciseLibrary: many(exerciseLibrary),
  workoutSessions: many(workoutSessions),
}));

export const programsRelations = relations(programs, ({ one, many }) => ({
  user: one(users, {
    fields: [programs.userId],
    references: [users.id],
  }),
  workouts: many(workouts),
  workoutSessions: many(workoutSessions),
}));

export const workoutsRelations = relations(workouts, ({ one, many }) => ({
  program: one(programs, {
    fields: [workouts.programId],
    references: [programs.id],
  }),
  workoutExercises: many(workoutExercises),
  workoutSessions: many(workoutSessions),
}));

export const exerciseLibraryRelations = relations(
  exerciseLibrary,
  ({ one, many }) => ({
    user: one(users, {
      fields: [exerciseLibrary.userId],
      references: [users.id],
    }),
    workoutExercises: many(workoutExercises),
    workoutSetLogs: many(workoutSetLogs),
  }),
);

export const workoutExercisesRelations = relations(
  workoutExercises,
  ({ one }) => ({
    workout: one(workouts, {
      fields: [workoutExercises.workoutId],
      references: [workouts.id],
    }),
    exercise: one(exerciseLibrary, {
      fields: [workoutExercises.exerciseId],
      references: [exerciseLibrary.id],
    }),
  }),
);

export const workoutSessionsRelations = relations(
  workoutSessions,
  ({ one, many }) => ({
    user: one(users, {
      fields: [workoutSessions.userId],
      references: [users.id],
    }),
    program: one(programs, {
      fields: [workoutSessions.programId],
      references: [programs.id],
    }),
    workout: one(workouts, {
      fields: [workoutSessions.workoutId],
      references: [workouts.id],
    }),
    workoutSetLogs: many(workoutSetLogs),
  }),
);

export const workoutSetLogsRelations = relations(workoutSetLogs, ({ one }) => ({
  session: one(workoutSessions, {
    fields: [workoutSetLogs.sessionId],
    references: [workoutSessions.id],
  }),
  exercise: one(exerciseLibrary, {
    fields: [workoutSetLogs.exerciseId],
    references: [exerciseLibrary.id],
  }),
}));

// === Type Exports ===

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type Program = typeof programs.$inferSelect;
export type NewProgram = typeof programs.$inferInsert;

export type Workout = typeof workouts.$inferSelect;
export type NewWorkout = typeof workouts.$inferInsert;

export type ExerciseLibraryItem = typeof exerciseLibrary.$inferSelect;
export type NewExerciseLibraryItem = typeof exerciseLibrary.$inferInsert;

export type WorkoutExercise = typeof workoutExercises.$inferSelect;
export type NewWorkoutExercise = typeof workoutExercises.$inferInsert;

export type WorkoutSession = typeof workoutSessions.$inferSelect;
export type NewWorkoutSession = typeof workoutSessions.$inferInsert;

export type WorkoutSetLog = typeof workoutSetLogs.$inferSelect;
export type NewWorkoutSetLog = typeof workoutSetLogs.$inferInsert;

// Composite types for nested data
export type WorkoutExerciseWithLibrary = WorkoutExercise & {
  exercise: ExerciseLibraryItem;
};

export type WorkoutWithExercises = Workout & {
  workoutExercises: WorkoutExerciseWithLibrary[];
};

export type ProgramWithWorkouts = Program & {
  workouts: WorkoutWithExercises[];
};

export type SessionWithSetLogs = WorkoutSession & {
  workoutSetLogs: WorkoutSetLog[];
};
