const configuredVersion = process.env.OCI_VERSION?.trim();

export const APP_VERSION = (configuredVersion || '0.2.1').replace(/^v/, '');
