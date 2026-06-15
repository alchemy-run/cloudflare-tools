# Changelog

## [v0.10.13](https://github.com/alchemy-run/cloudflare-tools/releases/tag/v0.10.13) (2026-06-12)

### Bug Fixes

- **runtime**: use forkScoped instead of forkDetach for watchers - by John Royal in [#45](https://github.com/alchemy-run/cloudflare-tools/pull/45) [(85c4b5b)](https://github.com/alchemy-run/cloudflare-tools/commit/85c4b5ba08930afceb6ae66691e00587511b1aad)

## [v0.10.12](https://github.com/alchemy-run/cloudflare-tools/releases/tag/v0.10.12) (2026-06-10)

### Bug Fixes

- **runtime**: support lazy api credentials - by John Royal in [#44](https://github.com/alchemy-run/cloudflare-tools/pull/44) [(4a1ce24)](https://github.com/alchemy-run/cloudflare-tools/commit/4a1ce2408c2ed11df27f805d2f9d74c98be45be0)

## [v0.10.11](https://github.com/alchemy-run/cloudflare-tools/releases/tag/v0.10.11) (2026-06-09)

*No significant changes*

## [v0.10.10](https://github.com/alchemy-run/cloudflare-tools/releases/tag/v0.10.10) (2026-06-07)

### Bug Fixes

- **runtime**: handle explicit ack in Queue binding - by @john-royal [(a328ed7)](https://github.com/alchemy-run/cloudflare-tools/commit/a328ed72ce5cec4a87777904fec80ac47c917bf3)
- **runtime**: validate maxBatchTimeout for queues - by @john-royal [(5de406b)](https://github.com/alchemy-run/cloudflare-tools/commit/5de406bf6434ef8fa6d215b0ad5342a697992515)
- **runtime**: create workflows:storage once per worker - by Dominik Vít in [#41](https://github.com/alchemy-run/cloudflare-tools/pull/41) [(91e2b04)](https://github.com/alchemy-run/cloudflare-tools/commit/91e2b0404721091f24d04e8d2a9621e45766529f)
- **vite-plugin**: use correct `esmExternalRequirePlugin` - by @john-royal in [#40](https://github.com/alchemy-run/cloudflare-tools/pull/40) [(ee27545)](https://github.com/alchemy-run/cloudflare-tools/commit/ee27545375fa5e644ab6c804432cc6b99b284d78)

## [v0.10.9](https://github.com/alchemy-run/cloudflare-tools/releases/tag/v0.10.9) (2026-06-05)

*No significant changes*

## [v0.10.8](https://github.com/alchemy-run/cloudflare-tools/releases/tag/v0.10.8) (2026-06-05)

### Features

- **runtime**: queues - by @john-royal in [#39](https://github.com/alchemy-run/cloudflare-tools/pull/39) [(ea762b1)](https://github.com/alchemy-run/cloudflare-tools/commit/ea762b1336c1366e58379596b06559c4acbb2bd9)

## [v0.10.7](https://github.com/alchemy-run/cloudflare-tools/releases/tag/v0.10.7) (2026-06-04)

### Bug Fixes

- **runtime**: stdout EBADF error in vitest - by @john-royal in [#37](https://github.com/alchemy-run/cloudflare-tools/pull/37) [(a95193e)](https://github.com/alchemy-run/cloudflare-tools/commit/a95193e563800d4cc3407bdd330b476f06a9a7cf)
- **runtime**: allow multiple loopback bindings with same name - by Jordan Stout in [#38](https://github.com/alchemy-run/cloudflare-tools/pull/38) [(22237ae)](https://github.com/alchemy-run/cloudflare-tools/commit/22237aed5e745988094d207fbb8255f524887492)

## [v0.10.6](https://github.com/alchemy-run/cloudflare-tools/releases/tag/v0.10.6) (2026-06-04)

### Bug Fixes

- **runtime**: cross-script do binding fails with some script names - by @john-royal [(9897fa1)](https://github.com/alchemy-run/cloudflare-tools/commit/9897fa1c4cdde39ca67560802f0bd054c10399f0)

## [v0.10.5](https://github.com/alchemy-run/cloudflare-tools/releases/tag/v0.10.5) (2026-06-04)

_No significant changes_

## [v0.10.4](https://github.com/alchemy-run/cloudflare-tools/releases/tag/v0.10.4) (2026-06-03)

### Bug Fixes

- **runtime**: cross-script durable object bindings fail - by @john-royal in [#36](https://github.com/alchemy-run/cloudflare-tools/pull/36) [(d9dfb24)](https://github.com/alchemy-run/cloudflare-tools/commit/d9dfb240e9da3becd9945725036133eb66832fd8)

## [v0.10.3](https://github.com/alchemy-run/cloudflare-tools/releases/tag/v0.10.3) (2026-06-03)

### Bug Fixes

- **runtime**: improve spawner reliability in Bun - by @john-royal in [#35](https://github.com/alchemy-run/cloudflare-tools/pull/35) [(e31fe47)](https://github.com/alchemy-run/cloudflare-tools/commit/e31fe4771fc5d0ea656c72edfaafe74b5bb5843d)

## [v0.10.2](https://github.com/alchemy-run/cloudflare-tools/releases/tag/v0.10.2) (2026-06-01)

### Bug Fixes

- **runtime**: only process request queue when target is set - by @john-royal in [#34](https://github.com/alchemy-run/cloudflare-tools/pull/34) [(18331e4)](https://github.com/alchemy-run/cloudflare-tools/commit/18331e4afb0633a0f6a6a3414c9b690768234d92)
- **runtime**: improve port conflict detection - by @john-royal in [#33](https://github.com/alchemy-run/cloudflare-tools/pull/33) [(8fe7f36)](https://github.com/alchemy-run/cloudflare-tools/commit/8fe7f36ee7fdde7e348c6abece8db040fecd1b01)

## [v0.10.1](https://github.com/alchemy-run/cloudflare-tools/releases/tag/v0.10.1) (2026-05-29)

_No significant changes_

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
