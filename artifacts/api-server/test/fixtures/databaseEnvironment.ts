// Allows SQL-building/media-only tests to import the shared DB module without
// opening a connection. Real admission integration tests still need DATABASE_URL.
process.env.DATABASE_URL ??= "postgresql://test:test@localhost/unused";
