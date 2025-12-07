CREATE TABLE `tool_invocation_message_parts` (
	`id` text PRIMARY KEY NOT NULL,
	`part_id` text NOT NULL,
	`tool_call_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`state` text NOT NULL,
	`input` text NOT NULL,
	`output` text,
	FOREIGN KEY (`part_id`) REFERENCES `message_parts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tool_invocation_message_parts_part_id_unique` ON `tool_invocation_message_parts` (`part_id`);--> statement-breakpoint
CREATE INDEX `tool_invocation_message_parts_part_id_idx` ON `tool_invocation_message_parts` (`part_id`);--> statement-breakpoint
CREATE INDEX `tool_invocation_message_parts_tool_call_id_idx` ON `tool_invocation_message_parts` (`tool_call_id`);