# About this repository

<!-- DRAFT: needs author -->
This is a published snapshot of a private working repository. It carries the code, the tests,
the scripts, the packaging loop, the cat's art and the prompts that made it. Its history starts
fresh at this snapshot; `MIRROR.json` records which commit of the working repository it was cut
from.

## What is not here

- **Working notes and logs.** The dated plan, trial reports and review notes written while trying
  CCF out on my own machine, and the step-by-step log of the sprite work. They describe one machine and one week, not the project. The prompts and measurements that
  document the cat's animations stay, beside the images under `assets/concepts/`.
- **The companion launcher.** The conversation panel starts its Claude Code session through a
  script in a separate repository of mine; that repository is not published.

`docs/STATUS.md` here is a trimmed copy of the working one: the passages about my own machine are
out. Where test fixtures carried a real Windows user folder, that folder is now called `dev`.

## Credit and licence

CCF began as a port of [Masko Code](https://github.com/RousselPaul/masko-code) v0.12.0 (MIT).
`LICENSE` keeps Masko's copyright notice beside mine; the MIT terms cover the code. Bundled
third-party assets keep their own licences: the Fredoka and Rubik fonts are under the SIL Open
Font License, with the texts in `apps/windows-shell/assets/fonts/`. The non-default mascots are
Masko's art from that release.
