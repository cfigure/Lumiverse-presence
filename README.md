# Shared Presence

A small Lumiverse (Spindle) extension for an account that more than one person
logs into. It shows who else is connected right now and announces preset saves
so the other editor knows to reload before continuing.

## Install

Lumiverse → Extensions → *Install from Source* → paste
`https://github.com/cfigure/Lumiverse-presence`, then enable it. Only the
auto-granted `ui_panels` permission is needed. Lumiverse builds `src/` itself if
`dist/` is missing.

Install it while logged in as the shared account so the extension is
user-scoped to that account.

## Use

- First load asks for a nickname (stored per browser). Click ✎ on the pill to change it.
- The pill lists other connected sessions under the same account. Drag it anywhere.
- When anyone saves a preset, everyone gets a toast with the preset name and new
  revision. The saver sees it too; ignore your own.

## Optional

Grant the privileged `presets` permission and the pill also shows which preset
each person has open. Without it, presence still works.

## Local build

```
bun install
bun run build
```
