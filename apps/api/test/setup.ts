process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgres://oci_test:oci_test@127.0.0.1:1/oci_test';
process.env.AUTH_SECRET ??= 'test-auth-secret-with-at-least-32-characters';
process.env.ENCRYPTION_KEY ??= 'test-encryption-key-with-at-least-32-chars';
process.env.APP_URL ??= 'http://localhost:3000';
process.env.STORAGE_LOCAL_PATH ??= './data/test-storage';
