import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Requires Node and the openssl CLI. Generates disposable keys locally; no IdP
// or credentials are contacted. This checks the installed SAML/XML dependency
// chain, not an external IdP login or OCI's complete authentication flow.
const root = fileURLToPath(new URL('../', import.meta.url));
const apiRequire = createRequire(join(root, 'apps/api/package.json'));
const ssoPath = apiRequire.resolve('@better-auth/sso');
// Uses the same XML validator installed by the production SSO plugin.
await import(pathToFileURL(ssoPath).href);
const samlRequire = createRequire(ssoPath);
const saml = samlRequire('samlify');
const directory = mkdtempSync(join(tmpdir(), 'oci-saml-'));
try {
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(directory, 'key.pem'),
      '-out',
      join(directory, 'cert.pem'),
      '-subj',
      '/CN=oci-local-test',
      '-days',
      '1',
    ],
    { stdio: 'ignore' },
  );
  const privateKey = readFileSync(join(directory, 'key.pem'), 'utf8');
  const signingCert = readFileSync(join(directory, 'cert.pem'), 'utf8');
  const binding = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST';
  const idp = saml.IdentityProvider({
    entityID: 'https://idp.example.test',
    privateKey,
    signingCert,
    singleLogoutService: [{ Binding: binding, Location: 'https://idp.example.test/logout' }],
    singleSignOnService: [{ Binding: binding, Location: 'https://idp.example.test/sso' }],
  });
  const sp = saml.ServiceProvider({
    entityID: 'https://oci.example.test',
    wantAssertionsSigned: true,
    wantMessageSigned: true,
    assertionConsumerService: [{ Binding: binding, Location: 'https://oci.example.test/acs' }],
  });
  const response = await idp.createLoginResponse(
    sp,
    { extract: { request: { id: '_oci-local-test' } } },
    'post',
    { email: 'review@example.test' },
  );
  const parsed = await sp.parseLoginResponse(idp, 'post', {
    body: { SAMLResponse: response.context },
  });
  assert.equal(parsed.extract.nameID, 'review@example.test');
  const xml = Buffer.from(response.context, 'base64').toString();
  assert(xml.includes('review@example.test'));
  const altered = xml.replaceAll('review@example.test', 'attacker@example.test');
  await assert.rejects(() =>
    sp.parseLoginResponse(idp, 'post', {
      body: { SAMLResponse: Buffer.from(altered).toString('base64') },
    }),
  );
  const malformed =
    '<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"><broken></samlp:Response>';
  await assert.rejects(() =>
    sp.parseLoginResponse(idp, 'post', {
      body: { SAMLResponse: Buffer.from(malformed).toString('base64') },
    }),
  );
  const xmldomRequire = createRequire(samlRequire.resolve('samlify'));
  console.log(
    JSON.stringify({
      samlify: samlRequire('samlify/package.json').version,
      xmldom: xmldomRequire('@xmldom/xmldom/package.json').version,
      signedRoundTrip: true,
      tamperedSignatureRejected: true,
      malformedXmlRejected: true,
    }),
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
