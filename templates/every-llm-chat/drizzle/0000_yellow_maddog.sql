CREATE TABLE `chats` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `files` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`r2_key` text NOT NULL,
	`mime_type` text NOT NULL,
	`size` integer NOT NULL,
	`uploaded_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `files_user_id_idx` ON `files` (`user_id`);--> statement-breakpoint
CREATE TABLE `image_message_parts` (
	`id` text PRIMARY KEY NOT NULL,
	`part_id` text NOT NULL,
	`file_id` text NOT NULL,
	FOREIGN KEY (`part_id`) REFERENCES `message_parts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `image_message_parts_part_id_idx` ON `image_message_parts` (`part_id`);--> statement-breakpoint
CREATE TABLE `message_parts` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`type` text NOT NULL,
	`order` integer NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `message_parts_message_id_idx` ON `message_parts` (`message_id`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `messages_chat_id_idx` ON `messages` (`chat_id`);--> statement-breakpoint
CREATE TABLE `text_message_parts` (
	`id` text PRIMARY KEY NOT NULL,
	`part_id` text NOT NULL,
	`text` text NOT NULL,
	FOREIGN KEY (`part_id`) REFERENCES `message_parts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `text_message_parts_part_id_idx` ON `text_message_parts` (`part_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);