ALTER TABLE `peer_rooms` ADD `source_hash` text NOT NULL DEFAULT '';--> statement-breakpoint
CREATE INDEX `peer_rooms_source_expiry` ON `peer_rooms` (`source_hash`,`expires_at`);
