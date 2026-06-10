# @yboyer/pi

<p align="center">
  <img src="https://raw.githubusercontent.com/yboyer/pi/master/.assets/pi.png" width="768">
</p>

Pi package with custom setup:

- custom extensions
- custom skills
- custom prompt templates
- custom theme

## Install

```bash
pi install git:github.com/yboyer/pi
```

Or from local clone:

```bash
pi install /absolute/path/to/pi
```

## settings.json

For full personal setup, use this `settings.json`:

```json
{
  "theme": "one-dark-pro",
  "quietStartup": true,
  "packages": [
    "npm:@juicesharp/rpiv-ask-user-question",
    "npm:pi-mcp-adapter",
    "git:github.com/yboyer/pi",
    {
      "source": "npm:context-mode",
      "skills": [
        "-skills/ctx-doctor/SKILL.md",
        "-skills/ctx-index/SKILL.md",
        "-skills/ctx-insight/SKILL.md",
        "-skills/ctx-purge/SKILL.md",
        "-skills/ctx-search/SKILL.md",
        "-skills/ctx-stats/SKILL.md",
        "-skills/ctx-upgrade/SKILL.md",
        "-skills/context-mode/SKILL.md"
      ]
    }
  ]
}
```

## Skills via `npx skills`

This repo is compatible with [`npx skills`](https://github.com/vercel-labs/skills) because skills live in `skills/`.

Example:

```bash
npx skills add github.com/yboyer/pi
```
