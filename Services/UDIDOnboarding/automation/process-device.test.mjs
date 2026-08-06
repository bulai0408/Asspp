import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  createProfileName,
  provisionProfile,
  verifyDeviceAttributes,
} from "./process-device.mjs";

const syntheticUdid = "00008120-0011223344556677";
const challenge = "synthetic-challenge";
const challengeHash = "fa83daaa4c137361cd935d77e82a7c629cb7117d87ead48e63d540441bbde806";

test("validates the callback challenge and device identifier", () => {
  assert.deepEqual(
    verifyDeviceAttributes(
      {
        UDID: syntheticUdid,
        PRODUCT: "iPhone17,2",
        VERSION: "23A123",
        CHALLENGE: challenge,
      },
      challengeHash,
    ),
    {
      udid: syntheticUdid,
      product: "iPhone17,2",
      version: "23A123",
    },
  );

  assert.throws(
    () => verifyDeviceAttributes({ UDID: syntheticUdid, CHALLENGE: "wrong" }, challengeHash),
    /challenge/i,
  );
  assert.throws(
    () => verifyDeviceAttributes({ UDID: "serial-number", CHALLENGE: challenge }, challengeHash),
    /device identifier/i,
  );
});

test("creates a stable profile name from the signing relationships", () => {
  const first = createProfileName({
    bundleIdId: "bundle",
    certificateId: "certificate",
    deviceIds: ["device-b", "device-a"],
  });
  const second = createProfileName({
    bundleIdId: "bundle",
    certificateId: "certificate",
    deviceIds: ["device-a", "device-b"],
  });

  assert.equal(first, second);
  assert.match(first, /^Asspp Ad Hoc [a-f0-9]{12}$/);
});

test("registers the callback device before creating a profile for every enabled device", async () => {
  const events = [];
  let createOptions;
  const client = {
    async ensureDevice(udid, name) {
      events.push(["ensure", udid, name]);
      return { id: "device-new" };
    },
    async listEnabledIosDevices() {
      events.push(["list"]);
      return [{ id: "device-old" }, { id: "device-new" }];
    },
    async findBundleId() {
      return { id: "bundle" };
    },
    async findDistributionCertificate() {
      return { id: "certificate" };
    },
    async findActiveProfile() {
      return null;
    },
    async createProfile(options) {
      createOptions = options;
      return {
        attributes: {
          name: options.name,
          profileContent: Buffer.from("synthetic-profile").toString("base64"),
        },
      };
    },
  };
  const directory = await mkdtemp(path.join(tmpdir(), "asspp-profile-test-"));
  const outputPath = path.join(directory, "profile.mobileprovision");
  try {
    const result = await provisionProfile({
      client,
      bundleIdentifier: "com.example.asspp",
      certificateSerialNumber: "SERIAL",
      outputPath,
      requestId: "opaque-request-id",
      device: { udid: syntheticUdid, product: "iPhone17,2", version: "23A123" },
      mask: (value) => events.push(["mask", value]),
    });

    assert.deepEqual(events.slice(0, 3), [
      ["mask", syntheticUdid],
      ["ensure", syntheticUdid, "Asspp Device opaque-r"],
      ["list"],
    ]);
    assert.deepEqual(createOptions.deviceIds, ["device-new", "device-old"]);
    assert.equal(readFileSync(outputPath, "utf8"), "synthetic-profile");
    assert.equal(result.profileCreated, true);
    assert.equal(result.product, "iPhone17,2");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reuses an active profile with the same relationship fingerprint", async () => {
  let createCalled = false;
  const client = {
    async listEnabledIosDevices() {
      return [{ id: "device-one" }];
    },
    async findBundleId() {
      return { id: "bundle" };
    },
    async findDistributionCertificate() {
      return { id: "certificate" };
    },
    async findActiveProfile(name) {
      return {
        attributes: {
          name,
          profileContent: Buffer.from("reused-profile").toString("base64"),
        },
      };
    },
    async createProfile() {
      createCalled = true;
    },
  };
  const directory = await mkdtemp(path.join(tmpdir(), "asspp-profile-test-"));
  const outputPath = path.join(directory, "profile.mobileprovision");
  try {
    const result = await provisionProfile({
      client,
      bundleIdentifier: "com.example.asspp",
      certificateSerialNumber: "SERIAL",
      outputPath,
    });

    assert.equal(createCalled, false);
    assert.equal(result.profileCreated, false);
    assert.equal(readFileSync(outputPath, "utf8"), "reused-profile");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
