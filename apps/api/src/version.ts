const configuredVersion = process.env.OCI_VERSION?.trim();

export const APP_VERSION = (configuredVersion || '0.7.0').replace(/^v/, '');
