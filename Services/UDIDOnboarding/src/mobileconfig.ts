import plist, { type PlistObject } from "plist";

const PROFILE_IDENTIFIER_PREFIX = "wiki.qaq.Asspp.onboarding";

export function buildProfileServiceProfile(options: {
  requestId: string;
  callbackUrl: string;
  challenge: string;
}): string {
  const profile: PlistObject = {
    PayloadContent: {
      URL: options.callbackUrl,
      DeviceAttributes: ["UDID", "PRODUCT", "VERSION"],
      Challenge: options.challenge,
    },
    PayloadDisplayName: "Asspp 设备登记",
    PayloadIdentifier: `${PROFILE_IDENTIFIER_PREFIX}.service.${options.requestId}`,
    PayloadOrganization: "Asspp",
    PayloadType: "Profile Service",
    PayloadUUID: crypto.randomUUID().toUpperCase(),
    PayloadVersion: 1,
  };
  return plist.build(profile);
}

export function buildWebClipProfile(options: { requestId: string; statusUrl: string }): string {
  const webClipUuid = crypto.randomUUID().toUpperCase();
  const profile: PlistObject = {
    PayloadContent: [
      {
        FullScreen: false,
        IsRemovable: true,
        Label: "Asspp 安装",
        PayloadDescription: "打开 Asspp 设备登记状态页",
        PayloadDisplayName: "Asspp 安装",
        PayloadIdentifier: `${PROFILE_IDENTIFIER_PREFIX}.webclip.${options.requestId}`,
        PayloadType: "com.apple.webClip.managed",
        PayloadUUID: webClipUuid,
        PayloadVersion: 1,
        Precomposed: true,
        URL: options.statusUrl,
      },
    ],
    PayloadDescription: "Asspp 设备登记状态页快捷方式",
    PayloadDisplayName: "Asspp 设备登记",
    PayloadIdentifier: `${PROFILE_IDENTIFIER_PREFIX}.result.${options.requestId}`,
    PayloadOrganization: "Asspp",
    PayloadRemovalDisallowed: false,
    PayloadType: "Configuration",
    PayloadUUID: crypto.randomUUID().toUpperCase(),
    PayloadVersion: 1,
  };
  return plist.build(profile);
}

export const mobileconfigHeaders = {
  "content-type": "application/x-apple-aspen-config; charset=utf-8",
  "content-disposition": 'attachment; filename="Asspp-Device-Onboarding.mobileconfig"',
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};
