---
name: "Neon Knockout 3D"
description: "A readable neon industrial arena with four articulated robot fighters."
colors:
  bg: "#05080c"
  bg-raised: "#0a1016"
  surface: "#0d151d"
  surface-strong: "#111c26"
  border: "#21313f"
  border-strong: "#365065"
  text: "#edf7fb"
  text-muted: "#8da4b4"
  cyan: "#25d9f8"
  cyan-dim: "#0e7085"
  amber: "#ffb347"
  amber-dim: "#8c5620"
  ready: "#77e34d"
  warning: "#ffc857"
  danger: "#ff5d6c"
  arena-void: "#060b16"
  arena-steel: "#283b4c"
  arena-wall: "#111f30"
  arena-edge: "#89e4ed"
  arena-edge-contracting: "#ffa066"
  protection-ivory: "#dce8ed"
  fighter-rift: "#58dced"
  fighter-bastion: "#f6b65d"
  fighter-pulse: "#ff668d"
  fighter-wraith: "#b79aff"
  fighter-dark: "#152332"
  fighter-pale: "#e4edf2"
  fighter-joint: "#303e50"
  fighter-pulse-armor: "#e0e4e1"
typography:
  display:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "clamp(2rem, 4vw, 3.25rem)"
    fontWeight: 650
    lineHeight: 1
    letterSpacing: "0.13em"
  body:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
  label:
    fontFamily: "\"SFMono-Regular\", Consolas, \"Liberation Mono\", monospace"
    fontSize: "0.75rem"
    letterSpacing: "0.12em"
  eyebrow:
    fontFamily: "\"SFMono-Regular\", Consolas, \"Liberation Mono\", monospace"
    fontSize: "0.72rem"
    letterSpacing: "0.2em"
  command:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontWeight: 650
    letterSpacing: "0.035em"
  chrome:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "0.72rem"
    letterSpacing: "0.05em"
  fighter-label:
    fontFamily: "system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: 1.3
  announcement:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "clamp(3.4rem, 9vw, 6rem)"
    fontWeight: 850
    lineHeight: 0.9
    letterSpacing: "-0.035em"
rounded:
  sm: "4px"
  md: "8px"
  lg: "14px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "6": "24px"
  "8": "32px"
components:
  button-cyan:
    backgroundColor: "{colors.bg-raised}"
    textColor: "{colors.text}"
    typography: "{typography.command}"
    rounded: "{rounded.sm}"
    padding: "0 18px"
  button-amber:
    backgroundColor: "{colors.bg-raised}"
    textColor: "{colors.text}"
    typography: "{typography.command}"
    rounded: "{rounded.sm}"
    padding: "0 18px"
  button-chrome:
    backgroundColor: "{colors.bg-raised}"
    textColor: "{colors.text-muted}"
    typography: "{typography.chrome}"
    rounded: "{rounded.sm}"
    padding: "0 11px"
  input:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.text}"
    rounded: "{rounded.sm}"
    height: "48px"
    padding: "0 16px"
  tech-frame:
    backgroundColor: "rgb(8 14 20 / 0.98)"
  fighter-option:
    backgroundColor: "{colors.bg-raised}"
    textColor: "{colors.text-muted}"
    padding: "{spacing.2}"
  fighter-option-selected:
    backgroundColor: "{colors.bg-raised}"
    textColor: "{colors.cyan}"
    padding: "{spacing.2}"
  ability-meter:
    backgroundColor: "rgb(37 217 248 / 0.1)"
    height: "5px"
---

# Design System: Neon Knockout 3D

## Overview

**Creative North Star: "Neon industrial arena"**

The neon industrial arena makes four authored robot silhouettes readable against a dark steel stage. Compact, instrument-like menus support the match; the 2.5D world supplies depth through geometry, directional poses and grounded shadows. Turkish remains the product language.

The camera is fixed and orthographic. Small emissive accents identify machinery and actions without washing out silhouettes, player rings or the playable boundary. All fighter geometry is authored locally with articulated Three.js primitives, so the visual identity works without external model assets or an asset CDN.

**Key Characteristics:**
- Dark steel surfaces with restrained cyan and amber interface accents.
- Four distinct fighter silhouettes, with player identity separate from chassis color.
- Fixed orthographic composition and visual height above a flat gameplay plane.
- Combat-clock poses and persistent, readable status cues.

This document records the implemented system. Frontmatter owns normative primitives; `.impeccable/design.json` extends them with motion, depth, responsive metadata and component samples. Source evidence: `src/client/styles/{tokens,layout,game,lan-share}.css`, `src/shared/fighters.ts`, and `src/client/game/three/{ArenaWorld,FighterModel,FighterView,fighterMotion,CharacterPreview,CombatEffects}`.

## Colors

Electric accents sit on blue-black interface surfaces and matte steel world geometry. Frontmatter names correspond to existing CSS roles or specific scene materials; UI cyan and RIFT cyan are deliberately distinct values.

### Primary

- **Interface cyan** (`cyan`, `cyan-dim`): creation actions, selection, focus, ability meters and room codes.
- **RIFT cyan** (`fighter-rift`): the athletic striker's armor and small emissive parts.

### Secondary

- **Interface amber** (`amber`, `amber-dim`): join actions and overload meters.
- **BASTION amber**, **PULSE coral**, **WRAITH violet** (`fighter-bastion`, `fighter-pulse`, `fighter-wraith`): distinct chassis materials and ability cues. PULSE uses pale armor around its coral reactor.
- **Ready green**, **warning gold**, **danger red** (`ready`, `warning`, `danger`): ready/connected, pending/warning and failure states. Accompany these colors with text or stateful controls.

### Neutral

- **Blue-black shell** (`bg`, `bg-raised`, `surface`, `surface-strong`): increasing interface surface strength.
- **Steel borders** (`border`, `border-strong`): dividers and interactive outlines.
- **Cool ivory text** and **muted blue text** (`text`, `text-muted`): primary content and supporting information.
- **Arena void**, **arena steel**, **arena wall**: the scene background, platform top and extruded sides. The implemented top uses `arena-steel`, replacing the earlier provisional floor value.
- **Arena edge** becomes **contracting edge** during contraction. **Protection ivory** is reserved here for the persistent spawn-protection ground ring.
- **Fighter dark**, **fighter pale**, **fighter joint**, **PULSE armor**: shared non-emissive mechanical materials.

**The Identity Rule.** Chassis color identifies a fighter type; the independent player accent, name and ground ring identify the player. Preserve both channels.

## Typography

**Display and body font:** the local Inter/system sans stack in frontmatter. There is no font download requirement; available system fallbacks determine actual rendering.

**Label font:** the local SFMono/Consolas/Liberation Mono stack. The contrast is functional: sans text carries names and instructions; mono text carries room codes, compact field labels, controls and match telemetry.

### Hierarchy

- **Display:** spaced uppercase game identity, using the responsive display role.
- **Body:** inherited UI font; sizes belong to their concrete components, rather than a fabricated global body size.
- **Label / eyebrow:** short, tracked interface labels. Preserve Turkish characters and concise wording.
- **Command / chrome:** larger main actions versus compact utility actions.
- **Fighter label:** projected DOM text above each model; truncate long names rather than covering neighboring fighters. At narrow widths, labels reduce to 9px and the name maximum reduces from 100px to 64px.
- **Announcement:** brief center-stage round feedback; sudden-death feedback has its own compact mono badge treatment.

## Layout

The application fills the dynamic viewport. Desktop chrome uses a 54px top row, 12px vertical gap and 12px/24px/16px shell padding. The 4px spacing scale in frontmatter supports compact menus without turning the match into a panel dashboard.

Landing content is capped at 1120px; the lobby at 1240px. Landing actions use two equal columns, while invitation entry uses one column. The lobby shows four fighter options and a shared procedural character showcase. Lobby content can scroll vertically when its content exceeds the available space. At widths of at least 900px and heights of at least 620px, the compact lobby uses a 145px showcase and 8px gaps.

The scene maps gameplay x/y to world x/z, with visual height on world y. The camera sits at (0, 950, 850), looks at the origin and does not orbit or shake. Its view height is the greater of 780 world units and 1330 divided by the viewport aspect ratio. Keep the full playable polygon visible when resizing; the arena outline follows the actual contracting polygon.

HUD elements occupy the perimeter: roster left, clock centered, connection right, combat status below. Their pointer-transparent layer leaves the canvas available. Coarse-pointer landscape play fills the viewport, hides top chrome and keyboard hints, and places the movement pad and action buttons within safe-area insets. Portrait orientation provides a rotate prompt. Narrow menus and short viewports use the existing CSS breakpoints recorded in the sidecar; do not infer a new responsive grid.

## Elevation & Depth

The interface combines dark tonal layers, fine borders and structural shadows; command accents have small inset/outward glows. Main frames use a broad dark shadow, top chrome a smaller one, and HUD panels a restrained overlay shadow. Exact reusable shadow and focus values live in the sidecar.

The arena is an extruded, beveled platform with a rough steel top, metal sides, hemisphere fill, a shadow-casting directional key and a cool rim light. Fog recedes into the blue-black void. Contact shadows, silhouette, articulation and restrained emissive geometry provide depth without bloom postprocessing.

**The Grounded Motion Rule.** Keep the fighter root at the displayed gameplay position. Apply bob, lean, twist, squash and respawn height to the body hierarchy; animation never moves hitboxes.

Decorative bobbing, preview sway and PULSE ornament rotation stop under reduced motion. Combat articulation, ability cues and the stable white protection ring remain legible. Impact effects retain their fade but use a fixed scale in reduced motion; UI announcements and meter interpolation stop animating. A returning fighter begins its brief body drop only after the authoritative respawn, at the new displayed spawn position.

## Shapes

Use clipped industrial corners for primary commands and major frames, with fine one-pixel borders. Commands clip opposing corners by 10px; large frames use an eight-corner 14px cut. Small form fields and utility controls use the small radius token. Circular forms carry energy, ground identity, protection, charge and touch controls.

The playable platform is an octagonal polygon that contracts with gameplay. Fighter form language stays distinct: RIFT has a narrow torso, split fins and long forearm blades; BASTION broad squared shoulders, heavy gauntlets and short armored legs; PULSE a spherical reactor with hovering lower machinery and orbital fins; WRAITH a tapered hooded body, long forearms and split trailing panels.

## Components

### Buttons

Cyan and amber commands are compact clipped metal controls with a minimum height of 48px and width of 180px. Color appears in the border and restrained glow; the fill remains raised dark. Utility buttons use smaller rectangular forms with a minimum height of 34px. Hover strengthens borders and text; press shifts by one pixel. Visible keyboard focus uses the shared two-layer focus ring. Disabled actions reduce opacity and remove glow.

### Inputs / Fields

Fields use a 48px height, small rounded corners and a strong steel border. Cyan and amber variants color the label and focused border; errors use the danger border. Room-code fields use mono type with uppercase rendering. Focus remains explicit; errors are tied to actual form state.

### Cards / Containers

Large technical frames use clipped corners, a dark translucent fill, an inset hairline and structural shadow. Do not reinterpret these as rounded floating cards. The LAN share region is a compact bordered strip: muted labels, a cyan local address and small copy/refresh controls, stacking with the lobby room header when space narrows.

### Top chrome

A three-column status strip holds the game mark, room context and connection/sound/leave controls. It carries status and session actions rather than a conventional multi-page navigation menu. Its compact variants remove low-priority visible text; landscape touch matches hide the strip entirely.

### Fighter selection and showcase

Four options use the existing selection border and text, paired with locally rendered 3D models on octagonal podiums. The selected fighter's real role, ability name and description appear below the showcase. Selection changes material emphasis; reduced motion removes decorative preview rotation and bobbing.

### Match HUD and ground cues

Compact mono panels show live score, overload, charge and movement-ability cooldown. Meters scale from the left with actual progress. Names and independent identity rings stay tied to projected player positions; the local ring is wider and brighter. Protection is a separate stable ivory ring, outside the identity ring, displayed while spawn protection is active and suppressed for offensive actions. It never depends on flicker, pulsing or transparency of the fighter body alone.

### Fighter animation and combat effects

RIFT steps and strikes sharply; BASTION moves with heavier planted timing; PULSE floats and radiates charge; WRAITH glides and becomes translucent during phase movement. Windup, active and recovery poses follow combat timing. Body-only knockout shrink/fade and authoritative return motion leave the ground origin intact. Attack trails use the current combat capsule geometry; charge and ability rings use real action state.

## Do's and Don'ts

### Do:
- Do preserve the whole playable polygon when the viewport changes.
- Do make RIFT, BASTION, PULSE and WRAITH identifiable by silhouette and motion.
- Do use server snapshot state for cooldowns, protection and match status.
- Do retain the white ground protection ring under reduced motion.
- Do preserve Turkish labels, keyboard focus and landscape touch controls.

### Don't:
- Don't use bloom-heavy noise or camera motion that hides competitive information.
- Don't move gameplay roots or hitboxes to make an animation look stronger.
- Don't replace player identity accents with chassis colors.
- Don't animate a fighter returning before the authoritative respawn occurs.
- Don't depend on remote fonts, models or asset CDNs for the local experience.
