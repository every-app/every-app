CREATE TABLE `chat_active_recipes` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`recipe_id` text NOT NULL,
	`activated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recipe_id`) REFERENCES `recipes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chat_active_recipes_chat_id_idx` ON `chat_active_recipes` (`chat_id`);--> statement-breakpoint
CREATE INDEX `chat_active_recipes_recipe_id_idx` ON `chat_active_recipes` (`recipe_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `chat_active_recipes_unique_idx` ON `chat_active_recipes` (`chat_id`,`recipe_id`);--> statement-breakpoint
CREATE TABLE `chats` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chats_user_id_idx` ON `chats` (`user_id`);--> statement-breakpoint
CREATE INDEX `chats_created_at_idx` ON `chats` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `files` (
	`id` text PRIMARY KEY NOT NULL,
	`r2_key` text NOT NULL,
	`mime_type` text NOT NULL,
	`size` text NOT NULL,
	`uploaded_at` text DEFAULT (current_timestamp) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `files_r2_key_unique` ON `files` (`r2_key`);--> statement-breakpoint
CREATE INDEX `files_r2_key_idx` ON `files` (`r2_key`);--> statement-breakpoint
CREATE TABLE `image_message_parts` (
	`id` text PRIMARY KEY NOT NULL,
	`part_id` text NOT NULL,
	`file_id` text NOT NULL,
	`mime_type` text NOT NULL,
	FOREIGN KEY (`part_id`) REFERENCES `message_parts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `image_message_parts_part_id_unique` ON `image_message_parts` (`part_id`);--> statement-breakpoint
CREATE INDEX `image_message_parts_part_id_idx` ON `image_message_parts` (`part_id`);--> statement-breakpoint
CREATE INDEX `image_message_parts_file_id_idx` ON `image_message_parts` (`file_id`);--> statement-breakpoint
CREATE TABLE `message_parts` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`type` text NOT NULL,
	`order` text NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `message_parts_message_id_order_idx` ON `message_parts` (`message_id`,`order`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `messages_chat_id_created_at_idx` ON `messages` (`chat_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `recipe_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`recipe_id` text NOT NULL,
	`chat_id` text,
	`content` text NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`recipe_id`) REFERENCES `recipes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `recipe_snapshots_recipe_id_idx` ON `recipe_snapshots` (`recipe_id`);--> statement-breakpoint
CREATE INDEX `recipe_snapshots_chat_id_idx` ON `recipe_snapshots` (`chat_id`);--> statement-breakpoint
CREATE TABLE `recipes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`content` text NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `recipes_user_id_idx` ON `recipes` (`user_id`);--> statement-breakpoint
CREATE TABLE `text_message_parts` (
	`id` text PRIMARY KEY NOT NULL,
	`part_id` text NOT NULL,
	`text` text NOT NULL,
	FOREIGN KEY (`part_id`) REFERENCES `message_parts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `text_message_parts_part_id_unique` ON `text_message_parts` (`part_id`);--> statement-breakpoint
CREATE INDEX `text_message_parts_part_id_idx` ON `text_message_parts` (`part_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);