CREATE TABLE `peer_offers` (
	`id` text PRIMARY KEY NOT NULL,
	`room_code` text NOT NULL,
	`guest_hash` text NOT NULL,
	`offer` text NOT NULL,
	`answer` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`room_code`) REFERENCES `peer_rooms`(`code`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `peer_offers_room` ON `peer_offers` (`room_code`);--> statement-breakpoint
CREATE INDEX `peer_offers_expiry` ON `peer_offers` (`expires_at`);--> statement-breakpoint
CREATE TABLE `peer_rooms` (
	`code` text PRIMARY KEY NOT NULL,
	`owner_hash` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `peer_rooms_expiry` ON `peer_rooms` (`expires_at`);