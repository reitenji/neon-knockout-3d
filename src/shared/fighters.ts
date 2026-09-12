import type { Chassis } from './model.js';

export type FighterDefinition = Readonly<{
  name: string;
  role: string;
  abilityName: string;
  description: string;
  color: string;
  moveSpeed: number;
  dashSpeed: number;
  dashDurationMs: number;
  dashInvulnerabilityMs: number;
  dashCooldownMs: number;
  knockbackMultiplier: number;
  armoredDashKnockbackMultiplier?: number;
  burstRadius?: number;
  burstOverloadGain?: number;
  burstBaseImpulse?: number;
}>;

export const FIGHTERS = Object.freeze({
  RIFT: Object.freeze({
    name: 'RIFT',
    role: 'Düellocu',
    abilityName: 'Yarık Hücumu',
    description: 'İleri doğru çok hızlı ve uzun bir hücum yapar.',
    color: '#58DCED',
    moveSpeed: 350,
    dashSpeed: 900,
    dashDurationMs: 160,
    dashInvulnerabilityMs: 100,
    dashCooldownMs: 1_300,
    knockbackMultiplier: 1
  }),
  BASTION: Object.freeze({
    name: 'BASTION',
    role: 'Muhafız',
    abilityName: 'Zırhlı İlerleyiş',
    description: 'Yavaşça ilerlerken gelen savrulmayı güçlü biçimde azaltır.',
    color: '#F6B65D',
    moveSpeed: 275,
    dashSpeed: 420,
    dashDurationMs: 250,
    dashInvulnerabilityMs: 0,
    dashCooldownMs: 1_700,
    knockbackMultiplier: 0.65,
    armoredDashKnockbackMultiplier: 0.3
  }),
  PULSE: Object.freeze({
    name: 'PULSE',
    role: 'Alan Kontrolü',
    abilityName: 'Radyal Darbe',
    description: 'Hücum başlarken yakındaki rakipleri her yöne savurur.',
    color: '#FF668D',
    moveSpeed: 315,
    dashSpeed: 650,
    dashDurationMs: 140,
    dashInvulnerabilityMs: 80,
    dashCooldownMs: 1_800,
    knockbackMultiplier: 1,
    burstRadius: 125,
    burstOverloadGain: 8,
    burstBaseImpulse: 260
  }),
  WRAITH: Object.freeze({
    name: 'WRAITH',
    role: 'Kaçışçı',
    abilityName: 'Faz Geçişi',
    description: 'Uzun bir faz penceresinde saldırıların içinden geçer.',
    color: '#B79AFF',
    moveSpeed: 340,
    dashSpeed: 780,
    dashDurationMs: 210,
    dashInvulnerabilityMs: 190,
    dashCooldownMs: 1_550,
    knockbackMultiplier: 1.12
  })
} satisfies Readonly<Record<Chassis, FighterDefinition>>);
