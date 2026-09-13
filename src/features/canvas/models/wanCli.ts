import type { ModelProviderDefinition, VideoModelDefinition } from "./types";
import type { VideoModelProfile } from "./videoProfiles";

export const WAN_CLI_PROVIDER_ID = "wan-cli";
export const wanCliProvider: ModelProviderDefinition = {
  id: WAN_CLI_PROVIDER_ID,
  name: "万相 CLI",
  label: "万相 CLI",
};
export const wanCliVideoProfile: VideoModelProfile = {
  id: "wan-cli",
  status: "verified",
  protocolLabel: "Wan CLI / Local",
  referenceImageTarget: "platform-file",
  supportsReferenceImages: true,
  supportsFirstLast: true,
  supportsReferenceAudio: false,
};
export const wanCliVideoModels: VideoModelDefinition[] = [
  {
    id: "wan-cli/wan3.0",
    mediaType: "video",
    displayName: "万相 CLI · Wan 3.0",
    providerId: WAN_CLI_PROVIDER_ID,
    description: "Wan 3.0",
    expectedDurationMs: 300000,
    aspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4"].map((value) => ({ value, label: value })),
    defaultAspectRatio: "16:9",
    durationOptions: Array.from({ length: 29 }, (_, index) => index + 2),
    defaultDuration: 5,
    resolutions: ["480p", "720p", "1080p"].map((value) => ({ value, label: value.toUpperCase() })),
    defaultResolution: "720p",
    profileId: "wan-cli",
    profileStatus: "verified",
  },
];
