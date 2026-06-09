# Changelog

All notable changes to Bumblebee will be documented in this file.

The format follows Keep a Changelog, and release versions should follow Semantic Versioning.

## Unreleased

### Added
- Documented local configuration safety and environment-variable API key usage.
- Added plugin interface types for future Bumblebee extension points.

### Changed
- Split channel message handling and knowledge extraction out of the TUI extension entry.
- Agent task fallback now returns explicit simulated-mode metadata instead of silent placeholder output.

### Fixed
- Environment variables can provide provider API keys when `.bumblebee.yaml` does not.
- Cache eviction policies now honor `lru`, `lfu`, and `fifo`.
- Persistence failures now log errors instead of being silently swallowed.
