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

export const FIGHTERS: Readonly<Record<Chassis, FighterDefinition>> = Object.freeze({
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
  }),
  EMBER: Object.freeze({
    name: 'EMBER', role: 'Patlayıcı', abilityName: 'Fırın Patlaması',
    description: 'Kısa hücum başlarken yakınındaki rakiplere güçlü bir ısı darbesi vurur.',
    color: '#FF753D', moveSpeed: 300, dashSpeed: 560, dashDurationMs: 150,
    dashInvulnerabilityMs: 0, dashCooldownMs: 1_900, knockbackMultiplier: 0.9,
    burstRadius: 90, burstOverloadGain: 12, burstBaseImpulse: 330
  }),
  VOLT: Object.freeze({
    name: 'VOLT', role: 'Sprinter', abilityName: 'Şimşek Adımı',
    description: 'Çok kısa ve hızlı bir kaçış yapar; hücumu çabuk yeniden dolar.',
    color: '#F8DD45', moveSpeed: 380, dashSpeed: 1_050, dashDurationMs: 100,
    dashInvulnerabilityMs: 70, dashCooldownMs: 950, knockbackMultiplier: 1.18
  }),
  TITAN: Object.freeze({
    name: 'TITAN', role: 'Ağır Zırh', abilityName: 'Çelik Duruş',
    description: 'Ağır adımlarla ilerlerken savrulmaya direnir. %250 hasarda zırhı da yetmez.',
    color: '#96CF64', moveSpeed: 250, dashSpeed: 220, dashDurationMs: 350,
    dashInvulnerabilityMs: 0, dashCooldownMs: 2_000, knockbackMultiplier: 0.55,
    armoredDashKnockbackMultiplier: 0.22
  }),
  NOVA: Object.freeze({
    name: 'NOVA', role: 'Yörünge Kontrolü', abilityName: 'Yıldız Dalgası',
    description: 'Geniş bir alandaki rakipleri hafifçe iten dalgayla mesafe açar.',
    color: '#79ABFF', moveSpeed: 290, dashSpeed: 480, dashDurationMs: 160,
    dashInvulnerabilityMs: 40, dashCooldownMs: 2_100, knockbackMultiplier: 1.05,
    burstRadius: 180, burstOverloadGain: 6, burstBaseImpulse: 210
  })
});
