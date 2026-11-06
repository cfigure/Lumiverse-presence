# Shared Presence

A small Lumiverse (Spindle) extension for editors who share an account. It
shows who is connected, what they have open, and what changed in the latest
preset save.

## Install

Lumiverse → Extensions → *Install from Source* → paste
`https://github.com/cfigure/Lumiverse-presence`, then enable it. `ui_panels`
is auto-granted; `presets` is privileged and optional (see below). Lumiverse builds `src/` itself if
`dist/` is missing.

This release targets the Lumiverse staging build with Spindle frontend session
routing. Each roster and save summary is scoped to its Lumiverse account.

## Use

- First load asks for a nickname (stored per browser). Use your usual nickname
  when switching browsers. Click ✎ on the pill to change it.
- The pill lists other connected sessions under the same account. Drag it anywhere.
- When a preset is saved, a toast and the pill show which blocks were edited,
  added, removed, or reordered, along with changes such as sampler settings and
  prompt behaviour. Hover over the summary in the pill to see the preset name.
  The pill keeps the latest summary while the extension backend is running,
  including when a browser reconnects.
- The summary compares the new save with the preceding saved version. With
  `presets` granted, the backend loads a baseline when a browser joins. When a
  baseline is unavailable, the pill shows “Preset saved · change details unavailable.”

## Optional

Grant the privileged `presets` permission and the pill also shows which preset
each person has open and the block they last changed, e.g.
`Pyro · editing Sola › 'Jailbreak'`. Without it, presence still works.

## Local build

```
bun install
bun run build
```
