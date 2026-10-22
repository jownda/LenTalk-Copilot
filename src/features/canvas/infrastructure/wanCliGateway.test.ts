import { describe, expect, it, vi } from "vitest";
import { generateWanCliVideo } from "@/commands/wanCli";
import { tauriAiGateway } from "./tauriAiGateway";
import { getModelProvider, getVideoModel } from "../models/registry";
import { resolveVideoModelProfile } from "../models/videoProfiles";

vi.mock("@/commands/wanCli", () => ({ generateWanCliVideo: vi.fn().mockResolvedValue("/wan/result.mp4") }));

describe("Wan CLI integration", () => {
  it("registers an independent provider with supported options", () => {
    const model = getVideoModel("wan-cli/wan3.0");
    expect(model?.providerId).toBe("wan-cli");
    expect(model?.durationOptions).toHaveLength(29);
    expect(model?.resolutions?.map((option) => option.value)).toEqual(["480p", "720p", "1080p"]);
    expect(getModelProvider("wan-cli").id).toBe("wan-cli");
    expect(resolveVideoModelProfile("wan-cli/wan3.0").supportsReferenceAudio).toBe(false);
    expect(resolveVideoModelProfile("jimeng-cli/seedance2.0").id).toBe("jimeng-cli");
  });

  it("routes generation to the local CLI without requiring a platform API key", async () => {
    const result = await tauriAiGateway.generateVideo({
      model: "wan-cli/wan3.0",
      clientJobId: "persisted-job",
      prompt: "A cat",
      duration: 5,
      aspectRatio: "16:9",
      videoResolution: "1080p",
      imageMode: "first-last",
      referenceImages: ["https://example.com/first.png", "https://example.com/last.png"],
    });
    expect(result).toBe("/wan/result.mp4");
    expect(generateWanCliVideo).toHaveBeenCalledWith(
      expect.objectContaining({
        executable: "wan",
        client_job_id: "persisted-job",
        model_version: "wan3.0",
        prompt: "A cat",
        video_resolution: "1080p",
        image_mode: "first-last",
        reference_images: ["https://example.com/first.png", "https://example.com/last.png"],
      }),
    );
  });
});
