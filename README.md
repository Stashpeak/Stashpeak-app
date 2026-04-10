# Stashpeak

A local-first desktop dashboard for your AI ecosystem. Replaces browser tabs for Anthropic Console, OpenAI Platform, OpenRouter, and Groq with one native app.

Built with Tauri 2 · React 19 · Rust · SQLite

---

## Features

- **Subscription tracker** — track monthly costs across AI services (ChatGPT Plus, Claude Pro, Cursor, Copilot, Midjourney, etc.)
- **API key vault** — store provider keys securely in the OS keychain (no plaintext)
- **Spend tracking** _(in progress)_ — live API usage & cost per provider; OpenRouter connector live, Anthropic/OpenAI/Groq coming
- **Docker monitoring** _(coming soon)_ — watch locally running AI containers
- **Visual map** _(coming soon)_ — overview of your entire AI stack

## Tech stack

| Layer | Technology |
|-------|-----------|
| Desktop shell | Tauri 2 |
| Frontend | React 19 + TypeScript + Tailwind CSS v4 |
| Backend | Rust (stable-x86_64-pc-windows-msvc) |
| Database | SQLite via rusqlite 0.32 (bundled) |
| Secrets | OS keychain via `keyring` crate |
| HTTP client | reqwest 0.12 + rustls (no OpenSSL) |
| Bundler | Vite 7 |

## Getting started

### Prerequisites
- [Rust](https://rustup.rs/) (stable toolchain)
- [Node.js](https://nodejs.org/) 18+
- [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS

### Development

```bash
npm install
npm run tauri dev
```

### Build

```bash
npm run tauri build
```

## Data storage

All data is stored locally:

- **Database:** `%APPDATA%\Stashpeak\stashpeak.db` (Windows) · `~/Library/Application Support/Stashpeak` (macOS) · `~/.local/share/stashpeak` (Linux)
- **API keys:** OS keychain — never written to disk in plaintext

## License

MIT
