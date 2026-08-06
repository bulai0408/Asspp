import { createHash, timingSafeEqual } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  AppStoreConnectClient,
  createAppStoreConnectToken,
  isValidUdid,
} from "./app-store-connect.mjs";

export function verifyDeviceAttributes(attributes, expectedChallengeHash) {
  if (!attributes || typeof attributes !== "object") {
    throw new Error("Device attributes are invalid");
  }
  const challenge = attributes.CHALLENGE ?? attributes.Challenge;
  if (typeof challenge !== "string" || !/^[a-f0-9]{64}$/i.test(expectedChallengeHash ?? "")) {
    throw new Error("Device challenge is invalid");
  }
  const actualHash = createHash("sha256").update(challenge).digest();
  const expectedHash = Buffer.from(expectedChallengeHash, "hex");
  if (expectedHash.length !== actualHash.length || !timingSafeEqual(actualHash, expectedHash)) {
    throw new Error("Device challenge does not match");
  }

  const udid = attributes.UDID;
  if (!isValidUdid(udid)) {
    throw new Error("Device identifier is invalid");
  }
  return {
    udid,
    product: boundedString(attributes.PRODUCT),
    version: boundedString(attributes.VERSION),
  };
}

export function createProfileName({ bundleIdId, certificateId, deviceIds }) {
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({
      bundleIdId,
      certificateId,
      deviceIds: [...new Set(deviceIds)].sort(),
    }))
    .digest("hex")
    .slice(0, 12);
  return `Asspp Ad Hoc ${fingerprint}`;
}

export async function provisionProfile({
  client,
  bundleIdentifier,
  certificateSerialNumber,
  outputPath,
  requestId = "scheduled",
  device,
  mask = (value) => console.log(`::add-mask::${value}`),
}) {
  let ensuredDevice;
  if (device) {
    mask(device.udid);
    ensuredDevice = await client.ensureDevice(device.udid, `Asspp Device ${requestId.slice(0, 8)}`);
  }

  const [enabledDevices, bundleId, certificate] = await Promise.all([
    client.listEnabledIosDevices(),
    client.findBundleId(bundleIdentifier),
    client.findDistributionCertificate(certificateSerialNumber),
  ]);
  const deviceIds = [...new Set([
    ...enabledDevices.map((candidate) => candidate.id),
    ...(ensuredDevice?.id ? [ensuredDevice.id] : []),
  ])].sort();
  if (deviceIds.length === 0) {
    throw new Error("No enabled iOS devices are registered");
  }

  const profileName = createProfileName({
    bundleIdId: bundleId.id,
    certificateId: certificate.id,
    deviceIds,
  });
  let profile = await client.findActiveProfile(profileName);
  let profileCreated = false;
  if (!profile) {
    profile = await client.createProfile({
      name: profileName,
      bundleIdId: bundleId.id,
      certificateId: certificate.id,
      deviceIds,
    });
    profileCreated = true;
  }

  const encodedProfile = profile?.attributes?.profileContent;
  if (typeof encodedProfile !== "string" || encodedProfile.length === 0) {
    throw new Error("Provisioning profile content is missing");
  }
  const profileBytes = Buffer.from(encodedProfile, "base64");
  if (profileBytes.length === 0) {
    throw new Error("Provisioning profile content is invalid");
  }
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, profileBytes, { mode: 0o600 });
  chmodSync(outputPath, 0o600);

  return {
    profilePath: outputPath,
    profileName,
    profileCreated,
    product: device?.product ?? null,
    deviceCount: deviceIds.length,
  };
}

async function main() {
  const issuerId = requiredEnvironment("APP_STORE_CONNECT_ISSUER_ID");
  const keyId = requiredEnvironment("APP_STORE_CONNECT_KEY_ID");
  const privateKeyBase64 = requiredEnvironment("APP_STORE_CONNECT_PRIVATE_KEY_BASE64");
  const bundleIdentifier = requiredEnvironment("IOS_BUNDLE_ID");
  const certificateSerialNumber = requiredEnvironment("IOS_CERTIFICATE_SERIAL_NUMBER");
  const outputPath = requiredEnvironment("PROFILE_OUTPUT_PATH");
  const requestId = process.env.ONBOARDING_REQUEST_ID || "scheduled";

  const privateKey = Buffer.from(privateKeyBase64, "base64").toString("utf8");
  if (!privateKey.includes("PRIVATE KEY")) {
    throw new Error("App Store Connect private key is invalid");
  }
  const token = createAppStoreConnectToken({ issuerId, keyId, privateKey });
  const client = new AppStoreConnectClient({ token });

  let device;
  const attributesPath = process.env.DEVICE_ATTRIBUTES_PATH;
  if (attributesPath) {
    const expectedChallengeHash = requiredEnvironment("EXPECTED_CHALLENGE_HASH");
    const attributes = JSON.parse(readFileSync(attributesPath, "utf8"));
    device = verifyDeviceAttributes(attributes, expectedChallengeHash);
  }

  const result = await provisionProfile({
    client,
    bundleIdentifier,
    certificateSerialNumber,
    outputPath,
    requestId,
    device,
  });

  writeGithubOutput("profile_path", result.profilePath);
  writeGithubOutput("profile_name", result.profileName);
  writeGithubOutput("profile_created", String(result.profileCreated));
  writeGithubOutput("device_count", String(result.deviceCount));
  if (result.product) {
    writeGithubOutput("product", result.product);
  }
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment: ${name}`);
  }
  return value;
}

function writeGithubOutput(name, value) {
  const outputPath = requiredEnvironment("GITHUB_OUTPUT");
  if (String(value).includes("\n") || String(value).includes("\r")) {
    throw new Error("GitHub output contains an invalid newline");
  }
  appendFileSync(outputPath, `${name}=${value}\n`, "utf8");
}

function boundedString(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 128 ? value : null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Device provisioning failed");
    process.exitCode = 1;
  });
}
