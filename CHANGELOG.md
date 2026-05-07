# Change Log

All notable changes to `@homebridge/ciao` will be documented in this file. This project tries to adhere to [Semantic Versioning](http://semver.org/).

## v1.3.9 (Pending Release)

- chore: dependency updates
- fix: accumulate per-packet results in sendQueryBroadcast
- fix: report interface name in sendResponse error messages
- fix: track newly added loopback interfaces in loopback map
- fix: drop stray boolean argument from send-failure log calls
- fix: handle rejection from sendResponseBroadcast in record update path
- fix: size NSEC bitmaps to fit rrtypes at byte boundaries
- fix: correct sign on local-compression pointer offset
- refactor: drop redundant assertion in formatMappedIPv4Address
- refactor: replace deprecated String#substr with slice
- perf: use Date.now() instead of new Date().getTime()
- perf: use Buffer.compare for TXT and OPT data equality checks
- refactor: collapse identical NSEC name encoding branches
- docs: clarify advertiseIpv6 default in MDNSServerOptions
- fix: unref TruncatedQuery timer so stalled handshakes don't pin event loop

## v1.3.8 (2026-05-04)

- chore: dependency updates
- fix: handle orphaned rejections in advertise retry and goodbye paths
- docs: regenerate typedoc docs for release

## v1.3.7 (2026-04-26)

- chore: dependency updates
- fix: MDNSServer sentPackets memory leak
- fix: add windowsHide to all child_process.exec calls (@Spaztazim)
- fix: gracefully handle sends on closed server during shutdown (@shields)
- fix: handle IPv4 address transitions gracefully on dynamic networks (@henryclawdius)
- fix: replace ip neigh show with ip -o link show in getLinuxNetworkInterfaces (@NorthernMan54)
- docs: regenerate typedoc docs for release
- docs: add dependencies section to readme file (@NorthernMan54)

## v1.3.6 (2026-03-29)

- Add compliance review note for RFC 6762 and RFC 6763 (@NorthernMan54)
- dependency updates
- rebuild docs after `typedoc` update

## v1.3.5 (2026-02-07)

- dependency updates
- update release script for oidc releases
- add `package-lock.json` to npm package

## v1.3.4 (2025-07-23)

### Changed

- Dependency updates

## v1.3.3 (2025-06-15)

### Changed

- Removed engines - node to simplify future maintenance

## v1.3.2 (2025-06-08)

### Changed

- Update dependencies

## v1.3.1 (2024-08-07)

### Changed

- Add support for node 22 in `engines`
- Updated dependencies + fix lint

## v1.3.0 (2024-07-08)

### Added

- Add support for publishing on IPv6 networks (#19) (@adriancable)
- Add support for IPv4-mapped IPv6 addresses (#43) (@donavanbecker & @hjdhjd)

### Changed

- update dependencies
- update dependencies, fix typedoc (#44)
- update changelog, fix lint
- Fix: minor housekeeping. (#48) (@@hjdhjd)

## v1.2.0 (2024-04-10)

### Changed

- added `CHANGELOG.md`
- update `README` with hb logo and formatting
- update dependencies
- spelling and grammar in code comments
- add alpha releases
- updated eslint rule
- update to match renamed `latest` branch
- regenerate docs
- update doc links in README
