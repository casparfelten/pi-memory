# Phase 1 implementation notes

## Java
Installed with:

```bash
apt-get update && apt-get install -y openjdk-17-jre-headless
```

## XTDB standalone JAR issue

I downloaded `com.xtdb:xtdb-http-server:1.24.5` from Maven Central, but it is **not** a self-contained standalone JAR in this environment:

```text
Error: Could not find or load main class clojure.main
Caused by: java.lang.ClassNotFoundException: clojure.main
```

To keep Phase 1 tests executable in this sandbox, `scripts/xtdb-start.sh` attempts to launch the downloaded Maven JAR first and then falls back to a local mock XTDB-compatible HTTP server (`scripts/mock-xtdb-server.mjs`) when that JAR exits immediately.

This keeps the client contract and endpoint behavior testable while preserving a best-effort real XTDB launch path.
