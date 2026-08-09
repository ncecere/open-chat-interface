const configuredVersion = process.env.OCI_VERSION?.trim();

export const APP_VERSION = (configuredVersion || '0.3.0').replace(/^v/, '');
