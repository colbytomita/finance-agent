ALTER TABLE `active_trades` ADD `excluded_from_stats` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `active_trades` ADD `excluded_reason` text;