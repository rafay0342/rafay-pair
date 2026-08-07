# Repository Guidelines

## Project Structure & Module Organization

RafayPair is a monorepo with independent clients: `apps/ios` (Swift/SwiftUI), `apps/android` (Kotlin/Compose), and `apps/web` (React/TypeScript). Backend entry points live in `apps/api` and `apps/worker`; reusable realtime, notification, and session logic is under `services/`. Shared schemas and assets belong in `packages/`. Infrastructure is defined in `infra/compose` and `infra/terraform`, while repository automation lives in `scripts/` and `.github/workflows/`. Treat `RAFAY_PAIR_FINAL_MOBILE_ONLY_NATIVE_MASTER.md` as the authoritative product specification.

## Build, Test, and Development Commands

- `make bootstrap`: verify/install repository dependencies and toolchain prerequisites.
- `make verify`: run formatting, linting, type checks, builds, and native tests.
- `make ios` / `make android`: build the native clients with platform tooling.
- `make web` / `make api`: build the Web bundle or server applications.
- `make test-web`: run Vitest and Playwright Web suites.
- `pnpm --filter @rafay-pair/api dev`: start the API in watch mode; substitute `web` or `worker` for those targets.
- `pnpm test:integration`: run database/Redis-backed server tests; local services must be available.

## Coding Style & Naming Conventions

Follow `.editorconfig`: two spaces generally, four spaces for Swift/Kotlin, tabs only in `Makefile`, LF endings, and no trailing whitespace. Prettier formats repository text; Oxlint checks Web TypeScript; `swift-format` checks iOS; Android uses Kotlin/Gradle lint rules. Use `PascalCase` for types/components, `camelCase` for functions and values, and descriptive kebab-case Markdown filenames. Keep platform UI code native—no Flutter or React Native.

## Testing Guidelines

Place TypeScript tests beside source as `*.test.ts` or in `apps/web/tests`; integration tests use `*.integration.test.ts`. Swift tests belong in `RafayPairTests`/`RafayPairUITests`; Kotlin unit and device tests belong in `src/test` and `src/androidTest`. Add deterministic tests for every behavior change and run the narrow suite first, then `make verify`. Never use fabricated physiological data as production behavior.

## Commit & Pull Request Guidelines

There is no Git history yet, so no established commit convention exists. Use short imperative, scoped subjects such as `fix(api): reject replayed integrity proofs`. Keep commits focused. Pull requests should explain behavior and security impact, link relevant issues/spec sections, list exact validation commands, and include screenshots for UI changes. Do not commit credentials, signing material, provider keys, generated build output, or local environment files.

## Security & Milestone Discipline

Keep Qwen credentials backend-only and inject secrets through protected CI/cloud stores. Preserve consent, privacy-pause, and account/pair isolation boundaries. Do not advance to pose, pulse, or AI runtime work until the preceding binary-delivery gate is proven on its required targets.
