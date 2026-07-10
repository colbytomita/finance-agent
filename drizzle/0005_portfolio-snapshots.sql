CREATE TABLE `portfolio_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`snapshot_date` text NOT NULL,
	`holdings_value` real NOT NULL,
	`open_trades_value` real NOT NULL,
	`total_value` real NOT NULL,
	`holding_count` integer NOT NULL,
	`captured_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `portfolio_snapshots_snapshot_date_unique` ON `portfolio_snapshots` (`snapshot_date`);