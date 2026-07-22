import { realpathSync } from "node:fs";

// Use the canonical, short system temp root for fixtures and Unix sockets.
// macOS's default /var/folders/... has symlinked ancestry, while its canonical
// form can exceed the Unix socket path limit once fixture names are appended.
const fixtureRoot = realpathSync("/tmp");

process.env.TMPDIR = fixtureRoot;
process.env.TMP = fixtureRoot;
process.env.TEMP = fixtureRoot;
