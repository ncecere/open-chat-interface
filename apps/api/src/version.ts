const configuredVersion = process.env.OCI_VERSION?.trim();

export const APP_VERSION = (configuredVersion || '0.11.1').replace(/^v/, '');
