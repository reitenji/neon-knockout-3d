export type DomainErrorCode =
  | 'INVALID_PAYLOAD'
  | 'INVALID_PLAYER'
  | 'BOT_NOT_FOUND'
  | 'INVALID_DIFFICULTY'
  | 'INVALID_ROLE'
  | 'SPECTATOR_ACTION'
  | 'ALREADY_IN_ROOM'
  | 'INVALID_CHASSIS'
  | 'INVALID_NAME'
  | 'INVALID_PHASE'
  | 'INVALID_RESUME_TOKEN'
  | 'INVALID_ROOM_CODE'
  | 'MATCH_IN_PROGRESS'
  | 'NOT_ENOUGH_PLAYERS'
  | 'NOT_HOST'
  | 'NOT_READY'
  | 'PLAYER_NOT_FOUND'
  | 'RATE_LIMITED'
  | 'SERVER_CAPACITY'
  | 'ROOM_FULL'
  | 'ROOM_NOT_FOUND';

export class DomainError {
  constructor(
    readonly code: DomainErrorCode,
    readonly safeMessage: string,
    readonly recoverable: boolean
  ) {}
}
