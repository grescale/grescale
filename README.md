# Grescale

> [!CAUTION]
> Grescale is an **experimental**, Bun-based alternative that is built to feel like PocketBase, but for Postgres.

It is heavily inspired by [PocketBase](https://github.com/pocketbase/pocketbase).

Most of this repository was created through vibe coding, with roughly **85%** generated that way and the remaining **15%** written by hand to fix bugs, tighten behavior, and clean up rough edges. It is a real project, but it is still very much an **experimental** one.

Over time, the plan is to slowly transfer everything to **100% human-coded** work so the project becomes more deliberate, maintainable, and easier to reason about.

## Why it exists

I use this for one of my personal projects, and I built it to suit my own workflow and constraints. That said, there is nothing preventing other people from using it for their own projects as well if it fits their needs.

## Status

> [!WARNING]
> This project is **not 100% production ready**.

> [!IMPORTANT]
> There may still be edge cases, missing hardening, and unfinished behavior. Please use it with care and treat it as software you adopt **at your own risk**.

## What it is

- A PocketBase-style backend built on Postgres
- Powered by Bun, Hono, and HTMX
- Designed to stay lightweight and approachable
- Meant to be practical for personal and small-scale projects

## Getting started

The project uses Bun for development and testing.

```bash
bun install
bun run dev
```

## Testing

```bash
bun test
bun run test:ui
```

## Final note

> [!CAUTION]
> If you decide to use Grescale, do so with the understanding that it is still evolving.
>
> It is meant to be useful, but it is **not a guaranteed production-grade backend platform yet**.
