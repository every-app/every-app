CREATE TABLE `access_evaluation_key` (
	`id` text PRIMARY KEY NOT NULL,
	`kid` text NOT NULL,
	`public_jwk` text NOT NULL,
	`private_jwk_sealed` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	CONSTRAINT "access_evaluation_key_singleton_check" CHECK("access_evaluation_key"."id" = 'current')
);
