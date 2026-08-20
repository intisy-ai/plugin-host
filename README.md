# plugin-host

[![npm version](https://img.shields.io/npm/v/plugin-host)](https://www.npmjs.com/package/plugin-host)
[![npm downloads](https://img.shields.io/npm/dm/plugin-host)](https://www.npmjs.com/package/plugin-host)
[![GitHub Stars](https://img.shields.io/github/stars/intisy-ai/plugin-host?style=social)](https://github.com/intisy-ai/plugin-host)

Generic ESM plugin host and manifest scanner for the intisy-ai AI-proxy ecosystem.

## Installation

```bash
npm install plugin-host
```

Once you have it installed you can use it like so:

`{{ name }}` scans a home's deployed plugin manifests, resolves a safe activation order from
their declared dependencies, and imports and activates each plugin's entry module in turn under
its own deadline. A plugin that throws, times out, or exports nothing usable is quarantined
without taking the rest of the host down.

## Under-the-Hood Architecture

```mermaid
flowchart TD
    A[Plugin directory in a home] --> B[readDeployedManifests scans manifest sidecars]
    B --> C[activationOrder resolves dependency order; cycles quarantined]
    C --> D{Next plugin in order}
    D --> E[importEntry loads the deployed bundle]
    E --> F[activate runs under its own deadline]
    F -->|resolves| G[Started: capabilities and services registered]
    F -->|throws or times out| H[Quarantined: host stays up]
    G --> D
    H --> D
    D -->|order exhausted| I[LoadedHost: started, quarantined, stop]
```

## Structure

- `src/plugin-manifests.ts` - `readDeployedManifests` scans a home's plugin directory for
  manifest sidecars, validating each and pairing it with its deployed bundle path
- `src/plugin-host.ts` - `startPlugins` resolves activation order, imports and activates each
  plugin under a timeout, and returns a `LoadedHost`; `callCapability` bounds a single capability
  call with a deadline; `ledgerRows` renders the host's ledger for a surface to display
- `src/index.ts` - the barrel: `startPlugins`, `callCapability`, `ledgerRows`,
  `readDeployedManifests`, the four timeout constants, and their types
- `dist/` - compiled output (generated; never committed)

## Installation

As a submodule, for an app or library built in this ecosystem:

```bash
git submodule add https://github.com/intisy-ai/plugin-host plugin-host
```

Or as an npm dependency:

```bash
npm install {{ name }}
```

## Configuration

`{{ name }}` reads no configuration file of its own. `PluginHostOptions.runtimeFor` builds the
`PluginRuntime` each plugin's context receives, and whoever starts the host supplies that
function, so the host's config lives wherever that runtime is built, not here.

## Logging

`{{ name }}` writes no log file of its own. The `PluginRuntime` a plugin receives carries its
logger, and that runtime is built by whoever starts the host, so the host's logging lives
wherever that runtime is built, not here.

## License

MIT

## License

[![MIT License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
