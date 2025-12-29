ALTER TABLE `exercise_library` ADD `progression_increment` integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE `programs` ADD `progression_mode` text DEFAULT 'linear' NOT NULL;