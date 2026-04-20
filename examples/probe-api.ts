/**
 * Diagnostic tool for probing the Degoo GraphQL schema and testing mutations.
 *
 * Usage:
 *   DEGOO_EMAIL=... DEGOO_PASSWORD=... DEGOO_FILE_ID=... DEGOO_META_ID=... npx tsx examples/probe-api.ts
 *
 * DEGOO_FILE_ID  — a file's numeric ID (from listFiles / getFile)
 * DEGOO_META_ID  — the same file's MetadataID (from getFile)
 */
import { DegooClient, DegooError } from '../src/index';
import { DEFAULTS } from '../src/internal/constants';
import { createApiClient } from '../src/internal/http';

const EMAIL    = process.env.DEGOO_EMAIL    ?? '';
const PASSWORD = process.env.DEGOO_PASSWORD ?? '';
const FILE_ID  = process.env.DEGOO_FILE_ID  ?? '';
const META_ID  = process.env.DEGOO_META_ID  ?? '';

async function gql(http: ReturnType<typeof createApiClient>, label: string, body: object) {
  process.stdout.write(`  [${label}] `);
  try {
    const { data } = await http.post(DEFAULTS.apiUrl, body);
    if (data.errors) { console.log('ERR:', data.errors[0].message); return null; }
    console.log('OK:', JSON.stringify(data.data).slice(0, 200));
    return data.data;
  } catch (e: any) { console.log('HTTP:', e.response?.status ?? e.message); return null; }
}

async function main() {
  if (!EMAIL || !PASSWORD) throw new Error('Set DEGOO_EMAIL and DEGOO_PASSWORD env vars');

  const client = await DegooClient.connect(EMAIL, PASSWORD);
  const http   = createApiClient(DEFAULTS.userAgent, DEFAULTS.apiToken);
  const token  = client.token;

  // ── Introspect setDeleteFile5 argument types ────────────────────────────────
  console.log('\n── setDeleteFile5 args ──');
  const schema = await http.post(DEFAULTS.apiUrl, {
    query: `{ __schema { mutationType { fields(includeDeprecated: true) {
      name
      args { name type { name kind ofType { name kind ofType { name kind } } } }
    } } } }`,
  });
  const fields = schema.data?.data?.__schema?.mutationType?.fields ?? [];
  const del5   = fields.find((f: any) => f.name === 'setDeleteFile5');
  del5?.args?.forEach((a: any) => {
    const t = a.type;
    const typeName = t.name ?? `${t.kind}(${t.ofType?.name ?? t.ofType?.kind})`;
    console.log(`  ${a.name}: ${typeName}`);
  });

  // ── Introspect IDType input fields ──────────────────────────────────────────
  console.log('\n── IDType fields ──');
  const idType = await http.post(DEFAULTS.apiUrl, {
    query: `{ __type(name: "IDType") {
      kind name
      inputFields { name description type { name kind ofType { name } } }
    } }`,
  });
  console.log(JSON.stringify(idType.data?.data?.__type, null, 2));

  // ── Live mutation probes (requires DEGOO_FILE_ID + DEGOO_META_ID) ───────────
  if (FILE_ID && META_ID) {
    const Q_DELETE = `
      mutation SetDeleteFile5($Token: String!, $IsInRecycleBin: Boolean!, $IDs: [IDType]!) {
        setDeleteFile5(Token: $Token, IsInRecycleBin: $IsInRecycleBin, IDs: $IDs)
      }
    `;
    console.log('\n── delete probes ──');
    await gql(http, 'FileID', {
      operationName: 'SetDeleteFile5',
      variables: { Token: token, IsInRecycleBin: true, IDs: [{ FileID: FILE_ID }] },
      query: Q_DELETE,
    });
    await gql(http, 'MetadataID', {
      operationName: 'SetDeleteFile5',
      variables: { Token: token, IsInRecycleBin: true, IDs: [{ MetadataID: META_ID }] },
      query: Q_DELETE,
    });

    console.log('\n── file detail ──');
    await gql(http, 'getOverlay4', {
      operationName: 'GetOverlay4',
      variables: { Token: token, ID: { FileID: FILE_ID } },
      query: `query GetOverlay4($Token: String!, $ID: IDType!) {
        getOverlay4(Token: $Token, ID: $ID) { ID Name MetadataID DeviceID IsInRecycleBin }
      }`,
    });
  } else {
    console.log('\nSkipping live mutation probes — set DEGOO_FILE_ID and DEGOO_META_ID to enable.');
  }
}

main().catch(e => console.error(e instanceof DegooError ? `DegooError: ${e.message}` : e.message ?? e));
