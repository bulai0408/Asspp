import { sign } from "node:crypto";

const DEFAULT_BASE_URL = "https://api.appstoreconnect.apple.com";

export function createAppStoreConnectToken({ issuerId, keyId, privateKey, now = Math.floor(Date.now() / 1000) }) {
  if (!issuerId || !keyId || !privateKey) {
    throw new Error("App Store Connect credentials are incomplete");
  }

  const header = encodeJson({ alg: "ES256", kid: keyId, typ: "JWT" });
  const payload = encodeJson({
    iss: issuerId,
    iat: now,
    exp: now + 600,
    aud: "appstoreconnect-v1",
  });
  const signingInput = `${header}.${payload}`;
  const signature = sign("sha256", Buffer.from(signingInput), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${signature.toString("base64url")}`;
}

export function isValidUdid(value) {
  return typeof value === "string" && /^(?:[0-9A-Fa-f]{40}|[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16})$/.test(value);
}

export class AppStoreConnectClient {
  constructor({ token, fetcher = fetch, baseUrl = DEFAULT_BASE_URL }) {
    if (!token) {
      throw new Error("App Store Connect token is required");
    }
    this.token = token;
    this.fetcher = fetcher;
    this.baseUrl = new URL(baseUrl);
  }

  async request(method, pathOrUrl, { query, body, expectedStatuses = [200] } = {}) {
    const url = this.#resolveUrl(pathOrUrl, query);
    const response = await this.fetcher(url, {
      method,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (!expectedStatuses.includes(response.status)) {
      throw new Error(`App Store Connect request failed (${response.status})`);
    }
    if (response.status === 204) {
      return null;
    }
    return response.json();
  }

  async listAll(path, query = {}) {
    const resources = [];
    let next = this.#resolveUrl(path, query).toString();

    while (next) {
      const page = await this.request("GET", next);
      if (!Array.isArray(page.data)) {
        throw new Error("App Store Connect response shape is invalid");
      }
      resources.push(...page.data);
      next = typeof page.links?.next === "string" ? page.links.next : "";
    }

    return resources;
  }

  async findDeviceByUdid(udid) {
    if (!isValidUdid(udid)) {
      throw new Error("Invalid device identifier");
    }
    const devices = await this.listAll("/v1/devices", {
      "filter[udid]": udid,
      "fields[devices]": "name,platform,udid,status,deviceClass,model",
      limit: "200",
    });
    return devices.find((device) => device.attributes?.udid?.toUpperCase() === udid.toUpperCase()) ?? devices[0] ?? null;
  }

  async ensureDevice(udid, name) {
    const existing = await this.findDeviceByUdid(udid);
    if (existing) {
      if (existing.attributes?.status === "DISABLED") {
        const response = await this.request("PATCH", `/v1/devices/${encodeURIComponent(existing.id)}`, {
          body: {
            data: {
              type: "devices",
              id: existing.id,
              attributes: { status: "ENABLED" },
            },
          },
        });
        return response.data;
      }
      return existing;
    }

    const response = await this.request("POST", "/v1/devices", {
      expectedStatuses: [201],
      body: {
        data: {
          type: "devices",
          attributes: { name, platform: "IOS", udid },
        },
      },
    });
    return response.data;
  }

  async listEnabledIosDevices() {
    return this.listAll("/v1/devices", {
      "filter[platform]": "IOS",
      "filter[status]": "ENABLED",
      "fields[devices]": "name,platform,udid,status,deviceClass,model",
      limit: "200",
    });
  }

  async findBundleId(identifier) {
    const bundleIds = await this.listAll("/v1/bundleIds", {
      "filter[identifier]": identifier,
      "filter[platform]": "IOS",
      "fields[bundleIds]": "name,platform,identifier",
      limit: "200",
    });
    const bundleId = bundleIds.find((candidate) => candidate.attributes?.identifier === identifier);
    if (!bundleId) {
      throw new Error("Configured bundle identifier was not found");
    }
    return bundleId;
  }

  async findDistributionCertificate(serialNumber) {
    const query = {
      "fields[certificates]": "name,certificateType,displayName,serialNumber,platform,expirationDate,activated",
      limit: "200",
    };
    if (serialNumber) {
      query["filter[serialNumber]"] = serialNumber;
    } else {
      query["filter[certificateType]"] = "DISTRIBUTION,IOS_DISTRIBUTION";
    }
    const certificates = await this.listAll("/v1/certificates", query);
    const now = Date.now();
    const usable = certificates
      .filter((certificate) => certificate.attributes?.activated !== false)
      .filter((certificate) => !certificate.attributes?.expirationDate || Date.parse(certificate.attributes.expirationDate) > now)
      .filter((certificate) => ["DISTRIBUTION", "IOS_DISTRIBUTION"].includes(certificate.attributes?.certificateType))
      .sort((left, right) => Date.parse(right.attributes?.expirationDate ?? 0) - Date.parse(left.attributes?.expirationDate ?? 0));
    if (usable.length === 0) {
      throw new Error("Matching iOS distribution certificate was not found");
    }
    return usable[0];
  }

  async findActiveProfile(name) {
    const profiles = await this.listAll("/v1/profiles", {
      "filter[name]": name,
      "filter[profileType]": "IOS_APP_ADHOC",
      "filter[profileState]": "ACTIVE",
      "fields[profiles]": "name,platform,profileType,profileState,profileContent,uuid,expirationDate",
      limit: "200",
    });
    return profiles.find((profile) => profile.attributes?.name === name && profile.attributes?.profileContent) ?? null;
  }

  async createProfile({ name, bundleIdId, certificateId, deviceIds }) {
    if (!Array.isArray(deviceIds) || deviceIds.length === 0) {
      throw new Error("At least one enabled iOS device is required");
    }
    const response = await this.request("POST", "/v1/profiles", {
      expectedStatuses: [201],
      body: {
        data: {
          type: "profiles",
          attributes: { name, profileType: "IOS_APP_ADHOC" },
          relationships: {
            bundleId: { data: { type: "bundleIds", id: bundleIdId } },
            certificates: { data: [{ type: "certificates", id: certificateId }] },
            devices: { data: deviceIds.map((id) => ({ type: "devices", id })) },
          },
        },
      },
    });
    return response.data;
  }

  #resolveUrl(pathOrUrl, query) {
    const url = new URL(pathOrUrl, this.baseUrl);
    if (url.origin !== this.baseUrl.origin) {
      throw new Error("App Store Connect pagination URL is invalid");
    }
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null && value !== "") {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return url;
  }
}

function encodeJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
