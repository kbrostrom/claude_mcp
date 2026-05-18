/**
 * AWS Signature V4 presigned URL generator for R2.
 *
 * Why hand-rolled: the @aws-sdk/s3-request-presigner package works on Workers
 * but adds ~500KB to the bundle for a single endpoint we'd call. WebCrypto +
 * a hundred lines of canonical-request construction is dramatically smaller
 * and has no Node-compat surprises.
 *
 * R2 is S3-compatible. Endpoint format:
 *   https://<account-id>.r2.cloudflarestorage.com/<bucket>/<key>
 * Region for R2 SigV4 is always "auto".
 *
 * Reference: https://docs.aws.amazon.com/general/latest/gr/sigv4_signing.html
 */

const ALGORITHM = "AWS4-HMAC-SHA256";
const SERVICE = "s3";
const REGION = "auto";

interface PresignParams {
  accessKeyId: string;
  secretAccessKey: string;
  accountId: string;
  bucket: string;
  key: string;
  method: "PUT" | "GET";
  expiresInSeconds: number;
}

export async function presignR2Url(p: PresignParams): Promise<string> {
  const host = `${p.accountId}.r2.cloudflarestorage.com`;
  const encodedKey = encodeS3Key(p.key);
  const canonicalUri = `/${p.bucket}/${encodedKey}`;

  const now = new Date();
  const amzDate = formatAmzDate(now);          // 20260518T143012Z
  const dateStamp = amzDate.slice(0, 8);        // 20260518
  const credentialScope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const credential = `${p.accessKeyId}/${credentialScope}`;

  // Presigned URLs put the signature in query params, with payload hash "UNSIGNED-PAYLOAD".
  const queryParams: Record<string, string> = {
    "X-Amz-Algorithm": ALGORITHM,
    "X-Amz-Credential": credential,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(p.expiresInSeconds),
    "X-Amz-SignedHeaders": "host",
  };

  // Canonical query string: sorted by key, each k=v URI-encoded
  const canonicalQueryString = Object.keys(queryParams)
    .sort()
    .map(
      (k) => `${rfc3986Encode(k)}=${rfc3986Encode(queryParams[k])}`
    )
    .join("&");

  const canonicalHeaders = `host:${host}\n`;
  const signedHeaders = "host";
  const payloadHash = "UNSIGNED-PAYLOAD";

  const canonicalRequest = [
    p.method,
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const stringToSign = [
    ALGORITHM,
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = await deriveSigningKey(
    p.secretAccessKey,
    dateStamp,
    REGION,
    SERVICE
  );
  const signature = await hmacHex(signingKey, stringToSign);

  return `https://${host}${canonicalUri}?${canonicalQueryString}&X-Amz-Signature=${signature}`;
}

/**
 * S3 keys: encode each path segment but preserve "/" between segments.
 * Most chars get percent-encoded per RFC 3986 except A-Za-z0-9-_.~.
 */
function encodeS3Key(key: string): string {
  return key
    .split("/")
    .map((segment) => rfc3986Encode(segment))
    .join("/");
}

function rfc3986Encode(s: string): string {
  // encodeURIComponent doesn't escape !'()*. RFC 3986 unreserved is A-Za-z0-9-_.~
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

function formatAmzDate(d: Date): string {
  // ISO 8601 basic format: 20060102T150405Z
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    d.getUTCFullYear() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    "T" +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    "Z"
  );
}

async function sha256Hex(message: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(message)
  );
  return toHex(buf);
}

async function hmac(
  keyData: ArrayBuffer | Uint8Array,
  message: string
): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
}

async function hmacHex(
  keyData: ArrayBuffer,
  message: string
): Promise<string> {
  return toHex(await hmac(keyData, message));
}

async function deriveSigningKey(
  secretKey: string,
  dateStamp: string,
  region: string,
  service: string
): Promise<ArrayBuffer> {
  const kDate = await hmac(
    new TextEncoder().encode("AWS4" + secretKey),
    dateStamp
  );
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, "aws4_request");
  return kSigning;
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
