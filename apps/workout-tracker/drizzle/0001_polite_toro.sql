DROP INDEX `workout_sessions_single_active_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `workout_sessions_single_active_idx` ON `workout_sessions` (`workout_id`) WHERE status = 'in_progress';