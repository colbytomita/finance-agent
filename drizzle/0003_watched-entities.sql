CREATE TABLE `watched_entities` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entity` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `watched_entities_entity_unique` ON `watched_entities` (`entity`);