# Changelog

## [v0.10.1](https://github.com/alchemy-run/cloudflare-tools/releases/tag/v0.10.1) (2026-05-29)

*No significant changes*

## [v0.10.0](https://github.com/alchemy-run/cloudflare-tools/releases/tag/v0.10.0) (2026-05-29)

### Features

- **runtime**: simplify worker proxy - by @john-royal in [#30](https://github.com/alchemy-run/cloudflare-tools/pull/30) [(0744a4e)](https://github.com/alchemy-run/cloudflare-tools/commit/0744a4e89fb26bd2d594b8f87ef1a722e698f1a1)

### Bug Fixes

- **runtime**: include address in error message when already in use - by @john-royal [(fa62c03)](https://github.com/alchemy-run/cloudflare-tools/commit/fa62c0322c6140026b078920c6794e7ed1c06330)

## [v0.9.2](https://github.com/alchemy-run/cloudflare-tools/releases/tag/v0.9.2) (2026-05-28)

### Bug Fixes

- **runtime**: correct `BindingServices` type - by @john-royal [(8fbd1ea)](https://github.com/alchemy-run/cloudflare-tools/commit/8fbd1ea15bf702aa9b680539d54e9bc73a48f724)

## [v0.9.1](https://github.com/alchemy-run/cloudflare-tools/releases/tag/v0.9.1) (2026-05-28)

### Features

- **runtime**: emulated analytics engine binding - by @john-royal [(5094273)](https://github.com/alchemy-run/cloudflare-tools/commit/50942733c9f2f43bffa0adcfcb17df378a4c408e)

### Bug Fixes

- **runtime**: loosen RateLimitProps - by @john-royal [(6adb345)](https://github.com/alchemy-run/cloudflare-tools/commit/6adb34588ad1cb34c17500cf02b3665e6943ae68)
- **runtime**: dispatch namespace props - by @john-royal [(55bc495)](https://github.com/alchemy-run/cloudflare-tools/commit/55bc4956070907352ecedbbe0d076020ad870283)
- **runtime**: send email props - by @john-royal [(f37ab72)](https://github.com/alchemy-run/cloudflare-tools/commit/f37ab7293306a5e3003c42e24e2116a0c08be950)

## [v0.9.0](https://github.com/alchemy-run/cloudflare-tools/releases/tag/v0.9.0) (2026-05-28)

### Features

- **runtime**: add 10 missing remote binding types - by @john-royal in [#29](https://github.com/alchemy-run/cloudflare-tools/pull/29) [(12ce587)](https://github.com/alchemy-run/cloudflare-tools/commit/12ce587c043bcc59ea76bd193a42bdd2c4fddde4)

## [v0.8.0](https://github.com/alchemy-run/cloudflare-tools/releases/tag/v0.8.0) (2026-05-28)

### Bug Fixes

- **vite-plugin**: handle websocket upgrade - by @john-royal in [#28](https://github.com/alchemy-run/cloudflare-tools/pull/28) [(3ae2801)](https://github.com/alchemy-run/cloudflare-tools/commit/3ae280136e1d6cbd8c99b14e917a0bc0b8b08811)
- **runtime**: consistent binding prop names - by @john-royal in [#26](https://github.com/alchemy-run/cloudflare-tools/pull/26) [(38e8edc)](https://github.com/alchemy-run/cloudflare-tools/commit/38e8edcb014e5c021a427da779cd4e803951888b)

## [v0.7.1](https://github.com/alchemy-run/cloudflare-tools/releases/tag/v0.7.1) (2026-05-27)

### Bug Fixes

- **vite-plugin**: handle external `require` calls in vite dev - by @john-royal in [#25](https://github.com/alchemy-run/cloudflare-tools/pull/25) [(e7ea5a0)](https://github.com/alchemy-run/cloudflare-tools/commit/e7ea5a08fa0afec5d5f6c2f6db63d14b9c527bea)
- **runtime**: remove verbose logging from workerd - by @john-royal [(e2599d7)](https://github.com/alchemy-run/cloudflare-tools/commit/e2599d74b048aacdaa9ebee61ada8f80d597c19f)

## [v0.7.0](https://github.com/alchemy-run/cloudflare-tools/releases/tag/v0.7.0) (2026-05-27)

### Features

- **runtime**: workflows - by @john-royal in [#24](https://github.com/alchemy-run/cloudflare-tools/pull/24) [(2e3c5f3)](https://github.com/alchemy-run/cloudflare-tools/commit/2e3c5f39f01680dd1b17666647e0ccd3c2e69bdf)
- **runtime**: rate limit binding - by @john-royal in [#21](https://github.com/alchemy-run/cloudflare-tools/pull/21) [(e32a171)](https://github.com/alchemy-run/cloudflare-tools/commit/e32a171f55592bbc3c5b5332b8eef38a1d44e3bd)

## [v0.6.3](https://github.com/alchemy-run/cloudflare-tools/releases/tag/v0.6.3) (2026-05-22)

### Bug Fixes

- **runtime**: dynamic import from LoopbackServer - by @john-royal [(f9aacde)](https://github.com/alchemy-run/cloudflare-tools/commit/f9aacdefb291727a5ae54342e2df12c97b6e1263)

## [v0.6.2](https://github.com/alchemy-run/cloudflare-tools/releases/tag/v0.6.2) (2026-05-22)

### Features

- **runtime**: artifacts binding - by @john-royal in [#19](https://github.com/alchemy-run/cloudflare-tools/pull/19) [(8f8edd4)](https://github.com/alchemy-run/cloudflare-tools/commit/8f8edd4f78db8a0565519720794e5828f73c14fe)

### Bug Fixes

- **runtime**: hide CODE_MOVED warning - by @john-royal in [#18](https://github.com/alchemy-run/cloudflare-tools/pull/18) [(1d687bd)](https://github.com/alchemy-run/cloudflare-tools/commit/1d687bd3d863bffacafe5222258c76bfda86779f)
- **vite-plugin**: use either BunServices or NodeServices - by @john-royal in [#17](https://github.com/alchemy-run/cloudflare-tools/pull/17) [(6cb7779)](https://github.com/alchemy-run/cloudflare-tools/commit/6cb7779792b3468d99bc1ac409304a8096dd8aed)
- **vite-plugin**: server fails to start due to invalid internal binding - by @john-royal in [#16](https://github.com/alchemy-run/cloudflare-tools/pull/16) [(f1d3a4a)](https://github.com/alchemy-run/cloudflare-tools/commit/f1d3a4a0efcf9f02db556c1cd17795e6ff93c2c4)

## [v0.6.1](https://github.com/alchemy-run/cloudflare-tools/releases/tag/v0.6.1) (2026-05-21)

### Bug Fixes

- **runtime**: include x-forwarded-for and x-forwarded-proto headers - by @john-royal [(1acca6b)](https://github.com/alchemy-run/cloudflare-tools/commit/1acca6b53b3d82c132553648450a398d44e4c7d9)

## [v0.6.0](https://github.com/alchemy-run/cloudflare-tools/releases/tag/v0.6.0) (2026-05-19)

### Features

- **vite-plugin**: assets - by @john-royal in [#12](https://github.com/alchemy-run/cloudflare-tools/pull/12) [(befe2cf)](https://github.com/alchemy-run/cloudflare-tools/commit/befe2cfc5a63bf3c4ddbfdf6b71ae2a4169914e9)
- **runtime**: assets - by @john-royal in [#10](https://github.com/alchemy-run/cloudflare-tools/pull/10) [(1a93bec)](https://github.com/alchemy-run/cloudflare-tools/commit/1a93bec7a6129bf80b7c5d04d4002d64b6fb8c39)

### Bug Fixes

- **rolldown-plugin**: mysql2 not bundling - by @john-royal in [#14](https://github.com/alchemy-run/cloudflare-tools/pull/14) [(d9a2b33)](https://github.com/alchemy-run/cloudflare-tools/commit/d9a2b33eb29f0257da9bb5572f86c3f432bed095)

## [v0.5.4](https://github.com/alchemy-run/cloudflare-tools/releases/tag/v0.5.4) (2026-05-15)

_No significant changes_

## [v0.5.3](https://github.com/alchemy-run/cloudflare-tools/releases/tag/v0.5.3) (2026-05-15)

### Bug Fixes

- **vite-plugin**: log failed to evaluate module - by @john-royal [(fdc9c0d)](https://github.com/alchemy-run/cloudflare-tools/commit/fdc9c0de9a2073ebc826cc28d1ff0b5e049650bc)

## [v0.5.2](https://github.com/alchemy-run/cloudflare-tools/releases/tag/v0.5.2) (2026-05-15)

### Bug Fixes

- **runtime**: retry on broken pipe - by @john-royal [(c182190)](https://github.com/alchemy-run/cloudflare-tools/commit/c1821908386b982432e7388b58611cace8a803a7)

## [v0.5.1](https://github.com/alchemy-run/cloudflare-tools/releases/tag/v0.5.1) (2026-05-15)

### Bug Fixes

- **vite-plugin**: avoid bundling @effect/platform-node - by @john-royal [(e28e7b2)](https://github.com/alchemy-run/cloudflare-tools/commit/e28e7b291b35a35a263486c62a6a95d8742940f3)

## [v0.5.0](https://github.com/alchemy-run/cloudflare-tools/releases/tag/v0.5.0) (2026-05-15)

### Features

- **vite-plugin**: update runtime - by @john-royal [(296c6cc)](https://github.com/alchemy-run/cloudflare-tools/commit/296c6cc614c395309c69cd02623ecb1ebe71ed7b)
- **runtime**: decouple local proxy - by @john-royal [(9ec791a)](https://github.com/alchemy-run/cloudflare-tools/commit/9ec791a87780b2036f07287f705cb4e4b378d649)

### Bug Fixes

- **runtime**: tweak error logging - by @john-royal [(965e776)](https://github.com/alchemy-run/cloudflare-tools/commit/965e7765991080f25dc008459719aecca74ffc8f)
- **runtime**: local proxy port - by @john-royal [(2583d2d)](https://github.com/alchemy-run/cloudflare-tools/commit/2583d2d1b022587cb2fe6d3fd4fa1d3fe0976156)
- **vite-plugin**: handle url address when connecting to workerd - by @john-royal [(660460c)](https://github.com/alchemy-run/cloudflare-tools/commit/660460c8211d5de0b43df1b65cb5ff7fc0dd8af5)
- **runtime**: add setter for local proxy port - by @john-royal [(cdeeb73)](https://github.com/alchemy-run/cloudflare-tools/commit/cdeeb73aeeee0fcf1e1a7fcf4655793b1b57296a)
- **runtime**: normalize local proxy subdomain - by @john-royal [(17e4c11)](https://github.com/alchemy-run/cloudflare-tools/commit/17e4c11602fe8aa8859371bddc4687042a26cf7d)
