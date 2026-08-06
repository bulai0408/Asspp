import { generateKeyPairSync, verify } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import {
  AppStoreConnectClient,
  createAppStoreConnectToken,
  isValidUdid,
} from "./app-store-connect.mjs";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function decodeBase64Url(value) {
  return Buffer.from(value, "base64url");
}

test("creates a short-lived ES256 App Store Connect token", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const now = 1_800_000_000;
  const token = createAppStoreConnectToken({
    issuerId: "issuer-id",
    keyId: "KEY123",
    privateKey,
    now,
  });
  const [headerPart, payloadPart, signaturePart] = token.split(".");

  assert.deepEqual(JSON.parse(decodeBase64Url(headerPart)), {
    alg: "ES256",
    kid: "KEY123",
    typ: "JWT",
  });
  assert.deepEqual(JSON.parse(decodeBase64Url(payloadPart)), {
    iss: "issuer-id",
    iat: now,
    exp: now + 600,
    aud: "appstoreconnect-v1",
  });
  assert.equal(
    verify(
      "sha256",
      Buffer.from(`${headerPart}.${payloadPart}`),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      decodeBase64Url(signaturePart),
    ),
    true,
  );
});

test("follows Apple pagination links", async () => {
  const urls = [];
  const fetcher = async (input) => {
    urls.push(String(input));
    if (urls.length === 1) {
      return jsonResponse({
        data: [{ type: "devices", id: "one" }],
        links: { next: "https://api.appstoreconnect.apple.com/v1/devices?cursor=next" },
      });
    }
    return jsonResponse({ data: [{ type: "devices", id: "two" }], links: {} });
  };
  const client = new AppStoreConnectClient({ token: "token", fetcher });

  const devices = await client.listAll("/v1/devices", { "filter[status]": "ENABLED" });

  assert.deepEqual(devices.map((device) => device.id), ["one", "two"]);
  assert.equal(urls[0], "https://api.appstoreconnect.apple.com/v1/devices?filter%5Bstatus%5D=ENABLED");
  assert.equal(urls[1], "https://api.appstoreconnect.apple.com/v1/devices?cursor=next");
});

test("reuses an existing registered device", async () => {
  const requests = [];
  const fetcher = async (input, init) => {
    requests.push(new Request(input, init));
    return jsonResponse({ data: [{ type: "devices", id: "device-existing", attributes: { status: "ENABLED" } }] });
  };
  const client = new AppStoreConnectClient({ token: "token", fetcher });

  const device = await client.ensureDevice("00008120-0011223344556677", "Asspp Device abc123");

  assert.equal(device.id, "device-existing");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "GET");
});

test("registers a missing iOS device", async () => {
  const requests = [];
  const fetcher = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    if (request.method === "GET") {
      return jsonResponse({ data: [] });
    }
    return jsonResponse({ data: { type: "devices", id: "device-new" } }, 201);
  };
  const client = new AppStoreConnectClient({ token: "token", fetcher });

  const device = await client.ensureDevice("00008120-0011223344556677", "Asspp Device abc123");

  assert.equal(device.id, "device-new");
  assert.equal(requests.length, 2);
  assert.deepEqual(await requests[1].json(), {
    data: {
      type: "devices",
      attributes: {
        name: "Asspp Device abc123",
        platform: "IOS",
        udid: "00008120-0011223344556677",
      },
    },
  });
});

test("keeps only iPhone-family devices for an iOS Ad Hoc profile", async () => {
  const fetcher = async () => jsonResponse({
    data: [
      { type: "devices", id: "iphone", attributes: { deviceClass: "IPHONE" } },
      { type: "devices", id: "ipad", attributes: { deviceClass: "IPAD" } },
      { type: "devices", id: "ipod", attributes: { deviceClass: "IPOD" } },
      { type: "devices", id: "watch", attributes: { deviceClass: "APPLE_WATCH" } },
      { type: "devices", id: "tv", attributes: { deviceClass: "APPLE_TV" } },
    ],
  });
  const client = new AppStoreConnectClient({ token: "token", fetcher });

  const devices = await client.listEnabledIosDevices();

  assert.deepEqual(devices.map((device) => device.id), ["iphone", "ipad", "ipod"]);
});

test("normalizes an X.509 serial number for Apple's certificate filter", async () => {
  let requestUrl;
  const fetcher = async (input) => {
    requestUrl = new URL(input);
    return jsonResponse({
      data: [{
        type: "certificates",
        id: "certificate-id",
        attributes: {
          activated: true,
          certificateType: "DISTRIBUTION",
          expirationDate: "2099-01-01T00:00:00.000+00:00",
          serialNumber: "AB12",
        },
      }],
    });
  };
  const client = new AppStoreConnectClient({ token: "token", fetcher });

  const certificate = await client.findDistributionCertificate("00ab12");

  assert.equal(certificate.id, "certificate-id");
  assert.equal(requestUrl.searchParams.get("filter[serialNumber]"), "AB12");
});

test("creates an Ad Hoc profile with bundle, certificate, and every device", async () => {
  let request;
  const fetcher = async (input, init) => {
    request = new Request(input, init);
    return jsonResponse({
      data: { type: "profiles", id: "profile-id", attributes: { profileContent: "cHJvZmlsZQ==" } },
    }, 201);
  };
  const client = new AppStoreConnectClient({ token: "token", fetcher });

  await client.createProfile({
    name: "Asspp Ad Hoc deadbeef",
    bundleIdId: "bundle-id",
    certificateId: "certificate-id",
    deviceIds: ["device-one", "device-two"],
  });

  assert.equal(request.method, "POST");
  assert.deepEqual(await request.json(), {
    data: {
      type: "profiles",
      attributes: { name: "Asspp Ad Hoc deadbeef", profileType: "IOS_APP_ADHOC" },
      relationships: {
        bundleId: { data: { type: "bundleIds", id: "bundle-id" } },
        certificates: { data: [{ type: "certificates", id: "certificate-id" }] },
        devices: {
          data: [
            { type: "devices", id: "device-one" },
            { type: "devices", id: "device-two" },
          ],
        },
      },
    },
  });
});

test("provider errors do not expose Apple response bodies", async () => {
  const fetcher = async () => jsonResponse({ errors: [{ detail: "private Apple detail with a UDID" }] }, 403);
  const client = new AppStoreConnectClient({ token: "token", fetcher });

  await assert.rejects(
    () => client.listAll("/v1/devices"),
    (error) => {
      assert.equal(error.message, "App Store Connect request failed (403)");
      assert.doesNotMatch(error.message, /private|udid/i);
      return true;
    },
  );
});

test("validates modern and legacy UDID formats", () => {
  assert.equal(isValidUdid("00008120-0011223344556677"), true);
  assert.equal(isValidUdid("00112233445566778899AABBCCDDEEFF00112233"), true);
  assert.equal(isValidUdid("serial-number"), false);
  assert.equal(isValidUdid("00008120-0011223344556677-extra"), false);
});
