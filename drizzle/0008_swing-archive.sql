CREATE TABLE `archived_setups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ticker` text NOT NULL,
	`setup_type` text NOT NULL,
	`setup_quality_score` real NOT NULL,
	`entry_range_low` real NOT NULL,
	`entry_range_high` real NOT NULL,
	`stop_loss` real NOT NULL,
	`target_price_1` real NOT NULL,
	`target_price_2` real,
	`risk_reward_ratio` real NOT NULL,
	`invalidation_condition` text,
	`detected_at` text NOT NULL,
	`archived_at` text NOT NULL,
	`note` text,
	`suppressing` integer DEFAULT true NOT NULL
);
