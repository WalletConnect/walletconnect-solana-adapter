# WalletConnect Solana Adapter - Core

[Try it!](https://walletconnect-solana.vercel.app/)

## How to run this repo?

1. Install dependencies

```sh
pnpm install
```

2. Build!

```sh
pnpm run build:packages
```

3. Run!

```sh
pnpm run dev:playground
```

## How to Test?

Most Mobile wallets don't support Testnet/Devnet. Either change the network to Mainnet or use our [sample wallet](https://react-wallet.walletconnect.com/).

## How to make a release?

1. Add a beta or alpha prefix (if needed):

replace `<tag>` with `alpha` or `beta`.

```sh
pnpm run <tag>
```

2. Bump a `patch` / `minor` / `major` / `prerelease`

prerelease will bump `alpha` or `beta` releases (e.g. from `v0.1.1-alpha.0` -> `v0.1.1-alpha.1`).

```sh
pnpm run <replace-with-version> 
```

- example:

```sh
pnpm run patch
```

3. Publish

```sh
pnpm run release
```

for `alpha` or `beta` releases use:

```sh
pnpm run release:<tag>
```

- example:

```sh
pnpm run release:alpha
```
