// Vitest stand-in for the `server-only` package: the real module throws when it is
// evaluated outside a React Server environment, which would break unit tests that
// legitimately import server modules. Next.js aliases the real package at build time.
export {};
